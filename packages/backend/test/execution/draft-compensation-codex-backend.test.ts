import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { integrationFixtures, waitJob } from '../integration/fixtures.js';
const { fixture, open } = integrationFixtures();

describe('codex draft compensation with production Backend defaults', () => {
  it('recovers a failed draft download after reopening without a second generation POST', async () => {
    const f = await fixture({ imageMode: 'url' });
    const draft = await f.backend.invoke('createPatternDraft', { name: 'synthetic draft' });
    f.server.control.failNext('image-generation', { type: 'download-once' });
    const created = await f.backend.invoke('createDraftBatch', { draftId: draft.id, clientKey: randomUUID(), operation: 'GENERATE', theme: 'synthetic flowers', providerId: f.provider.id, imageModelId: 'gpt-image-1', candidateCount: 2 });
    const id = created.job!.id; await waitJob(f.backend, id, 'FAILED');
    expect((await f.backend.invoke('getJobRequests', { jobId: id })).items.map(r => [r.state, r.localState])).toEqual([['COMPLETED', 'PENDING'], ['COMPLETED', 'COMMITTED']]);
    const survivor = (await f.backend.invoke('listDraftCandidates', { draftId: draft.id })).items[0]!;
    await f.backend.close();
    const backend = await open(f.options);
    const resumed = await backend.invoke('retryFailedDraftBatch', { draftId: draft.id, batchId: created.batch.id });
    expect(resumed.job.id).toBe(id); await waitJob(backend, id);
    const candidates = (await backend.invoke('listDraftCandidates', { draftId: draft.id })).items;
    expect(candidates).toHaveLength(2); expect(candidates.find(c => c.id === survivor.id)).toEqual(survivor);
    expect(f.server.state.counts['image-generation']).toBe(2);
    expect(f.server.state.counts.download).toBe(3);
    expect((await backend.invoke('getJobRequests', { jobId: id })).items.map(r => r.localState)).toEqual(['COMMITTED', 'COMMITTED']);
  });

  it('does not revive a deleted successful candidate during failed-slot compensation', async () => {
    const f = await fixture({ imageMode: 'url' });
    const draft = await f.backend.invoke('createPatternDraft', { name: 'synthetic draft' });
    f.server.control.failNext('image-generation', { type: 'download-once' });
    const created = await f.backend.invoke('createDraftBatch', { draftId: draft.id, clientKey: randomUUID(), operation: 'GENERATE', theme: 'synthetic flowers', providerId: f.provider.id, imageModelId: 'gpt-image-1', candidateCount: 2 });
    const id = created.job!.id; await waitJob(f.backend, id, 'FAILED');
    const survivor = (await f.backend.invoke('listDraftCandidates', { draftId: draft.id })).items[0]!;
    await f.backend.invoke('deleteDraftCandidate', { draftId: draft.id, candidateId: survivor.id });
    await f.backend.invoke('retryFailedDraftBatch', { draftId: draft.id, batchId: created.batch.id });
    await waitJob(f.backend, id);
    const candidates = (await f.backend.invoke('listDraftCandidates', { draftId: draft.id })).items;
    console.log('production Backend deletion evidence', { generationPosts: f.server.state.counts['image-generation'], downloads: f.server.state.counts.download, candidateCount: candidates.length, deletedCandidateRevived: candidates.some(c => c.id === survivor.id) });
    expect(candidates.some(c => c.id === survivor.id)).toBe(false);
    expect(candidates).toHaveLength(1);
  });
});
