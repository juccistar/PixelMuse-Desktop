import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Value } from '@sinclair/typebox/value';
import { EcomRepository, DesktopHistoryRepository, LocalAssetStore, SecretBox, SuiteCatalog, openDatabase } from '@ecomgen/core';
import { operations, type Input, type Operation, type Output } from '@ecomgen/contracts';
import { registerDomainCommands } from '../../src/commands/index.js';
import { registerExecutors, createExecutionSnapshot, candidateIdFor } from '../../src/execution/index.js';
import { RuntimeStore } from '../../src/runtime/state.js';
import { RequestLedger } from '../../src/runtime/request-ledger.js';
import { ResourceRegistry } from '../../src/runtime/resources.js';
import { InvalidationEvents } from '../../src/runtime/events.js';
import { PersistentScheduler } from '../../src/runtime/scheduler.js';
import type { CommandContext } from '../../src/runtime/ports.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ecomgen-draft-compensation-'));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const image = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#3a73aa' } }).png().toBuffer();
  const posts: Array<{ url: string; key: string | undefined; body: unknown }> = [];
  const downloads = new Map<number, number>();
  const failures = new Set<number>();
  const rejected = new Set<number>();
  const held = new Map<number, ServerResponse>();
  const hold = new Set<number>();
  const dropped = new Set<number>();
  let baseUrl = '';
  const sendImage = (res: ServerResponse) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(image); };
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      posts.push({ url: req.url, key: req.headers['idempotency-key'] as string | undefined, body: JSON.parse(Buffer.concat(chunks).toString()) });
      if (dropped.has(posts.length)) { req.socket.destroy(); return; }
      if (rejected.has(posts.length)) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({error:{message:'synthetic known rejection',type:'invalid_request_error'}})); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: `${baseUrl}/downloads/${posts.length}.png` }] })); return;
    }
    const match = /^\/downloads\/(\d+)\.png$/.exec(req.url ?? '');
    if (req.method === 'GET' && match) {
      const index = Number(match[1]); downloads.set(index, (downloads.get(index) ?? 0) + 1);
      if (failures.delete(index)) { res.writeHead(503); res.end('synthetic download failure'); return; }
      if (hold.has(index)) { held.set(index, res); return; }
      sendImage(res); return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const release = (index: number) => { hold.delete(index); const res = held.get(index); if (res) { held.delete(index); sendImage(res); } };
  cleanups.push(async () => { for (const index of held.keys()) release(index); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const secrets = new SecretBox(randomBytes(32));
  async function open() {
    const db = openDatabase(join(root, 'drafts.sqlite')), repository = new EcomRepository(db), storage = new LocalAssetStore(root);
    await storage.initialize();
    const store = new RuntimeStore(db), ledger = new RequestLedger(store, secrets), resources = new ResourceRegistry(store, storage);
    const events = new InvalidationEvents(store, () => undefined);
    let context: CommandContext;
    const scheduler = new PersistentScheduler(store, repository, ledger, () => context, 2);
    context = { repository, history: new DesktopHistoryRepository(db), storage, secrets,
      catalog: new SuiteCatalog({ dataDir: root, repository }), scheduler, requestLedger: ledger, resources, events,
      clock: store.clock, idFactory: randomUUID, signal: new AbortController().signal, transaction: work => events.transaction(work) };
    scheduler.register(registerExecutors(context));
    const handlers = registerDomainCommands(context);
    const invoke = async <K extends Operation>(name: K, input: Input<K>): Promise<Output<K>> => {
      expect(Value.Check(operations[name].input, input)).toBe(true);
      const handler = handlers[name]; if (!handler) throw new Error(`Missing domain command ${name}`);
      const result = await (handler as (ctx: CommandContext, input: Input<K>) => Promise<Output<K>>)(context, input);
      expect(Value.Check(operations[name].output, result)).toBe(true); return result;
    };
    let closed = false;
    const close = async () => { if (closed) return; await scheduler.close(); db.close(); closed = true; };
    cleanups.push(close);
    const wait = async (id: string, status: string) => {
      await vi.waitFor(() => expect(repository.getJob(id)?.status).toBe(status), { timeout: 10000, interval: 10 });
      await scheduler.waitForIdle([id]);
    };
    return { db, repository, storage, store, ledger, scheduler, context, invoke, close, wait };
  }
  const backend = await open();
  const provider = backend.repository.saveProvider({ name: 'synthetic loopback', baseUrl: `${baseUrl}/v1`, encryptedApiKey: secrets.encrypt('synthetic-key'), reasoningProtocol: 'openai', models: [
    { id: 'gpt-image-1', supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, imageApiKind: 'openai_images' },
  ] });
  const draft = await backend.invoke('createPatternDraft', { name: 'synthetic draft', composeType: 'PLACEMENT' });
  const submit = (count = 2) => backend.invoke('createDraftBatch', { draftId: draft.id, clientKey: randomUUID(), operation: 'GENERATE', theme: 'synthetic flowers', background: 'WHITE', providerId: provider.id, imageModelId: 'gpt-image-1', candidateCount: count });
  return { ...backend, open, submit, provider, draft, posts, downloads, failures, held, hold, release, dropped, rejected };
}


describe('independent compensation verification', () => {
  it.each([false, true])('known HTTP400 must allow explicit failed-slot replacement (restart=%s)', async restart => {
    const f = await fixture(); f.rejected.add(2);
    const created = await f.submit(), id = created.job!.id;
    f.scheduler.start(); await f.wait(id, 'FAILED');
    const survivor = f.repository.listDraftCandidates(f.draft.id)[0]!;
    const survivorBytes = await f.storage.read(survivor.storagePath);
    expect(f.repository.listDraftSlots(created.batch.id).map(s => s.status)).toEqual(['SUCCEEDED', 'FAILED']);
    expect(f.ledger.summaries(id).map(s => s.state)).toEqual(['COMPLETED', 'COMPLETED']);
    const receipts = f.store.get(id)!.requests.map(r => f.ledger.forJob(id, new AbortController().signal).receipt(r.descriptor.requestKey)?.status);
    expect(receipts).toEqual([200, 400]);
    const snapshot = f.store.get(id)!.snapshot;
    const requests = f.ledger.summaries(id);
    f.repository.saveProvider({ ...f.provider, baseUrl: 'http://127.0.0.1:1/v1', encryptedApiKey: f.context.secrets.encrypt('changed-synthetic-key') });
    await f.invoke('updatePatternDraft', { draftId: f.draft.id, expectedRevision: f.repository.getPatternDraft(f.draft.id)!.revision, name: 'changed draft' });
    let active: Awaited<ReturnType<typeof f.open>> = f;
    if (restart) { await f.close(); active = await f.open(); }
    const retried = await active.invoke('retryFailedDraftBatch', {draftId:f.draft.id, batchId:created.batch.id});
    expect(retried.reused).toBe(false);
    expect(retried.job!.id).not.toBe(id);
    expect(retried.batch.candidateCount).toBe(2);
    expect(retried.batch.slots.map(slot => [slot.jobId, slot.attempt])).toEqual([[id, 1], [retried.job!.id, 2]]);
    expect(active.repository.getJob(retried.job!.id)?.input).toMatchObject({ slots: [2], replacementOf: id });
    active.scheduler.start();
    await vi.waitFor(() => expect(['FAILED', 'SUCCEEDED']).toContain(active.repository.getJob(retried.job!.id)?.status), {timeout:10000,interval:10});
    await active.scheduler.waitForIdle([retried.job!.id]);
    console.log('HTTP400 recovery evidence', JSON.stringify({restart, posts:f.posts.length, status:active.repository.getJob(retried.job!.id)?.status, slots:active.repository.listDraftSlots(created.batch.id).map(s=>({status:s.status,attempt:s.attempt,jobId:s.jobId})), candidateCount:active.repository.listDraftCandidates(f.draft.id).length, receipts, requests:active.ledger.summaries(id)}));
    expect(active.repository.getDraftCandidate(survivor.id)).toEqual(survivor);
    expect(await active.storage.read(survivor.storagePath)).toEqual(survivorBytes);
    expect.soft(active.repository.getJob(retried.job!.id)?.status).toBe('SUCCEEDED');
    expect.soft(active.repository.listDraftCandidates(f.draft.id)).toHaveLength(2);
    expect.soft(f.posts).toHaveLength(3);
    expect(f.posts[2]!.body).toEqual(f.posts[1]!.body);
    expect(f.posts[2]!.key).not.toBe(f.posts[1]!.key);
    expect(f.downloads).toEqual(new Map([[1, 1], [3, 1]]));
    expect(active.store.get(id)!.snapshot).toEqual(snapshot);
    expect(active.ledger.summaries(id)).toEqual(requests);
  });

  it.each(['none', 'before-compensation', 'after-compensation'])('recovers mixed successful receipt and rejected slot with only one replacement POST (restart=%s)', async restart => {
    const f = await fixture(); f.failures.add(1); f.rejected.add(2);
    const created = await f.submit(), id = created.job!.id;
    const snapshot = f.store.get(id)!.snapshot;
    f.scheduler.start(); await f.wait(id, 'FAILED');
    expect(f.ledger.summaries(id).map(request => [request.state, request.localState])).toEqual([['COMPLETED', 'PENDING'], ['COMPLETED', 'PENDING']]);
    f.repository.saveProvider({ ...f.provider, baseUrl: 'http://127.0.0.1:1/v1', encryptedApiKey: f.context.secrets.encrypt('changed-synthetic-key') });
    let active: Awaited<ReturnType<typeof f.open>> = f;
    if (restart === 'before-compensation') { await f.close(); active = await f.open(); }
    const retried = await active.invoke('retryFailedDraftBatch', { draftId: f.draft.id, batchId: created.batch.id });
    const replacementId = retried.batch.slots[1]!.jobId!;
    expect(retried.reused).toBe(false);
    expect(retried.batch.candidateCount).toBe(2);
    expect(retried.batch.slots.map(slot => [slot.status, slot.jobId, slot.attempt])).toEqual([['QUEUED', id, 1], ['QUEUED', replacementId, 2]]);
    expect(replacementId).not.toBe(id);
    const replacementSnapshot = active.store.get(replacementId)!.snapshot;
    expect(replacementSnapshot.effective.execution).toEqual({ ...(snapshot.effective.execution as object), slots: [{ batchId: created.batch.id, index: 2, attempt: 2 }] });
    if (restart === 'after-compensation') { await active.close(); active = await f.open(); }
    active.scheduler.start(); await active.wait(id, 'SUCCEEDED'); await active.wait(replacementId, 'SUCCEEDED');
    expect(f.posts).toHaveLength(3);
    expect(f.posts[2]!.body).toEqual(f.posts[1]!.body);
    expect(f.posts[2]!.key).not.toBe(f.posts[1]!.key);
    expect(f.downloads).toEqual(new Map([[1, 2], [3, 1]]));
    expect(active.repository.listDraftCandidates(f.draft.id)).toHaveLength(2);
    expect(active.repository.listDraftSlots(created.batch.id).map(slot => slot.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    expect(active.store.get(id)!.snapshot).toEqual(snapshot);
    expect(active.store.get(replacementId)!.snapshot).toEqual(replacementSnapshot);
    expect(active.ledger.summaries(id).map(request => request.localState)).toEqual(['COMMITTED', 'PENDING']);
    expect(active.ledger.summaries(replacementId).map(request => request.localState)).toEqual(['COMMITTED']);
    expect(active.db.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 2 });
  });

  it('does not replace a rejected slot while another result in the batch is still returning', async () => {
    const f = await fixture(); f.rejected.add(1); f.hold.add(2);
    const created = await f.submit(), id = created.job!.id;
    f.scheduler.start();
    await vi.waitFor(() => expect(f.held.has(2)).toBe(true), { timeout: 10000, interval: 10 });
    const slots = f.repository.listDraftSlots(created.batch.id);
    const active = await f.invoke('retryFailedDraftBatch', { draftId: f.draft.id, batchId: created.batch.id });
    expect(active).toMatchObject({ reused: true, job: { id, status: 'RUNNING' } });
    expect(f.repository.listDraftSlots(created.batch.id)).toEqual(slots);
    expect(f.posts).toHaveLength(2);
    f.release(2); await f.wait(id, 'FAILED');
    const survivor = f.repository.getDraftCandidate(candidateIdFor(created.batch.id, 2))!;
    const compensated = await f.invoke('retryFailedDraftBatch', { draftId: f.draft.id, batchId: created.batch.id });
    await f.wait(compensated.job!.id, 'SUCCEEDED');
    expect(f.repository.getDraftCandidate(survivor.id)).toEqual(survivor);
    expect(f.posts).toHaveLength(3);
    expect(f.downloads).toEqual(new Map([[2, 1], [3, 1]]));
  });

  it('rolls back a new replacement intent when a later historical owner has a stale attempt', async () => {
    const f = await fixture(); f.failures.add(1); f.failures.add(2);
    const created = await f.submit(), originalId = created.job!.id;
    f.scheduler.start(); await f.wait(originalId, 'FAILED');
    const historical = f.context.transaction(() => {
      const job = f.repository.createJob({ id: randomUUID(), type: 'PATTERN_DRAFT_GENERATE', projectId: null, storyboardItemId: null,
        providerId: f.provider.id, modelId: 'gpt-image-1', input: { draftId: f.draft.id, batchId: created.batch.id, slots: [1], task: 'BATCH' } });
      f.repository.assignDraftSlotsToJob(created.batch.id, [1], job.id, true);
      f.scheduler.freeze(job.id, createExecutionSnapshot(f.context, job)); return job;
    });
    f.rejected.add(3); f.scheduler.enqueue(historical.id); await f.wait(historical.id, 'FAILED');
    f.repository.updateDraftSlot(created.batch.id, 2, { attempt: 9 });
    const slots = f.repository.listDraftSlots(created.batch.id);
    const originalRuntime = f.store.get(originalId), historicalRuntime = f.store.get(historical.id);
    await expect(f.invoke('retryFailedDraftBatch', { draftId: f.draft.id, batchId: created.batch.id })).rejects.toMatchObject({ code: 'STALE_SLOT_ATTEMPT' });
    expect(f.repository.listDraftSlots(created.batch.id)).toEqual(slots);
    expect(f.store.get(originalId)).toEqual(originalRuntime);
    expect(f.store.get(historical.id)).toEqual(historicalRuntime);
    expect(f.repository.getJob(historical.id)?.status).toBe('FAILED');
    expect(f.db.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 2 });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.posts).toHaveLength(3);
  });

  it.each([false, true])('failed-slot compensation must not revive a deleted finalized successful candidate (restart=%s)', async restart => {
    const f = await fixture(); f.failures.add(2);
    const created = await f.submit(), id = created.job!.id;
    f.scheduler.start(); await f.wait(id, 'FAILED');
    const survivor = f.repository.listDraftCandidates(f.draft.id)[0]!;
    const finalized = await f.invoke('finalizeDraftCandidate', { draftId: f.draft.id, candidateId: survivor.id, clientKey: randomUUID() });
    const pattern = f.repository.getPattern(finalized.pattern.id)!;
    const patternBytes = await f.storage.read(pattern.storagePath!);
    const successfulSlot = f.repository.listDraftSlots(created.batch.id)[0]!;
    const snapshot = f.store.get(id)!.snapshot;
    await f.invoke('deleteDraftCandidate', {draftId:f.draft.id, candidateId:survivor.id});
    expect(f.repository.getDraftCandidate(survivor.id)).toBeUndefined();
    expect(f.repository.listDraftSlots(created.batch.id).map(s=>s.status)).toEqual(['SUCCEEDED','FAILED']);
    let active: Awaited<ReturnType<typeof f.open>> = f;
    if (restart) { await f.close(); active = await f.open(); }
    await active.invoke('retryFailedDraftBatch', {draftId:f.draft.id,batchId:created.batch.id});
    active.scheduler.start(); await active.wait(id, 'SUCCEEDED');
    expect(active.repository.getDraftCandidate(survivor.id)).toBeUndefined();
    expect(active.repository.listDraftCandidates(f.draft.id)).toHaveLength(1);
    expect(active.repository.listDraftSlots(created.batch.id)[0]).toEqual(successfulSlot);
    expect(active.repository.getPattern(pattern.id)).toEqual(pattern);
    expect(await active.storage.read(pattern.storagePath!)).toEqual(patternBytes);
    expect(active.store.get(id)!.snapshot).toEqual(snapshot);
    expect(f.posts).toHaveLength(2);
    expect(f.downloads).toEqual(new Map([[1, 1], [2, 2]]));
  });
});
