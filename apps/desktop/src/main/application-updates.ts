import { randomUUID } from 'node:crypto';
import { open, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CancellationToken } from 'electron-updater';
import { ConfirmedNsisUpdater } from './update-installer.js';
import type { ApplicationUpdateStatus } from '@ecomgen/contracts';

type Info = { version: string; releaseDate?: string | null; releaseNotes?: string | Array<{ version: string; note: string | null }> | null };
type Progress = { percent: number; transferred: number; total: number; bytesPerSecond: number };
/** 更新库端口，测试可以注入不访问网络的实现。 */
export interface ApplicationUpdaterPort {
  autoDownload: boolean; autoInstallOnAppQuit: boolean; allowPrerelease: boolean; allowDowngrade: boolean;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: Info } | null>;
  downloadUpdate(token: CancellationToken): Promise<unknown>;
  quitAndInstall(silent: boolean, forceRunAfter: boolean): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'download-progress', listener: (progress: Progress) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'download-progress', listener: (progress: Progress) => void): unknown;
}
export interface ApplicationUpdateOptions {
  version: string; supported: boolean; unsupportedReason: string | null; userData: string;
  prepareInstall(): Promise<void>; recoverAfterInstallFailure(): Promise<void>;
  updater?: ApplicationUpdaterPort;
}
const releaseUrl = 'https://github.com/juccistar/pixelmuse-releases/releases' as const;
const checkError = '检查更新失败，请检查网络后重试。';
function publicCheckError(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown } | null;
  if (value?.code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || (value?.code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' && typeof value.message === 'string' && /\b404\b/.test(value.message))) return '发布仓库尚未提供可用的正式版本。';
  if (value?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return '新版本缺少更新信息文件，请等待发布者补齐。';
  return checkError;
}
const downloadError = '下载更新失败，请检查网络后重试。';
const installError = '启动安装失败，请重试。';
const recoveryError = '后台恢复失败，请重启应用';
const preferencesError = '保存更新设置失败，请重试。';
const preferenceName = 'application-update-preferences.json';

async function readAutoCheck(path: string): Promise<boolean> {
  try {
    const file = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(1025);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024) return true;
      const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      return typeof value === 'object' && value !== null && 'autoCheck' in value && typeof value.autoCheck === 'boolean' ? value.autoCheck : true;
    } finally { await file.close(); }
  } catch { return true; }
}
function text(value: unknown, max = 32768): string {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
}
function notes(value: Info['releaseNotes']): string {
  if (typeof value === 'string') return text(value);
  if (!Array.isArray(value)) return '';
  return text(value.slice(0, 100).map(item => `${text(item.version, 128)}\n${text(item.note)}`).join('\n\n'));
}
function nonnegative(value: number): number { return Number.isFinite(value) ? Math.max(0, value) : 0; }

/** 创建独立更新状态机；更新源和安装路径不由页面提供。 */
export async function createApplicationUpdateService(options: ApplicationUpdateOptions) {
  const path = join(options.userData, preferenceName);
  const updater: ApplicationUpdaterPort = options.updater ?? new ConfirmedNsisUpdater({ provider: 'github', owner: 'juccistar', repo: 'pixelmuse-releases', releaseType: 'release' });
  updater.autoDownload = false; updater.autoInstallOnAppQuit = false; updater.allowPrerelease = false; updater.allowDowngrade = false;
  let status: ApplicationUpdateStatus = {
    state: options.supported ? 'IDLE' : 'UNSUPPORTED', currentVersion: options.version,
    availableVersion: null, releaseNotes: '', releaseDate: null, checkedAt: null, error: null,
    supported: options.supported, unsupportedReason: options.unsupportedReason, autoCheck: await readAutoCheck(path), releaseUrl, progress: null,
  };
  let disposed = false;
  let started = false;
  let checkPromise: Promise<ApplicationUpdateStatus> | undefined;
  let downloadPromise: Promise<void> | undefined;
  let token: CancellationToken | undefined;
  let installPromise: Promise<ApplicationUpdateStatus> | undefined;
  let preferenceQueue: Promise<void> = Promise.resolve();
  let installEventError = false;
  let installerInvoked = false;
  let recovery: Promise<boolean> | undefined;
  let recoveryFailed = false;
  const recover = () => recovery ??= options.recoverAfterInstallFailure().then(() => true, () => {
    recoveryFailed = true;
    if (!disposed) status = { ...status, state: 'ERROR', error: recoveryError };
    return false;
  });
  const snapshot = (): ApplicationUpdateStatus => ({ ...status, progress: status.progress && { ...status.progress } });
  const onProgress = (progress: Progress) => {
    if (disposed || status.state !== 'DOWNLOADING' || !token || token.cancelled) return;
    status = { ...status, progress: { percent: Math.min(100, nonnegative(progress.percent)), transferred: nonnegative(progress.transferred), total: nonnegative(progress.total), bytesPerSecond: nonnegative(progress.bytesPerSecond) } };
  };
  const onError = () => {
    if (!disposed && installerInvoked && status.state === 'INSTALLING') {
      installEventError = true;
      status = { ...status, state: 'ERROR', error: installError };
      void recover();
    }
    // 检查和下载的 Promise 负责终态，事件可能来自已取消的旧请求。
  };
  updater.on('download-progress', onProgress);
  updater.on('error', onError);
  const service = {
    getStatus: snapshot,
    check(): Promise<ApplicationUpdateStatus> {
      if (checkPromise) return checkPromise;
      if (disposed || recoveryFailed || !options.supported || downloadPromise || installPromise || status.state === 'DOWNLOADED') return Promise.resolve(snapshot());
      status = { ...status, state: 'CHECKING', error: null, progress: null, availableVersion: null, releaseNotes: '', releaseDate: null };
      checkPromise = (async () => {
        try {
          const result = await updater.checkForUpdates();
          if (!disposed) {
            if (!result || !result.updateInfo || typeof result.updateInfo.version !== 'string' || !result.updateInfo.version) throw new Error('no result');
            const info = result.updateInfo;
            status = { ...status, state: result.isUpdateAvailable ? 'AVAILABLE' : 'NOT_AVAILABLE', availableVersion: result.isUpdateAvailable ? text(info.version, 128) : null, releaseNotes: result.isUpdateAvailable ? notes(info.releaseNotes) : '', releaseDate: result.isUpdateAvailable && typeof info.releaseDate === 'string' ? text(info.releaseDate, 128) : null, checkedAt: new Date().toISOString(), error: null };
          }
        } catch (error) {
          if (!disposed) status = { ...status, state: 'ERROR', error: publicCheckError(error), checkedAt: new Date().toISOString() };
        }
        return snapshot();
      })().finally(() => { checkPromise = undefined; });
      return checkPromise;
    },
    download(): ApplicationUpdateStatus {
      if (disposed || recoveryFailed || !options.supported || downloadPromise || checkPromise || !(status.state === 'AVAILABLE' || (status.state === 'ERROR' && status.availableVersion))) return snapshot();
      const current = new CancellationToken(); token = current;
      status = { ...status, state: 'DOWNLOADING', progress: null, error: null };
      downloadPromise = Promise.resolve().then(() => updater.downloadUpdate(current)).then(() => {
        if (!disposed && token === current && !current.cancelled && status.state === 'DOWNLOADING') status = { ...status, state: 'DOWNLOADED', progress: null };
      }, () => {
        if (!disposed && token === current && !current.cancelled) status = { ...status, state: 'ERROR', error: downloadError, progress: null };
      }).finally(() => { if (token === current) token = undefined; downloadPromise = undefined; });
      return snapshot();
    },
    cancel(): ApplicationUpdateStatus {
      if (!disposed && status.state === 'DOWNLOADING' && token) {
        token.cancel(); token = undefined;
        status = { ...status, state: 'AVAILABLE', progress: null, error: null };
      }
      return snapshot();
    },
    install(): Promise<ApplicationUpdateStatus> {
      if (installPromise) return installPromise;
      if (disposed || status.state !== 'DOWNLOADED') return Promise.resolve(snapshot());
      status = { ...status, state: 'INSTALLING', error: null };
      recovery = undefined; installerInvoked = false;
      installPromise = (async () => {
        try {
          await options.prepareInstall();
          if (disposed) { await recover(); return snapshot(); }
          installEventError = false;
          installerInvoked = true;
          updater.quitAndInstall(false, true);
          if (installEventError) throw new Error('installer failed');
        } catch (error) {
          // prepareInstall 可能已经部分关闭后台，因此失败时也尝试恢复。
          const recovered = await recover();
          const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
          const busy = !installerInvoked && ['UPDATE_BUSY', 'UPDATE_INSTALL_BUSY', 'WORKSPACE_BUSY', 'UPDATE_MAINTENANCE'].includes(String(code));
          if (!disposed) status = { ...status, state: recovered && busy ? 'DOWNLOADED' : 'ERROR', error: !recovered ? recoveryError : busy ? '后台仍有任务或工作空间操作，请完成后再安装更新。' : installError };
        }
        return snapshot();
      })().finally(() => { installPromise = undefined; });
      return installPromise;
    },
    setAutoCheck(autoCheck: boolean): Promise<ApplicationUpdateStatus> {
      const operation = preferenceQueue.then(async () => {
        if (disposed || typeof autoCheck !== 'boolean') return;
        const temporary = join(options.userData, `.${preferenceName}.${randomUUID()}.tmp`);
        try {
          await mkdir(options.userData, { recursive: true });
          await writeFile(temporary, JSON.stringify({ autoCheck }), { flag: 'wx', mode: 0o600 });
          await rename(temporary, path);
          if (!disposed) status = { ...status, autoCheck, error: status.error === preferencesError ? null : status.error };
        } catch {
          await unlink(temporary).catch(() => undefined);
          if (!disposed) status = { ...status, error: preferencesError };
        }
      });
      preferenceQueue = operation.catch(() => undefined);
      return operation.then(snapshot);
    },
    startAutoCheck(): void {
      if (started || disposed) return;
      started = true;
      if (options.supported && status.autoCheck) void service.check();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true; token?.cancel(); token = undefined;
      // 更新库可能在取消后异步发出 error，保留监听器以避免未处理异常。
      updater.removeListener('download-progress', onProgress);
    },
  };
  return service;
}
