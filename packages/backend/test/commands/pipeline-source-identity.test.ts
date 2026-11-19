import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Value } from '@sinclair/typebox/value';
import { DesktopHistoryRepository, EcomRepository, LocalAssetStore, SecretBox, SuiteCatalog, openDatabase, requestFingerprint } from '@ecomgen/core';
import { operations, POD_PRINT_SPECS, POD_PRINT_SPEC_VERSION, type Input, type Operation, type Output } from '@ecomgen/contracts';
import { registerDomainCommands } from '../../src/commands/index.js';
import { startPatternPipeline } from '../../src/commands/patternPipelines.js';
import type { CommandScope } from '../../src/commands/support.js';
import { candidateIdFor, registerExecutors } from '../../src/execution/index.js';
import { InvalidationEvents } from '../../src/runtime/events.js';
import type { CommandContext } from '../../src/runtime/ports.js';
import { RequestLedger } from '../../src/runtime/request-ledger.js';
import { ResourceRegistry } from '../../src/runtime/resources.js';
import { PersistentScheduler } from '../../src/runtime/scheduler.js';
import { RuntimeStore } from '../../src/runtime/state.js';

describe('pipeline source execution identity', () => {
  let root: string;
  let db: ReturnType<typeof openDatabase>;
  let context: CommandContext;
  let scheduler: PersistentScheduler;
  let handlers: ReturnType<typeof registerDomainCommands>;
  let providerId: string;
  let server: Server;
  let image: Buffer;
  let requests: Array<{ method: string; url: string; prompt?: string }>;
  const answers = () => ({ specId: POD_PRINT_SPECS[0]!.id, layout: 'TILE' as const, listingPlatform: 'ETSY' as const, listingProviderId: providerId, listingModelId: 'reasoner' });
  const forge = (theme: string, idempotencyKey?: string): Input<'createPatternForgeJob'> => ({ providerId, imageModelId: 'gpt-image-1.5', theme, pipeline: answers(), ...(idempotencyKey ? { idempotencyKey } : {}) });
  const invoke = async <K extends Operation>(name: K, input: Input<K>): Promise<Output<K>> => {
    expect(Value.Check(operations[name].input, input)).toBe(true);
    const result = await handlers[name]!(context, input);
    expect(Value.Check(operations[name].output, result)).toBe(true);
    return result as Output<K>;
  };
  const pipelineCount = () => (db.prepare('SELECT count(*) AS count FROM pattern_pipelines').get() as { count: number }).count;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ecomgen-pipeline-source-'));
    db = openDatabase(join(root, 'test.sqlite'));
    const repository = new EcomRepository(db), storage = new LocalAssetStore(root);
    await storage.initialize();
    // Smooth black-to-white edges deliberately fail the actual seam check, pausing before print/listing.
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const offset = (y * 16 + x) * 4;
      pixels.fill(x * 17, offset, offset + 3);
      pixels[offset + 3] = 255;
    }
    image = await sharp(pixels, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer();
    requests = [];
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { prompt?: string };
      requests.push({ method: req.method ?? '', url: req.url ?? '', prompt: body.prompt });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/images/generations') res.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }));
      else { res.statusCode = 500; res.end(JSON.stringify({ error: 'Unexpected loopback request' })); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const secrets = new SecretBox(Buffer.alloc(32, 19)), store = new RuntimeStore(db);
    const network: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(`${baseUrl}/`)) throw new Error('Only the isolated loopback provider is allowed');
      return fetch(input, init);
    };
    const requestLedger = new RequestLedger(store, secrets, network), resources = new ResourceRegistry(store, storage), events = new InvalidationEvents(store, () => undefined);
    scheduler = new PersistentScheduler(store, repository, requestLedger, () => context, 2);
    context = { repository, history: new DesktopHistoryRepository(db), storage, secrets, catalog: new SuiteCatalog({ dataDir: root, repository }), scheduler, resources, events, requestLedger, clock: store.clock, idFactory: randomUUID, signal: new AbortController().signal, transaction: work => events.transaction(work) };
    scheduler.register(registerExecutors(context));
    providerId = repository.saveProvider({ name: 'synthetic loopback', baseUrl, encryptedApiKey: secrets.encrypt('synthetic-key'), reasoningProtocol: 'openai', models: [
      { id: 'reasoner', supportsVision: true, supportsThinking: false, supportsTools: false, supportsStructuredOutput: true, imageApiKind: null },
      { id: 'gpt-image-1.5', supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, imageApiKind: 'openai_images' },
    ] }).id;
    handlers = registerDomainCommands(context);
  });

  afterEach(async () => {
    await scheduler?.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    db?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each([undefined, 'shared-client-key'])('binds distinct forge themes to their own SOURCE, with key %s', async idempotencyKey => {
    const first = await invoke('createPatternForgeJob', forge('red flowers', idempotencyKey));
    const second = await invoke('createPatternForgeJob', forge('blue birds', idempotencyKey));
    expect(second.id).not.toBe(first.id);
    const firstStep = context.repository.getPatternPipelineStepByJobId(first.id);
    const secondStep = context.repository.getPatternPipelineStepByJobId(second.id);
    expect(firstStep).toMatchObject({ step: 'SOURCE', status: 'QUEUED', jobId: first.id });
    expect(secondStep).toMatchObject({ step: 'SOURCE', status: 'QUEUED', jobId: second.id });
    expect(secondStep!.pipelineId).not.toBe(firstStep!.pipelineId);
    for (const step of [firstStep!, secondStep!]) {
      const pipeline = context.repository.getPatternPipeline(step.pipelineId)!;
      expect(pipeline).toMatchObject({ patternId: null, status: 'RUNNING' });
      expect(pipeline.steps.filter(entry => entry.jobId)).toEqual([step]);
    }
    expect(pipelineCount()).toBe(2);
    expect((await invoke('createPatternForgeJob', forge('red flowers', idempotencyKey)))).toMatchObject({ id: first.id, reused: true });
    expect((await invoke('createPatternForgeJob', forge('blue birds', idempotencyKey)))).toMatchObject({ id: second.id, reused: true });
    expect(pipelineCount()).toBe(2);
    expect(requests).toEqual([]);
  });

  it('reuses startPatternPipeline itself for the same source execution', async () => {
    const source = await invoke('createPatternForgeJob', forge('red flowers'));
    const step = context.repository.getPatternPipelineStepByJobId(source.id)!;
    const scope: CommandScope = { ...context, queue: () => { throw new Error('Same-source reuse must not enqueue'); }, cancel: id => scheduler.cancel(id) };
    for (const status of ['RUNNING', 'AWAITING_INPUT'] as const) {
      context.repository.updatePatternPipeline(step.pipelineId, { status });
      const result = context.transaction(() => startPatternPipeline(scope, { patternId: null, patternHash: null, answers: answers(), sourceJobId: source.id }).next());
      expect(result.done).toBe(true);
      expect(result.value).toMatchObject({ reused: true, pipeline: { id: step.pipelineId, status } });
    }
    expect(pipelineCount()).toBe(1);
    expect(context.repository.getPatternPipelineStepByJobId(source.id)).toEqual(step);
    expect(requests).toEqual([]);
  });

  it('preserves existing-pattern fingerprints, active reuse and completed reruns', async () => {
    const pattern = await invoke('uploadPattern', { file: { name: 'synthetic.png', mimeType: 'image/png', base64: image.toString('base64') } });
    const input = { patternId: pattern.id, ...answers() };
    const first = await invoke('createPatternPipeline', input);
    const stored = context.repository.getPatternPipeline(first.id)!;
    const fingerprint = requestFingerprint({ type: 'PATTERN_PIPELINE', patternId: pattern.id, patternHash: context.repository.getPattern(pattern.id)!.fileHash, specId: input.specId, specVersion: POD_PRINT_SPEC_VERSION, layout: 'TILE', repeatLayout: 'STRAIGHT', listingPlatform: input.listingPlatform, listingProviderId: providerId, listingModelId: 'reasoner', sellingPoints: null, bannedWords: null, idempotencyKey: null });
    expect(stored.requestFingerprint).toBe(fingerprint);
    expect(stored.steps.map(step => step.step)).toEqual(['TILE_CHECK', 'PRINT_PACK', 'LISTING']);
    expect(await invoke('createPatternPipeline', input)).toMatchObject({ id: first.id, reused: true });
    context.transaction(() => {
      for (const step of stored.steps) {
        if (step.jobId) context.repository.updateJob(step.jobId, { status: 'SUCCEEDED' });
        context.repository.updatePatternPipelineStep(step.id, { status: 'SUCCEEDED' });
      }
      context.repository.updatePatternPipeline(first.id, { status: 'SUCCEEDED' });
    });
    const rerun = await invoke('createPatternPipeline', input);
    expect(rerun).toMatchObject({ reused: false });
    expect(rerun.id).not.toBe(first.id);
    expect(rerun.steps[0]!.jobId).not.toBe(first.steps[0]!.jobId);
    expect(pipelineCount()).toBe(2);
    expect(requests).toEqual([]);
  });

  it('advances both actual forge sources through the scheduler without cross-binding or reissuing duplicates', async () => {
    const sources = [await invoke('createPatternForgeJob', forge('red flowers')), await invoke('createPatternForgeJob', forge('blue birds'))];
    const pipelineIds = sources.map(source => context.repository.getPatternPipelineStepByJobId(source.id)?.pipelineId);
    expect(pipelineIds.every(Boolean)).toBe(true);
    expect(new Set(pipelineIds).size).toBe(2);
    scheduler.start();
    await expect.poll(() => pipelineIds.map(id => context.repository.getPatternPipeline(id!)?.status), { timeout: 15000, interval: 10 }).toEqual(['AWAITING_INPUT', 'AWAITING_INPUT']);
    const allJobIds: string[] = [];
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index]!;
      const pipeline = context.repository.getPatternPipeline(pipelineIds[index]!)!;
      expect(context.repository.getJob(source.id)?.status).toBe('SUCCEEDED');
      expect(pipeline).toMatchObject({ patternId: candidateIdFor(source.id, 1), blockReason: 'SEAM_RISK' });
      expect(context.repository.getPattern(pipeline.patternId!)?.sourceJobId).toBe(source.id);
      expect(pipeline.steps[0]).toMatchObject({ step: 'SOURCE', jobId: source.id, status: 'SUCCEEDED' });
      expect(pipeline.steps[1]).toMatchObject({ step: 'TILE_CHECK', status: 'SUCCEEDED' });
      const nextJob = context.repository.getJob(pipeline.steps[1]!.jobId!)!;
      expect(nextJob.input.patternId).toBe(pipeline.patternId);
      expect(pipeline.steps.slice(2).every(step => step.status === 'PENDING' && step.jobId === null)).toBe(true);
      expect(context.requestLedger.summaries(source.id)).toMatchObject([{ state: 'COMPLETED', localState: 'COMMITTED' }]);
      allJobIds.push(source.id, nextJob.id);
    }
    await scheduler.waitForIdle(allJobIds);
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.method === 'POST' && request.url === '/v1/images/generations')).toBe(true);
    expect(requests.some(request => request.prompt?.includes('red flowers'))).toBe(true);
    expect(requests.some(request => request.prompt?.includes('blue birds'))).toBe(true);
    expect(await invoke('createPatternForgeJob', forge('red flowers'))).toMatchObject({ id: sources[0]!.id, reused: true });
    expect(await invoke('createPatternForgeJob', forge('blue birds'))).toMatchObject({ id: sources[1]!.id, reused: true });
    expect(requests).toHaveLength(2);
    expect(pipelineCount()).toBe(2);
  });
});
