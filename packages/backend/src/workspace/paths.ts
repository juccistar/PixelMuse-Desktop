import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { BackendError } from '../validation.js';

export const namespaces = ['assets', 'outputs', 'exports', 'edits', 'layers', 'thumbs', 'tmp', 'suite-forge', 'models', 'patterns', 'print-packs', 'drafts', 'suites'] as const;
export const invalidWorkspace = () => new BackendError('INVALID_WORKSPACE', '工作空间目录无效、已被占用或包含冲突文件。请选择独立的空目录。');
export function nested(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
/** 逐级检查，拒绝 junction、符号链接与非规范化别名。 */
export async function safeDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw invalidWorkspace();
  const normalized = resolve(path);
  let current = normalized;
  for (;;) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw invalidWorkspace();
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  const actual = await realpath(normalized);
  if (actual.toLowerCase() !== normalized.toLowerCase()) throw invalidWorkspace();
  return actual;
}
export function safeRelative(path: string): boolean {
  return !!path && !isAbsolute(path) && !win32.isAbsolute(path) && !path.includes(':') && !path.split(/[\\/]/).some(part => !part || part === '.' || part === '..') &&
    !/^(?:backend\.sqlite(?:-wal|-shm)?|backend\.lock|master-key\.enc|workspace(?:[.-].*)?|\.pixelmuse.*)$/i.test(path.split(/[\\/]/)[0]!);
}
