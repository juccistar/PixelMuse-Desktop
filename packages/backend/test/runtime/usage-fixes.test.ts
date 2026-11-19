import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EcomRepository, openDatabase, SecretBox, type SqliteDatabase } from '@ecomgen/core';
import { bindExternalRequests } from '@ecomgen/providers';
import { createPlanningTools } from '../../../agent/src/tools.js';
import { RequestLedger } from '../../src/runtime/request-ledger.js';
import { RuntimeStore, FrozenJobSnapshotSchema, type FrozenJobSnapshot } from '../../src/runtime/state.js';
import { backfillUsage, UsageStore } from '../../src/runtime/usage-store.js';
import { createUsageHandlers } from '../../src/commands/usage.js';
import { createBackend } from '../../src/index.js';
import { EXECUTOR_TYPES, type CommandContext, type ExecutorMap } from '../../src/runtime/ports.js';
const databases: SqliteDatabase[] = [], directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) if (db.open) db.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(file = ':memory:') {
 const db = openDatabase(file); databases.push(db);
 const repository = new EcomRepository(db), secrets = new SecretBox(randomBytes(32));
 const store = new RuntimeStore(db), ledger = new RequestLedger(store, secrets);
 const events = { publish: vi.fn() };
 const context = { repository, secrets, events, clock: store.clock, idFactory: randomUUID, signal: new AbortController().signal, transaction: <T>(fn: () => T) => store.transaction(fn) } as unknown as CommandContext;
 const provider = repository.saveProvider({ name: 'usage-fix', baseUrl: 'https://model.invalid', reasoningProtocol: 'openai', encryptedApiKey: secrets.encrypt('test-only'), models: [{ id: 'reasoner', supportsVision: true, supportsThinking: true, supportsStructuredOutput: true, supportsTools: true, imageApiKind: null }] });
 const add = () => {
  const job = repository.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type: 'COPYWRITE', input: { target: 'LISTING' } });
  const snapshot: FrozenJobSnapshot = { version: 1, jobId: job.id, type: job.type, createdAt: store.clock(), input: job.input as any, resources: [], effective: {} };
  store.transaction(() => store.create(job.id, snapshot)); return job;
 };
 const descriptor = (key: string, purpose: 'MODEL' | 'IMAGE' | 'SEGMENTATION' | 'SEARCH' | 'POLL' = 'MODEL') => ({ requestKey: key, fingerprint: createHash('sha256').update(key).digest('hex'), purpose, model: { providerId: provider.id, modelId: 'reasoner' } });
 const handlers = () => createUsageHandlers(context, db);
 const price = { providerId: provider.id, modelId: 'reasoner', currency: 'USD' as const, inputPerMillion: null, outputPerMillion: null, cachedInputPerMillion: null, perRequest: 2 };
 return { db, repository, secrets, store, ledger, context, events, provider, add, descriptor, handlers, price };
}
const receipt = (input = 17) => ({ status: 200, headers: [] as [string, string][], bodyBase64: Buffer.from(JSON.stringify({ usage: { input_tokens: input, output_tokens: 5 } })).toString('base64') });
function pathFixture() { const dir = mkdtempSync(join(tmpdir(), 'usage-fix-')); directories.push(dir); return join(dir, 'usage.sqlite'); }
function reopen(file: string) { const db = openDatabase(file); databases.push(db); return db; }
describe('用量审查缺陷回归', () => {
 it('实际research工具的免费searxng搜索不借用推理模型身份或价格', async () => {
  const f = fixture(), h = f.handlers(), job = f.add(); h.setModelPricing(f.context, f.price);
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ results: [{ title: 'light', url: 'https://example.invalid', content: 'visual trend' }] })));
  const external = bindExternalRequests(f.ledger.forJob(job.id, new AbortController().signal), 'planning', { providerId: f.provider.id, modelId: 'reasoner' });
  const tool = createPlanningTools({} as any, { sources: [{ id: 'free', name: 'free searxng', kind: 'searxng', baseUrl: 'https://search.invalid' }], external }).find(t => t.name === 'research_visual_direction')!;
  await tool.execute('tool-1', { query: 'visual lighting' });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(h.listUsage(f.context, {}).items[0]).toMatchObject({ purpose: 'SEARCH', state: 'COMPLETED', providerId: null, modelId: null, pricingSnapshot: null, currency: null, estimatedAmount: null });
  expect(h.getUsageSummary(f.context, {}).amounts).toEqual([]);
 });
 it.each(['MODEL', 'IMAGE', 'SEGMENTATION', 'SEARCH', 'POLL'] as const)('purpose %s 只为实际模型调用冻结价格', purpose => {
  const f = fixture(), h = f.handlers(), job = f.add(); h.setModelPricing(f.context, f.price);
  const scope = f.ledger.forJob(job.id, new AbortController().signal); scope.begin(f.descriptor('purpose', purpose)); scope.complete('purpose', receipt());
  const entry = h.listUsage(f.context, {}).items[0]!;
  expect(entry.estimatedAmount).toBe(['SEARCH', 'POLL'].includes(purpose) ? null : 2);
 });
 it('101号完成写失败优先恢复，真实SQLite重开保留旧价格与去重', () => {
  const file = pathFixture(), f = fixture(file), h = f.handlers(); h.setModelPricing(f.context, f.price);
  for (let i = 0; i < 100; i++) { const job = f.add(), scope = f.ledger.forJob(job.id, new AbortController().signal); scope.begin(f.descriptor(`old:${i}`)); scope.complete(`old:${i}`, receipt(1)); }
  const job = f.add(), scope = f.ledger.forJob(job.id, new AbortController().signal); scope.begin(f.descriptor('lost'));
  f.db.exec("CREATE TRIGGER fail_stats BEFORE UPDATE ON desktop_usage_records BEGIN SELECT RAISE(ABORT,'test failure'); END");
  scope.complete('lost', receipt()); f.db.exec('DROP TRIGGER fail_stats');
  expect(f.store.get(job.id)!.requests[0]!.state).toBe('COMPLETED');
  expect(new UsageStore(f.db).get(job.id, 'lost')!.state).toBe('IN_FLIGHT');
  h.setModelPricing(f.context, { ...f.price, currency: 'CNY', perRequest: 99 }); f.db.close();
  for (let i = 0; i < 3; i++) {
   const db = reopen(file), decrypt = vi.spyOn(f.secrets, 'decrypt'); backfillUsage(db, f.secrets);
   expect(new UsageStore(db).get(job.id, 'lost')).toMatchObject({ state: 'COMPLETED', inputTokens: 17, currency: 'USD', estimatedAmount: 2, pricingSnapshot: { perRequest: 2 } });
   expect((db.prepare('SELECT count(*) AS n FROM desktop_usage_records').get() as { n: number }).n).toBe(101);
   expect(decrypt).toHaveBeenCalledTimes(i === 0 ? 1 : 0); decrypt.mockRestore(); db.close();
  }
 });
 it('图片大回执写用量失败后跨重开补偿，保持价格且不重发', async () => {
  const file = pathFixture(), f = fixture(file), h = f.handlers(); h.setModelPricing(f.context, f.price);
  const jobs = [f.add(), f.add()]; let calls = 0;
  const body = JSON.stringify({ data: [{ b64_json: 'x'.repeat(1024 * 1024) }], usage: { input_tokens: 17, output_tokens: 5 } });
  const ledger = new RequestLedger(f.store, f.secrets, async () => { calls++; return new Response(body); });
  f.db.exec("CREATE TRIGGER fail_large_stats BEFORE UPDATE ON desktop_usage_records BEGIN SELECT RAISE(ABORT,'test failure'); END");
  for (const [index, job] of jobs.entries()) await ledger.forJob(job.id, new AbortController().signal).fetch(f.descriptor(`image:${index}`, 'IMAGE'), 'https://never-network.invalid');
  f.db.exec('DROP TRIGGER fail_large_stats');
  expect(calls).toBe(2);
  for (const [index, job] of jobs.entries()) {
   expect(f.store.get(job.id)!.requests[0]!.state).toBe('COMPLETED');
   expect(new UsageStore(f.db).get(job.id, `image:${index}`)!.state).toBe('IN_FLIGHT');
  }
  f.db.close();
  for (let pass = 0; pass < 2; pass++) {
   const db = reopen(file); backfillUsage(db, f.secrets);
   expect(jobs.filter((job, index) => new UsageStore(db).get(job.id, `image:${index}`)?.state === 'COMPLETED')).toHaveLength(2);
   db.close();
  }
  const db = reopen(file);
  for (const [index, job] of jobs.entries()) expect(new UsageStore(db).get(job.id, `image:${index}`)).toMatchObject({ state: 'COMPLETED', inputTokens: 17, estimatedAmount: 2, pricingSnapshot: { perRequest: 2 } });
  const replay = new RequestLedger(new RuntimeStore(db), f.secrets, async () => { calls++; return new Response('{}'); });
  await replay.forJob(jobs[0]!.id, new AbortController().signal).fetch(f.descriptor('image:0', 'IMAGE'), 'https://never-network.invalid');
  expect(calls).toBe(2);
 });
 it('旧历史游标跨真实SQLite重开前进，包括同一快照第201个请求', () => {
  const file = pathFixture(), f = fixture(file);
  for (let i = 0; i < 101; i++) { const job = f.add(), scope = f.ledger.forJob(job.id, new AbortController().signal); scope.begin(f.descriptor(`old:${i}`)); scope.complete(`old:${i}`, receipt(1)); }
  const big = f.add(), scope = f.ledger.forJob(big.id, new AbortController().signal); scope.begin(f.descriptor('template')); scope.complete('template', receipt());
  const template = f.store.get(big.id)!.requests[0]!;
  f.store.mutate(big.id, runtime => { runtime.requests = Array.from({ length: 201 }, (_, i) => ({ ...template, descriptor: f.descriptor(`many:${i}`) })); });
  f.db.prepare('DELETE FROM desktop_usage_records').run(); f.db.close();
  const counts: number[] = [];
  for (let i = 0; i < 4; i++) {
   const db = reopen(file), decrypt = vi.spyOn(f.secrets, 'decrypt'); backfillUsage(db, f.secrets);
   counts.push((db.prepare('SELECT count(*) AS n FROM desktop_usage_records').get() as { n: number }).n);
   expect(decrypt.mock.calls.length).toBeLessThanOrEqual(200); decrypt.mockRestore(); db.close();
  }
  expect(counts[0]).toBe(100); expect(counts.at(-1)).toBe(302);
  const db = reopen(file); expect(new UsageStore(db).get(big.id, 'many:200')).toMatchObject({ state: 'COMPLETED', inputTokens: 17, pricingSnapshot: null });
 });
 it('8MiB字节预算耗尽后游标停在边界，重开SQLite继续导入剩余大快照', () => {
  const file = pathFixture(), f = fixture(file);
  for (let i = 0; i < 10; i++) {
   const job = f.add(), scope = f.ledger.forJob(job.id, new AbortController().signal); scope.begin(f.descriptor(`large:${i}`)); scope.complete(`large:${i}`, receipt());
   const raw = f.db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get(job.id) as { payload: string };
   const runtime = JSON.parse(raw.payload); runtime.snapshot.input.filler = 'x'.repeat(950000);
   f.db.prepare('UPDATE desktop_job_runtime SET payload=? WHERE job_id=?').run(JSON.stringify(runtime), job.id);
  }
  f.db.prepare('DELETE FROM desktop_usage_records').run(); f.db.close();
  const counts: number[] = [];
  for (let i = 0; i < 2; i++) { const db = reopen(file); backfillUsage(db, f.secrets); counts.push((db.prepare('SELECT count(*) AS n FROM desktop_usage_records').get() as { n: number }).n); db.close(); }
  expect(counts).toEqual([8, 10]);
 });
 it('大量损坏待修复行不能饿死101号有效完成回执', () => {
  const file = pathFixture(), f = fixture(file); f.handlers();
  for (let i = 0; i < 101; i++) {
   const job = f.add(), scope = f.ledger.forJob(job.id, new AbortController().signal); scope.begin(f.descriptor(`pending:${i}`)); scope.complete(`pending:${i}`, receipt());
   f.db.prepare("UPDATE desktop_usage_records SET entry_json=json_set(entry_json,'$.state','IN_FLIGHT') WHERE job_id=?").run(job.id);
   if (i < 100) f.store.mutate(job.id, runtime => { runtime.requests[0]!.responseHash = 'f'.repeat(64); });
  }
  const target = (f.db.prepare('SELECT job_id FROM desktop_job_runtime ORDER BY rowid DESC LIMIT 1').get() as { job_id: string }).job_id;
  f.db.close();
  for (let i = 0; i < 4; i++) { const db = reopen(file); backfillUsage(db, f.secrets); db.close(); }
  const db = reopen(file); expect(new UsageStore(db).get(target, 'pending:100')).toMatchObject({ state: 'COMPLETED', inputTokens: 17 });
  expect((db.prepare("SELECT count(*) AS n FROM desktop_usage_records WHERE json_extract(entry_json,'$.state')='IN_FLIGHT'").get() as { n: number }).n).toBe(0);
 });
 it('已提交的begin/complete/unknown/recover触发通知，通知失败不改变付费调用与重放', async () => {
  const f = fixture(), job = f.add(), seen: string[] = []; let calls = 0;
  const ledger = new RequestLedger(f.store, f.secrets, async () => { calls++; return new Response(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 1 } })); }, () => {
   expect(f.db.inTransaction).toBe(false);
   seen.push(new UsageStore(f.db).get(job.id, 'one')!.state);
   throw new Error('subscriber failure');
  });
  const scope = ledger.forJob(job.id, new AbortController().signal);
  await scope.fetch(f.descriptor('one'), 'https://never-network.invalid'); await scope.fetch(f.descriptor('one'), 'https://never-network.invalid');
  expect(calls).toBe(1); expect(seen).toEqual(['IN_FLIGHT', 'COMPLETED']);
  scope.begin(f.descriptor('two')); scope.begin(f.descriptor('three')); scope.unknown('two'); ledger.recover(job.id);
  expect(seen).toHaveLength(6); expect(new UsageStore(f.db).get(job.id, 'three')!.state).toBe('UNKNOWN');
 });
 it('回滚与外层未提交事务不发布通知；完成写失败重放只修统计', async () => {
  const f = fixture(), job = f.add(), notify = vi.fn(); let calls = 0;
  const ledger = new RequestLedger(f.store, f.secrets, async () => { calls++; return new Response(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 1 } })); }, notify);
  const scope = ledger.forJob(job.id, new AbortController().signal);
  f.db.exec("CREATE TRIGGER fail_begin BEFORE INSERT ON desktop_usage_records BEGIN SELECT RAISE(ABORT,'test failure'); END");
  await expect(scope.fetch(f.descriptor('one'), 'https://never-network.invalid')).rejects.toThrow(); expect(notify).not.toHaveBeenCalled(); expect(calls).toBe(0);
  f.db.exec('DROP TRIGGER fail_begin');
  f.db.exec("CREATE TRIGGER fail_complete BEFORE UPDATE ON desktop_usage_records BEGIN SELECT RAISE(ABORT,'test failure'); END");
  await scope.fetch(f.descriptor('one'), 'https://never-network.invalid'); expect(notify).toHaveBeenCalledTimes(1); f.db.exec('DROP TRIGGER fail_complete');
  await scope.fetch(f.descriptor('one'), 'https://never-network.invalid'); expect(calls).toBe(1); expect(notify).toHaveBeenCalledTimes(2);
  scope.begin(f.descriptor('two')); notify.mockClear();
  expect(() => f.store.transaction(() => { scope.unknown('two'); throw new Error('rollback'); })).toThrow('rollback');
  await Promise.resolve(); expect(notify).not.toHaveBeenCalled(); expect(new UsageStore(f.db).get(job.id, 'two')!.state).toBe('IN_FLIGHT');
  f.store.transaction(() => ledger.recover(job.id)); expect(notify).not.toHaveBeenCalled();
  await Promise.resolve(); expect(notify).toHaveBeenCalledTimes(1); expect(new UsageStore(f.db).get(job.id, 'two')!.state).toBe('UNKNOWN');
 });
 it('实际Backend调度器向订阅者发布usage topic', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-event-fix-')); directories.push(root);
  const topics: string[] = []; let context!: CommandContext;
  const executors = Object.fromEntries(EXECUTOR_TYPES.map(type => [type, { snapshotSchema: FrozenJobSnapshotSchema, execute: async (execution: any) => { if (type === 'COPYWRITE') await execution.external.fetch({ requestKey: 'event', fingerprint: 'a'.repeat(64), purpose: 'MODEL' }, 'https://never-network.invalid'); } }])) as unknown as ExecutorMap;
  const backend = await createBackend({ dataDir: root, masterKey: Buffer.alloc(32, 29).toString('base64'), version: 'usage-fix' }, event => topics.push(event.topic), { commands: current => { context = current; return {}; }, executors, fetch: async () => new Response(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 1 } })) });
  try {
   const job = context.transaction(() => { const j = context.repository.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type: 'COPYWRITE', input: { target: 'LISTING' } }); context.scheduler.freeze(j.id, { version: 1, jobId: j.id, type: j.type, createdAt: context.clock(), input: { target: 'LISTING' }, effective: {}, resources: [] }); return j; });
   await vi.waitFor(() => expect(context.repository.getJob(job.id)!.status).toBe('SUCCEEDED'), { timeout: 5000, interval: 5 });
   expect((await backend.invoke('listUsage', {})).items[0]).toMatchObject({ state: 'COMPLETED', inputTokens: 3 });
   expect(topics.filter(topic => topic === 'usage')).toHaveLength(2);
  } finally { await backend.close(); }
 });
});
