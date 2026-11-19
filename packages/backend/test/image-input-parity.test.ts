import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Value } from '@sinclair/typebox/value';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ByteImportSchema, CreatePatternExtractJobInput, ImageByteImportSchema,
  MAX_IMAGE_TRANSPORT_BYTES, operations, type ByteImport,
} from '@ecomgen/contracts';
import { LocalAssetStore } from '../../core/src/files.js';
import { decodeByteImport } from '../src/validation.js';

const formats = [
  ['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'],
  ['avif', 'image/avif'], ['tiff', 'image/tiff'],
] as const;
type ImageFormat = typeof formats[number][0];
const images = new Map<ImageFormat, Buffer>();
const file = (buffer: Buffer, mimeType = 'image/png'): ByteImport => ({ name: 'generated.image', mimeType, base64: buffer.toString('base64') });
const store = new LocalAssetStore(join(tmpdir(), 'ecomgen-image-inspection-unused'));
const uuid = '00112233-4455-4677-8899-aabbccddeeff';

beforeAll(async () => {
  // AVIF 必须真的编码成功；缺失 libheif/AV1 能力时测试直接失败，不静默跳过。
  for (const [format] of formats) {
    images.set(format, await sharp({ create: { width: 12, height: 10, channels: 3, background: '#ab45ef' } }).toFormat(format).toBuffer());
  }
});

/** 最小非压缩 RGB TIFF，显式覆盖两种端序（Sharp 默认编码只生成其中一种）。 */
function tiff(endian: 'LE' | 'BE'): Buffer {
  const bytes = Buffer.alloc(143);
  const u16 = (offset: number, value: number) => endian === 'LE' ? bytes.writeUInt16LE(value, offset) : bytes.writeUInt16BE(value, offset);
  const u32 = (offset: number, value: number) => endian === 'LE' ? bytes.writeUInt32LE(value, offset) : bytes.writeUInt32BE(value, offset);
  bytes.write(endian === 'LE' ? 'II' : 'MM'); u16(2, 42); u32(4, 8); u16(8, 10);
  const tags = [[256, 4, 1, 1], [257, 4, 1, 1], [258, 3, 3, 134], [259, 3, 1, 1], [262, 3, 1, 2], [273, 4, 1, 140], [277, 3, 1, 3], [278, 4, 1, 1], [279, 4, 1, 3], [284, 3, 1, 1]];
  tags.forEach(([tag, type, count, value], index) => {
    const offset = 10 + 12 * index;
    u16(offset, tag!); u16(offset + 2, type!); u32(offset + 4, count!);
    if (type === 3 && count === 1) u16(offset + 8, value!); else u32(offset + 8, value!);
  });
  u16(134, 8); u16(136, 8); u16(138, 8); bytes.set([171, 69, 239], 140);
  return bytes;
}

describe('published desktop image byte inputs', () => {
  it('shares the exact domain shape with IPC and extraction', () => {
    expect(ByteImportSchema).toBe(ImageByteImportSchema);
    expect(CreatePatternExtractJobInput.properties.file).toBe(ImageByteImportSchema);
  });

  it.each(formats)('accepts generated %s with real decoding and registered operation validation', async (format, mime) => {
    const bytes = images.get(format)!;
    const input = file(bytes, mime);
    expect(Value.Check(operations.uploadAsset.input, { projectId: uuid, file: input })).toBe(true);
    expect(decodeByteImport(input)).toEqual(bytes);
    expect(await store.inspectImage(bytes)).toMatchObject({ width: 12, height: 10 });
    const decoded = await sharp(bytes, { limitInputPixels: 100_000_000, failOn: 'error' }).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 12, height: 10 });
  });

  it.each(formats)('rejects every incorrect supported MIME for %s content', (format, mime) => {
    for (const [, otherMime] of formats) {
      if (otherMime !== mime) expect(() => decodeByteImport(file(images.get(format)!, otherMime))).toThrow();
    }
  });

  it.each(['LE', 'BE'] as const)('accepts genuinely decodable %s TIFF headers', async endian => {
    const bytes = tiff(endian);
    expect(decodeByteImport(file(bytes, 'image/tiff'))).toEqual(bytes);
    const decoded = await sharp(bytes, { failOn: 'error' }).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 1, height: 1, channels: 3 });
    expect([...decoded.data]).toEqual([171, 69, 239]);
  });

  it('recognizes AVIF compatible brands when the major brand is mif1', async () => {
    const bytes = Buffer.from(images.get('avif')!);
    bytes.write('mif1', 8, 'ascii');
    expect(decodeByteImport(file(bytes, 'image/avif'))).toEqual(bytes);
    expect((await sharp(bytes, { failOn: 'error' }).raw().toBuffer({ resolveWithObject: true })).info).toMatchObject({ width: 12, height: 10 });
  });

  it('rejects generic HEIF, truncated ftyp and incidental avif text', () => {
    const avif = Buffer.from(images.get('avif')!);
    const ftypSize = avif.readUInt32BE(0);
    const generic = Buffer.from(avif);
    generic.write('mif1', 8, 'ascii');
    for (let offset = 16; offset < ftypSize; offset += 4) generic.write('mif1', offset, 'ascii');
    generic.write('avif', 12, 'ascii'); // minor_version 不是品牌。
    expect(() => decodeByteImport(file(generic, 'image/avif'))).toThrow();
    expect(() => decodeByteImport(file(avif.subarray(0, ftypSize - 1), 'image/avif'))).toThrow();
    const malformed = Buffer.from(avif); malformed.writeUInt32BE(15, 0);
    expect(() => decodeByteImport(file(malformed, 'image/avif'))).toThrow();
    expect(() => decodeByteImport(file(Buffer.from('0000mdat-not-an-image-avif'), 'image/avif'))).toThrow();
  });

  it('rejects high-bit bytes that only resemble ASCII container signatures after masking', () => {
    for (const [format, mime] of [['avif', 'image/avif'], ['webp', 'image/webp']] as const) {
      const bytes = Buffer.from(images.get(format)!);
      const offset = format === 'avif' ? 4 : 0;
      bytes[offset] = bytes[offset]! | 0x80;
      expect(() => decodeByteImport(file(bytes, mime))).toThrow();
    }
  });

  it('rejects SVG and unsupported MIME types even when disguised as PNG', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="10"></svg>');
    expect(() => decodeByteImport(file(svg, 'image/svg+xml'))).toThrow();
    expect(() => decodeByteImport(file(svg))).toThrow();
    expect(() => decodeByteImport(file(images.get('png')!, 'application/octet-stream'))).toThrow();
  });

  it.each(['', 'A===', 'AAAA\n', 'AA-A', 'AA_A', 'AAAA=', 'AAAAAA', 'AB==', 'AAB=', 'data:image/png;base64,AAAA'])('rejects malformed or empty base64 %j', base64 => {
    expect(() => decodeByteImport({ name: 'bad.png', mimeType: 'image/png', base64 })).toThrow();
  });

  it('preserves the 50MiB published file size at the transport boundary', () => {
    const bytes = Buffer.alloc(50 * 1024 * 1024); images.get('png')!.copy(bytes);
    const input = file(bytes);
    expect(Value.Check(ByteImportSchema, input)).toBe(true);
    expect(decodeByteImport(input).length).toBe(50 * 1024 * 1024);
  });

  it('checks actual decoded bytes when an extra byte still fits the base64 character bound', () => {
    const bytes = Buffer.alloc(MAX_IMAGE_TRANSPORT_BYTES + 1); images.get('png')!.copy(bytes);
    const input = file(bytes);
    expect(Value.Check(ByteImportSchema, input)).toBe(true);
    expect(() => decodeByteImport(input)).toThrow('图片内容或大小无效');
    expect(Value.Check(ByteImportSchema, { ...input, base64: input.base64 + 'AAAA' })).toBe(false);
  });

  it.each(formats)('does not treat a fake %s signature as a decoded image', async (format, mime) => {
    const bytes = images.get(format)!;
    const header = bytes.subarray(0, format === 'avif' ? bytes.readUInt32BE(0) : format === 'tiff' ? 8 : format === 'webp' ? 12 : format === 'jpeg' ? 3 : 8);
    expect(decodeByteImport(file(header, mime))).toEqual(header);
    await expect(store.inspectImage(header)).rejects.toThrow();
  });

  it('rejects truncated pixel data even when Sharp can still read dimensions', async () => {
    const bytes = images.get('png')!;
    const truncated = bytes.subarray(0, bytes.length - 20);
    expect(decodeByteImport(file(truncated))).toEqual(truncated);
    expect(await sharp(truncated).metadata()).toMatchObject({ width: 12, height: 10 });
    await expect(store.inspectImage(truncated)).rejects.toThrow();
  });

  it('retains the real pixel limit after byte decoding', async () => {
    const limited = new LocalAssetStore(join(tmpdir(), 'ecomgen-image-pixel-inspection-unused'), { maxImagePixels: 100 });
    await expect(limited.inspectImage(decodeByteImport(file(images.get('png')!)))).rejects.toThrow();
  });
});

describe('registered extraction and mask contracts', () => {
  const extract = (image: unknown) => ({ providerId: uuid, modelId: 'segmentation-model', file: image });

  it('accepts typed extraction bytes with valid formats and embedded domain refs', () => {
    const input = { ...extract(file(images.get('avif')!, 'image/avif')), imageResolution: '1K', pipeline: { specId: 'mug-11oz', listingPlatform: 'ETSY', listingProviderId: uuid, listingModelId: 'vision' } };
    expect(Value.Check(operations.createPatternExtractJob.input, input)).toBe(true);
    expect(Value.Check(operations.createPatternExtractJob.input, { ...input, providerId: 'not-a-uuid' })).toBe(false);
    expect(Value.Check(operations.createPatternExtractJob.input, { ...input, imageResolution: 'unsupported' })).toBe(false);
    expect(Value.Check(operations.createPatternExtractJob.input, { ...input, pipeline: { ...input.pipeline, listingPlatform: 'OTHER' } })).toBe(false);
  });

  it('rejects multipart strings, missing bytes, and arbitrary paths at every nesting level', () => {
    const valid = file(images.get('png')!);
    for (const image of ['binary', 'C:\\private\\product.png', valid.base64, { path: 'C:/private/product.png' }, { ...valid, path: 'C:/private/product.png' }, null]) {
      expect(Value.Check(operations.createPatternExtractJob.input, extract(image))).toBe(false);
    }
    expect(Value.Check(operations.createPatternExtractJob.input, { providerId: uuid, modelId: 'model' })).toBe(false);
    expect(Value.Check(operations.createPatternExtractJob.input, { ...extract(valid), path: 'C:/private/product.png' })).toBe(false);
    expect(Value.Check(operations.createPatternExtractJob.input, { ...extract(valid), pipeline: { specId: 'mug', listingPlatform: 'ETSY', listingProviderId: uuid, listingModelId: 'vision', path: 'private' } })).toBe(false);
  });

  it.each(['editMask', 'protectMask'] as const)('keeps %s PNG-only despite broader image upload support', key => {
    for (const [format, mime] of formats) {
      expect(Value.Check(operations.createEditTurn.input, { sessionId: uuid, message: 'retain product', [key]: file(images.get(format)!, mime) })).toBe(format === 'png');
    }
  });

  it('keeps all offline projections synchronized with the 154 actual contracts and 131 old mappings', async () => {
    const catalog = JSON.parse(await readFile(new URL('../../contracts/command-catalog.json', import.meta.url), 'utf8')) as { operations: Array<{ operation: string; input: unknown; output: unknown; source?: { operationId?: string } }> };
    expect(Object.keys(operations)).toHaveLength(154);
    // 额外两行保留事件订阅与旧空操作的迁移说明，并非可调用命令。
    expect(catalog.operations).toHaveLength(156);
    expect(catalog.operations.filter(row => row.source?.operationId)).toHaveLength(131);
    const commands = catalog.operations.filter(row => row.input !== null);
    expect(commands).toHaveLength(154);
    expect(new Set(commands.map(row => row.operation))).toEqual(new Set(Object.keys(operations)));
    for (const row of commands) {
      const actual = operations[row.operation as keyof typeof operations];
      expect(actual, row.operation).toBeDefined();
      expect(row.input, row.operation).toEqual(JSON.parse(JSON.stringify(actual.input)));
      expect(row.output, row.operation).toEqual(JSON.parse(JSON.stringify(actual.output)));
    }
  });
});
