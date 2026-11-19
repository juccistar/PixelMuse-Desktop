import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { SqliteDatabase } from '@ecomgen/core';
import { RuntimeStore } from '../../src/runtime/state.js';
import { candidateIdFor } from '../../src/execution/context.js';
import { hasTransparentPixels } from '../../src/execution/pattern-background.js';
import { file, regressionFixtures, waitJob } from '../desktop-regression-helpers.js';

const { fixture, open } = regressionFixtures();
const flows = ['forge', 'variant-transparent', 'variant-source'] as const;
type Flow = typeof flows[number];
type Fixture = Awaited<ReturnType<typeof fixture>>;
const transparentPng = (red = 90) => sharp({ create: { width: 32, height: 24, channels: 4, background: { r: red, g: 40, b: 180, alpha: 0.5 } } }).png().toBuffer();

async function submit(f: Fixture, flow: Flow, candidateCount: number) {
  if (flow === 'forge') return f.backend.invoke('createPatternForgeJob', {
    providerId: f.provider.id, imageModelId: 'gpt-image-1', theme: 'Synthetic flowers', background: 'TRANSPARENT', candidateCount,
  });
  const source = await f.backend.invoke('uploadPattern', { file: file(await transparentPng()), name: 'Synthetic transparent source' });
  return f.backend.invoke('createPatternVariantJob', {
    patternId: source.id, providerId: f.provider.id, imageModelId: 'gpt-image-1',
    axis: 'STYLE', preset: 'WATERCOLOR', background: flow === 'variant-source' ? 'SOURCE' : 'TRANSPARENT', candidateCount,
  });
}

function candidates(f: Pick<Fixture, 'context'>, jobId: string) {
  return f.context.repository.listPatternsByJobId(jobId).sort((a, b) => a.id.localeCompare(b.id));
}

function runtime(f: Pick<Fixture, 'context'>, jobId: string) {
  return new RuntimeStore((f.context.repository as unknown as { db: SqliteDatabase }).db).get(jobId)!;
}

function completeReceipts(f: Pick<Fixture, 'context'>, jobId: string) {
  const requests = runtime(f, jobId).requests;
  for (const request of requests) {
    expect(request.state).toBe('COMPLETED');
    const receipt = JSON.parse(f.context.secrets.decrypt(request.encryptedReceipt!));
    expect(receipt.status).toBe(200);
    expect(JSON.parse(Buffer.from(receipt.bodyBase64, 'base64').toString()).data).toHaveLength(1);
  }
  return requests;
}

async function artwork(f: Pick<Fixture, 'context'>, jobId: string) {
  return Promise.all(candidates(f, jobId).map(row => f.context.storage.read(row.storagePath!)));
}

async function retry(f: Pick<Fixture, 'backend' | 'context'>, jobId: string, status: string) {
  await f.context.scheduler.waitForIdle([jobId]);
  await f.backend.invoke('retryJob', { jobId });
  const result = await waitJob(f.backend, jobId, status);
  await f.context.scheduler.waitForIdle([jobId]);
  return result;
}

describe('retained pattern transparency verdict recovery', () => {
  it.each(flows)('%s keeps opaque committed candidates FAILED across repeated retries and reopen', async flow => {
    const requests: Array<{ background: unknown; outputFormat: unknown }> = [];
    const f = await fixture({ mock: { imageForRequest: (request, images) => {
      requests.push({ background: request.json?.background ?? request.fields.background, outputFormat: request.json?.output_format ?? request.fields.output_format });
      return images.image; // Has an alpha channel, but every alpha value is 255.
    } } });
    const job = await submit(f, flow, 1);
    await waitJob(f.backend, job.id, 'FAILED');
    const retained = candidates(f, job.id);
    const bytes = await artwork(f, job.id);
    expect(retained.map(row => row.id)).toEqual([candidateIdFor(job.id, 1)]);
    expect(await hasTransparentPixels(bytes[0]!)).toBe(false);
    expect(requests).toEqual([{ background: 'transparent', outputFormat: 'png' }]);
    const receipts = f.context.requestLedger.summaries(job.id);
    expect(receipts).toEqual([expect.objectContaining({ state: 'COMPLETED', localState: 'COMMITTED' })]);
    const snapshot = runtime(f, job.id).snapshot;
    const evidence = completeReceipts(f, job.id);
    for (let index = 0; index < 2; index++) {
      await retry(f, job.id, 'FAILED');
      expect(candidates(f, job.id)).toEqual(retained);
      expect(await artwork(f, job.id)).toEqual(bytes);
      expect(f.context.requestLedger.summaries(job.id)).toEqual(receipts);
      expect(completeReceipts(f, job.id)).toEqual(evidence);
    }
    await f.backend.close();
    const reopened = await open(f.options);
    await retry(reopened, job.id, 'FAILED');
    expect(candidates(reopened, job.id)).toEqual(retained);
    expect(await artwork(reopened, job.id)).toEqual(bytes);
    expect(reopened.context.requestLedger.summaries(job.id)).toEqual(receipts);
    expect(completeReceipts(reopened, job.id)).toEqual(evidence);
    expect(runtime(reopened, job.id).snapshot).toEqual(snapshot);
    expect(requests).toHaveLength(1);
    expect(f.server.state.counts[flow === 'forge' ? 'image-generation' : 'image-edit']).toBe(1);
  });

  it('retains a valid partial candidate and failed opaque candidate without generating the next candidate or advancing SOURCE', async () => {
    const alpha = await transparentPng();
    const f = await fixture({ mock: { imageForRequest: (request, images) => request.kindCall === 1 ? alpha : images.image } });
    const job = await f.backend.invoke('createPatternForgeJob', {
      providerId: f.provider.id, imageModelId: 'gpt-image-1', theme: 'Synthetic pipeline flowers', background: 'TRANSPARENT', candidateCount: 3,
      pipeline: { specId: 'mug-11oz-wrap', layout: 'TILE', repeatLayout: 'MIRROR', listingPlatform: 'ETSY', listingProviderId: f.provider.id, listingModelId: 'mock-reasoner' },
    });
    await waitJob(f.backend, job.id, 'FAILED');
    const retained = candidates(f, job.id);
    const bytes = await artwork(f, job.id);
    expect(retained.map(row => row.id).sort()).toEqual([candidateIdFor(job.id, 1), candidateIdFor(job.id, 2)].sort());
    const valid = f.context.repository.getPattern(candidateIdFor(job.id, 1))!;
    expect(await hasTransparentPixels(await f.context.storage.read(valid.storagePath!))).toBe(true);
    const receipts = f.context.requestLedger.summaries(job.id);
    expect(receipts).toHaveLength(2);
    expect(receipts.every(row => row.state === 'COMPLETED' && row.localState === 'COMMITTED')).toBe(true);
    const evidence = completeReceipts(f, job.id);
    const source = f.context.repository.getPatternPipelineStepByJobId(job.id)!;
    const assertBlocked = (current: Pick<Fixture, 'context'>) => {
      const pipeline = current.context.repository.getPatternPipeline(source.pipelineId)!;
      expect(pipeline.status).toBe('FAILED');
      expect(pipeline.steps[0]).toMatchObject({ step: 'SOURCE', status: 'FAILED', jobId: job.id });
      expect(pipeline.steps.slice(1).every(step => step.jobId === null && step.status === 'PENDING')).toBe(true);
      expect(current.context.repository.getPattern(candidateIdFor(job.id, 3))).toBeUndefined();
      expect(candidates(current, job.id)).toEqual(retained);
      expect(current.context.requestLedger.summaries(job.id)).toEqual(receipts);
      expect(completeReceipts(current, job.id)).toEqual(evidence);
    };
    assertBlocked(f);
    for (let index = 0; index < 2; index++) {
      await retry(f, job.id, 'FAILED');
      assertBlocked(f);
    }
    await f.backend.close();
    const reopened = await open(f.options);
    await retry(reopened, job.id, 'FAILED');
    assertBlocked(reopened);
    expect(await artwork(reopened, job.id)).toEqual(bytes);
    expect(f.server.state.counts['image-generation']).toBe(2);
    expect(f.server.state.counts.chat).toBe(0);
  });

  it.each(flows)('%s preserves valid partial success and resumes a completed receipt download without another POST', async flow => {
    const alpha = await transparentPng();
    const kind = flow === 'forge' ? 'image-generation' : 'image-edit';
    const secondAlpha = await transparentPng(160);
    const f = await fixture({ mock: { image: alpha, imageForRequest: request => request.kindCall === 1 ? alpha : secondAlpha, faults: [{ kind, at: 2, fault: { type: 'download-once' } }] } });
    const job = await submit(f, flow, 2);
    await waitJob(f.backend, job.id, 'FAILED');
    const retained = candidates(f, job.id);
    const bytes = await artwork(f, job.id);
    expect(retained.map(row => row.id)).toEqual([candidateIdFor(job.id, 1)]);
    expect(await hasTransparentPixels(bytes[0]!)).toBe(true);
    const receipts = f.context.requestLedger.summaries(job.id);
    expect(receipts).toHaveLength(2);
    expect(receipts.every(row => row.state === 'COMPLETED')).toBe(true);
    expect(receipts.map(row => row.localState).sort()).toEqual(['COMMITTED', 'PENDING']);
    expect(f.server.state.counts[kind]).toBe(2);
    const evidence = completeReceipts(f, job.id);
    await f.backend.close();
    const reopened = await open(f.options);
    await retry(reopened, job.id, 'SUCCEEDED');
    expect(reopened.context.repository.getPattern(retained[0]!.id)).toEqual(retained[0]);
    expect(await reopened.context.storage.read(retained[0]!.storagePath!)).toEqual(bytes[0]);
    expect(candidates(reopened, job.id).map(row => row.id).sort()).toEqual([candidateIdFor(job.id, 1), candidateIdFor(job.id, 2)].sort());
    expect(await Promise.all((await artwork(reopened, job.id)).map(hasTransparentPixels))).toEqual([true, true]);
    expect(reopened.context.requestLedger.summaries(job.id).map(row => row.requestKey).sort()).toEqual(receipts.map(row => row.requestKey).sort());
    expect(reopened.context.requestLedger.summaries(job.id).every(row => row.state === 'COMPLETED' && row.localState === 'COMMITTED')).toBe(true);
    expect(f.server.state.counts[kind]).toBe(2);
    expect(f.server.state.counts.download).toBe(2);
    expect(completeReceipts(reopened, job.id).map(row => ({ ...row, localState: 'PENDING' }))).toEqual(evidence.map(row => ({ ...row, localState: 'PENDING' })));
  });
});
