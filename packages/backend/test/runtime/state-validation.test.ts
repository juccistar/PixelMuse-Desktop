import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { TypeCheck, TypeCompiler } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import { EcomRepository, openDatabase, type SqliteDatabase } from '@ecomgen/core';
import {
  FrozenJobSnapshotSchema, JobRuntimeSchema, JsonValueSchema, RuntimeStore,
  type FrozenJobSnapshot, type JobRuntimeRecord,
} from '../../src/runtime/state.js';

const databases: SqliteDatabase[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = openDatabase(':memory:');
  databases.push(db);
  const repository = new EcomRepository(db), store = new RuntimeStore(db);
  const job = repository.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type: 'PLAN', input: {} });
  const snapshot: FrozenJobSnapshot = {
    version: 1, jobId: job.id, type: 'PLAN', createdAt: '2026-11-07T00:00:00.000Z',
    input: { batches: [{ targetImageCount: 4 }] }, effective: { prompt: 'frozen' }, resources: [],
  };
  return { db, repository, store, job, snapshot };
}

function runtime(snapshot: FrozenJobSnapshot): JobRuntimeRecord {
  return { version: 1, snapshot, phase: 'READY', attempt: 0, runToken: null, requests: [] };
}

function invalid(action: () => unknown, code = 'INVALID_RUNTIME') {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

function largeSnapshot(snapshot: FrozenJobSnapshot): FrozenJobSnapshot {
  const suites = Array.from({ length: 48 }, (_, suite) => ({
    id: `suite-${suite}`, version: 1, enabled: true,
    scenarios: Array.from({ length: 16 }, (_, scene) => ({
      id: `scene-${suite}-${scene}`, purpose: scene % 2 ? 'DETAIL' : 'HERO',
      prompt: '商品材质、构图、光影及背景必须遵循冻结的套图配置。'.repeat(8),
      parameters: { size: '1024x1024', candidateCount: 1, nullable: null, strengths: [0, 0.5, 1] },
      layers: [{ product: { preserve: true, references: ['asset-one', 'asset-two'] } }],
    })),
  }));
  const reads = Array.from({ length: 96 }, (_, index) => ({
    id: `read-${index}`, source: { kind: 'SUITE_SOURCE', id: `source-${index}` },
    sections: [{ title: '冻结参考', content: '套图源内容和商品事实保持可追溯。'.repeat(24) }],
  }));
  return {
    ...snapshot,
    input: { batches: Array.from({ length: 5 }, (_, batch) => ({ batch, targetImageCount: 4, targets: [`sku-${batch}`] })) },
    effective: { suites, reads, catalog: { revision: 3, entries: [{ id: 'sku-one', attributes: { color: '白色' } }] } },
  };
}

describe('RuntimeStore 完整持久快照校验', () => {
  it.each(['{broken', 'null', '[]', '{"version":1}'])('损坏或不完整 JSON 仍返回 INVALID_RUNTIME：%s', payload => {
    const { store } = fixture();
    invalid(() => store.decode(JobRuntimeSchema, payload));
  });

  it.each([
    ['非法阶段', (record: JobRuntimeRecord) => Object.assign(record, { phase: 'PAID' })],
    ['负数代次', (record: JobRuntimeRecord) => { record.attempt = -1; }],
    ['额外运行字段', (record: JobRuntimeRecord) => Object.assign(record, { trusted: true })],
    ['非法嵌套 record', (record: JobRuntimeRecord) => Object.assign(record.snapshot, { effective: [] })],
    ['非法请求', (record: JobRuntimeRecord) => { record.requests.push({ descriptor: { requestKey: 'round:0', fingerprint: 'bad', purpose: 'MODEL' }, state: 'COMPLETED', localState: 'PENDING', startedAt: 'now' }); }],
  ] as const)('成功读取后外部篡改数据库仍被拒绝：%s', (_label, tamper) => {
    const { db, store, job, snapshot } = fixture();
    store.transaction(() => store.create(job.id, snapshot));
    const record = store.get(job.id)!;
    tamper(record);
    db.prepare('UPDATE desktop_job_runtime SET payload=? WHERE job_id=?').run(JSON.stringify(record), job.id);
    invalid(() => store.get(job.id));
    invalid(() => store.mutate(job.id, current => { current.attempt++; }));
  });

  it('每次重新读取数据库、校验最新值，返回对象与持久数据独立', () => {
    const { db, store, job, snapshot } = fixture();
    store.transaction(() => store.create(job.id, snapshot));
    const first = store.get(job.id)!;
    first.snapshot.effective.prompt = 'only local';
    expect(store.get(job.id)!.snapshot.effective.prompt).toBe('frozen');
    const replacement = runtime(snapshot);
    replacement.attempt = 7;
    replacement.runToken = 'external-generation';
    db.prepare('UPDATE desktop_job_runtime SET payload=? WHERE job_id=?').run(JSON.stringify(replacement), job.id);
    expect(store.get(job.id)).toEqual(replacement);
    db.prepare('UPDATE desktop_job_runtime SET payload=? WHERE job_id=?').run('{broken', job.id);
    invalid(() => store.get(job.id));
  });

  it.each([
    ['undefined', undefined], ['函数', () => undefined], ['Symbol', Symbol('invalid')], ['BigInt', 1n],
    ['NaN', NaN], ['Infinity', Infinity], ['负 Infinity', -Infinity],
    ['Date record', new Date('2026-11-07')], ['Uint8Array record', new Uint8Array([1])],
  ] as const)('拒绝递归 record/array 内的非 JSON 值：%s', (_label, value) => {
    const { store, snapshot } = fixture();
    const nested = { branch: [{ value }] };
    expect(Value.Check(JsonValueSchema, nested)).toBe(false);
    invalid(() => store.validate(JsonValueSchema, nested));
    const record = runtime(snapshot);
    Object.assign(record.snapshot.effective, { nested });
    invalid(() => store.validate(JobRuntimeSchema, record));
  });

  it.each([null, [], new Date('2026-11-07'), new Uint8Array([1])])('冻结输入仍要求合法 JSON record：%s', input => {
    const { store, snapshot } = fixture();
    const value = { ...snapshot, input };
    expect(Value.Check(FrozenJobSnapshotSchema, value)).toBe(false);
    invalid(() => store.validate(FrozenJobSnapshotSchema, value));
  });

  it('合法大型递归快照可创建、反复读取并进行同步状态更新', () => {
    const { store, job, snapshot } = fixture();
    const frozen = largeSnapshot(snapshot);
    const history = { previous: [{ snapshot: { facts: ['保留', null, 3, false], nested: { branches: [[{ leaf: true }]] } } }] };
    store.transaction(() => store.create(job.id, frozen, history));
    const record = store.get(job.id)!;
    expect(record.snapshot).toEqual(frozen);
    expect(record.preservedHistory).toEqual(history);
    expect(Value.Check(JobRuntimeSchema, record)).toBe(true);
    store.mutate(job.id, current => { current.phase = 'EXECUTING'; current.attempt++; current.runToken = 'generation-one'; });
    expect(store.get(job.id)).toEqual({ ...record, phase: 'EXECUTING', attempt: 1, runToken: 'generation-one' });
  });

  it('保留不可变快照及历史，失败的状态与业务写入一起回滚', () => {
    const { store, repository, job, snapshot } = fixture();
    store.transaction(() => store.create(job.id, snapshot, { old: [{ value: 'frozen' }] }));
    const original = store.get(job.id)!;
    for (const change of [
      (record: JobRuntimeRecord) => { record.snapshot.effective.prompt = 'changed'; },
      (record: JobRuntimeRecord) => { record.preservedHistory = { old: [] }; },
    ]) {
      invalid(() => store.mutate(job.id, record => {
        record.attempt = 9;
        repository.updateJob(job.id, { progress: 55 });
        change(record);
      }), 'IMMUTABLE_SNAPSHOT');
      expect(store.get(job.id)).toEqual(original);
      expect(repository.getJob(job.id)!.progress).toBe(0);
    }
    invalid(() => store.mutate(job.id, record => { record.attempt = -1; }));
    expect(store.get(job.id)).toEqual(original);
    expect(store.mutate(job.id, record => { record.attempt++; return 'committed'; })).toBe('committed');
    expect(store.get(job.id)!.attempt).toBe(1);
  });

  it('拒绝异步 mutate/事务并回滚同步写入，嵌套事务保留 SAVEPOINT 边界', () => {
    const { store, repository, job, snapshot } = fixture();
    store.transaction(() => store.create(job.id, snapshot));
    invalid(() => store.mutate(job.id, async record => {
      record.attempt = 4;
      repository.updateJob(job.id, { progress: 35 });
    }), 'ASYNC_TRANSACTION');
    expect(store.get(job.id)!.attempt).toBe(0);
    expect(repository.getJob(job.id)!.progress).toBe(0);
    store.transaction(() => {
      repository.updateJob(job.id, { progress: 10 });
      invalid(() => store.transaction(async () => { repository.updateJob(job.id, { progress: 60 }); }), 'ASYNC_TRANSACTION');
      expect(repository.getJob(job.id)!.progress).toBe(10);
    });
    expect(repository.getJob(job.id)!.progress).toBe(10);
  });

  it('创建仍要求事务及一致身份，资源数量与索引上限内合法数据可打开', () => {
    const { store, job, snapshot } = fixture();
    invalid(() => store.create(job.id, snapshot), 'TRANSACTION_REQUIRED');
    invalid(() => store.transaction(() => store.create(job.id, { ...snapshot, jobId: 'other-job' })), 'INVALID_SNAPSHOT');
    const resources: FrozenJobSnapshot['resources'] = Array.from({ length: 1000 }, (_, index) => ({
      ref: { kind: 'LAYER_FILE', id: `layer-${index}`, index: 255 }, hash: 'a'.repeat(64),
    }));
    store.transaction(() => store.create(job.id, { ...snapshot, resources }));
    expect(store.get(job.id)!.snapshot.resources).toEqual(resources);
    invalid(() => store.validate(FrozenJobSnapshotSchema, { ...snapshot, resources: [...resources, resources[0]] }));
  });

  it.each([
    { ref: { kind: 'LAYER_FILE', id: 'layer', index: 256 }, hash: 'a'.repeat(64) },
    { ref: { kind: 'ASSET', id: '../outside' }, hash: 'a'.repeat(64) },
    { ref: { kind: 'UNKNOWN', id: 'asset' }, hash: 'a'.repeat(64) },
    { ref: { kind: 'ASSET', id: 'asset', path: 'C:/private' }, hash: 'a'.repeat(64) },
    { ref: { kind: 'ASSET', id: 'asset' }, hash: 'A'.repeat(64) },
  ])('资源引用仍遵循原 schema 边界：%j', resource => {
    const { store, snapshot } = fixture();
    const value = { ...snapshot, resources: [resource] };
    expect(Value.Check(FrozenJobSnapshotSchema, value)).toBe(false);
    invalid(() => store.validate(FrozenJobSnapshotSchema, value));
  });

  it('不同 schema 身份即使同 $id 仍使用各自约束', () => {
    const { store } = fixture();
    const short = Type.String({ $id: 'shared-label', maxLength: 1 });
    const long = Type.String({ $id: 'shared-label', minLength: 3 });
    store.validate(short, 'a');
    store.validate(long, 'abc');
    invalid(() => store.validate(short, 'abc'));
    invalid(() => store.validate(long, 'a'));
  });

  it('完整递归 schema 可编译，跨 store 复用程序但逐次检查新值', () => {
    const { db, store, snapshot } = fixture();
    const schema = { ...JobRuntimeSchema }, value = runtime(largeSnapshot(snapshot));
    const compile = vi.spyOn(TypeCompiler, 'Compile'), compiledCheck = vi.spyOn(TypeCheck.prototype, 'Check');
    store.validate(schema, value);
    value.attempt = -1;
    invalid(() => new RuntimeStore(db).validate(schema, value));
    value.attempt = 1;
    store.validate(schema, value);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compiledCheck).toHaveBeenCalledTimes(3);
  });

  it('编译器不可用时继续使用 Value.Check 接受合法旧快照并拒绝非法值', () => {
    const { store, snapshot } = fixture();
    // 独立 schema 身份，模拟打包环境禁止动态代码或编译器不支持某个既有 schema。
    const schema = { ...JobRuntimeSchema };
    const compile = vi.spyOn(TypeCompiler, 'Compile').mockImplementationOnce(() => { throw new Error('compiler unavailable'); });
    const value = runtime(snapshot), payload = JSON.stringify(value);
    expect(store.decode(schema, payload)).toEqual(value);
    expect(store.decode(schema, payload)).toEqual(value);
    invalid(() => store.decode(schema, JSON.stringify({ ...value, attempt: -1 })));
    expect(compile).toHaveBeenCalledTimes(1);
  });
});
