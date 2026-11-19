import { createHash, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { lstat, open, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { BackendError } from '../validation.js';
import { invalidWorkspace, safeDirectory } from './paths.js';

const legacyClaimPattern = /^\.pixelmuse-storage-([1-9]\d*)-([a-f0-9-]{36})\.claim$/;
const inUse = () => new BackendError('WORKSPACE_IN_USE', '素材工作空间已被其他后台使用。');
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
/** 固定保护一个路径命名空间；目录删除或移动不会移动/删除占用记录。 */
export interface MediaOwnerRelease {
  (): Promise<void>;
  assert(): void;
}
/**
 * 在父目录发布按规范路径分组的唯一空 claim；递归删除媒体根时仍保有该路径所有权。
 * 两个申请者先发布再扫描，至少一方能看到另一方；允许双方安全拒绝，不允许双 owner。
 * 死 claim 只按永不复用的随机文件名清理；allowMissing 用于在发布迁移目录前预占最终路径。
 */
export async function acquireMediaOwner(root: string, options: { allowMissing?: boolean } = {}): Promise<MediaOwnerRelease> {
  root = resolve(root);
  const parent = await safeDirectory(dirname(root));
  const checkRoot = async (): Promise<boolean> => {
    try { await safeDirectory(root); return true; }
    catch (error) { if (options.allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  await checkRoot();
  const key = createHash('sha256').update(root.toLowerCase()).digest('hex');
  const prefix = `.pixelmuse-storage-${key}-`;
  const pattern = new RegExp(`^${prefix.replaceAll('.', '\\.')}([1-9]\\d*)-([a-f0-9-]{36})\\.claim$`);
  const name = `${prefix}${process.pid}-${randomUUID()}.claim`, path = join(parent, name);
  const file = await open(path, 'wx', 0o600);
  try { try { await file.sync(); } finally { await file.close(); } }
  catch (error) { await rm(path, { force: true }); throw error; }
  try {
    const scan = async (directory: string, matcher: RegExp): Promise<void> => {
      for (const other of await readdir(directory)) {
        const match = matcher.exec(other);
        if (!match || (directory === parent && other === name)) continue;
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || alive(pid)) throw inUse();
        await rm(join(directory, other), { force: true });
      }
    };
    await scan(parent, pattern);
    if (await checkRoot()) {
      // 只兼容旧版活动记录，不再将目录内记录当作本协议的权威所有权。
      await scan(root, legacyClaimPattern);
      const legacyPath = join(root, '.pixelmuse-storage.lock');
      try {
        const info = await lstat(legacyPath);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) throw invalidWorkspace();
        let legacy: { pid?: unknown } | undefined;
        try { legacy = JSON.parse(await readFile(legacyPath, 'utf8')) as typeof legacy; }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        if (Number.isSafeInteger(legacy?.pid) && Number(legacy?.pid) > 0 && alive(Number(legacy?.pid))) throw inUse();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    let released = false;
    const release: MediaOwnerRelease = Object.assign(async () => {
      if (released) return;
      await rm(path, { force: true });
      released = true;
    }, { assert: (): void => {
      if (released) throw invalidWorkspace();
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 0) throw invalidWorkspace();
    } });
    return release;
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}
