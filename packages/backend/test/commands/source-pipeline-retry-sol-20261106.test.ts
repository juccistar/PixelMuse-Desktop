import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { SqliteDatabase } from '@ecomgen/core';
import { candidateIdFor } from '../../src/execution/index.js';
import { RuntimeStore } from '../../src/runtime/state.js';
import { regressionFixtures, waitJob, poll } from '../desktop-regression-helpers.js';

const { fixture, open } = regressionFixtures();
type Fixture = Awaited<ReturnType<typeof fixture>>;
function request(f: Fixture, idempotencyKey = 'source-retry-original') {
  return { providerId: f.provider.id, imageModelId: 'gpt-image-1', theme: 'Synthetic source recovery', candidateCount: 1,
    pipeline: { specId: 'mug-11oz-wrap', layout: 'CENTERED' as const, listingPlatform: 'ETSY' as const, listingProviderId: f.provider.id, listingModelId: 'mock-reasoner' }, idempotencyKey };
}
function runtime(f: Pick<Fixture, 'context'>, jobId: string) {
  return new RuntimeStore((f.context.repository as unknown as { db: SqliteDatabase }).db).get(jobId)!;
}
async function completed(f: Pick<Fixture, 'backend' | 'context'>, jobId: string) {
  const step = f.context.repository.getPatternPipelineStepByJobId(jobId)!;
  const result = await poll(async () => {
    const pipeline = await f.backend.invoke('getPatternPipeline', { pipelineId: step.pipelineId });
    return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'AWAITING_INPUT'].includes(pipeline.status) ? pipeline : undefined;
  }, 'actual source pipeline completion');
  expect(result.status, JSON.stringify(result)).toBe('SUCCEEDED');
  for (const entry of result.steps) if (entry.jobId) {
    await waitJob(f.backend, entry.jobId);
    await f.context.scheduler.waitForIdle([entry.jobId]);
  }
  return result;
}

describe('supported SOURCE recovery and pipeline retry boundaries', () => {
  it('rejects SOURCE and downstream step reruns before a source exists, retaining the failed owning pipeline', async () => {
    const f = await fixture();
    f.server.control.failNext('image-generation', { type: 'http', status: 400 });
    const source = await f.backend.invoke('createPatternForgeJob', request(f));
    await waitJob(f.backend, source.id, 'FAILED');
    await f.context.scheduler.waitForIdle([source.id]);
    const owner = f.context.repository.getPatternPipelineStepByJobId(source.id)!;
    const before = await f.backend.invoke('getPatternPipeline', { pipelineId: owner.pipelineId });
    expect(before).toMatchObject({ status: 'FAILED', patternId: null, steps: [expect.objectContaining({ step: 'SOURCE', status: 'FAILED', jobId: source.id }), expect.anything(), expect.anything(), expect.anything()] });
    for (const step of ['SOURCE', 'TILE_CHECK', 'PRINT_PACK', 'LISTING'] as const)
      await expect(f.backend.invoke('retryPatternPipelineStep', { pipelineId: before.id, step })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await f.backend.invoke('getPatternPipeline', { pipelineId: before.id })).toEqual(before);
    expect(f.server.state.counts['image-generation']).toBe(1);
    expect(f.server.state.counts.chat).toBe(0);
  });

  it('starts an explicitly new source intent after HTTP400 and preserves failure, dedupe and independent generations', async () => {
    const f = await fixture();
    f.server.control.failNext('image-generation', { type: 'http', status: 400 });
    const source = await f.backend.invoke('createPatternForgeJob', request(f));
    await waitJob(f.backend, source.id, 'FAILED');
    await f.context.scheduler.waitForIdle([source.id]);
    const owner = f.context.repository.getPatternPipelineStepByJobId(source.id)!;
    const before = await f.backend.invoke('getPatternPipeline', { pipelineId: owner.pipelineId });
    const snapshot = runtime(f, source.id).snapshot;
    const evidence = runtime(f, source.id).requests;
    // A same-job retry replays a complete rejection; it must not silently authorize another POST.
    await f.backend.invoke('retryJob', { jobId: source.id });
    await waitJob(f.backend, source.id, 'FAILED');
    await f.context.scheduler.waitForIdle([source.id]);
    expect(f.server.state.counts['image-generation']).toBe(1);
    // Reissuing the source command explicitly creates a new generation after a known failure.
    const nextRequest = request(f);
    const retried = await f.backend.invoke('createPatternForgeJob', nextRequest);
    expect(retried.id).not.toBe(source.id);
    const result = await completed(f, retried.id);
    expect(result.id).not.toBe(before.id);
    expect(result.steps.map(entry => entry.step)).toEqual(['SOURCE', 'TILE_CHECK', 'PRINT_PACK', 'LISTING']);
    expect(result.steps.every(entry => entry.status === 'SUCCEEDED')).toBe(true);
    expect(result.steps[0]!.jobId).toBe(retried.id);
    expect(result.patternId).toBe(candidateIdFor(retried.id, 1));
    expect((await f.backend.invoke('listPatternPrintPacks', { patternId: result.patternId! })).items).toHaveLength(1);
    expect((await f.backend.invoke('getPatternListingResult', { patternId: result.patternId!, jobId: result.steps[3]!.jobId! })).copy.tags).toHaveLength(13);
    const retained = await f.backend.invoke('getPatternPipeline', { pipelineId: before.id });
    expect(retained).toMatchObject({ id: before.id, status: 'FAILED', patternId: null, steps: before.steps });
    expect(runtime(f, source.id).snapshot).toEqual(snapshot);
    expect(runtime(f, source.id).requests).toEqual(evidence);
    expect(await f.backend.invoke('createPatternForgeJob', nextRequest)).toMatchObject({ id: retried.id, reused: true });
    await expect(f.backend.invoke('retryPatternPipelineStep', { pipelineId: result.id, step: 'SOURCE' })).rejects.toMatchObject({ code: 'CONFLICT', message: '图案获取步骤请从花型墙的来源入口重新发起' });
    expect(await f.backend.invoke('getPatternPipeline', { pipelineId: result.id })).toEqual(result);
    expect(f.server.state.counts['image-generation']).toBe(2);
    expect(f.server.state.counts.chat).toBe(1);
  });

  it('retries a cancelled TILE_CHECK in a fresh generation and retains the seam decision gate', async () => {
    const f = await fixture();
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#553311' } }).png().toBuffer();
    const pattern = await f.backend.invoke('uploadPattern', { file: { name: 'cancel-risk.png', mimeType: 'image/png', base64: bytes.toString('base64') }, name: 'Synthetic seam gate' });
    const queued = await f.backend.invoke('createPatternPipeline', { patternId: pattern.id, ...request(f).pipeline, layout: 'TILE', idempotencyKey: 'tile-cancel-retry' });
    const gate = async () => poll(async () => {
      const current = await f.backend.invoke('getPatternPipeline', { pipelineId: queued.id });
      return ['AWAITING_INPUT', 'FAILED', 'CANCELLED'].includes(current.status) ? current : undefined;
    }, 'durable seam gate');
    const waiting = await gate();
    expect(waiting).toMatchObject({ status: 'AWAITING_INPUT', blockReason: 'SEAM_RISK' });
    const originalTile = waiting.steps.find(entry => entry.step === 'TILE_CHECK')!;
    await waitJob(f.backend, originalTile.jobId!);
    await f.context.scheduler.waitForIdle([originalTile.jobId!]);
    const snapshot = runtime(f, originalTile.jobId!).snapshot;
    await f.backend.invoke('cancelPatternPipeline', { pipelineId: queued.id });
    const cancelled = await f.backend.invoke('getPatternPipeline', { pipelineId: queued.id });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.steps.filter(entry => entry.step !== 'TILE_CHECK').every(entry => entry.jobId === null)).toBe(true);
    const rerun = await f.backend.invoke('retryPatternPipelineStep', { pipelineId: queued.id, step: 'TILE_CHECK' });
    const nextTile = rerun.steps.find(entry => entry.step === 'TILE_CHECK')!;
    expect(nextTile.jobId).not.toBe(originalTile.jobId);
    const regated = await gate();
    expect(regated).toMatchObject({ id: queued.id, patternId: pattern.id, status: 'AWAITING_INPUT', blockReason: 'SEAM_RISK' });
    expect(regated.steps.filter(entry => entry.step !== 'TILE_CHECK').every(entry => entry.jobId === null)).toBe(true);
    expect(f.server.state.counts['image-generation']).toBe(0);
    expect(f.server.state.counts.chat).toBe(0);
    await f.backend.invoke('continuePatternPipeline', { pipelineId: queued.id, resolution: 'USE_CENTERED' });
    const recovered = await completed(f, nextTile.jobId!);
    expect(recovered).toMatchObject({ id: queued.id, patternId: pattern.id, layout: 'CENTERED' });
    expect(recovered.steps.every(entry => entry.status === 'SUCCEEDED')).toBe(true);
    expect(runtime(f, originalTile.jobId!).snapshot).toEqual(snapshot);
    expect(await f.backend.invoke('getJob', { jobId: originalTile.jobId! })).toMatchObject({ status: 'SUCCEEDED' });
    expect(f.server.state.counts.chat).toBe(1);
  });

  it('recovers a cancelled SOURCE locally after reopen, retaining partial artwork, receipts and frozen configuration', async () => {
    const f = await fixture();
    f.server.control.addFault({ kind: 'image-generation', at: 2, fault: { type: 'download-once' } });
    const input = { ...request(f), candidateCount: 2 };
    const source = await f.backend.invoke('createPatternForgeJob', input);
    await waitJob(f.backend, source.id, 'FAILED');
    await f.context.scheduler.waitForIdle([source.id]);
    const step = f.context.repository.getPatternPipelineStepByJobId(source.id)!;
    const first = f.context.repository.getPattern(candidateIdFor(source.id, 1))!;
    const bytes = await f.context.storage.read(first.storagePath!);
    const snapshot = runtime(f, source.id).snapshot;
    const receipts = runtime(f, source.id).requests.map(entry => entry.encryptedReceipt);
    expect(receipts).toHaveLength(2);
    expect(f.context.requestLedger.summaries(source.id).map(entry => entry.localState).sort()).toEqual(['COMMITTED', 'PENDING']);
    // The paid POST already has a complete receipt; cancel only while replaying its download tail.
    f.server.control.failNext('download', { type: 'hang' });
    await f.backend.invoke('retryJob', { jobId: source.id });
    await expect.poll(() => f.server.state.hanging, { timeout: 5000 }).toBe(1);
    await f.backend.invoke('cancelPatternPipeline', { pipelineId: step.pipelineId });
    await waitJob(f.backend, source.id, 'CANCELLED');
    await f.context.scheduler.waitForIdle([source.id]);
    expect(await f.backend.invoke('getPatternPipeline', { pipelineId: step.pipelineId })).toMatchObject({ status: 'CANCELLED', steps: [expect.objectContaining({ step: 'SOURCE', status: 'CANCELLED' }), expect.anything(), expect.anything(), expect.anything()] });
    const provider = f.context.repository.getProvider(f.provider.id)!;
    f.context.repository.saveProvider({ ...provider, baseUrl: 'http://127.0.0.1:1/changed-after-freeze' });
    await f.backend.close();
    const reopened = await open(f.options);
    expect(await reopened.backend.invoke('retryJob', { jobId: source.id })).toMatchObject({ id: source.id });
    const result = await completed(reopened, source.id);
    expect(result.id).toBe(step.pipelineId);
    expect(result.steps[0]!.jobId).toBe(source.id);
    // The downstream TILE_CHECK updates seam metadata; the retained source identity and bytes stay fixed.
    const { tileable: _tileable, tileableScore: _score, tileableCheckedWith: _version, updatedAt: _updated, ...artwork } = first;
    expect(reopened.context.repository.getPattern(first.id)).toMatchObject(artwork);
    expect(await reopened.context.storage.read(first.storagePath!)).toEqual(bytes);
    expect(runtime(reopened, source.id).snapshot).toEqual(snapshot);
    expect(runtime(reopened, source.id).requests.map(entry => entry.encryptedReceipt)).toEqual(receipts);
    expect(runtime(reopened, source.id).attempt).toBe(3);
    expect(reopened.context.requestLedger.summaries(source.id).every(entry => entry.state === 'COMPLETED' && entry.localState === 'COMMITTED')).toBe(true);
    expect(f.server.state.counts['image-generation']).toBe(2);
    expect(f.server.state.counts.download).toBe(3);
    expect(f.server.state.counts.chat).toBe(1);
  });

  it('keeps an in-flight SOURCE cancellation UNKNOWN and blocks retry, cancellation downgrade and duplicate dispatch', async () => {
    const f = await fixture();
    f.server.control.failNext('image-generation', { type: 'hang' });
    const input = request(f);
    const source = await f.backend.invoke('createPatternForgeJob', input);
    await expect.poll(() => f.server.state.hanging, { timeout: 5000 }).toBe(1);
    const owner = f.context.repository.getPatternPipelineStepByJobId(source.id)!;
    await f.backend.invoke('cancelPatternPipeline', { pipelineId: owner.pipelineId });
    await waitJob(f.backend, source.id, 'UNKNOWN');
    await f.context.scheduler.waitForIdle([source.id]);
    const pipeline = await f.backend.invoke('getPatternPipeline', { pipelineId: owner.pipelineId });
    expect(pipeline).toMatchObject({ status: 'AWAITING_INPUT', blockReason: 'EXTERNAL_RESULT_UNKNOWN', steps: [expect.objectContaining({ step: 'SOURCE', status: 'UNKNOWN', jobId: source.id }), expect.anything(), expect.anything(), expect.anything()] });
    expect(pipeline.steps.slice(1).every(entry => entry.jobId === null)).toBe(true);
    await f.backend.close();
    const reopened = await open(f.options);
    await expect(reopened.backend.invoke('retryJob', { jobId: source.id })).rejects.toMatchObject({ code: 'RETRY_UNSAFE' });
    await expect(reopened.backend.invoke('cancelPatternPipeline', { pipelineId: pipeline.id })).rejects.toMatchObject({ code: 'EXTERNAL_UNKNOWN' });
    for (const step of ['SOURCE', 'PRINT_PACK'] as const)
      await expect(reopened.backend.invoke('retryPatternPipelineStep', { pipelineId: pipeline.id, step })).rejects.toBeDefined();
    expect(await reopened.backend.invoke('createPatternForgeJob', input)).toMatchObject({ id: source.id, reused: true });
    expect(await reopened.backend.invoke('getPatternPipeline', { pipelineId: pipeline.id })).toEqual(pipeline);
    expect(f.server.state.counts['image-generation']).toBe(1);
    expect(f.server.state.counts.chat).toBe(0);
  });
});
