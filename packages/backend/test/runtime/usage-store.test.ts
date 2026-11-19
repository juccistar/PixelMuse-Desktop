import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EcomRepository, openDatabase, SecretBox, type SqliteDatabase } from '@ecomgen/core';
import type { ModelPricing, UsageEntry } from '@ecomgen/contracts';
import { createRecordedFetch, settleRecordedFetch } from '@ecomgen/providers';
import { RequestLedger } from '../../src/runtime/request-ledger.js';
import { RuntimeStore, type FrozenJobSnapshot } from '../../src/runtime/state.js';
import { createUsageHandlers } from '../../src/commands/usage.js';
import type { CommandContext } from '../../src/runtime/ports.js';
const databases: SqliteDatabase[] = [], directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) if (db.open) db.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(filename = ':memory:') {
  const db = openDatabase(filename); databases.push(db);
  const repository = new EcomRepository(db), secrets = new SecretBox(randomBytes(32));
  let now = '2026-11-06T01:00:00.000Z';
  const clock = () => now, store = new RuntimeStore(db, clock), ledger = new RequestLedger(store, secrets);
  const provider = repository.saveProvider({ name: '@private-service', baseUrl: 'https://secret-endpoint.invalid', reasoningProtocol: 'openai', encryptedApiKey: secrets.encrypt('PRIVATE-API-KEY'), models: [{ id: 'reasoner', supportsVision: true, supportsThinking: false, supportsStructuredOutput: true, supportsTools: true, imageApiKind: null }] });
  const project = repository.createProject({ name: '\t=FORMULA()', category: null, productDescription: 'PRIVATE-PROMPT', verifiedFacts: [], prohibitedClaims: [], brandGuidelines: {}, platformTargets: [], targetMarket: null, copyLanguage: null, reasoningProviderId: provider.id, reasoningModelId: 'reasoner', imageProviderId: null, imageModelId: null, defaultMode: 'CREATIVE', imageResolution: '1K', imageAspectRatio: 'AUTO', candidatesPerType: 1 });
  const events = { publish: vi.fn() };
  const context = { repository, secrets, events, clock, transaction: <T>(fn: () => T) => store.transaction(fn) } as unknown as CommandContext;
  const add = () => {
    const job = repository.createJob({ id: randomUUID(), projectId: project.id, storyboardItemId: null, type: 'COPYWRITE', input: { target: 'LISTING' } });
    const snapshot: FrozenJobSnapshot = { version: 1, jobId: job.id, type: job.type, createdAt: clock(), input: job.input as FrozenJobSnapshot['input'], resources: [], effective: { execution: { reads: { [`getProvider:${JSON.stringify([provider.id])}`]: { name: provider.name }, [`getProject:${JSON.stringify([project.id])}`]: { name: project.name } } } } };
    store.transaction(() => store.create(job.id, snapshot));
    return job;
  };
  const descriptor = (key: string) => ({ requestKey: key, fingerprint: createHash('sha256').update(key).digest('hex'), purpose: 'MODEL' as const, model: { providerId: provider.id, modelId: 'reasoner' } });
  const complete = (jobId: string, key: string, status = 200, usage: unknown = { input_tokens: 1000000, output_tokens: 500000, input_tokens_details: { cached_tokens: 250000 } }) => {
    const scope = ledger.forJob(jobId, new AbortController().signal); scope.begin(descriptor(key));
    scope.complete(key, { status, headers: [['x-secret', 'PRIVATE-HEADER']], bodyBase64: Buffer.from(JSON.stringify({ usage, response: 'PRIVATE-RESPONSE', prompt: 'PRIVATE-PROMPT' })).toString('base64') });
    return scope;
  };
  const pricing = (currency: 'USD' | 'CNY' = 'USD'): Omit<ModelPricing, 'updatedAt'> => ({ providerId: provider.id, modelId: 'reasoner', currency, inputPerMillion: 4, outputPerMillion: 8, cachedInputPerMillion: 1, perRequest: 0.5 });
  return { db, repository, secrets, store, ledger, provider, project, context, events, add, complete, descriptor, pricing, advance: (value: string) => { now = value; }, handlers: () => createUsageHandlers(context, db) };
}
const list = (f: ReturnType<typeof fixture>) => f.handlers().listUsage(f.context, {});
describe('用量持久化和命令', () => {
  it('发送前原子保存IN_FLIGHT价格快照；完成、提交、重放不重复', async () => {
    const f = fixture(), h = f.handlers(), job = f.add(); h.setModelPricing(f.context, f.pricing());
    let calls = 0;
    const ledger = new RequestLedger(f.store, f.secrets, async () => {
      calls++; const before = h.listUsage(f.context, {}).items[0]!;
      expect(before.state).toBe('IN_FLIGHT'); expect(before.pricingSnapshot?.inputPerMillion).toBe(4);
      return new Response(JSON.stringify({ usage: { input_tokens: 1000000, output_tokens: 500000, input_tokens_details: { cached_tokens: 250000 } } }));
    });
    const scope = ledger.forJob(job.id, new AbortController().signal), descriptor = f.descriptor('round:0');
    await scope.fetch(descriptor, 'https://unused.invalid');
    scope.committed(descriptor.requestKey); await scope.fetch(descriptor, 'https://unused.invalid');
    const row = h.listUsage(f.context, {}).items[0]!;
    expect(calls).toBe(1); expect(h.listUsage(f.context, {}).total).toBe(1);
    expect(row).toMatchObject({ state: 'COMPLETED', httpStatus: 200, estimatedAmount: 7.75, currency: 'USD', inputTokens: 1000000, cachedInputTokens: 250000 });
    expect(f.ledger.summaries(job.id)[0]?.localState).toBe('COMMITTED');
  });
  it('SSE观察到终态后仍等待EOF，加密回执提交前用量不可提前完成', async () => {
    const f = fixture(), h = f.handlers(), job = f.add(), scope = f.ledger.forJob(job.id, new AbortController().signal);
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const recorded = createRecordedFetch(scope, 'stream', 'MODEL', { providerId: f.provider.id, modelId: 'reasoner' }, async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(Buffer.from('data: {"usage":{"prompt_tokens":9,"completion_tokens":2},"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } }));
    const response = await recorded('https://unused.invalid'); const reader = response.body!.getReader(); await reader.read();
    let settled = false; const barrier = settleRecordedFetch(recorded).then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(h.listUsage(f.context, {}).items[0]).toMatchObject({ state: 'IN_FLIGHT', inputTokens: null });
    expect(f.store.get(job.id)?.requests[0]?.encryptedReceipt).toBeUndefined();
    stream.close(); await barrier;
    expect(h.listUsage(f.context, {}).items[0]).toMatchObject({ state: 'COMPLETED', inputTokens: 9, outputTokens: 2 });
    expect(f.store.get(job.id)?.requests[0]?.encryptedReceipt).not.toContain('prompt_tokens');
    await reader.cancel();
  });
  it('同一请求键在两个任务独立计数，修改在途价格不会重定价', () => {
    const f = fixture(), h = f.handlers(), first = f.add(), second = f.add(); h.setModelPricing(f.context, f.pricing());
    const scope = f.ledger.forJob(first.id, new AbortController().signal); scope.begin(f.descriptor('same-key'));
    h.setModelPricing(f.context, { ...f.pricing('CNY'), inputPerMillion: 40 });
    scope.complete('same-key', { status: 200, headers: [], bodyBase64: Buffer.from('{"usage":{"input_tokens":1000000,"output_tokens":500000,"cached_tokens":250000}}').toString('base64') });
    f.complete(second.id, 'same-key');
    const rows = h.listUsage(f.context, {}).items;
    expect(rows).toHaveLength(2); expect(rows.find(row => row.jobId === first.id)).toMatchObject({ estimatedAmount: 7.75, currency: 'USD' });
    expect(rows.find(row => row.jobId === second.id)).toMatchObject({ estimatedAmount: 34.75, currency: 'CNY' });
    expect(h.getUsageSummary(f.context, {}).taskCount).toBe(2);
  });
  it('计量插入失败时运行登记回滚且无网络；完整回执后统计失败不重发', async () => {
    const f = fixture(), job = f.add(); let calls = 0;
    const ledger = new RequestLedger(f.store, f.secrets, async () => { calls++; return new Response('{}'); });
    f.db.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON desktop_usage_records BEGIN SELECT RAISE(ABORT,'blocked'); END;");
    await expect(ledger.forJob(job.id, new AbortController().signal).fetch(f.descriptor('one'), 'https://unused.invalid')).rejects.toThrow();
    expect(calls).toBe(0); expect(f.ledger.summaries(job.id)).toEqual([]);
    f.db.exec('DROP TRIGGER fail_usage');
    const scope = ledger.forJob(job.id, new AbortController().signal);
    f.db.exec("CREATE TRIGGER fail_usage_update BEFORE UPDATE ON desktop_usage_records BEGIN SELECT RAISE(ABORT,'blocked'); END;");
    await scope.fetch(f.descriptor('one'), 'https://unused.invalid');
    expect(f.ledger.summaries(job.id)[0]?.state).toBe('COMPLETED');
    await scope.fetch(f.descriptor('one'), 'https://unused.invalid'); expect(calls).toBe(1);
  });
  it('价格修改只影响后续请求；按币种汇总且剔除不能完整计价请求', () => {
    const f = fixture(), h = f.handlers(), job = f.add();
    h.setModelPricing(f.context, f.pricing()); f.complete(job.id, 'usd');
    f.advance('2026-11-06T02:00:00.000Z'); h.setModelPricing(f.context, { ...f.pricing('CNY'), perRequest: 1 }); f.complete(job.id, 'cny');
    f.complete(job.id, 'missing', 200, { input_tokens: 1 });
    const summary = h.getUsageSummary(f.context, {});
    expect(summary.amounts).toEqual([{ currency: 'CNY', estimatedAmount: 8.25, pricedRequests: 1 }, { currency: 'USD', estimatedAmount: 7.75, pricedRequests: 1 }]);
    expect(h.listUsage(f.context, {}).items.find(row => row.requestKey === 'usd')?.pricingSnapshot?.updatedAt).toBe('2026-11-06T01:00:00.000Z');
    expect(h.listUsage(f.context, {}).items.find(row => row.requestKey === 'missing')?.estimatedAmount).toBeNull();
    expect(summary).toMatchObject({ requestCount: 3, taskCount: 1, withUsageCount: 3, inputTokens: 2000001 });
    expect(h.listModelPricing(f.context, {}).items).toHaveLength(1);
  });
  it('取消或失败的任务保留前序完整用量，HTTP失败与UNKNOWN分别计数', () => {
    const f = fixture(), h = f.handlers(), job = f.add();
    f.complete(job.id, 'success'); f.complete(job.id, 'http-error', 429, { input_tokens: 3, output_tokens: 1 });
    const scope = f.ledger.forJob(job.id, new AbortController().signal); scope.begin(f.descriptor('pending')); scope.unknown('pending');
    f.db.prepare("UPDATE jobs SET status='CANCELLED' WHERE id=?").run(job.id);
    expect(h.getUsageSummary(f.context, {})).toMatchObject({ requestCount: 3, completedCount: 2, failedResponseCount: 1, unknownCount: 1, inFlightCount: 0, inputTokens: 1000003, outputTokens: 500001, taskCount: 1 });
    expect(() => scope.begin(f.descriptor('another'))).toThrow();
  });
  it('崩溃恢复同步未知状态，迟到完整回执可收敛且保持同一条记录', () => {
    const f = fixture(), h = f.handlers(), job = f.add(), scope = f.ledger.forJob(job.id, new AbortController().signal);
    scope.begin(f.descriptor('late')); expect(h.getUsageSummary(f.context, {}).inFlightCount).toBe(1);
    f.ledger.recover(job.id); expect(h.getUsageSummary(f.context, {}).unknownCount).toBe(1);
    scope.complete('late', { status: 200, headers: [], bodyBase64: Buffer.from('{"usage":{"input_tokens":2,"output_tokens":0}}').toString('base64') });
    expect(h.getUsageSummary(f.context, {})).toMatchObject({ requestCount: 1, completedCount: 1, unknownCount: 0, outputTokens: 0 });
  });
  it('无用量和无价格显示null，空统计不会制造零Token或零费用', () => {
    const f = fixture(), h = f.handlers();
    expect(h.getUsageSummary(f.context, {})).toMatchObject({ requestCount: 0, inputTokens: null, outputTokens: null, amounts: [] });
    const job = f.add(); f.complete(job.id, 'unprovided', 500, undefined);
    const scope = f.ledger.forJob(job.id, new AbortController().signal); scope.begin(f.descriptor('empty'));
    scope.complete('empty', { status: 200, headers: [], bodyBase64: 'e30=' });
    expect(h.listUsage(f.context, {}).items.find(row => row.requestKey === 'empty')).toMatchObject({ inputTokens: null, outputTokens: null, estimatedAmount: null, currency: null, usageSource: 'UNAVAILABLE' });
  });
  it('项目和连接被删除后保留最小名称、价格和用量，公开结果不含秘密', () => {
    const f = fixture(), h = f.handlers(), job = f.add(); h.setModelPricing(f.context, f.pricing()); f.complete(job.id, 'retained');
    f.db.prepare('DELETE FROM projects WHERE id=?').run(f.project.id); f.repository.deleteProvider(f.provider.id);
    expect(f.store.get(job.id)).toBeUndefined();
    const row = h.listUsage(f.context, {}).items[0]!;
    expect(row).toMatchObject({ projectId: f.project.id, projectName: f.project.name, providerName: f.provider.name, estimatedAmount: 7.75, state: 'COMPLETED' });
    const data = JSON.stringify({ list: h.listUsage(f.context, {}), summary: h.getUsageSummary(f.context, {}), prices: h.listModelPricing(f.context, {}) });
    for (const secret of ['PRIVATE-API-KEY', 'PRIVATE-PROMPT', 'PRIVATE-RESPONSE', 'PRIVATE-HEADER', 'secret-endpoint.invalid', 'encryptedReceipt', 'bodyBase64']) expect(data).not.toContain(secret);
    expect(h.getUsageSummary(f.context, {}).taskCount).toBe(1);
  });
  it('时间/项目/连接/模型/用途/状态筛选一致，分页和逆序范围有校验', () => {
    const f = fixture(), h = f.handlers(), job = f.add(); f.complete(job.id, 'old');
    f.advance('2026-11-06T03:00:00.000Z'); f.complete(job.id, 'new');
    const filter = { from: '2026-11-06T10:00:00+08:00', to: '2026-11-06T04:00:00Z', projectId: f.project.id, providerId: f.provider.id, modelId: 'reasoner', purpose: 'MODEL', state: 'COMPLETED' as const };
    expect(h.listUsage(f.context, filter).items.map(row => row.requestKey)).toEqual(['new']);
    expect(h.getUsageSummary(f.context, filter).requestCount).toBe(1);
    expect(h.listUsage(f.context, { limit: 1, offset: 1 }).items[0]?.requestKey).toBe('old');
    expect(h.listUsage(f.context, { modelId: 'missing' }).total).toBe(0);
    expect(() => h.listUsage(f.context, { limit: 201 })).toThrow();
    expect(() => h.listUsage(f.context, { offset: -1 })).toThrow();
    expect(() => h.getUsageSummary(f.context, { from: '2026-11-07T00:00:00Z', to: '2026-11-06T00:00:00Z' })).toThrow();
  });
  it('Token总数超过精确整数范围时保留明细并明确汇总限制', () => {
    const f = fixture(), h = f.handlers(), job = f.add();
    f.complete(job.id, 'large:1', 200, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 });
    f.complete(job.id, 'large:2', 200, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 });
    expect(h.getUsageSummary(f.context, {})).toMatchObject({ inputTokens: null, outputTokens: 0 });
    expect(h.getUsageSummary(f.context, {}).historyNote).toContain('超出可精确表示');
    expect(h.listUsage(f.context, {}).items[0]?.inputTokens).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('保存单价无需任何请求，拒绝无效模型及非有限/负数单价', () => {
    const f = fixture(), h = f.handlers();
    expect(() => h.setModelPricing(f.context, { ...f.pricing(), modelId: 'missing' })).toThrow();
    for (const value of [-1, NaN, Infinity, 1e10]) expect(() => h.setModelPricing(f.context, { ...f.pricing(), perRequest: value })).toThrow();
    h.setModelPricing(f.context, { ...f.pricing(), inputPerMillion: null, outputPerMillion: null, cachedInputPerMillion: null, perRequest: null });
    expect(h.listUsage(f.context, {}).total).toBe(0); expect(f.events.publish).toHaveBeenCalledWith({ topic: 'usage' });
  });
  it('重开SQLite后历史与冻结价格保持，不依赖运行账本存活', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixelmuse-usage-')); directories.push(dir); const filename = join(dir, 'desktop.sqlite');
    const f = fixture(filename), h = f.handlers(), job = f.add(); h.setModelPricing(f.context, f.pricing()); f.complete(job.id, 'persisted'); f.db.close();
    const db = openDatabase(filename); databases.push(db);
    const next = createUsageHandlers(f.context, db);
    expect(next.listUsage(f.context, {}).items[0]).toMatchObject({ estimatedAmount: 7.75, state: 'COMPLETED', pricingSnapshot: { inputPerMillion: 4 } });
  });
});
describe('历史回填与安全有界导出', () => {
  it('可靠旧回执校验hash后回填；不套用新价格，查询不再次解密', () => {
    const f = fixture(), job = f.add(); f.complete(job.id, 'historical');
    f.db.prepare('DELETE FROM desktop_usage_records').run();
    const price = { ...f.pricing(), updatedAt: '2026-11-06T06:00:00Z' };
    f.db.prepare('INSERT INTO desktop_model_pricing VALUES (?,?,?)').run(price.providerId, price.modelId, JSON.stringify(price));
    const decrypt = vi.spyOn(f.secrets, 'decrypt'), h = f.handlers();
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(h.listUsage(f.context, {}).items[0]).toMatchObject({ usageSource: 'PROVIDER', inputTokens: 1000000, estimatedAmount: null, pricingSnapshot: null });
    for (let index = 0; index < 3; index++) { h.getUsageSummary(f.context, {}); h.listUsage(f.context, {}); f.handlers(); }
    expect(decrypt).toHaveBeenCalledTimes(1); expect(h.getUsageSummary(f.context, {}).historyNote).toContain('最多100份');
  });
  it('损坏回执不得回填伪造Token，大快照可回填', () => {
    const f = fixture(), job = f.add(); f.complete(job.id, 'tampered');
    f.store.mutate(job.id, runtime => { runtime.requests[0]!.responseHash = 'f'.repeat(64); });
    const big = f.add(); f.complete(big.id, 'big');
    const raw = f.db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get(big.id) as { payload: string };
    f.db.prepare('UPDATE desktop_job_runtime SET payload=? WHERE job_id=?').run(raw.payload.replace('"input":{', '"input":{"filler":"' + 'x'.repeat(1024 * 1024) + '",'), big.id);
    f.db.prepare('DELETE FROM desktop_usage_records').run();
    const decrypt = vi.spyOn(f.secrets, 'decrypt'), h = f.handlers();
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(h.listUsage(f.context, {}).items).toHaveLength(2);
    expect(h.listUsage(f.context, {}).items.find(row => row.requestKey === 'tampered')?.usageSource).toBe('UNAVAILABLE');
    expect(h.listUsage(f.context, {}).items.find(row => row.requestKey === 'big')).toMatchObject({ state: 'COMPLETED', inputTokens: 1000000 });
    expect(h.getUsageSummary(f.context, {}).historyNote).toContain('跳过1项');
  });
  it('每次启动最多处理100份运行快照，边界后的回执不读取', () => {
    const f = fixture(); for (let i = 0; i < 101; i++) f.complete(f.add().id, `old:${i}`);
    f.db.prepare('DELETE FROM desktop_usage_records').run(); const decrypt = vi.spyOn(f.secrets, 'decrypt');
    const h = f.handlers(); expect(decrypt).toHaveBeenCalledTimes(100); expect(h.listUsage(f.context, {}).total).toBe(100);
  });
  it('历史回填另有200个请求上限和8MiB总预算', () => {
    const f = fixture(), job = f.add(); f.complete(job.id, 'template', 200, { input_tokens: 1, output_tokens: 1 });
    const template = f.store.get(job.id)!.requests[0]!;
    f.store.mutate(job.id, runtime => { runtime.requests = Array.from({ length: 201 }, (_, index) => ({ ...template, descriptor: f.descriptor(`history:${index}`) })); });
    f.db.prepare('DELETE FROM desktop_usage_records').run(); const decrypt = vi.spyOn(f.secrets, 'decrypt');
    const h = f.handlers(); expect(h.listUsage(f.context, {}).total).toBe(200); expect(decrypt).toHaveBeenCalledTimes(200);
    expect(h.getUsageSummary(f.context, {}).historyNote).toContain('最多200个请求');
    const g = fixture();
    for (let index = 0; index < 10; index++) {
      const item = g.add(); g.complete(item.id, `old:${index}`);
      const raw = g.db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get(item.id) as { payload: string };
      const runtime = JSON.parse(raw.payload); runtime.snapshot.input.filler = 'x'.repeat(950000);
      g.db.prepare('UPDATE desktop_job_runtime SET payload=? WHERE job_id=?').run(JSON.stringify(runtime), item.id);
    }
    g.db.prepare('DELETE FROM desktop_usage_records').run(); const otherDecrypt = vi.spyOn(g.secrets, 'decrypt');
    expect(g.handlers().listUsage(g.context, {}).total).toBe(8); expect(otherDecrypt).toHaveBeenCalledTimes(8);
  });
  it('CSV转义公式、前导控制符和引号，筛选口径相同且无原始秘密', () => {
    const f = fixture(), h = f.handlers(), job = f.add(); f.complete(job.id, '=EXCEL("quoted")');
    const file = h.exportUsage(f.context, { providerId: f.provider.id }); const csv = Buffer.from(file.base64, 'base64').toString('utf8');
    expect(file.mimeType).toBe('text/csv'); expect(file.name).toMatch(/\.csv$/);
    expect(csv).toContain('"\'\t=FORMULA()"'); expect(csv).toContain('"\'@private-service"');
    expect(csv).toContain('"\'=EXCEL(""quoted"")"');
    expect(csv).not.toContain('PRIVATE-RESPONSE'); expect(csv).not.toContain('PRIVATE-HEADER'); expect(csv).not.toContain('secret-endpoint');
    expect(csv.split('\r\n')).toHaveLength(3);
    const empty = Buffer.from(h.exportUsage(f.context, { providerId: 'missing' }).base64, 'base64').toString('utf8'); expect(empty.split('\r\n')).toHaveLength(2);
  });
  it('CSV超过10000条或8MiB拒绝整个导出', () => {
    const f = fixture(), h = f.handlers(), job = f.add(); f.complete(job.id, 'template'); const entry = list(f).items[0]!;
    const insert = f.db.prepare('INSERT INTO desktop_usage_records VALUES (?,?,?,?,?)');
    f.db.transaction(() => { for (let i = 0; i < 10000; i++) { const row: UsageEntry = { ...entry, id: `copy:${i}`, requestKey: `copy:${i}` }; insert.run(row.id, row.jobId, row.requestKey, JSON.stringify(row), row.startedAt); } })();
    expect(() => h.exportUsage(f.context, {})).toThrow(/10000/);
    f.db.prepare('DELETE FROM desktop_usage_records').run();
    f.db.transaction(() => { for (let i = 0; i < 4500; i++) { const row: UsageEntry = { ...entry, id: `large:${i}`, requestKey: `large:${i}`, projectName: 'x'.repeat(1000), providerName: 'y'.repeat(1000) }; insert.run(row.id, row.jobId, row.requestKey, JSON.stringify(row), row.startedAt); } })();
    expect(() => h.exportUsage(f.context, {})).toThrow(/8MiB/);
  });
});
