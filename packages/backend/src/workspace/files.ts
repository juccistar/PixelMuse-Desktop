import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { SqliteDatabase } from '@ecomgen/core';
import { invalidWorkspace, namespaces, nested, safeDirectory, safeRelative } from './paths.js';

export interface MediaFile { relativePath: string; size: number; hash: string }
/** 持久记录中的历史平铺引用也必须随媒体迁移，不能只扫描资源登记表。 */
export function legacyReferences(db: SqliteDatabase): string[] {
  const paths = new Set<string>();
  const visit = (value: unknown, key = ''): void => {
    if (typeof value === 'string') {
      if (/path(?:s)?$/i.test(key) && safeRelative(value)) paths.add(value);
      else if (/^[\[{]/.test(value)) { try { visit(JSON.parse(value)); } catch { /* 非 JSON 文本不参与文件扫描。 */ } }
    } else if (Array.isArray(value)) for (const item of value) visit(item, key);
    else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) visit(item, name);
  };
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as { name: string; type: string }[];
    const selected = columns.filter(column => /path$|(?:payload|input|result|snapshot)(?:_json)?$/i.test(column.name));
    if (!selected.length) continue;
    const rows = db.prepare(`SELECT ${selected.map(column => quote(column.name)).join(',')} FROM ${quote(table.name)}`).all() as Record<string, unknown>[];
    for (const row of rows) visit(row);
  }
  return [...paths];
}
export async function digestFile(root: string, path: string, signal: AbortSignal): Promise<{ size: number; hash: string }> {
  signal.throwIfAborted(); await safeDirectory(root);
  if (!nested(root, path)) throw invalidWorkspace();
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || (await realpath(path)).toLowerCase() !== path.toLowerCase()) throw invalidWorkspace();
  const hash = createHash('sha256'); let size = 0;
  const file = await open(path, 'r');
  try {
    const opened = await file.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.nlink !== 1) throw invalidWorkspace();
    for await (const chunk of file.createReadStream({ autoClose: false, signal })) { size += chunk.length; hash.update(chunk); }
    const after = await file.stat();
    if (size !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw invalidWorkspace();
  } finally { await file.close(); }
  return { size, hash: hash.digest('hex') };
}
function identity(info: Stats, root = false): string {
  if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw invalidWorkspace();
  // 根中还有迁移日志/临时配置，只有媒体子树的时间戳参与 fencing。
  return JSON.stringify([info.isDirectory() ? 'd' : 'f', info.dev, info.ino, ...(root ? [] : [info.size, info.mtimeMs, info.ctimeMs])]);
}
function equalSnapshot(before: Map<string, string>, after: Map<string, string>): void {
  if (after.size !== before.size || [...before].some(([path, value]) => after.get(path) !== value)) throw invalidWorkspace();
}
/** 内容清点及提交前轻量元数据复核；不宣称获得操作系统级原子快照。 */
export async function verifiedInventory(root: string, references: string[], signal: AbortSignal): Promise<{ files: MediaFile[]; assertUnchanged(): void }> {
  const paths = [...namespaces, ...references];
  if (references.some(path => !safeRelative(path))) throw invalidWorkspace();
  const snapshot = async (): Promise<Map<string, string>> => {
    await safeDirectory(root);
    const entries = new Map<string, string>([['', identity(await lstat(root), true)]]);
    const walk = async (path: string): Promise<void> => {
      signal.throwIfAborted();
      let info; try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      entries.set(relative(root, path), identity(info));
      if (info.isDirectory()) { await safeDirectory(path); for (const name of await readdir(path)) await walk(join(path, name)); }
    };
    for (const path of paths) await walk(join(root, path));
    return entries;
  };
  const before = await snapshot(), files: MediaFile[] = [];
  for (const relativePath of [...before.keys()].sort()) {
    if (before.get(relativePath)!.startsWith('["f"')) files.push({ relativePath, ...await digestFile(root, join(root, relativePath), signal) });
  }
  equalSnapshot(before, await snapshot());
  return { files, assertUnchanged: (): void => {
    signal.throwIfAborted();
    if (realpathSync.native(root).toLowerCase() !== root.toLowerCase()) throw invalidWorkspace();
    const current = new Map<string, string>([['', identity(lstatSync(root), true)]]);
    const walk = (path: string): void => {
      signal.throwIfAborted();
      let info; try { info = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      current.set(relative(root, path), identity(info));
      if (info.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
    };
    for (const path of paths) walk(join(root, path));
    equalSnapshot(before, current);
  } };
}
export async function inventory(root: string, references: string[], signal: AbortSignal): Promise<MediaFile[]> {
  return (await verifiedInventory(root, references, signal)).files;
}
