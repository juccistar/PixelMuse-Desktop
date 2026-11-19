import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CancellationToken } from 'electron-updater';
import { createApplicationUpdateService, type ApplicationUpdaterPort } from './application-updates.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class FakeUpdater extends EventEmitter {
  autoDownload = true; autoInstallOnAppQuit = true; allowPrerelease = true; allowDowngrade = true;
  checkForUpdates = vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.4.8', releaseDate: '2026-11-09', releaseNotes: '<b>更新</b>' } }));
  downloadUpdate = vi.fn((_token: CancellationToken): Promise<unknown> => Promise.resolve([]));
  quitAndInstall = vi.fn((_silent: boolean, _force: boolean) => undefined);
}
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture(supported = true) {
  const userData = await mkdtemp(join(tmpdir(), 'pixelmuse-update-')); directories.push(userData);
  const updater = new FakeUpdater();
  const prepareInstall = vi.fn(async (): Promise<void> => undefined);
  const recoverAfterInstallFailure = vi.fn(async (): Promise<void> => undefined);
  const service = await createApplicationUpdateService({ version: '0.4.7', supported, unsupportedReason: supported ? null : '仅支持安装版', userData, updater: updater as ApplicationUpdaterPort, prepareInstall, recoverAfterInstallFailure });
  return { service, updater, userData, prepareInstall, recoverAfterInstallFailure };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('应用更新服务', () => {
  it('固定策略，合并检查并限制公开信息', async () => {
    const { service, updater } = await fixture();
    const pending = deferred<Awaited<ReturnType<typeof updater.checkForUpdates>>>();
    updater.checkForUpdates.mockReturnValueOnce(pending.promise);
    const first = service.check(); const second = service.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect([updater.autoDownload, updater.autoInstallOnAppQuit, updater.allowPrerelease, updater.allowDowngrade]).toEqual([false, false, false, false]);
    pending.resolve({ isUpdateAvailable: true, updateInfo: { version: '0.4.8', releaseDate: '', releaseNotes: `<b>更新</b>${'x'.repeat(40000)}` } });
    expect((await first).state).toBe('AVAILABLE');
    expect((await second).releaseNotes).toHaveLength(32768);
    expect(service.getStatus().releaseNotes).not.toContain('<b>');
    expect(service.getStatus().releaseUrl).toBe('https://github.com/juccistar/pixelmuse-releases/releases');
  });
  it('没有发布或网络出错时不报告最新版，也不暴露原始错误', async () => {
    const { service, updater } = await fixture();
    updater.checkForUpdates.mockRejectedValueOnce(new Error('secret C:/private'));
    const result = await service.check();
    expect(result.state).toBe('ERROR'); expect(result.error).toContain('检查网络');
    expect(JSON.stringify(result)).not.toContain('secret');
    updater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: false, updateInfo: { version: '0.4.7', releaseDate: '', releaseNotes: '' } });
    expect((await service.check()).state).toBe('NOT_AVAILABLE');
  });
  it.each([
    ['ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'no versions', '尚未提供'],
    ['ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'GitHub 404: private details', '尚未提供'],
    ['ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'network timeout: private details', '检查网络'],
    ['ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'private URL', '缺少更新信息'],
  ])('区分发布缺失与网络故障（%s）', async (code, message, expected) => {
    const { service, updater } = await fixture();
    updater.checkForUpdates.mockRejectedValueOnce(Object.assign(new Error(message), { code }));
    const result = await service.check();
    expect(result.state).toBe('ERROR'); expect(result.error).toContain(expected);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('后台繁忙保留已下载包，用户重试安装无需重新下载', async () => {
    const { service, updater, prepareInstall } = await fixture();
    await service.check(); service.download(); await flush();
    prepareInstall.mockRejectedValueOnce(Object.assign(new Error('private queue details'), { code: 'UPDATE_BUSY' }));
    const busy = await service.install();
    expect(busy.state).toBe('DOWNLOADED'); expect(busy.error).toContain('后台仍有任务');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect((await service.install()).state).toBe('INSTALLING');
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
  it('取消后忽略迟到的进度和下载完成，下载未结束前不重复启动', async () => {
    const { service, updater } = await fixture();
    const pending = deferred<unknown>(); updater.downloadUpdate.mockReturnValueOnce(pending.promise);
    await service.check(); service.download(); service.download(); await flush();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    const token = updater.downloadUpdate.mock.calls[0]![0];
    updater.emit('download-progress', { percent: 200, transferred: -1, total: 5, bytesPerSecond: 1 });
    expect(service.getStatus().progress?.percent).toBe(100);
    service.cancel(); expect(token.cancelled).toBe(true);
    updater.emit('update-downloaded', {}); updater.emit('download-progress', { percent: 100, transferred: 5, total: 5, bytesPerSecond: 1 });
    service.download(); expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    pending.resolve([]); await flush();
    expect(service.getStatus().state).toBe('AVAILABLE');
    service.download(); await flush(); expect(service.getStatus().state).toBe('DOWNLOADED');
  });
  it('下载失败后允许直接重试，完成前不能安装', async () => {
    const { service, updater } = await fixture();
    updater.downloadUpdate.mockRejectedValueOnce(new Error('private download URL'));
    await service.check(); service.download(); await flush();
    expect(service.getStatus().state).toBe('ERROR');
    await service.install(); expect(updater.quitAndInstall).not.toHaveBeenCalled();
    service.download(); await flush();
    expect(service.getStatus().state).toBe('DOWNLOADED');
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
  });
  it('安装先等待后台准备，错误时恢复，绝不在普通退出时自动安装', async () => {
    const { service, updater, prepareInstall, recoverAfterInstallFailure } = await fixture();
    await service.check(); service.download(); await flush();
    const preparing = deferred<void>(); prepareInstall.mockReturnValueOnce(preparing.promise);
    const first = service.install(); const second = service.install();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    preparing.resolve(); await first; await second;
    expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
    updater.emit('error', new Error('spawn failed')); await flush();
    expect(service.getStatus().state).toBe('ERROR');
    expect(recoverAfterInstallFailure).toHaveBeenCalledTimes(1);
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });
  it('准备失败时恢复后台并阻止安装', async () => {
    const { service, updater, prepareInstall, recoverAfterInstallFailure } = await fixture();
    await service.check(); service.download(); await flush();
    prepareInstall.mockRejectedValueOnce(new Error('private'));
    expect((await service.install()).state).toBe('ERROR');
    expect(recoverAfterInstallFailure).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
  it('后台恢复失败时保持错误并阻止继续检查和下载', async () => {
    const { service, updater, prepareInstall, recoverAfterInstallFailure } = await fixture();
    await service.check(); service.download(); await flush();
    prepareInstall.mockRejectedValueOnce(new Error('prepare failed'));
    recoverAfterInstallFailure.mockRejectedValueOnce(new Error('private recovery details'));
    const result = await service.install();
    expect(result.error).toBe('后台恢复失败，请重启应用');
    await service.check(); service.download();
    expect(service.getStatus().error).toBe('后台恢复失败，请重启应用');
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });
  it('异步安装错误后的后台恢复失败会明确显示', async () => {
    const { service, updater, recoverAfterInstallFailure } = await fixture();
    await service.check(); service.download(); await flush(); await service.install();
    recoverAfterInstallFailure.mockRejectedValueOnce(new Error('private'));
    updater.emit('error', new Error('spawn failed')); await flush();
    expect(service.getStatus().error).toBe('后台恢复失败，请重启应用');
  });
  it('偏好持久化且限制文件大小，不支持时不自动检查', async () => {
    const { service, updater, userData } = await fixture(false);
    service.startAutoCheck(); service.startAutoCheck();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await service.setAutoCheck(false);
    expect(JSON.parse(await readFile(join(userData, 'application-update-preferences.json'), 'utf8'))).toEqual({ autoCheck: false });
    const next = await createApplicationUpdateService({ version: '1', supported: true, unsupportedReason: null, userData, updater: updater as ApplicationUpdaterPort, prepareInstall: async () => undefined, recoverAfterInstallFailure: async () => undefined });
    expect(next.getStatus().autoCheck).toBe(false); next.startAutoCheck();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await writeFile(join(userData, 'application-update-preferences.json'), 'x'.repeat(1025));
    const invalid = await createApplicationUpdateService({ version: '1', supported: true, unsupportedReason: null, userData, updater: updater as ApplicationUpdaterPort, prepareInstall: async () => undefined, recoverAfterInstallFailure: async () => undefined });
    expect(invalid.getStatus().autoCheck).toBe(true);
  });
});
