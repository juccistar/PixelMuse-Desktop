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
  return { ...backend, open, submit, provider, draft, posts, downloads, failures, held, hold, release, dropped };
}

describe('draft compensation through real commands and persistent scheduler', () => {
  it.each([false, true])('replays a complete receipt after download failure, preserving partial success and frozen inputs (restart=%s)', async restart => {
    const f = await fixture(); f.failures.add(1);
    const created = await f.submit(); const id = created.job!.id;
    const snapshot = f.store.get(id)!.snapshot;
    f.scheduler.start(); await f.wait(id, 'FAILED');
    expect(f.repository.listDraftSlots(created.batch.id).map(slot => slot.status)).toEqual(['FAILED', 'SUCCEEDED']);
    const successful = f.repository.listDraftCandidates(f.draft.id)[0]!;
    expect(f.ledger.summaries(id).map(row => [row.state, row.localState])).toEqual([['COMPLETED', 'PENDING'], ['COMPLETED', 'COMMITTED']]);
    // A retry must not freeze this changed configuration or change the original request fingerprint.
    f.repository.saveProvider({ ...f.provider, baseUrl: 'http://127.0.0.1:1/v1', encryptedApiKey: f.context.secrets.encrypt('changed-synthetic-key') });
    let active: Awaited<ReturnType<typeof f.open>> = f;
    if (restart) { await f.close(); active = await f.open(); }
    const retried = await active.invoke('retryFailedDraftBatch', { draftId: f.draft.id, batchId: created.batch.id });
    expect(retried).toMatchObject({ reused: true, job: { id } });
    expect(retried.batch.slots.map(slot => [slot.jobId, slot.attempt])).toEqual([[id, 1], [id, 1]]);
    active.scheduler.start(); await active.wait(id, 'SUCCEEDED');
    expect(f.posts).toHaveLength(2); expect(f.downloads).toEqual(new Map([[1, 2], [2, 1]]));
    expect(active.store.get(id)!.snapshot).toEqual(snapshot);
    expect(active.repository.getDraftCandidate(successful.id)).toEqual(successful);
    expect(active.repository.getDraftCandidate(candidateIdFor(created.batch.id, 1))).toBeDefined();
    expect(active.ledger.summaries(id).map(row => row.localState)).toEqual(['COMMITTED', 'COMMITTED']);
    expect(active.db.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 1 });
  });

  it('reuses an active job during a held second download and preserves its already returned result', async () => {
    const f = await fixture(); f.failures.add(1); f.hold.add(2);
    const created = await f.submit(), id = created.job!.id; f.scheduler.start();
    await vi.waitFor(() => expect(f.held.has(2)).toBe(true), { timeout: 10000, interval: 10 });
    const before = f.repository.listDraftSlots(created.batch.id);
    expect(before.map(slot => slot.status)).toEqual(['FAILED', 'RUNNING']);
    expect(f.ledger.summaries(id).map(row => row.state)).toEqual(['COMPLETED', 'COMPLETED']);
    const pending = await f.invoke('retryFailedDraftBatch', { draftId: f.draft.id, batchId: created.batch.id });
    expect(pending).toMatchObject({ reused: true, job: { id, status: 'RUNNING' } });
    expect(f.repository.listDraftSlots(created.batch.id)).toEqual(before);
    expect(f.posts).toHaveLength(2);
    f.release(2); await f.wait(id, 'FAILED');
    expect(f.repository.listDraftSlots(created.batch.id).map(slot => slot.status)).toEqual(['FAILED', 'SUCCEEDED']);
    expect(f.repository.getDraftCandidate(candidateIdFor(created.batch.id, 2))).toBeDefined();
    await f.invoke('retryFailedDraftBatch', { draftId: f.draft.id, batchId: created.batch.id });
    await f.wait(id, 'SUCCEEDED');
    expect(f.posts).toHaveLength(2); expect(f.downloads).toEqual(new Map([[1, 2], [2, 1]]));
  });

  it('continues a completed response download after shutdown and reopen with no new generation', async () => {
    const f = await fixture(); f.hold.add(1);
    const created = await f.submit(1), id = created.job!.id; f.scheduler.start();
    await vi.waitFor(() => expect(f.held.has(1)).toBe(true), { timeout: 10000, interval: 10 });
    expect(f.ledger.summaries(id)[0]).toMatchObject({ state: 'COMPLETED', localState: 'PENDING' });
    await f.close(); f.release(1);
    const reopened = await f.open();
    expect(reopened.repository.getJob(id)?.status).toBe('CANCELLED');
    // Ordinary retry and compensation both retain the same slot/request identity.
    reopened.scheduler.retry(id); reopened.scheduler.start(); await reopened.wait(id, 'SUCCEEDED');
    expect(f.posts).toHaveLength(1); expect(f.downloads.get(1)).toBe(2);
  });

  it('rejects UNKNOWN even if another slot has a complete failed download receipt, including after restart', async () => {
    const f = await fixture(); f.failures.add(1); f.dropped.add(2);
    const created = await f.submit(), id = created.job!.id; f.scheduler.start(); await f.wait(id, 'UNKNOWN');
    const before = f.repository.listDraftSlots(created.batch.id);
    await expect(f.invoke('retryFailedDraftBatch', { draftId: f.draft.id, batchId: created.batch.id })).rejects.toMatchObject({ code: 'EXTERNAL_UNKNOWN' });
    expect(f.repository.listDraftSlots(created.batch.id)).toEqual(before);
    await f.close(); const reopened = await f.open(); reopened.scheduler.start();
    await expect(reopened.invoke('retryFailedDraftBatch', { draftId: f.draft.id, batchId: created.batch.id })).rejects.toMatchObject({ code: 'EXTERNAL_UNKNOWN' });
    expect(() => reopened.scheduler.retry(id)).toThrow(); expect(f.posts).toHaveLength(2);
  });

  it('resumes every failed owner in a batch split by historical compensation, without reviving surrendered slots', async () => {
    const f = await fixture(); f.failures.add(1); f.failures.add(2);
    const created = await f.submit(), originalId = created.job!.id; f.scheduler.start(); await f.wait(originalId, 'FAILED');
    const originalSnapshot = f.store.get(originalId)!.snapshot;
    // Reproduce persisted old compensation: slot 1 moved to another job; slot 2 still owns original evidence.
    const replacement = f.context.transaction(() => {
      const job = f.repository.createJob({ id: randomUUID(), type: 'PATTERN_DRAFT_GENERATE', projectId: null, storyboardItemId: null,
        providerId: f.provider.id, modelId: 'gpt-image-1', input: { draftId: f.draft.id, batchId: created.batch.id, slots: [1], task: 'BATCH', retry: true } });
      f.repository.assignDraftSlotsToJob(created.batch.id, [1], job.id, true);
      f.scheduler.freeze(job.id, createExecutionSnapshot(f.context, job)); return job;
    });
    f.failures.add(3); f.scheduler.enqueue(replacement.id); await f.wait(replacement.id, 'FAILED');
    expect(f.posts).toHaveLength(3);
    await f.close(); const reopened = await f.open();
    const resumed = await reopened.invoke('retryFailedDraftBatch', { draftId: f.draft.id, batchId: created.batch.id });
    expect(resumed.batch.slots.map(slot => [slot.status, slot.jobId, slot.attempt])).toEqual([
      ['QUEUED', replacement.id, 2], ['QUEUED', originalId, 1],
    ]);
    reopened.scheduler.start(); await reopened.wait(replacement.id, 'SUCCEEDED'); await reopened.wait(originalId, 'SUCCEEDED');
    expect(f.posts).toHaveLength(3); expect(f.downloads).toEqual(new Map([[1, 1], [2, 2], [3, 2]]));
    expect(reopened.repository.listDraftCandidates(f.draft.id)).toHaveLength(2);
    expect(reopened.store.get(originalId)!.snapshot).toEqual(originalSnapshot);
    expect(reopened.ledger.summaries(originalId).map(row => row.localState)).toEqual(['PENDING', 'COMMITTED']);
  });

  it('rolls back all owner retries if a later owner has a stale attempt', async () => {
    const f = await fixture(); f.failures.add(1); f.failures.add(2);
    const created = await f.submit(), originalId = created.job!.id; f.scheduler.start(); await f.wait(originalId, 'FAILED');
    const replacement = f.context.transaction(() => {
      const job = f.repository.createJob({ id: randomUUID(), type: 'PATTERN_DRAFT_GENERATE', projectId: null, storyboardItemId: null,
        providerId: f.provider.id, modelId: 'gpt-image-1', input: { draftId: f.draft.id, batchId: created.batch.id, slots: [1], task: 'BATCH' } });
      f.repository.assignDraftSlotsToJob(created.batch.id, [1], job.id, true);
      f.scheduler.freeze(job.id, createExecutionSnapshot(f.context, job)); return job;
    });
    f.failures.add(3); f.scheduler.enqueue(replacement.id); await f.wait(replacement.id, 'FAILED');
    f.repository.updateDraftSlot(created.batch.id, 2, { attempt: 9 });
    const before = f.repository.listDraftSlots(created.batch.id);
    await expect(f.invoke('retryFailedDraftBatch', { draftId: f.draft.id, batchId: created.batch.id })).rejects.toMatchObject({ code: 'STALE_SLOT_ATTEMPT' });
    expect(f.repository.getJob(replacement.id)?.status).toBe('FAILED');
    expect(f.store.get(replacement.id)?.phase).toBe('SETTLED');
    expect(f.repository.listDraftSlots(created.batch.id)).toEqual(before);
    await new Promise<void>(resolve => setImmediate(resolve)); expect(f.posts).toHaveLength(3);
  });
});
