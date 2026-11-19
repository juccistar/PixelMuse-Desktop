import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: electron.fork } }));
import { BackendHost } from './backend-host.js';

class Child extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn();
}

async function started() {
  const child = new Child();
  electron.fork.mockReturnValue(child);
  const host = new BackendHost({ dataDir: 'test', masterKey: 'test', version: 'test' }, () => undefined);
  const starting = host.start();
  child.emit('spawn'); child.emit('message', { type: 'ready' });
  await starting;
  return { host, child };
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('strict update shutdown', () => {
  it('requires both close acknowledgement and a zero exit code', async () => {
    const { host, child } = await started();
    const stopping = host.stopStrict();
    child.emit('message', { type: 'close-failed' });
    child.emit('exit', 1);
    await expect(stopping).rejects.toThrow('后台未能正常关闭');
    expect(host.hasProcess).toBe(false);
  });

  it('rejects a zero exit without acknowledgement and a nonzero exit after acknowledgement', async () => {
    for (const [acknowledged, code] of [[false, 0], [true, 1]] as const) {
      const { host, child } = await started();
      const stopping = host.stopStrict();
      if (acknowledged) child.emit('message', { type: 'closed' });
      child.emit('exit', code);
      await expect(stopping).rejects.toThrow('后台未能正常关闭');
    }
  });

  it('accepts an acknowledged zero exit', async () => {
    const { host, child } = await started();
    const stopping = host.stopStrict();
    child.emit('message', { type: 'closed' }); child.emit('exit', 0);
    await expect(stopping).resolves.toBeUndefined();
  });

  it('keeps a live backend available when the shutdown message could not be sent', async () => {
    const { host, child } = await started();
    child.postMessage.mockImplementationOnce(() => { throw new Error('send failed'); });
    await expect(host.stopStrict()).rejects.toThrow('后台关闭请求失败');
    expect(host.available).toBe(true);
    expect(host.hasProcess).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('does not kill or consider a timed out process exited', async () => {
    vi.useFakeTimers();
    const { host, child } = await started();
    const stopping = host.stopStrict();
    const rejected = expect(stopping).rejects.toThrow('后台关闭超时');
    await vi.advanceTimersByTimeAsync(15000); await rejected;
    expect(child.kill).not.toHaveBeenCalled();
    expect(host.hasProcess).toBe(true);
    let exited = false;
    const waiting = host.waitForExit().then(() => { exited = true; });
    await Promise.resolve(); expect(exited).toBe(false);
    child.emit('exit', 0); await waiting;
    expect(host.hasProcess).toBe(false);
  });
});
