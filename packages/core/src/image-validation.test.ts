import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalAssetStore } from './files.js';

const unusedRoot = join(tmpdir(), 'core-image-inspection-unused');
const formats = ['png', 'jpeg', 'webp', 'avif', 'tiff'] as const;
const images = new Map<string, Buffer>();
const directories: string[] = [];

beforeAll(async () => {
  const pixels = Buffer.from(Array.from({ length: 32 * 24 * 3 }, (_, i) => (i * 47 + i * i) % 256));
  for (const format of formats) {
    images.set(format, await sharp(pixels, { raw: { width: 32, height: 24, channels: 3 } }).toFormat(format).toBuffer());
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Only change the tiny fixture's IHDR and CRC; never allocate the declared large pixel grid.
function declaredPngSize(source: Buffer, width: number, height: number): Buffer {
  const content = Buffer.from(source);
  content.writeUInt32BE(width, 16);
  content.writeUInt32BE(height, 20);
  let crc = 0xffffffff;
  for (const byte of content.subarray(12, 29)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  content.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  return content;
}

describe('LocalAssetStore image validation', () => {
  it('rejects truncated PNG pixels even when its dimensions are readable', async () => {
    const content = await sharp({ create: { width: 12, height: 10, channels: 3, background: '#123456' } }).png().toBuffer();
    const truncated = content.subarray(0, content.length - 20);
    expect(await sharp(truncated).metadata()).toMatchObject({ width: 12, height: 10 });
    await expect(sharp(truncated, { failOn: 'error' }).raw().toBuffer()).rejects.toThrow();
    await expect(new LocalAssetStore(unusedRoot).inspectImage(truncated)).rejects.toThrow();
  });

  it.each(formats)('fully validates valid %s without changing its encoded bytes or RGB pixels', async format => {
    const content = images.get(format)!;
    const original = Buffer.from(content);
    const pixels = await sharp(content).raw().toBuffer();
    await expect(new LocalAssetStore(unusedRoot).inspectImage(content)).resolves.toEqual({
      width: 32, height: 24, format: format === 'avif' ? 'heif' : format, hasAlpha: false,
    });
    expect(content).toEqual(original);
    expect(await sharp(content).raw().toBuffer()).toEqual(pixels);
  });

  it.each(['png', 'webp', 'avif', 'tiff'] as const)('preserves real alpha metadata for %s', async format => {
    const image = sharp({ create: { width: 12, height: 10, channels: 4, background: { r: 15, g: 100, b: 220, alpha: 0.4 } } });
    const content = await (format === 'tiff' ? image.tiff({ compression: 'deflate' }) : image.toFormat(format)).toBuffer();
    await expect(new LocalAssetStore(unusedRoot).inspectImage(content)).resolves.toEqual({
      width: 12, height: 10, format: format === 'avif' ? 'heif' : format, hasAlpha: true,
    });
  });

  it.each(formats)('rejects truncated %s data from the installed real codec', async format => {
    const content = images.get(format)!;
    const truncated = content.subarray(0, content.length - 20);
    // WebP rejects truncation at the container-header stage; the other codecs still expose dimensions.
    if (format !== 'webp') expect(await sharp(truncated).metadata()).toMatchObject({ width: 32, height: 24 });
    await expect(sharp(truncated, { failOn: 'warning' }).raw().toBuffer()).rejects.toThrow();
    await expect(new LocalAssetStore(unusedRoot).inspectImage(truncated)).rejects.toThrow();
  });

  it('rejects JPEG truncation warnings that a permissive decoder would repair', async () => {
    const truncated = images.get('jpeg')!.subarray(0, -1);
    await expect(sharp(truncated, { failOn: 'none' }).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
    await expect(new LocalAssetStore(unusedRoot).inspectImage(truncated)).rejects.toThrow();
  });

  it('checks the byte bound before reading metadata or decoding pixels', async () => {
    const content = images.get('png')!;
    const metadata = vi.spyOn(sharp.prototype, 'metadata');
    const stats = vi.spyOn(sharp.prototype, 'stats');
    await expect(new LocalAssetStore(unusedRoot, { maxImageBytes: content.length - 1 }).inspectImage(content)).rejects.toThrow('byte limit');
    expect(metadata).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
    await expect(new LocalAssetStore(unusedRoot, { maxImageBytes: content.length }).inspectImage(content)).resolves.toMatchObject({ width: 32 });
  });

  it('rejects dimensions above the default 100M pixel bound before decoding', async () => {
    const content = declaredPngSize(images.get('png')!, 10_001, 10_000);
    expect(content.length).toBe(images.get('png')!.length);
    const stats = vi.spyOn(sharp.prototype, 'stats');
    await expect(new LocalAssetStore(unusedRoot).inspectImage(content)).rejects.toThrow(/pixel limit/i);
    expect(stats).not.toHaveBeenCalled();
  });

  it('applies configured pixel bounds before decoding and accepts the exact boundary', async () => {
    const content = images.get('png')!;
    const stats = vi.spyOn(sharp.prototype, 'stats');
    await expect(new LocalAssetStore(unusedRoot, { maxImagePixels: 32 * 24 - 1 }).inspectImage(content)).rejects.toThrow(/pixel limit/i);
    expect(stats).not.toHaveBeenCalled();
    await expect(new LocalAssetStore(unusedRoot, { maxImagePixels: 32 * 24 }).inspectImage(content)).resolves.toMatchObject({ width: 32, height: 24 });
  });

  it('counts all TIFF pages toward the bound and retains the stacked dimensions', async () => {
    const content = await sharp(Buffer.alloc(12 * 20 * 3, 100), { raw: { width: 12, height: 20, channels: 3, pageHeight: 10 } }).tiff({ compression: 'deflate' }).toBuffer();
    expect(await sharp(content, { animated: true }).metadata()).toMatchObject({ pages: 2, pageHeight: 10 });
    const stats = vi.spyOn(sharp.prototype, 'stats');
    await expect(new LocalAssetStore(unusedRoot, { maxImagePixels: 12 * 10 }).inspectImage(content)).rejects.toThrow(/pixel limit/i);
    expect(stats).not.toHaveBeenCalled();
    await expect(new LocalAssetStore(unusedRoot, { maxImagePixels: 12 * 20 }).inspectImage(content)).resolves.toEqual({ width: 12, height: 20, format: 'tiff', hasAlpha: false });
  });

  it('decodes later TIFF pages even when the first page and all metadata remain intact', async () => {
    const source = await sharp(Buffer.alloc(12 * 20 * 3, 100), { raw: { width: 12, height: 20, channels: 3, pageHeight: 10 } }).tiff({ compression: 'deflate' }).toBuffer();
    expect(source.toString('ascii', 0, 2)).toBe('II');
    const firstDirectory = source.readUInt32LE(4);
    const secondDirectory = source.readUInt32LE(firstDirectory + 2 + 12 * source.readUInt16LE(firstDirectory));
    const tags = new Map<number, number>();
    for (let i = 0; i < source.readUInt16LE(secondDirectory); i++) {
      const entry = secondDirectory + 2 + i * 12;
      tags.set(source.readUInt16LE(entry), entry);
    }
    const offsetTag = tags.get(273)!;
    const countTag = tags.get(279)!;
    expect(source.readUInt32LE(offsetTag + 4)).toBe(1);
    expect(source.readUInt32LE(countTag + 4)).toBe(1);
    const offset = source.readUInt32LE(offsetTag + 8);
    const count = source.readUInt32LE(countTag + 8);
    // Relocate the real encoded second-page strip after the directories, then truncate only its pixels.
    const relocated = Buffer.concat([source, source.subarray(offset, offset + count)]);
    relocated.writeUInt32LE(source.length, offsetTag + 8);
    await expect(new LocalAssetStore(unusedRoot).inspectImage(relocated)).resolves.toMatchObject({ width: 12, height: 20 });
    const truncated = relocated.subarray(0, relocated.length - Math.ceil(count / 2));
    expect(await sharp(truncated, { animated: true }).metadata()).toMatchObject({ width: 12, height: 20, pages: 2 });
    await expect(sharp(truncated).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
    await expect(sharp(truncated, { animated: true }).raw().toBuffer()).rejects.toThrow();
    await expect(new LocalAssetStore(unusedRoot).inspectImage(truncated)).rejects.toThrow();
  });

  it('rejects an already cancelled inspection before any native work', async () => {
    const reason = new Error('cancel before inspection');
    const metadata = vi.spyOn(sharp.prototype, 'metadata');
    const stats = vi.spyOn(sharp.prototype, 'stats');
    await expect(new LocalAssetStore(unusedRoot).inspectImage(images.get('png')!, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(metadata).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
  });

  it('does not start pixel decoding when cancelled during metadata', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel during metadata');
    const original = sharp.prototype.metadata;
    vi.spyOn(sharp.prototype, 'metadata').mockImplementationOnce(async function (this: sharp.Sharp) {
      const metadata = await original.call(this);
      controller.abort(reason);
      return metadata;
    });
    const stats = vi.spyOn(sharp.prototype, 'stats');
    await expect(new LocalAssetStore(unusedRoot).inspectImage(images.get('png')!, controller.signal)).rejects.toBe(reason);
    expect(stats).not.toHaveBeenCalled();
  });

  it('waits for native decoding to settle and rejects cancellation before caller publication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'core-image-validation-'));
    directories.push(root);
    const store = new LocalAssetStore(root);
    await store.initialize();
    const controller = new AbortController();
    const reason = new Error('cancel during native decode');
    const original = sharp.prototype.stats;
    let nativeSettled = false;
    vi.spyOn(sharp.prototype, 'stats').mockImplementationOnce(function (this: sharp.Sharp) {
      const decoding = original.call(this);
      controller.abort(reason);
      return decoding.finally(() => { nativeSettled = true; });
    });
    const inspectThenPublish = async () => {
      await store.inspectImage(images.get('png')!, controller.signal);
      return store.putAsset('project', 'image.png', images.get('png')!, { signal: controller.signal });
    };
    await expect(inspectThenPublish()).rejects.toBe(reason);
    expect(nativeSettled).toBe(true);
    expect(readdirSync(join(root, 'assets'))).toEqual([]);
    expect(readdirSync(join(root, 'tmp'))).toEqual([]);
  });

  it('rejects broken pixels before caller writes any managed artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'core-image-validation-'));
    directories.push(root);
    const store = new LocalAssetStore(root);
    await store.initialize();
    const content = images.get('png')!.subarray(0, -20);
    const inspectThenPublish = async () => {
      await store.inspectImage(content);
      return store.putAsset('project', 'image.png', content);
    };
    await expect(inspectThenPublish()).rejects.toThrow();
    expect(readdirSync(join(root, 'assets'))).toEqual([]);
    expect(readdirSync(join(root, 'tmp'))).toEqual([]);
  });
});
