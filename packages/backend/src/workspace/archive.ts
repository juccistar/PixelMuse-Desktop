import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { LocalAssetStore } from '@ecomgen/core';
import { GeneratedFileSchema, type GeneratedFile } from '@ecomgen/contracts';
import { BackendError, check } from '../validation.js';

/** 另存对话框之前持久归档画布产物；取消另存不丢失创作结果。 */
export async function archiveGeneratedFile(storage: LocalAssetStore, input: GeneratedFile, signal: AbortSignal): Promise<null> {
  check(GeneratedFileSchema, input);
  const bytes = Buffer.from(input.base64, 'base64');
  if (!bytes.length || bytes.length > 64 * 1024 * 1024 || bytes.toString('base64') !== input.base64) throw new BackendError('INVALID_FILE', '生成文件编码或容量无效。');
  const extension = input.mimeType === 'image/png' ? '.png' : input.mimeType === 'image/vnd.adobe.photoshop' ? '.psd' : input.mimeType === 'application/zip' ? '.zip' : '.json';
  let valid = input.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
    input.mimeType === 'image/vnd.adobe.photoshop' ? bytes.toString('ascii', 0, 4) === '8BPS' :
    input.mimeType === 'application/zip' ? bytes[0] === 80 && bytes[1] === 75 && [3,5,7].includes(bytes[2] ?? 0) : false;
  if (extension === '.json') { try { JSON.parse(bytes.toString('utf8')); valid = true; } catch { /* 返回统一安全错误。 */ } }
  if (!valid || !input.name.toLowerCase().endsWith(extension)) throw new BackendError('INVALID_FILE', '生成文件内容与类型不一致。');
  signal.throwIfAborted();
  const id = randomUUID(), relative = join('exports', 'canvas', id, `file-${basename(input.name)}`), temporary = storage.absolute(join('tmp', `canvas-${id}`));
  const target = storage.absolute(relative);
  await mkdir(storage.absolute(join('exports', 'canvas', id)), { recursive: true });
  storage.absolute(relative);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes, { signal }); await file.sync(); } finally { await file.close(); }
    signal.throwIfAborted(); storage.absolute(relative); await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  return null;
}
