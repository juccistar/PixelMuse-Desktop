import { describe, expect, it, vi } from 'vitest';
import { ApplicationPreferences } from './application-preferences.js';

function fixture() {
  const state = { settings: { interfaceScale: 1, taskNotifications: false }, job: { id: 'job-1', status: 'RUNNING' }, supported: true };
  const dependencies = {
    readSettings: vi.fn(async () => ({ ...state.settings })),
    readJob: vi.fn(async () => ({ ...state.job })),
    applyScale: vi.fn(), notificationsSupported: () => state.supported, notify: vi.fn(),
  };
  return { state, dependencies, preferences: new ApplicationPreferences(dependencies) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
describe('application 原生设置行为', () => {
  it('启动、设置变更、文档加载和重连均用后台缩放，重启后可重置为 1', async () => {
    const f = fixture(); f.state.settings.interfaceScale = 1.3;
    await f.preferences.refresh(); expect(f.dependencies.applyScale).toHaveBeenLastCalledWith(1.3);
    f.preferences.applyCurrentScale(); expect(f.dependencies.applyScale).toHaveBeenLastCalledWith(1.3);
    f.preferences.disconnected(); f.state.settings.interfaceScale = 1;
    await f.preferences.refresh(); expect(f.dependencies.applyScale).toHaveBeenLastCalledWith(1);
    const restarted = new ApplicationPreferences(f.dependencies); await restarted.refresh();
    expect(f.dependencies.applyScale).toHaveBeenLastCalledWith(1);
  });
  it('缺失媒体时查询失败保留缩放，首次不可用不伪造设置', async () => {
    const f = fixture(); f.state.settings.interfaceScale = 1.2; await f.preferences.refresh();
    f.dependencies.readSettings.mockRejectedValue(new Error('workspace unavailable'));
    await f.preferences.refresh(); f.preferences.applyCurrentScale(); expect(f.dependencies.applyScale).toHaveBeenLastCalledWith(1.2);
    f.dependencies.applyScale.mockClear(); const fresh = new ApplicationPreferences(f.dependencies); await fresh.refresh(); fresh.applyCurrentScale();
    expect(f.dependencies.applyScale).not.toHaveBeenCalled();
  });
  it.each([0.7, 1.31, NaN, Infinity])('拒绝无效缩放 %s', async interfaceScale => {
    const f = fixture(); f.state.settings.interfaceScale = interfaceScale; await f.preferences.refresh(); expect(f.dependencies.applyScale).not.toHaveBeenCalled();
  });
  it('设置变化发生在查询中时，最终应用最新持久值', async () => {
    const f = fixture(), pending = deferred<typeof f.state.settings>();
    f.dependencies.readSettings.mockImplementationOnce(() => pending.promise);
    const first = f.preferences.refresh(); f.state.settings.interfaceScale = 1.2;
    const second = f.preferences.refresh(); pending.resolve({ interfaceScale: 1, taskNotifications: false });
    await Promise.all([first, second]); expect(f.dependencies.applyScale).toHaveBeenLastCalledWith(1.2);
    expect(f.dependencies.readSettings).toHaveBeenCalledTimes(2);
  });
  it('关闭或平台不支持时无查询无通知；历史终态不通知', async () => {
    const f = fixture(); await f.preferences.refresh(); await f.preferences.observeJob('job-1'); expect(f.dependencies.readJob).not.toHaveBeenCalled();
    f.state.settings.taskNotifications = true; await f.preferences.refresh();
    f.state.supported = false; await f.preferences.observeJob('job-1'); expect(f.dependencies.readJob).not.toHaveBeenCalled();
    f.state.supported = true; f.state.job.status = 'SUCCEEDED'; await f.preferences.observeJob('job-1'); expect(f.dependencies.notify).not.toHaveBeenCalled();
  });
  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'])('本次进程观察到 RUNNING -> %s 才通知且重复事件不重报', async status => {
    const f = fixture(); f.state.settings.taskNotifications = true; await f.preferences.refresh();
    await f.preferences.observeJob('job-1'); f.state.job.status = status; await f.preferences.observeJob('job-1'); await f.preferences.observeJob('job-1');
    expect(f.dependencies.notify).toHaveBeenCalledExactlyOnceWith(status);
    f.state.job.status = 'QUEUED'; await f.preferences.observeJob('job-1');
    f.state.job.status = 'RUNNING'; await f.preferences.observeJob('job-1'); f.state.job.status = status; await f.preferences.observeJob('job-1');
    await f.preferences.observeJob('job-1');
    expect(f.dependencies.notify.mock.calls).toEqual([[status], [status]]);
  });
  it('同一任务失败后显式重试成功，各次终态只提醒一次且不含任务数据', async () => {
    const f = fixture(); f.state.settings.taskNotifications = true; await f.preferences.refresh();
    for (const status of ['RUNNING', 'FAILED', 'FAILED', 'QUEUED', 'RUNNING', 'RUNNING', 'SUCCEEDED', 'SUCCEEDED']) {
      f.state.job.status = status; await f.preferences.observeJob('job-1');
    }
    expect(f.dependencies.notify.mock.calls).toEqual([['FAILED'], ['SUCCEEDED']]);
    f.preferences.disconnected(); await f.preferences.refresh(); await f.preferences.observeJob('job-1');
    f.state.settings.taskNotifications = false; await f.preferences.refresh();
    f.state.settings.taskNotifications = true; await f.preferences.refresh(); await f.preferences.observeJob('job-1');
    const restarted = new ApplicationPreferences(f.dependencies); await restarted.refresh(); await restarted.observeJob('job-1');
    expect(f.dependencies.notify.mock.calls).toEqual([['FAILED'], ['SUCCEEDED']]);
  });
  it('100 个进度事件只共享一个在途查询和一次复查，终态不丢失', async () => {
    const f = fixture(); f.state.settings.taskNotifications = true; await f.preferences.refresh();
    const pending = deferred<typeof f.state.job>(); f.dependencies.readJob.mockImplementationOnce(() => pending.promise);
    const first = f.preferences.observeJob('job-1'); await Promise.resolve();
    const events = Array.from({ length: 100 }, () => f.preferences.observeJob('job-1'));
    expect(events.every(event => event === first)).toBe(true);
    expect(f.dependencies.readJob).toHaveBeenCalledTimes(1);
    f.state.job.status = 'SUCCEEDED'; pending.resolve({ id: 'job-1', status: 'RUNNING' });
    await Promise.all([first, ...events]);
    expect(f.dependencies.readJob).toHaveBeenCalledTimes(2);
    expect(f.dependencies.notify).toHaveBeenCalledExactlyOnceWith('SUCCEEDED');
    await f.preferences.observeJob('job-1'); expect(f.dependencies.notify).toHaveBeenCalledTimes(1);
  });
  it('复查期间的新终态仍会触发读取，重复事件不会增加排队数量', async () => {
    const f = fixture(); f.state.settings.taskNotifications = true; await f.preferences.refresh();
    const first = deferred<typeof f.state.job>(), second = deferred<typeof f.state.job>(), secondStarted = deferred<void>();
    f.dependencies.readJob.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => { secondStarted.resolve(); return second.promise; });
    const query = f.preferences.observeJob('job-1'); await Promise.resolve();
    f.preferences.observeJob('job-1'); first.resolve({ id: 'job-1', status: 'RUNNING' }); await secondStarted.promise;
    f.state.job.status = 'FAILED';
    const terminalEvents = Array.from({ length: 100 }, () => f.preferences.observeJob('job-1'));
    second.resolve({ id: 'job-1', status: 'RUNNING' }); await Promise.all([query, ...terminalEvents]);
    expect(f.dependencies.readJob).toHaveBeenCalledTimes(3);
    expect(f.dependencies.notify).toHaveBeenCalledExactlyOnceWith('FAILED');
  });
  it('失败的在途查询也会保留事件要求的终态复查', async () => {
    const f = fixture(); f.state.settings.taskNotifications = true; await f.preferences.refresh(); await f.preferences.observeJob('job-1');
    const pending = deferred<typeof f.state.job>();
    f.dependencies.readJob.mockImplementationOnce(async () => { await pending.promise; throw new Error('unavailable'); });
    const query = f.preferences.observeJob('job-1'); await Promise.resolve();
    f.state.job.status = 'SUCCEEDED'; const terminal = f.preferences.observeJob('job-1'); pending.resolve(f.state.job);
    await Promise.all([query, terminal]); expect(f.dependencies.notify).toHaveBeenCalledExactlyOnceWith('SUCCEEDED');
  });
  it('通知抛错也只消费本次终态，新尝试仍可通知', async () => {
    const f = fixture(); f.state.settings.taskNotifications = true; await f.preferences.refresh();
    f.dependencies.notify.mockImplementationOnce(() => { throw new Error('OS refused'); });
    for (const status of ['RUNNING', 'FAILED', 'FAILED', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'SUCCEEDED']) {
      f.state.job.status = status; await f.preferences.observeJob('job-1');
    }
    expect(f.dependencies.notify.mock.calls).toEqual([['FAILED'], ['SUCCEEDED']]);
  });
  it('后台断开和关闭提醒都会丢弃旧运行状态', async () => {
    const f = fixture(); f.state.settings.taskNotifications = true; await f.preferences.refresh(); await f.preferences.observeJob('job-1');
    f.preferences.disconnected(); f.state.job.status = 'SUCCEEDED'; await f.preferences.observeJob('job-1'); expect(f.dependencies.notify).not.toHaveBeenCalled();
    f.state.job.status = 'RUNNING'; await f.preferences.observeJob('job-1'); f.state.settings.taskNotifications = false; await f.preferences.refresh();
    f.state.settings.taskNotifications = true; await f.preferences.refresh(); f.state.job.status = 'FAILED'; await f.preferences.observeJob('job-1');
    expect(f.dependencies.notify).not.toHaveBeenCalled();
  });
  it('关闭再开启提醒后，旧终态查询和待复查均失效', async () => {
    const f = fixture(); f.state.settings.taskNotifications = true; await f.preferences.refresh(); await f.preferences.observeJob('job-1');
    const pending = deferred<typeof f.state.job>(); f.dependencies.readJob.mockImplementationOnce(() => pending.promise);
    const query = f.preferences.observeJob('job-1'); await Promise.resolve(); const dirty = f.preferences.observeJob('job-1');
    f.state.settings.taskNotifications = false; await f.preferences.refresh();
    f.state.settings.taskNotifications = true; await f.preferences.refresh();
    pending.resolve({ id: 'job-1', status: 'SUCCEEDED' }); await Promise.all([query, dirty]);
    expect(f.dependencies.readJob).toHaveBeenCalledTimes(2); expect(f.dependencies.notify).not.toHaveBeenCalled();
    f.state.job.status = 'SUCCEEDED'; await f.preferences.observeJob('job-1'); expect(f.dependencies.notify).not.toHaveBeenCalled();
  });
  it('旧查询完成不能清理重连后同一任务的在途查询或通知', async () => {
    const f = fixture(); f.state.settings.taskNotifications = true; await f.preferences.refresh(); await f.preferences.observeJob('job-1');
    const old = deferred<typeof f.state.job>(), current = deferred<typeof f.state.job>();
    f.dependencies.readJob.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
    const oldQuery = f.preferences.observeJob('job-1'); await Promise.resolve(); f.preferences.observeJob('job-1');
    f.preferences.disconnected(); const newQuery = f.preferences.observeJob('job-1'); await Promise.resolve();
    old.resolve({ id: 'job-1', status: 'FAILED' }); await oldQuery;
    f.state.job.status = 'SUCCEEDED'; const terminal = f.preferences.observeJob('job-1');
    expect(terminal).toBe(newQuery); expect(f.dependencies.notify).not.toHaveBeenCalled();
    current.resolve({ id: 'job-1', status: 'RUNNING' }); await Promise.all([newQuery, terminal]);
    expect(f.dependencies.readJob).toHaveBeenCalledTimes(4); expect(f.dependencies.notify).toHaveBeenCalledExactlyOnceWith('SUCCEEDED');
  });
  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'])('历史 %s 重放以及 QUEUED 后终态均不通知', async status => {
    const f = fixture(); f.state.settings.taskNotifications = true; await f.preferences.refresh();
    for (const next of [status, status, 'QUEUED', status]) { f.state.job.status = next; await f.preferences.observeJob('job-1'); }
    expect(f.dependencies.notify).not.toHaveBeenCalled();
  });
  it('断线期间返回的旧设置不覆盖缩放，重连后仍可重置为 1', async () => {
    const f = fixture(); f.state.settings.interfaceScale = 1.2; await f.preferences.refresh();
    const pending = deferred<typeof f.state.settings>(); f.dependencies.readSettings.mockImplementationOnce(() => pending.promise);
    const old = f.preferences.refresh(); f.preferences.disconnected();
    pending.resolve({ interfaceScale: 1.3, taskNotifications: true }); await old;
    f.preferences.applyCurrentScale(); expect(f.dependencies.applyScale).toHaveBeenLastCalledWith(1.2);
    f.state.settings.interfaceScale = 1; await f.preferences.refresh(); expect(f.dependencies.applyScale).toHaveBeenLastCalledWith(1);
  });
  it('断开前查询稍后完成也不会发出跨重启通知', async () => {
    const f = fixture(); f.state.settings.taskNotifications = true; await f.preferences.refresh(); await f.preferences.observeJob('job-1');
    const pending = deferred<typeof f.state.job>(); f.dependencies.readJob.mockImplementationOnce(() => pending.promise);
    const query = f.preferences.observeJob('job-1'); await Promise.resolve(); f.preferences.disconnected(); pending.resolve({ id: 'job-1', status: 'SUCCEEDED' });
    await query; expect(f.dependencies.notify).not.toHaveBeenCalled();
  });
});
