import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, link, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decodeGeneratedFile, parseResourceRequest, readSelectedImage } from './native-files';
import { imageTypeFromHeader } from '../shared/image-types';
const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'ecomgen-native-')); dirs.push(dir); return dir; }
describe('main 原生文件边界', () => {
  it('只从受限 kind/id/index 解析协议资源，适配 Chromium 主机大小写', () => {
    expect(parseResourceRequest('ecomgen-resource://layer_file/export-1/2')).toEqual({ kind: 'LAYER_FILE', id: 'export-1', index: 2 });
    expect(parseResourceRequest('ecomgen-resource://OUTPUT/out-1')).toEqual({ kind: 'OUTPUT', id: 'out-1' });
  });
  it.each(['file:///C:/secret.png','https://provider.invalid/file','ecomgen-resource://ASSET/../private','ecomgen-resource://ASSET/id?path=C:/secret','ecomgen-resource://OUTPUT/id/0','ecomgen-resource://LAYER_FILE/id/256','ecomgen-resource://ASSET/%2e%2e','ecomgen-resource://ASSET/id#frag','ecomgen-resource://ASSET/user:pass@id'])('拒绝任意地址 %s', value => {
    expect(() => parseResourceRequest(value)).toThrow();
  });
  it('读取原生选择图片为无路径 ByteImport', async () => {
    const dir = await directory(); const path = join(dir, 'photo.png'); await writeFile(path, PNG);
    expect(await readSelectedImage(path)).toEqual({ name: 'photo.png', mimeType: 'image/png', base64: PNG.toString('base64') });
  });
  it('拒绝空文件、目录、伪装扩展名及硬链接', async () => {
    const dir = await directory(), empty = join(dir,'empty.png'), fake = join(dir,'fake.png'), image = join(dir,'image.png'), alias = join(dir,'alias.png');
    await writeFile(empty, ''); await writeFile(fake, 'not an image'); await writeFile(image, PNG); await link(image, alias); await mkdir(join(dir,'folder'));
    await expect(readSelectedImage(empty)).rejects.toMatchObject({ code: 'INVALID_FILE' });
    await expect(readSelectedImage(fake)).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' });
    await expect(readSelectedImage(alias)).rejects.toMatchObject({ code: 'INVALID_FILE' });
    await expect(readSelectedImage(join(dir,'folder'))).rejects.toMatchObject({ code: 'INVALID_FILE' });
  });
  it('原生导入保留 AVIF 与 TIFF 字节格式，不隐式转码', async () => {
    const dir = await directory();
    const tiff = Buffer.from([73,73,42,0,8,0,0,0]);
    const avif = Buffer.from('\0\0\0\x20ftypavif\0\0\0\0mif1');
    await writeFile(join(dir,'artwork.tiff'),tiff); await writeFile(join(dir,'artwork.avif'),avif);
    expect(await readSelectedImage(join(dir,'artwork.tiff'))).toMatchObject({mimeType:'image/tiff',base64:tiff.toString('base64')});
    expect(await readSelectedImage(join(dir,'artwork.avif'))).toMatchObject({mimeType:'image/avif',base64:avif.toString('base64')});
  });
  it('识别已发布桌面的 TIFF 与 AVIF 文件头', () => {
    expect(imageTypeFromHeader(Uint8Array.from([73,73,42,0]))).toBe('image/tiff');
    expect(imageTypeFromHeader(Uint8Array.from([77,77,0,42]))).toBe('image/tiff');
    expect(imageTypeFromHeader(Buffer.from('\0\0\0\x20ftypavif\0\0\0\0mif1'))).toBe('image/avif');
  });
  it('生成文件只接受声明的有界类型且校验签名、扩展名与规范 Base64', () => {
    const value = { name: 'canvas.png', mimeType: 'image/png', base64: PNG.toString('base64') };
    expect(decodeGeneratedFile(value).bytes).toEqual(PNG);
    expect(() => decodeGeneratedFile({ ...value, name: '../canvas.png' })).toThrow();
    expect(() => decodeGeneratedFile({ ...value, name: 'canvas.exe' })).toThrow();
    expect(() => decodeGeneratedFile({ ...value, path: 'C:/secret' })).toThrow();
    expect(() => decodeGeneratedFile({ ...value, mimeType: 'application/zip' })).toThrow();
    expect(() => decodeGeneratedFile({ ...value, base64: value.base64 + '=' })).toThrow();
  });
  it('JSON 内容必须完整解析，拒绝可执行格式', () => {
    expect(decodeGeneratedFile({ name:'suite.json',mimeType:'application/json',base64:Buffer.from('{"id":"user-suite"}').toString('base64') }).file.name).toBe('suite.json');
    expect(() => decodeGeneratedFile({ name:'suite.json',mimeType:'application/json',base64:Buffer.from('{broken').toString('base64') })).toThrow();
    expect(() => decodeGeneratedFile({ name:'file.exe',mimeType:'application/octet-stream',base64:Buffer.from('MZ').toString('base64') })).toThrow();
  });
});
