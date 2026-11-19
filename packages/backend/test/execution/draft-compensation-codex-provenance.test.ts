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

describe('codex independent historical finalization verification', () => {
  it('attributes finalized artwork to the candidate slot owner', async () => {
    const f = await fixture(); f.failures.add(1); f.failures.add(2);
    const created = await f.submit(), originalId = created.job!.id;
    f.scheduler.start(); await f.wait(originalId, 'FAILED');
    const replacement = f.context.transaction(() => {
      const job = f.repository.createJob({ id: randomUUID(), type: 'PATTERN_DRAFT_GENERATE', projectId: null, storyboardItemId: null,
        providerId: f.provider.id, modelId: 'gpt-image-1', input: { draftId: f.draft.id, batchId: created.batch.id, slots: [1], task: 'BATCH', retry: true } });
      f.repository.assignDraftSlotsToJob(created.batch.id, [1], job.id, true);
      f.scheduler.freeze(job.id, createExecutionSnapshot(f.context, job)); return job;
    });
    f.scheduler.enqueue(replacement.id); await f.wait(replacement.id, 'SUCCEEDED');
    await f.invoke('retryFailedDraftBatch', { draftId: f.draft.id, batchId: created.batch.id });
    await f.wait(originalId, 'SUCCEEDED');
    const candidate = f.repository.getDraftCandidate(candidateIdFor(created.batch.id, 1))!;
    const finalized = await f.invoke('finalizeDraftCandidate', { draftId: f.draft.id, candidateId: candidate.id, clientKey: randomUUID() });
    const pattern = f.repository.getPattern(finalized.pattern.id)!;
    expect(f.repository.listDraftSlots(created.batch.id)[0]?.jobId).toBe(replacement.id);
    expect(pattern.sourceAssetHash).toBe(candidate.fileHash);
    expect(f.posts).toHaveLength(3);
    console.log('finalization evidence', { originalId, replacementId: replacement.id, sourceJobId: pattern.sourceJobId, sourceHashMatches: pattern.sourceAssetHash === candidate.fileHash });
    expect(pattern.sourceJobId).toBe(replacement.id);
  });
});
