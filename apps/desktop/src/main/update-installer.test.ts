import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), quit: vi.fn(), emit: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('electron', () => ({ app: { quit: mocks.quit }, autoUpdater: { emit: mocks.emit } }));
import { ConfirmedNsisUpdater } from './update-installer.js';

const adapter = {
  version: '0.4.7', name: 'PixelMuse', isPackaged: true, appUpdateConfigPath: '', userDataPath: '', baseCachePath: '',
  whenReady: async () => undefined, relaunch: () => undefined, quit: () => undefined, onQuit: () => undefined,
};
class TestUpdater extends ConfirmedNsisUpdater {
  launch(): Promise<boolean> { return this.spawnLog('installer.exe', ['--updated']); }
}
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

describe('安装器启动确认', () => {
  it('异步启动失败不退出应用', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mocks.spawn.mockReturnValueOnce(child);
    const updater = new TestUpdater(null, adapter);
    let result!: Promise<boolean>;
    vi.spyOn(updater, 'install').mockImplementation(() => { result = updater.launch(); return true; });
    updater.quitAndInstall(false, true);
    child.emit('error', Object.assign(new Error('failed'), { code: 'ENOENT' }));
    await expect(result).rejects.toMatchObject({ code: 'INSTALLER_NOT_FOUND' });
    expect(mocks.quit).not.toHaveBeenCalled();
  });
  it('同步启动失败也不进入无法确认的 shell 回退', async () => {
    mocks.spawn.mockImplementationOnce(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    const updater = new TestUpdater(null, adapter);
    await expect(updater.launch()).rejects.toMatchObject({ code: 'INSTALLER_NOT_FOUND' });
    expect(mocks.quit).not.toHaveBeenCalled();
  });
  it('只在收到 spawn 后安排退出', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mocks.spawn.mockReturnValueOnce(child);
    const updater = new TestUpdater(null, adapter);
    let result!: Promise<boolean>;
    vi.spyOn(updater, 'install').mockImplementation(() => { result = updater.launch(); return true; });
    updater.quitAndInstall(false, true);
    vi.runAllTimers();
    expect(mocks.quit).not.toHaveBeenCalled();
    child.emit('spawn');
    await expect(result).resolves.toBe(true);
    expect(mocks.quit).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(mocks.quit).toHaveBeenCalledOnce();
    expect(mocks.emit).toHaveBeenCalledWith('before-quit-for-update');
  });
});
