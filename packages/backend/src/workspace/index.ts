import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { WorkspaceStatus } from '@ecomgen/contracts';
import { BackendError } from '../validation.js';
import { digestFile, inventory, verifiedInventory } from './files.js';
import { invalidWorkspace, nested, safeDirectory } from './paths.js';
import { acquireMediaOwner, type MediaOwnerRelease } from './owner.js';
export { acquireMediaOwner } from './owner.js';

const markerName = '.pixelmuse-workspace.json';
const configName = 'workspace-config.json';
const journalName = 'workspace-migration.json';
const busy = () => new BackendError('WORKSPACE_BUSY', '后台仍有任务或操作，请等待完成后再切换工作空间。');
const migrationError = '工作空间迁移未完成。原素材已保留，请检查目录权限、可用空间和设备连接后重试。';
interface Configuration { version: 1; directory: string; owner: string }
interface Marker { version: 1; owner: string; migration: string; complete: boolean }
export interface WorkspaceHooks {
  enter(): Promise<void>;
  leave(): void;
  references(): string[];
  unavailable?(): void;
}
async function json(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) throw invalidWorkspace();
  return JSON.parse(await readFile(path, 'utf8'));
}
function syncJson(path: string): Record<string, unknown> {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) throw invalidWorkspace();
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}
async function optionalJson(path: string): Promise<unknown> {
  try { return await json(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
/** 写入并 fsync 临时文件后原子替换；配置在复制验证之前绝不指向目标。 */
async function atomicJson(path: string, value: unknown, beforePublish?: () => void): Promise<void> {
  await safeDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    beforePublish?.();
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
/** 媒体根状态机；数据库、密钥和日志始终留在原 userData。 */
export class MediaWorkspace {
  private owner = '';
  private root: string;
  private available = false;
  private releaseSource?: MediaOwnerRelease;
  private releaseTarget?: () => Promise<void>;
  private statusValue: WorkspaceStatus;
  private controller?: AbortController;
  private running?: Promise<void>;
  private committing = false;
  private closed = false;
  private selecting = false;
  private selection?: Promise<WorkspaceStatus>;
  private hooks?: WorkspaceHooks;
  constructor(private readonly dataDir: string) {
    this.root = dataDir;
    this.statusValue = { directory: dataDir, configured: false, state: 'READY', copiedFiles: 0, totalFiles: 0, copiedBytes: 0, totalBytes: 0 };
  }
  get directory(): string { return this.root; }
  get usable(): boolean { return this.available; }
  get committed(): boolean { return this.statusValue.state === 'RESTARTING'; }
  status(): WorkspaceStatus {
    if (this.available && !this.running && !this.committed) { try { this.assertStorageRoot(); } catch { /* 状态查询交付明确的恢复信息。 */ } }
    return { ...this.statusValue };
  }
  /** 每次存储寻址都核验目录身份，防止运行中目录断开后 mkdir 创建空白替身。 */
  assertStorageRoot(): void {
    try {
      if (!this.available || this.closed) throw invalidWorkspace();
      const rootInfo = lstatSync(this.root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || realpathSync.native(this.root).toLowerCase() !== this.root.toLowerCase()) throw invalidWorkspace();
      if (!this.releaseSource) throw invalidWorkspace();
      this.releaseSource.assert();
      if (this.root.toLowerCase() === this.dataDir.toLowerCase() && syncJson(join(this.root, 'workspace-owner.json')).owner !== this.owner) throw invalidWorkspace();
      if (this.root.toLowerCase() !== this.dataDir.toLowerCase()) {
        const marker = syncJson(join(this.root, markerName));
        if (marker.version !== 1 || marker.owner !== this.owner || marker.complete !== true) throw invalidWorkspace();
      }
    } catch {
      this.available = false;
      if (!this.running) this.statusValue.state = 'FAILED';
      this.statusValue.error = '已选择的工作空间不可用。请连接原设备或重新选择原工作空间。';
      this.hooks?.unavailable?.();
      throw new BackendError('WORKSPACE_UNAVAILABLE', '已选择的工作空间不可用，请先重新连接原目录。');
    }
  }
  attach(hooks: WorkspaceHooks): void { this.hooks = hooks; }
  async initialize(): Promise<void> {
    await safeDirectory(this.dataDir);
    const ownerPath = join(this.dataDir, 'workspace-owner.json');
    const stored = await optionalJson(ownerPath) as { owner?: unknown } | undefined;
    if (!stored) { this.owner = randomUUID(); await atomicJson(ownerPath, { version: 1, owner: this.owner }); }
    else if (typeof stored.owner === 'string' && /^[a-f0-9-]{36}$/.test(stored.owner)) this.owner = stored.owner;
    else throw invalidWorkspace();
    const config = await optionalJson(join(this.dataDir, configName)) as Configuration | undefined;
    if (config) {
      if (config.version !== 1 || config.owner !== this.owner || typeof config.directory !== 'string') throw invalidWorkspace();
      this.root = resolve(config.directory); this.statusValue.directory = this.root; this.statusValue.configured = true;
      try {
        await this.validateOwnedRoot(this.root);
        this.releaseSource = await acquireMediaOwner(this.root); this.available = true;
      } catch {
        // 已配置目录缺失/被占用时保留配置，允许 UI 重新连接；不创建空目录或回退旧副本。
        this.statusValue.state = 'FAILED'; this.statusValue.error = '已选择的工作空间不可用。请连接原设备或重新选择原工作空间。';
      }
    } else { this.releaseSource = await acquireMediaOwner(this.root); this.available = true; }
    const interrupted = await optionalJson(join(this.dataDir, journalName)) as { state?: string; migration?: string; source?: string; staging?: string; target?: string } | undefined;
    if (interrupted && !['COMMITTED', 'CANCELLED', 'FAILED'].includes(interrupted.state ?? '') && this.available) {
      if (config && interrupted.target && resolve(interrupted.target).toLowerCase() === this.root.toLowerCase()) {
        // 配置提交与日志更新之间崩溃时，以已经验证身份的活动配置为准。
        await atomicJson(join(this.dataDir, journalName), { ...interrupted, state: 'COMMITTED' });
      } else {
        await this.recoverAbandoned(interrupted);
        this.statusValue.state = 'FAILED'; this.statusValue.error = '上次迁移被中断，原素材已保留，可重新选择空目录迁移。';
      }
    }
  }
  private async recoverAbandoned(journal: { migration?: string; source?: string; staging?: string; target?: string }): Promise<void> {
    if (!journal.migration || !/^[a-f0-9-]{36}$/.test(journal.migration) || !journal.staging || !journal.target || journal.source?.toLowerCase() !== this.root.toLowerCase()) return;
    const staging = resolve(journal.staging), target = resolve(journal.target);
    if (basename(staging) !== `.pixelmuse-migration-${journal.migration}` || target !== join(dirname(staging), 'PixelMuse')) return;
    for (const path of [staging, target]) {
      if ([this.root, this.dataDir, dirname(this.dataDir)].some(root => path.toLowerCase() === root.toLowerCase() || nested(root, path) || nested(path, root))) continue;
      try {
        // 尚未发布的最终路径也可能留下死 claim；先回收/取得命名空间，再检查实际目录。
        const release = await acquireMediaOwner(path, { allowMissing: true });
        try {
          await safeDirectory(path);
          const marker = await json(join(path, markerName)) as Marker;
          if (marker.owner !== this.owner || marker.migration !== journal.migration) continue;
          release.assert();
          await rm(path, { recursive: true });
        } finally { await release(); }
      } catch { /* 活动 owner、外部替换或未知目录均保留，不推断为可删除的临时文件。 */ }
    }
  }
  private async validateOwnedRoot(root: string): Promise<void> {
    await safeDirectory(root);
    if (nested(this.dataDir, root) || nested(root, this.dataDir) || root.toLowerCase() === this.dataDir.toLowerCase()) throw invalidWorkspace();
    const marker = await json(join(root, markerName)) as Marker;
    if (marker.version !== 1 || marker.owner !== this.owner || marker.complete !== true) throw invalidWorkspace();
  }
  async choose(selected: string): Promise<WorkspaceStatus> {
    if (this.closed || this.selecting || this.running || this.committing || this.committed) throw busy();
    this.status();
    this.selecting = true;
    this.selection = this.chooseDirectory(selected);
    try { return await this.selection; } finally { this.selecting = false; this.selection = undefined; }
  }
  private async chooseDirectory(selected: string): Promise<WorkspaceStatus> {
    const parent = await safeDirectory(selected);
    if (this.closed) throw busy();
    // 原设备重新挂载后显式重连，只允许同一持久身份和同一路径。
    if (!this.available) {
      if (parent.toLowerCase() !== this.root.toLowerCase()) throw new BackendError('WORKSPACE_UNAVAILABLE', '请先重新连接并选择原工作空间，避免从过期副本继续创作。');
      if (this.root.toLowerCase() === this.dataDir.toLowerCase()) {
        const identity = await json(join(parent, 'workspace-owner.json')) as { version?: unknown; owner?: unknown };
        if (identity.version !== 1 || identity.owner !== this.owner) throw invalidWorkspace();
      } else await this.validateOwnedRoot(parent);
      await this.releaseSource?.(); this.releaseSource = undefined;
      this.releaseSource = await acquireMediaOwner(parent);
      this.available = true; this.statusValue = { ...this.statusValue, state: 'RESTARTING', error: undefined };
      return this.status();
    }
    const target = join(parent, 'PixelMuse');
    for (const protectedRoot of [this.root, this.dataDir, dirname(this.dataDir)]) {
      if (target.toLowerCase() === protectedRoot.toLowerCase() || nested(protectedRoot, target) || nested(target, protectedRoot)) throw invalidWorkspace();
    }
    try { await lstat(target); throw invalidWorkspace(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (this.closed || !this.hooks) throw busy();
    // enter 在任何 await 前关闭业务入口与队列认领，等待此前已接受的操作。
    this.controller = new AbortController();
    this.statusValue = { ...this.statusValue, state: 'COPYING', error: undefined, copiedFiles: 0, totalFiles: 0, copiedBytes: 0, totalBytes: 0 };
    const run = this.migrate(parent, target, this.controller.signal);
    this.running = run;
    void run.finally(() => { this.running = undefined; this.controller = undefined; }).catch(() => undefined);
    return this.status();
  }
  private async migrate(parent: string, target: string, signal: AbortSignal): Promise<void> {
    const id = randomUUID(), staging = join(parent, `.pixelmuse-migration-${id}`);
    let made = false, published = false, committed = false, entered = false;
    let unlock: MediaOwnerRelease | undefined, unlockTarget: MediaOwnerRelease | undefined;
    const journal = (state: string) => atomicJson(join(this.dataDir, journalName), { version: 1, migration: id, state, source: this.root, staging, target });
    try {
      await this.hooks!.enter(); entered = true; signal.throwIfAborted();
      unlockTarget = await acquireMediaOwner(target, { allowMissing: true });
      await journal('COPYING');
      const files = await inventory(this.root, this.hooks!.references(), signal);
      this.statusValue.totalFiles = files.length; this.statusValue.totalBytes = files.reduce((total, file) => total + file.size, 0);
      await safeDirectory(parent);
      unlock = await acquireMediaOwner(staging, { allowMissing: true });
      await mkdir(staging); made = true;
      await atomicJson(join(staging, markerName), { version: 1, owner: this.owner, migration: id, complete: false });
      for (const file of files) {
        signal.throwIfAborted();
        const source = join(this.root, file.relativePath), destination = join(staging, file.relativePath);
        // 复制前重新核验源路径；流复制使用独占目标，禁止覆盖。
        const current = await digestFile(this.root, source, signal);
        if (current.hash !== file.hash || current.size !== file.size) throw invalidWorkspace();
        await mkdir(dirname(destination), { recursive: true }); await safeDirectory(dirname(destination));
        const sourceInfo = await lstat(source), input = await open(source, 'r');
        try {
          const opened = await input.stat();
          if (sourceInfo.isSymbolicLink() || opened.nlink !== 1 || sourceInfo.ino !== opened.ino || sourceInfo.dev !== opened.dev) throw invalidWorkspace();
          const output = await open(destination, 'wx', 0o600);
          try {
            for await (const chunk of input.createReadStream({ autoClose: false, signal })) { await output.writeFile(chunk); this.statusValue.copiedBytes += chunk.length; }
            await output.sync();
          } finally { await output.close(); }
        } finally { await input.close(); }
        this.statusValue.copiedFiles++;
      }
      this.statusValue.state = 'VERIFYING'; await journal('VERIFYING');
      for (const file of files) {
        const copied = await digestFile(staging, join(staging, file.relativePath), signal);
        if (copied.size !== file.size || copied.hash !== file.hash) throw invalidWorkspace();
      }
      signal.throwIfAborted();
      await atomicJson(join(staging, markerName), { version: 1, owner: this.owner, migration: id, complete: true });
      await safeDirectory(parent);
      try { await lstat(target); throw invalidWorkspace(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rename(staging, target); published = true;
      // 两侧并行 hash，避免先检查的一侧等待另一侧完整清点期间失去复核。
      this.assertStorageRoot();
      const references = this.hooks!.references();
      const snapshots = await Promise.allSettled([
        verifiedInventory(this.root, references, signal), verifiedInventory(target, references, signal),
      ]);
      const [sourceSnapshot, targetSnapshot] = snapshots.map(result => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      }) as [Awaited<ReturnType<typeof verifiedInventory>>, Awaited<ReturnType<typeof verifiedInventory>>];
      for (const snapshot of [sourceSnapshot, targetSnapshot]) {
        if (snapshot.files.length !== files.length || snapshot.files.some((file, index) => {
          const original = files[index]!;
          return file.relativePath !== original.relativePath || file.size !== original.size || file.hash !== original.hash;
        })) throw invalidWorkspace();
      }
      signal.throwIfAborted();
      // 临时配置已写入/fsync 后，紧接 rename 前只读两侧元数据，检测 hash 结束后的变化。
      // 仍有文件系统调用间的窄竞态；这里不提供 OS 快照或阻止任意外部写入的承诺。
      this.committing = true;
      await atomicJson(join(this.dataDir, configName), { version: 1, directory: target, owner: this.owner }, () => {
        sourceSnapshot.assertUnchanged(); targetSnapshot.assertUnchanged();
        this.assertStorageRoot(); unlockTarget!.assert();
        const marker = syncJson(join(target, markerName));
        if (marker.version !== 1 || marker.owner !== this.owner || marker.migration !== id || marker.complete !== true) throw invalidWorkspace();
      }); committed = true;
      this.releaseTarget = unlockTarget; unlockTarget = undefined;
      this.statusValue = { ...this.statusValue, directory: target, configured: true, state: 'RESTARTING', error: undefined };
      try { await journal('COMMITTED'); } catch { /* 原子配置已提交，不能回滚或删除新根。 */ }
    } catch {
      this.statusValue.error = signal.aborted ? undefined : migrationError;
      try { await journal(signal.aborted ? 'CANCELLED' : 'FAILED'); } catch { /* 原根和活动配置未变。 */ }
    } finally {
      this.committing = false;
      if (!committed) {
        const path = published ? target : staging;
        if (made) {
          try {
            await safeDirectory(path);
            const marker = await json(join(path, markerName)) as Marker;
            const owner = published ? unlockTarget : unlock;
            if (marker.owner === this.owner && marker.migration === id && owner) {
              owner.assert();
              await rm(path, { recursive: true });
            }
          } catch { /* 只清理由本轮身份标记的目录，未知内容保留供恢复。 */ }
        }
        try { await unlockTarget?.(); } catch { /* 删除完成后才释放最终路径。 */ }
        if (entered) this.hooks!.leave();
      }
      try { await unlock?.(); } catch { /* 暂存路径的占用独立于最终路径，完成后释放。 */ }
      if (!committed) this.statusValue.state = signal.aborted ? 'READY' : 'FAILED';
    }
  }
  async cancel(): Promise<WorkspaceStatus> {
    if (this.committing || this.committed) return this.status();
    this.controller?.abort(); await this.running; return this.status();
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.selection?.catch(() => undefined);
    if (!this.committing && !this.committed) this.controller?.abort();
    await this.running;
    await this.releaseTarget?.(); await this.releaseSource?.();
  }
}
