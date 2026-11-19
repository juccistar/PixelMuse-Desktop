import { utilityProcess, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { ChangeEventSchema, type BackendOptions, type ChangeEvent, type RpcResponse } from '@ecomgen/contracts';

import { PublicError } from './public-error.js';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
/** 单一后台拥有数据库；仅在确认旧进程退出后启动替代实例。 */
export class BackendHost extends EventEmitter {
  private child?: UtilityProcess;
  private pending = new Map<string, Pending>();
  private stopping = false;
  private ready = false;
  private restartCount = 0;
  private restartTimer?: NodeJS.Timeout;
  private initializationTimer?: NodeJS.Timeout;
  public constructor(private readonly options: BackendOptions, private readonly log: (message: string) => void) { super(); }
  /** 主进程在迁移重启期间仍可返回只读工作空间状态。 */
  public get available(): boolean { return this.ready && !this.stopping; }
  /** 退出超时后不得在旧进程仍持有锁时启动新实例。 */
  public get hasProcess(): boolean { return this.child !== undefined; }

  public start(): Promise<void> {
    if (this.child) return Promise.reject(new Error('Backend already started'));
    return new Promise((resolve, reject) => {
      let initialized = false;
      const child = utilityProcess.fork(join(import.meta.dirname, 'backend.js'), [], {
        serviceName: 'EcomGen Backend', stdio: 'pipe',
      });
      this.child = child;
      // 子进程输出只记录存在性；不转存可能含 Provider 请求内容的原始输出。
      child.stderr?.on('data', () => this.log('Backend emitted a diagnostic error.'));
      this.initializationTimer = setTimeout(() => {
        reject(new Error('后台启动超时'));
        child.kill();
      }, 30000);
      child.on('message', (message: { type: 'ready' | 'closed' } | { type: 'fatal'; message: string } | { type: 'changed'; event: ChangeEvent } | ({ type: 'response' } & RpcResponse)) => {
        if (message.type === 'ready') {
          clearTimeout(this.initializationTimer);
          initialized = true;
          this.ready = true;
          this.emit('status', 'ready');
          resolve();
        } else if (message.type === 'fatal') {
          reject(new Error(message.message ?? '后台初始化失败'));
          child.kill();
        } else if (message.type === 'changed' && Value.Check(ChangeEventSchema, message.event)) {
          this.emit('changed', message.event);
        } else if (message.type === 'response' && message.id) {
          const waiter = this.pending.get(message.id);
          if (!waiter) return;
          clearTimeout(waiter.timer);
          this.pending.delete(message.id);
          if (message.ok) waiter.resolve(message.data);
          else waiter.reject(new PublicError(message.error?.code ?? 'INTERNAL_ERROR', message.error?.message ?? '本地操作失败'));
        }
      });
      child.once('exit', code => {
        clearTimeout(this.initializationTimer);
        this.child = undefined;
        this.ready = false;
        this.emit('status', 'disconnected');
        for (const waiter of this.pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('本地后台已断开；请重新查询操作状态。'));
        }
        this.pending.clear();
        this.log(`Backend exited (${code}).`);
        if (!initialized) reject(new Error('后台未能启动，请检查数据目录。'));
        if (!this.stopping && initialized && this.restartCount < 2) {
          this.restartCount += 1;
          this.restartTimer = setTimeout(() => {
            void this.start().catch(() => this.log('Backend restart failed.'));
          }, this.restartCount * 1000);
        }
      });
      child.once('spawn', () => child.postMessage({ type: 'init', options: this.options }));
    });
  }

  public request(operation: string, input: unknown, host = false): Promise<unknown> {
    if (!this.child || !this.ready || this.stopping) return Promise.reject(new Error('本地后台不可用'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('操作超时，请重新查询当前状态后再决定是否重试。'));
      }, host ? 120000 : 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.postMessage({ type: host ? 'host' : 'invoke', id, operation, input });
    });
  }

  /** 安装前必须收到关闭确认并观察到零退出码；超时不视作成功。 */
  public async stopStrict(): Promise<void> {
    if (this.stopping || !this.child || !this.ready) throw new Error('本地后台不可用，无法安全安装更新。');
    this.stopping = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    await new Promise<void>((resolve, reject) => {
      let closed = false;
      const cleanup = () => { clearTimeout(timer); child.removeListener('message', onMessage); child.removeListener('exit', onExit); };
      const onMessage = (message: { type?: string }) => { if (message.type === 'closed') closed = true; };
      const onExit = (code: number) => {
        cleanup();
        if (closed && code === 0) resolve();
        else reject(new Error('后台未能正常关闭，无法安装更新。'));
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('后台关闭超时，无法安装更新。')); }, 15000);
      child.on('message', onMessage);
      child.once('exit', onExit);
      try { child.postMessage({ type: 'shutdown' }); }
      catch { cleanup(); this.stopping = false; reject(new Error('后台关闭请求失败，无法安装更新。')); }
    });
  }

  /** 严格关闭失败后等待旧进程退出，再允许调用方启动替代实例。 */
  public async waitForExit(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    if (!this.child) return;
    const child = this.child;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill(), 15000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.postMessage({ type: 'shutdown' });
    });
  }
}
