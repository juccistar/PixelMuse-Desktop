import { spawn, type StdioOptions } from 'node:child_process';
import { app, autoUpdater } from 'electron';
import { NsisUpdater } from 'electron-updater';

/** 只在安装器进程确认启动后退出，仍由更新库决定安装文件和参数。 */
export class ConfirmedNsisUpdater extends NsisUpdater {
  override quitAndInstall(isSilent = false, isForceRunAfter = false): void {
    if (!this.install(isSilent, isSilent ? isForceRunAfter : this.autoRunAppAfterInstall)) this.quitAndInstallCalled = false;
  }

  protected override spawnLog(cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv, stdio: StdioOptions = 'ignore'): Promise<boolean> {
    return new Promise((resolve, reject) => {
      try {
        const child = spawn(cmd, args, { stdio, env, detached: true });
        child.once('error', error => {
          // 库对 ENOENT 的 shell.openPath 回退无法确认启动，因此按失败处理。
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') (error as NodeJS.ErrnoException).code = 'INSTALLER_NOT_FOUND';
          this.quitAndInstallCalled = false;
          reject(error);
        });
        child.once('spawn', () => {
          child.unref();
          resolve(true);
          setImmediate(() => { autoUpdater.emit('before-quit-for-update'); app.quit(); });
        });
      } catch (error) {
        if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') (error as NodeJS.ErrnoException).code = 'INSTALLER_NOT_FOUND';
        this.quitAndInstallCalled = false;
        reject(error);
      }
    });
  }
}
