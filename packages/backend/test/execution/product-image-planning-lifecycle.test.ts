import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectImagePlanning } from '@ecomgen/contracts';
import type { SqliteDatabase, StoryboardItemRecord } from '@ecomgen/core';
import { storyboardReply, type MockRequestContext } from '../../../../scripts/full-mock-provider.mjs';
import { regressionFixtures, file, waitJob, visualStoryboardReply } from '../desktop-regression-helpers.js';
import { RuntimeStore } from '../../src/runtime/state.js';
import { outputImagePlanning, outputProvenance } from '../../src/execution/snapshot.js';

const fixtures = regressionFixtures();
const LOCK = 'Neutral ivory #F5F1E8 and charcoal #252525, matte surface, soft daylight from the left.';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(beforeImageReply?: (request: MockRequestContext) => Promise<void>) {
  const imageRequests: MockRequestContext[] = [];
  const f = await fixtures.fixture({ mock: {
    replyForRequest: request => {
      if (request.workflow !== 'storyboard') return undefined;
      const payload = request.payload;
      if (payload.planningVersion === 2) return visualStoryboardReply(payload, LOCK);
      return storyboardReply({
        assetTypes: payload.allowedTemplateIds.slice(0, 12), targetImageCount: payload.targetImageCount,
        candidateCount: payload.candidatesPerType, mode: payload.defaultMode,
        campaignStyleLock: payload.productImageBatch?.campaignStyleLock ?? LOCK,
        referencedAssets: payload.assets.filter((asset: any) => asset.kind === 'PRODUCT').map((asset: any) => asset.handle),
      });
    },
    imageForRequest: async (request, images) => {
      imageRequests.push(request);
      await beforeImageReply?.(request);
      return images.image;
    },
  } });
  const truth = await f.backend.invoke('uploadAsset', { projectId: f.project.id, role: 'PRODUCT_TRUTH', file: file(f.bytes, 'product.png') });
  let planning = (await f.backend.invoke('saveProjectImagePlanning', {
    projectId: f.project.id, expectedRevision: 0,
    config: { mainCount: 1, detailCount: 1, skuImagesPerGroup: 1, shareImages: false },
    skus: ['蓝色', '红色'].map(name => ({ id: randomUUID(), name, code: null, attributes: [{ name: '颜色', value: name }], productAssetIds: [truth.id], included: true })),
    imageGroups: [],
  })).planning;
  const save = async (patch: Partial<Pick<ProjectImagePlanning, 'config' | 'skus' | 'imageGroups'>>) => {
    const result = await f.backend.invoke('saveProjectImagePlanning', {
      projectId: f.project.id, expectedRevision: planning.revision,
      config: planning.config, skus: planning.skus, imageGroups: planning.imageGroups, ...patch,
    });
    planning = result.planning;
    return result;
  };
  const plan = async (scope: 'ALL' | 'STALE' = 'ALL') => {
    const job = await f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: planning.revision, scope });
    await waitJob(f.backend, job.id);
    return f.backend.invoke('getStoryboard', { projectId: f.project.id });
  };
  const confirm = async () => {
    const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    return f.backend.invoke('confirmStoryboard', { projectId: f.project.id, version: board.storyboard!.version });
  };
  const store = new RuntimeStore((f.context.repository as unknown as { db: SqliteDatabase }).db);
  return { ...f, truth, imageRequests, save, plan, confirm, planning: () => planning, store };
}

describe('product image planning generation lifecycle and complete versions', () => {
  it.each(['publication', 'artifact-replay'] as const)('settles a SKU changed during generation through %s without stale deadlock or changing frozen ownership', async settlement => {
    const entered = deferred(), release = deferred();
    const f = await setup(async () => { entered.resolve(); await release.promise; });
    const board = await f.plan(); await f.confirm();
    const sku = board.items.find(item => item.imagePlanning?.skus[0]?.id === f.planning().skus[0]!.id)!;
    const frozenContext = structuredClone(sku.imagePlanning!);
    const update = f.context.repository.updateStoryboardItem.bind(f.context.repository);
    let failPublication = settlement === 'artifact-replay';
    const publish = vi.spyOn(f.context.repository, 'updateStoryboardItem').mockImplementation((id, patch) => {
      if (id === sku.id && patch.status === 'GENERATED' && failPublication) {
        failPublication = false;
        throw new Error('synthetic failure after output publication');
      }
      return update(id, patch);
    });
    let jobId!: string;
    let frozenSnapshot!: string;
    try {
      const queued = await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [sku.id] });
      jobId = queued.jobs[0]!.id;
      frozenSnapshot = JSON.stringify(f.store.get(jobId)!.snapshot);
      await entered.promise;
      try {
        expect(f.context.repository.getStoryboardItem(sku.id)?.status).toBe('GENERATING');
        expect(f.context.repository.listOutputs(f.project.id)).toEqual([]);
        const changed = await f.save({ skus: f.planning().skus.map((member, index) => index ? member : { ...member, name: '目录等待期间改名' }) });
        expect(changed.staleItemIds).toEqual([sku.id]);
        expect(f.context.repository.getStoryboardItem(sku.id)).toMatchObject({ planningStale: true, imagePlanning: frozenContext });
      } finally { release.resolve(); }
      await waitJob(f.backend, jobId, settlement === 'publication' ? 'SUCCEEDED' : 'FAILED');
      await f.context.scheduler.waitForIdle([jobId]);
      if (settlement === 'artifact-replay') {
        expect(f.context.repository.getStoryboardItem(sku.id)).toMatchObject({ status: 'GENERATING', planningStale: true });
        expect(f.context.repository.listOutputs(f.project.id)).toHaveLength(1);
        expect(f.context.requestLedger.summaries(jobId)).toEqual([expect.objectContaining({ state: 'COMPLETED', localState: 'PENDING' })]);
        // 实际产物已存在，即使状态未结算，也保留历史成图的确认资格。
        await f.confirm();
        await f.backend.invoke('retryJob', { jobId });
        await waitJob(f.backend, jobId);
      }
      expect(f.context.repository.getStoryboardItem(sku.id)).toMatchObject({ status: 'GENERATED', planningStale: false, imagePlanning: frozenContext });
      expect(JSON.stringify(f.store.get(jobId)!.snapshot)).toBe(frozenSnapshot);
      const outputs = f.context.repository.listOutputs(f.project.id);
      expect(outputs).toHaveLength(1);
      expect(outputImagePlanning(outputs[0]!.generationSnapshot)).toEqual(frozenContext);
      expect(outputProvenance(outputs[0]!.generationSnapshot)!.attachments.map(attachment => attachment.id)).toEqual([f.truth.id]);
      expect(f.imageRequests).toHaveLength(1);
      expect(f.server.state.counts['image-edit']).toBe(1);
      expect(f.context.requestLedger.summaries(jobId).every(request => request.localState === 'COMMITTED')).toBe(true);
      await f.confirm();
      await expect(f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: f.planning().revision, scope: 'STALE' })).rejects.toMatchObject({ code: 'CONFLICT' });
    } finally { release.resolve(); publish.mockRestore(); }
  });

  it('reuses all candidates of a superseded historical regeneration while it is generating and keeps the new-key lock', async () => {
    let hold = false;
    const entered = deferred(), release = deferred();
    const f = await setup(async () => { if (hold) { entered.resolve(); await release.promise; } });
    const originalBoard = await f.plan(); await f.confirm();
    const sku = originalBoard.items.find(item => item.imagePlanning?.purpose === 'SKU')!;
    const initial = await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [sku.id] });
    await waitJob(f.backend, initial.jobs[0]!.id);
    const original = f.context.repository.listOutputs(f.project.id)[0]!;
    await f.save({ skus: f.planning().skus.map(member => ({ ...member, name: `${member.name}新目录` })) });
    await f.plan('ALL');
    expect(f.context.repository.getStoryboardItem(sku.id)?.planningSuperseded).toBe(true);
    expect(f.context.repository.getStoryboard(f.project.id)?.status).toBe('DRAFT');
    hold = true;
    const request = { projectId: f.project.id, storyboardItemIds: [sku.id], revision: 'retry', regenerationKey: randomUUID(), generationConfig: { candidateCount: 2 } };
    const submitted = await f.backend.invoke('createGenerationJobs', request);
    const snapshots = submitted.jobs.map(job => JSON.stringify(f.store.get(job.id)!.snapshot));
    await entered.promise;
    try {
      expect(f.context.repository.getStoryboardItem(sku.id)?.status).toBe('GENERATING');
      expect(submitted.jobs).toHaveLength(2);
      expect(submitted.jobs.flatMap(job => f.context.requestLedger.summaries(job.id)).some(request => request.state === 'IN_FLIGHT')).toBe(true);
      expect((await f.backend.invoke('createGenerationJobs', request)).jobs.map(job => job.id)).toEqual(submitted.jobs.map(job => job.id));
      await expect(f.backend.invoke('createGenerationJobs', { ...request, regenerationKey: randomUUID() })).rejects.toMatchObject({ code: 'EXTERNAL_UNKNOWN' });
      expect(f.context.repository.listJobs(f.project.id).filter(job => job.type === 'GENERATE')).toHaveLength(3);
    } finally { release.resolve(); }
    for (const job of submitted.jobs) await waitJob(f.backend, job.id);
    expect((await f.backend.invoke('createGenerationJobs', request)).jobs.map(job => job.id)).toEqual(submitted.jobs.map(job => job.id));
    const outputs = f.context.repository.listOutputs(f.project.id);
    expect(outputs).toHaveLength(3);
    expect(outputs).toContainEqual(original);
    expect(outputs.every(output => JSON.stringify(outputImagePlanning(output.generationSnapshot)) === JSON.stringify(sku.imagePlanning))).toBe(true);
    expect(submitted.jobs.map(job => JSON.stringify(f.store.get(job.id)!.snapshot))).toEqual(snapshots);
    expect(f.imageRequests).toHaveLength(3);
  });

  it('replays the historical key after a complete response and disk failure, then resumes the same frozen job across restart without another POST', async () => {
    const f = await setup();
    const board = await f.plan(); await f.confirm();
    const sku = board.items.find(item => item.imagePlanning?.purpose === 'SKU')!;
    const initial = await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [sku.id] });
    await waitJob(f.backend, initial.jobs[0]!.id);
    const original = f.context.repository.listOutputs(f.project.id)[0]!;
    await f.plan('ALL');
    const request = { projectId: f.project.id, storyboardItemIds: [sku.id], revision: 'retry', regenerationKey: randomUUID(), generationConfig: { candidateCount: 1 } };
    const put = vi.spyOn(f.context.storage, 'putOutput').mockRejectedValueOnce(new Error('synthetic local disk failure'));
    let jobId!: string;
    let frozenSnapshot!: string;
    try {
      const submitted = await f.backend.invoke('createGenerationJobs', request);
      jobId = submitted.jobs[0]!.id;
      frozenSnapshot = JSON.stringify(f.store.get(jobId)!.snapshot);
      await waitJob(f.backend, jobId, 'FAILED');
      await f.context.scheduler.waitForIdle([jobId]);
      expect(f.context.repository.getStoryboardItem(sku.id)).toMatchObject({ status: 'GENERATING', planningSuperseded: true });
      expect(f.context.requestLedger.summaries(jobId)).toEqual([expect.objectContaining({ state: 'COMPLETED', localState: 'PENDING' })]);
      expect(f.context.repository.listOutputs(f.project.id)).toEqual([original]);
      expect((await f.backend.invoke('createGenerationJobs', request)).jobs).toEqual([expect.objectContaining({ id: jobId, status: 'FAILED' })]);
      expect(f.imageRequests).toHaveLength(2);
    } finally { put.mockRestore(); }
    await f.backend.close();
    const reopened = await fixtures.open(f.options);
    const store = new RuntimeStore((reopened.context.repository as unknown as { db: SqliteDatabase }).db);
    expect((await reopened.backend.invoke('createGenerationJobs', request)).jobs).toEqual([expect.objectContaining({ id: jobId, status: 'FAILED' })]);
    await reopened.backend.invoke('retryJob', { jobId });
    await waitJob(reopened.backend, jobId);
    expect((await reopened.backend.invoke('createGenerationJobs', request)).jobs).toEqual([expect.objectContaining({ id: jobId, status: 'SUCCEEDED' })]);
    expect(JSON.stringify(store.get(jobId)!.snapshot)).toBe(frozenSnapshot);
    expect(reopened.context.repository.listJobs(f.project.id).filter(job => job.type === 'GENERATE')).toHaveLength(2);
    const outputs = reopened.context.repository.listOutputs(f.project.id);
    expect(outputs).toHaveLength(2);
    expect(outputs).toContainEqual(original);
    expect(outputImagePlanning(outputs.find(output => output.jobId === jobId)!.generationSnapshot)).toEqual(sku.imagePlanning);
    expect(reopened.context.repository.getStoryboardItem(sku.id)).toMatchObject({ status: 'GENERATED', planningStale: false, planningSuperseded: true });
    expect(reopened.context.requestLedger.summaries(jobId)).toEqual([expect.objectContaining({ state: 'COMPLETED', localState: 'COMMITTED' })]);
    expect(f.server.state.counts['image-edit']).toBe(2);
    expect(f.imageRequests).toHaveLength(2);
  });

  it('includes every current item in the edited and confirmed version after ALL then STALE, preserving older JSON, output and frozen context', async () => {
    const f = await setup();
    const board = await f.plan(); await f.confirm();
    const main = board.items.find(item => item.imagePlanning?.purpose === 'MAIN')!;
    const affected = board.items.find(item => item.imagePlanning?.skus[0]?.id === f.planning().skus[0]!.id)!;
    const retainedSku = board.items.find(item => item.imagePlanning?.skus[0]?.id === f.planning().skus[1]!.id)!;
    const generated = await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [retainedSku.id] });
    await waitJob(f.backend, generated.jobs[0]!.id);
    const oldOutputs = f.context.repository.listOutputs(f.project.id);
    const frozenSnapshot = JSON.stringify(f.store.get(generated.jobs[0]!.id)!.snapshot);
    const oldContexts = f.context.repository.listStoryboardItems(f.project.id).map(item => [item.id, item.imagePlanning] as const);
    await f.save({ skus: f.planning().skus.map((member, index) => index ? member : { ...member, name: '蓝色更新规格' }) });
    const partial = await f.plan('STALE');
    expect(partial.items).toHaveLength(4);
    expect(partial.items.some(item => item.id === affected.id)).toBe(false);
    expect(f.context.repository.getStoryboardItem(affected.id)?.planningSuperseded).toBe(true);
    expect(f.context.repository.getStoryboardItem(main.id)!.storyboardVersion).toBeLessThan(partial.storyboard!.version);
    const previousVersions = f.context.history.listStoryboardVersions(f.project.id);
    await f.backend.invoke('updateStoryboardItem', { itemId: main.id, promptInstruction: 'USER EDIT OF RETAINED MAIN', candidateCount: 3 });
    const edited = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    expect(edited.storyboard!.version).toBe(partial.storyboard!.version + 1);
    const expectedIds = partial.items.map(item => item.id).sort();
    const latest = f.context.history.listStoryboardVersions(f.project.id)[0]!;
    const draft = JSON.parse(latest.dataJson) as { items: StoryboardItemRecord[] };
    expect(draft.items.map(item => item.id).sort()).toEqual(expectedIds);
    expect(draft.items.every(item => !item.planningSuperseded && item.storyboardVersion === edited.storyboard!.version)).toBe(true);
    expect(draft.items.find(item => item.id === main.id)).toMatchObject({ promptInstruction: 'USER EDIT OF RETAINED MAIN', candidateCount: 3 });
    expect(draft.items.find(item => item.id === retainedSku.id)?.imagePlanning).toEqual(retainedSku.imagePlanning);
    await f.confirm();
    const confirmed = f.context.history.listStoryboardVersions(f.project.id)[0]!;
    const confirmation = JSON.parse(confirmed.dataJson) as { status: string; items: StoryboardItemRecord[] };
    expect(confirmed.confirmed).toBe(true);
    expect(confirmation.status).toBe('CONFIRMED');
    expect(confirmation.items.map(item => item.id).sort()).toEqual(expectedIds);
    expect(confirmation.items.find(item => item.id === main.id)).toMatchObject({ status: 'CONFIRMED', promptInstruction: 'USER EDIT OF RETAINED MAIN' });
    expect(f.context.history.listStoryboardVersions(f.project.id).slice(1)).toEqual(previousVersions);
    expect(f.context.repository.listOutputs(f.project.id)).toEqual(oldOutputs);
    expect(JSON.stringify(f.store.get(generated.jobs[0]!.id)!.snapshot)).toBe(frozenSnapshot);
    for (const [id, context] of oldContexts) expect(f.context.repository.getStoryboardItem(id)?.imagePlanning).toEqual(context);
  });
});
