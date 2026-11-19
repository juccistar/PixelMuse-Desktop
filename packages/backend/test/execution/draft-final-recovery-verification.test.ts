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



describe('final recovery supplementary verification', () => {
  it.each([false, true])('HTTP400 replacement preserves a deleted finalized successful candidate (restart=%s)', async restart => {
    const f = await fixture(); f.rejected.add(2);
    const created = await f.submit(), id = created.job!.id;
    f.scheduler.start(); await f.wait(id, 'FAILED');
    const successful = f.repository.listDraftCandidates(f.draft.id)[0]!;
    const finalized = await f.invoke('finalizeDraftCandidate', {draftId:f.draft.id,candidateId:successful.id,clientKey:randomUUID()});
    const pattern = f.repository.getPattern(finalized.pattern.id)!;
    const bytes = await f.storage.read(pattern.storagePath!);
    const requests = f.store.get(id)!.requests;
    const successfulSlot = f.repository.listDraftSlots(created.batch.id)[0];
    await f.invoke('deleteDraftCandidate', {draftId:f.draft.id,candidateId:successful.id});
    let active: Awaited<ReturnType<typeof f.open>> = f;
    if (restart) { await f.close(); active = await f.open(); }
    const result = await active.invoke('retryFailedDraftBatch', {draftId:f.draft.id,batchId:created.batch.id});
    active.scheduler.start(); await active.wait(result.job!.id, 'SUCCEEDED');
    expect(f.posts).toHaveLength(3);
    expect(active.repository.getDraftCandidate(successful.id)).toBeUndefined();
    expect(active.repository.listDraftCandidates(f.draft.id)).toHaveLength(1);
    expect(active.repository.listDraftSlots(created.batch.id)[0]).toEqual(successfulSlot);
    expect(active.repository.getPattern(pattern.id)).toEqual(pattern);
    expect(await active.storage.read(pattern.storagePath!)).toEqual(bytes);
    expect(active.store.get(id)!.requests).toEqual(requests);
    const recovered = active.repository.listDraftCandidates(f.draft.id)[0]!;
    const replacementFinalized = await active.invoke('finalizeDraftCandidate', {draftId:f.draft.id,candidateId:recovered.id,clientKey:randomUUID()});
    expect(active.repository.getPattern(replacementFinalized.pattern.id)?.sourceJobId).toBe(result.job!.id);
  });
  it('blocks an IN_FLIGHT receipt despite FAILED job and slot rows, before and after restart', async () => {
    const f = await fixture(); f.rejected.add(2);
    const created = await f.submit(), id = created.job!.id;
    f.scheduler.start(); await f.wait(id, 'FAILED');
    f.store.mutate(id, runtime => { runtime.requests[1]!.state = 'IN_FLIGHT'; });
    const before = f.repository.listDraftSlots(created.batch.id);
    await expect(f.invoke('retryFailedDraftBatch',{draftId:f.draft.id,batchId:created.batch.id})).rejects.toMatchObject({code:'EXTERNAL_UNKNOWN'});
    expect(f.repository.listDraftSlots(created.batch.id)).toEqual(before);
    expect(f.db.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({n:1});
    await f.close(); const reopened = await f.open(); reopened.scheduler.start();
    await expect(reopened.invoke('retryFailedDraftBatch',{draftId:f.draft.id,batchId:created.batch.id})).rejects.toMatchObject({code:'EXTERNAL_UNKNOWN'});
    expect(reopened.repository.listDraftSlots(created.batch.id)).toEqual(before);
    expect(f.posts).toHaveLength(2);
  });
  it('uses null sourceJobId when the selected candidate slot has no owner', async () => {
    const f = await fixture();
    const created = await f.submit(), id = created.job!.id;
    f.scheduler.start(); await f.wait(id, 'SUCCEEDED');
    const candidate = f.repository.listDraftCandidates(f.draft.id)[0]!;
    f.db.prepare('UPDATE draft_slots SET job_id = NULL WHERE batch_id = ? AND slot_index = ?').run(created.batch.id, candidate.slotIndex);
    const result = await f.invoke('finalizeDraftCandidate',{draftId:f.draft.id,candidateId:candidate.id,clientKey:randomUUID()});
    expect(f.repository.getPattern(result.pattern.id)?.sourceJobId).toBeNull();
  });
});
