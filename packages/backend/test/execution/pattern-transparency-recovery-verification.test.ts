import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { candidateIdFor } from '../../src/execution/context.js';
import { hasTransparentPixels } from '../../src/execution/pattern-background.js';
import { file, regressionFixtures, waitJob } from '../desktop-regression-helpers.js';

const { fixture, open } = regressionFixtures();
const alpha = () => sharp({ create: { width: 32, height: 24, channels: 4, background: { r: 80, g: 130, b: 190, alpha: 0.25 } } }).png().toBuffer();
const flows = ['forge', 'TRANSPARENT', 'SOURCE'] as const;
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function submit(f: Fixture, flow: typeof flows[number], candidateCount: number, sourceBytes?: Buffer) {
  if (flow === 'forge') return f.backend.invoke('createPatternForgeJob', {
    providerId: f.provider.id, imageModelId: 'gpt-image-1', theme: 'Independent synthetic probe', background: 'TRANSPARENT', candidateCount,
    pipeline: { specId: 'mug-11oz-wrap', layout: 'TILE', repeatLayout: 'MIRROR', listingPlatform: 'ETSY', listingProviderId: f.provider.id, listingModelId: 'mock-reasoner' },
  });
  const source = await f.backend.invoke('uploadPattern', { file: file(sourceBytes ?? await alpha()) });
  return f.backend.invoke('createPatternVariantJob', {
    patternId: source.id, providerId: f.provider.id, imageModelId: 'gpt-image-1', axis: 'STYLE', preset: 'WATERCOLOR', background: flow, candidateCount,
  });
}
async function retry(f: Pick<Fixture, 'backend' | 'context'>, id: string, status = 'FAILED') {
  await f.context.scheduler.waitForIdle([id]);
  await f.backend.invoke('retryJob', { jobId: id });
  const job = await waitJob(f.backend, id, status);
  await f.context.scheduler.waitForIdle([id]);
  return job;
}

describe('independent transparency recovery probes', () => {
  it.each(flows)('%s validates an opaque result first recovered from a completed download receipt', async flow => {
    const kind = flow === 'forge' ? 'image-generation' : 'image-edit';
    const f = await fixture({ mock: { faults: [{ kind, at: 1, fault: { type: 'download-once' } }] } });
    const job = await submit(f, flow, 2);
    await waitJob(f.backend, job.id, 'FAILED');
    expect(f.context.repository.listPatternsByJobId(job.id)).toHaveLength(0);
    const pending = f.context.requestLedger.summaries(job.id);
    expect(pending).toEqual([expect.objectContaining({ state: 'COMPLETED', localState: 'PENDING' })]);
    await f.backend.close();
    const reopened = await open(f.options);
    await retry(reopened, job.id);
    const retained = reopened.context.repository.listPatternsByJobId(job.id);
    expect(retained.map(row => row.id)).toEqual([candidateIdFor(job.id, 1)]);
    const bytes = await reopened.context.storage.read(retained[0]!.storagePath!);
    expect(await hasTransparentPixels(bytes)).toBe(false);
    const committed = reopened.context.requestLedger.summaries(job.id);
    expect(committed).toEqual([expect.objectContaining({ requestKey: pending[0]!.requestKey, state: 'COMPLETED', localState: 'COMMITTED' })]);
    for (let index = 0; index < 2; index++) {
      await retry(reopened, job.id);
      expect(reopened.context.repository.listPatternsByJobId(job.id)).toEqual(retained);
      expect(reopened.context.requestLedger.summaries(job.id)).toEqual(committed);
      expect(await reopened.context.storage.read(retained[0]!.storagePath!)).toEqual(bytes);
    }
    if (flow === 'forge') {
      const step = reopened.context.repository.getPatternPipelineStepByJobId(job.id)!;
      const pipeline = reopened.context.repository.getPatternPipeline(step.pipelineId)!;
      expect(pipeline.status).toBe('FAILED');
      expect(pipeline.steps.slice(1).every(row => row.jobId === null && row.status === 'PENDING')).toBe(true);
    }
    expect(f.server.state.counts[kind]).toBe(1);
    expect(f.server.state.counts.chat).toBe(0);
    expect(f.server.state.counts.download).toBe(2);
  });

  it.each(['TRANSPARENT', 'SOURCE'] as const)('%s variant retains mixed partial results and stops before candidate three', async flow => {
    const transparent = await alpha();
    const f = await fixture({ mock: { imageForRequest: (request, images) => request.kindCall === 1 ? transparent : images.image } });
    const job = await submit(f, flow, 3);
    await waitJob(f.backend, job.id, 'FAILED');
    const retained = f.context.repository.listPatternsByJobId(job.id);
    expect(retained.map(row => row.id).sort()).toEqual([candidateIdFor(job.id, 1), candidateIdFor(job.id, 2)].sort());
    const first = retained.find(row => row.id === candidateIdFor(job.id, 1))!;
    expect(await hasTransparentPixels(await f.context.storage.read(first.storagePath!))).toBe(true);
    const receipts = f.context.requestLedger.summaries(job.id);
    await f.backend.close();
    const reopened = await open(f.options);
    for (let index = 0; index < 2; index++) {
      await retry(reopened, job.id);
      expect(reopened.context.repository.listPatternsByJobId(job.id)).toEqual(retained);
      expect(reopened.context.requestLedger.summaries(job.id)).toEqual(receipts);
      expect(reopened.context.repository.getPattern(candidateIdFor(job.id, 3))).toBeUndefined();
    }
    expect(f.server.state.counts['image-edit']).toBe(2);
  });

  it('SOURCE from opaque artwork still accepts opaque results during completed-receipt recovery', async () => {
    const secondOpaque = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#22bb88' } }).png().toBuffer();
    const f = await fixture({ mock: { imageForRequest: (request, images) => request.kindCall === 1 ? images.image : secondOpaque, faults: [{ kind: 'image-edit', at: 2, fault: { type: 'download-once' } }] } });
    const job = await submit(f, 'SOURCE', 2, f.bytes);
    await waitJob(f.backend, job.id, 'FAILED');
    const retained = f.context.repository.listPatternsByJobId(job.id);
    expect(retained).toHaveLength(1);
    await f.backend.close();
    const reopened = await open(f.options);
    await retry(reopened, job.id, 'SUCCEEDED');
    expect(reopened.context.repository.getPattern(retained[0]!.id)).toEqual(retained[0]);
    expect(reopened.context.repository.listPatternsByJobId(job.id)).toHaveLength(2);
    expect(f.server.state.counts['image-edit']).toBe(2);
  });
});
