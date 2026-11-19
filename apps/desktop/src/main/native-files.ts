import { open, lstat } from 'node:fs/promises';
import { basename } from 'node:path';
import { ByteImportSchema, resourceRefFromUrl, type ByteImport, type ResourceRef } from '@ecomgen/contracts';
import { Value } from '@sinclair/typebox/value';
import { GeneratedFileSchema, type GeneratedFile } from '../shared/native-contracts.js';
import { PublicError } from './public-error.js';
import { imageTypeFromHeader } from '../shared/image-types.js';

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_SELECTION_BYTES = 128 * 1024 * 1024;
/** 原生选择的路径只在 main 内使用，限制读入量并拒绝特殊文件和链接。 */
export async function readSelectedImage(path: string): Promise<ByteImport> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size < 1 || stat.size > MAX_IMAGE_BYTES) throw new PublicError('INVALID_FILE', '图片必须是 50 MiB 以内的普通文件');
  const file = await open(path, 'r');
  try {
    const current = await file.stat();
    if (!current.isFile() || current.nlink > 1 || current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) throw new PublicError('FILE_CHANGED', '图片在读取前发生变化，请重新选择');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    const after = await file.stat();
    if (offset !== bytes.length || after.size !== bytes.length || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs || after.nlink > 1) throw new PublicError('FILE_CHANGED', '图片在读取时发生变化，请重新选择');
    const mimeType = imageTypeFromHeader(bytes);
    if (!mimeType) throw new PublicError('UNSUPPORTED_IMAGE', '图片格式未获当前导入契约支持，请使用 PNG、JPEG 或 WebP');
    const result = { name: basename(path), mimeType, base64: bytes.toString('base64') };
    if (!Value.Check(ByteImportSchema, result)) throw new PublicError('UNSUPPORTED_IMAGE', '当前后台导入契约尚未接纳此图片格式，请更新本地应用');
    return result as ByteImport;
  } finally { await file.close(); }
}
/** Chromium 会规范化协议主机名；只规范化 kind，其他部分保持严格语法。 */
export function parseResourceRequest(value: string): ResourceRef {
  return resourceRefFromUrl(value.replace(/^(ecomgen-resource:\/\/)([a-z_]+)\//, (_, prefix: string, kind: string) => prefix + kind.toUpperCase() + '/'));
}
export function decodeGeneratedFile(value: unknown): { file: GeneratedFile; bytes: Buffer } {
  if (!Value.Check(GeneratedFileSchema, value)) throw new PublicError('INVALID_INPUT', '导出文件不符合契约');
  const file = value as GeneratedFile;
  const bytes = Buffer.from(file.base64, 'base64');
  if (!bytes.length || bytes.length > 64 * 1024 * 1024 || bytes.toString('base64') !== file.base64) throw new PublicError('INVALID_FILE', '导出文件超过容量或编码无效');
  const allowed = file.mimeType === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : file.mimeType === 'image/vnd.adobe.photoshop' ? bytes.toString('ascii',0,4) === '8BPS'
    : file.mimeType === 'application/zip' ? bytes[0] === 80 && bytes[1] === 75 && [3,5,7].includes(bytes[2] ?? 0)
    : (() => { try { JSON.parse(bytes.toString('utf8')); return true; } catch { return false; } })();
  if (!allowed) throw new PublicError('INVALID_FILE', '导出文件内容与类型不一致');
  const extension = file.mimeType === 'image/png' ? '.png' : file.mimeType === 'image/vnd.adobe.photoshop' ? '.psd' : file.mimeType === 'application/zip' ? '.zip' : '.json';
  if (!file.name.toLowerCase().endsWith(extension)) throw new PublicError('INVALID_FILE', '导出文件扩展名与类型不一致');
  return { file, bytes };
}
