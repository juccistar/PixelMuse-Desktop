import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { BackendError } from './validation.js';

const MAX_IMAGE_SIZE = 50 * 1024 * 1024;
const formats: Record<string, { mimeType: string; extension: string }> = {
  jpeg: { mimeType: 'image/jpeg', extension: 'jpg' }, png: { mimeType: 'image/png', extension: 'png' },
  webp: { mimeType: 'image/webp', extension: 'webp' }, gif: { mimeType: 'image/gif', extension: 'gif' },
  tiff: { mimeType: 'image/tiff', extension: 'tiff' }, avif: { mimeType: 'image/avif', extension: 'avif' },
};

/** 使用路径段判断归属，避免相同前缀目录被当成托管目录。 */
export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** 每次交付真实文件前校验 realpath，拒绝目录 junction 和文件符号链接逃逸。 */
export async function managedPath(root: string, file: string): Promise<string> {
  const path = resolve(root, file);
  if (!within(root, path)) throw new BackendError('INVALID_STORAGE', '存储路径无效。');
  const actual = await realpath(path);
  if (!within(root, actual) || actual !== path || !(await stat(actual)).isFile()) {
    throw new BackendError('INVALID_STORAGE', '存储文件无效。');
  }
  return actual;
}

/** 写入前重新校验托管子目录，不能沿 junction 向外部写文件。 */
export async function managedDirectory(root: string, name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) {
    throw new BackendError('INVALID_STORAGE', '存储目录无效。');
  }
  return path;
}

/** 进程存活锁防止多个 Backend 同时调度同一 SQLite 队列。 */
export async function acquireOwner(root: string): Promise<() => Promise<void>> {
  const path = join(root, 'backend.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => { await rm(path, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // 单一 owner 由进程锁保护；只有确认旧进程已退出才移除崩溃遗留锁。
      let pid: number;
      try { pid = Number(await readFile(path, 'utf8')); } catch { throw new BackendError('BACKEND_IN_USE', '存储已被其他进程使用。'); }
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new BackendError('BACKEND_IN_USE', '存储锁无效。');
      try { process.kill(pid, 0); } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ESRCH') { await rm(path); continue; }
      }
      throw new BackendError('BACKEND_IN_USE', '存储已被其他进程使用。');
    }
  }
  throw new BackendError('BACKEND_IN_USE', '无法取得存储所有权。');
}

/** 以实际内容和 sharp metadata 验证图片，扩展名不作为格式依据。 */
export async function readImage(path: string, signal: AbortSignal) {
  if (!isAbsolute(path)) throw new BackendError('INVALID_IMAGE', '请选择有效的本地图片。');
  let buffer: Buffer;
  try {
    const handle = await open(path, constants.O_RDONLY);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < 1 || info.size > MAX_IMAGE_SIZE) throw new BackendError('INVALID_IMAGE', '图片必须是小于等于 50MB 的普通文件。');
      const chunks: Buffer[] = [];
      let size = 0;
      // 限制实际读取字节数，避免检查后源文件增大绕过上限。
      for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
        size += (chunk as Buffer).length;
        if (size > MAX_IMAGE_SIZE) throw new BackendError('INVALID_IMAGE', '图片不能超过 50MB。');
        chunks.push(chunk as Buffer);
      }
      buffer = Buffer.concat(chunks);
    } finally { await handle.close(); }
    signal.throwIfAborted();
    const metadata = await sharp(buffer, { limitInputPixels: 100_000_000, failOn: 'error' }).metadata();
    const format = metadata.format === 'heif' && metadata.compression === 'av1' ? 'avif' : metadata.format;
    const supported = format ? formats[format] : undefined;
    if (!supported || !metadata.width || !metadata.height) throw new BackendError('INVALID_IMAGE', '不支持此图片格式，SVG 不允许导入。');
    return { buffer, ...supported, width: metadata.width, height: metadata.height,
      sha256: createHash('sha256').update(buffer).digest('hex'), name: basename(path) };
  } catch (error) {
    if (signal.aborted) throw new BackendError('BACKEND_CLOSED', '后端正在关闭。');
    if (error instanceof BackendError) throw error;
    throw new BackendError('INVALID_IMAGE', '无法读取图片或图片格式无效。');
  }
}
