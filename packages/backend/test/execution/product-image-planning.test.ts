import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { resolveProductImageTargets, operations, suitePlanningCounts, type ProjectImagePlanning } from '@ecomgen/contracts';
import { ECOM_TEMPLATES } from '@ecomgen/ecom-skill';
import { storyboardReply, editPlanReply, type MockRequestContext } from '../../../../scripts/full-mock-provider.mjs';
import { regressionFixtures, file, waitJob, unzip, visualStoryboardReply } from '../desktop-regression-helpers.js';
import { outputImagePlanning, outputProvenance } from '../../src/execution/snapshot.js';
import { productPlanningBatches } from '../../src/execution/product-image-planning.js';
import { projectPublic } from '../../src/commands/support.js';
import { candidateIdFor } from '../../src/execution/context.js';
import { RuntimeStore } from '../../src/runtime/state.js';

const fixtures = regressionFixtures();
const LOCK = 'Charcoal #252525 and white #FFFFFF, matte surface, neutral daylight from the left.';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function setup(options: { mode?: 'CREATIVE' | 'PIXEL_PROTECTED'; beforeReply?: (request: MockRequestContext) => Promise<void> } = {}) {
  const payloads: Record<string, any>[] = [];
  const imageRequests: MockRequestContext[] = [];
  const f = await fixtures.fixture({ mode: options.mode, mock: {
    replyForRequest: async request => {
      if (request.workflow === 'edit-plan') return editPlanReply('no-confirmation');
      if (request.workflow !== 'storyboard') return undefined;
      payloads.push(structuredClone(request.payload));
      await options.beforeReply?.(request);
      const payload = request.payload;
      if (payload.planningVersion === 2) return visualStoryboardReply(payload, LOCK);
      const suiteShots = payload.planningMode === 'MANUAL' ? payload.requestedSuiteShots : undefined;
      return storyboardReply({
        assetTypes: payload.allowedTemplateIds.slice(0, 12), targetImageCount: payload.targetImageCount, suiteShots,
        candidateCount: payload.candidatesPerType, mode: payload.defaultMode,
        campaignStyleLock: payload.productImageBatch?.campaignStyleLock ?? suiteShots?.[0]?.styleLock ?? LOCK,
        referencedAssets: payload.assets.filter((asset: any) => asset.kind === 'PRODUCT').map((asset: any) => asset.handle),
      });
    },
    imageForRequest: (request, images) => { imageRequests.push(request); return images.image; },
  } });
  await f.backend.invoke('updateProject', { projectId: f.project.id, candidatesPerType: 2 });
  const truths = [];
  for (const color of ['#ba3322', '#2244bb', '#338855']) {
    const bytes = await sharp({ create: { width: 32, height: 24, channels: 4, background: color } }).png().toBuffer();
    const asset = await f.backend.invoke('uploadAsset', { projectId: f.project.id, role: 'PRODUCT_TRUTH', file: file(bytes, `truth-${truths.length}.png`) });
    truths.push({ ...asset, bytes });
  }
  const styleBytes = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#777777' } }).png().toBuffer();
  const style = await f.backend.invoke('uploadAsset', { projectId: f.project.id, role: 'STYLE_REFERENCE', file: file(styleBytes, 'style.png') });
  const skus = Array.from({ length: 6 }, (_, index) => ({ id: randomUUID(), name: `用户规格${index + 1}`, code: `SKU-${index + 1}`, attributes: [{ name: '用户属性', value: `属性${index + 1}` }], productAssetIds: [truths[Math.floor(index / 2)]!.id], included: true }));
  const imageGroups = Array.from({ length: 3 }, (_, index) => ({ id: randomUUID(), name: `显式共图${index + 1}`, skuIds: skus.slice(index * 2, index * 2 + 2).map(sku => sku.id), productAssetIds: [truths[index]!.id] }));
  let planning = (await f.backend.invoke('saveProjectImagePlanning', { projectId: f.project.id, expectedRevision: 0, config: { mainCount: 5, detailCount: 8, skuImagesPerGroup: 1, shareImages: true }, skus, imageGroups })).planning;
  const save = async (patch: Partial<Pick<ProjectImagePlanning, 'config' | 'skus' | 'imageGroups'>>) => {
    const result = await f.backend.invoke('saveProjectImagePlanning', { projectId: f.project.id, expectedRevision: planning.revision, config: planning.config, skus: planning.skus, imageGroups: planning.imageGroups, ...patch });
    planning = result.planning;
    return result;
  };
  const submit = (scope: 'ALL' | 'STALE' = 'ALL', userInstruction?: string) => f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: planning.revision, scope, userInstruction });
  const plan = async (scope: 'ALL' | 'STALE' = 'ALL') => { const job = await submit(scope); await waitJob(f.backend, job.id); return f.backend.invoke('getStoryboard', { projectId: f.project.id }); };
  const confirm = async () => { const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id }); return f.backend.invoke('confirmStoryboard', { projectId: f.project.id, version: board.storyboard!.version }); };
  return { ...f, truths, style, payloads, imageRequests, save, submit, plan, confirm, planning: () => planning };
}

describe('单持久任务商品图片规划', () => {
  it('自动图片规划不冻结无关套图目录，手选套图仍冻结被选定义', async () => {
    const f = await setup();
    const pending = await f.submit();
    const store = new RuntimeStore((f.context.repository as any).db);
    const snapshot = store.get(pending.id)!.snapshot;
    await f.backend.invoke('cancelJob', { jobId: pending.id });
    expect((snapshot.effective.execution as any).suites).toHaveLength(0);
    const suite = f.context.catalog.listSuites()[0]!;
    expect(suite.shots.length).toBeGreaterThan(0);
    const manual = await f.backend.invoke('createPlanningJob', { projectId: f.project.id, planningMode: 'MANUAL', requestedSuiteShots: [suite.shots[0]!.assetType] });
    const selected = store.get(manual.id)!.snapshot;
    expect((selected.effective.execution as any).suites).toHaveLength(1);
    expect((selected.effective.execution as any).suites[0]).toEqual(suite);
    await waitJob(f.backend, manual.id);
    const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    expect(board.items.map(item => item.assetType)).toEqual([suite.shots[0]!.assetType]);
    expect(f.payloads[0]!.requestedSuiteShots).toMatchObject([{ assetType: suite.shots[0]!.assetType, shotRole: suite.shots[0]!.shotRole, styleLock: suite.styleLock.lockText }]);
  });

  it('MANUAL 模板循环覆盖多个目标，STALE沿完整目录映射且同键重放不重复收费', async () => {
    const f = await setup();
    await f.save({ config: { mainCount: 3, detailCount: 0, skuImagesPerGroup: 1, shareImages: false }, skus: [], imageGroups: [] });
    const selected = ECOM_TEMPLATES.slice(0, 2).map(value => value.id);
    expect(selected).toHaveLength(2);
    const selection = { requestedTypes: selected };
    const command = { projectId: f.project.id, expectedRevision: f.planning().revision, planningMode: 'MANUAL' as const, regenerationKey: randomUUID(), ...selection };
    const first = await f.backend.invoke('createProductImagePlanningJob', command);
    await waitJob(f.backend, first.id);
    const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    expect(board.items.map(item => [item.imagePlanning!.targetId, item.assetType])).toEqual([['MAIN:1', selected[0]], ['MAIN:2', selected[1]], ['MAIN:3', selected[0]]]);
    expect(f.payloads.map(payload => payload.targetImageCount)).toEqual([2, 1]);
    const count = f.server.state.counts.chat;
    await expect(f.backend.invoke('createProductImagePlanningJob', command)).resolves.toMatchObject({ id: first.id, reused: true });
    expect(f.server.state.counts.chat).toBe(count);
    await f.save({ config: { ...f.planning().config, mainCount: 4 } });
    const stale = await f.backend.invoke('createProductImagePlanningJob', { ...command, expectedRevision: f.planning().revision, scope: 'STALE', regenerationKey: randomUUID() });
    await waitJob(f.backend, stale.id);
    const updated = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    expect(updated.items.find(item => item.imagePlanning?.targetId === 'MAIN:4')?.assetType).toBe(selected[1]);
    expect(updated.items.filter(item => item.imagePlanning?.targetId !== 'MAIN:4').map(item => item.id)).toEqual(board.items.map(item => item.id));
    expect(f.payloads.at(-1)!.targetImageCount).toBe(1);
  });

  it('套图蓝图派生用途数量，按镜头精确绑定并支持同键重放', async () => {
    const f = await setup();
    const suite = f.context.catalog.listSuites().find(value => value.shots.length >= 2)!;
    const blueprint = await f.backend.invoke('getSuitePlanningBlueprint', { suiteId: suite.id });
    const counts = suitePlanningCounts(blueprint);
    await f.save({ config: { ...counts, shareImages: false, suiteBlueprint: blueprint }, skus: [], imageGroups: [] });
    const expected = resolveProductImageTargets(f.planning());
    expect(expected.length).toBe(blueprint.shots.filter(shot => shot.purpose !== 'SKU').length);
    expect(expected.length).toBeGreaterThan(0);
    const command = { projectId: f.project.id, expectedRevision: f.planning().revision, regenerationKey: randomUUID() };
    const job = await f.backend.invoke('createProductImagePlanningJob', command);
    await waitJob(f.backend, job.id);
    const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    expect(board.items).toHaveLength(expected.length);
    for (const target of expected) {
      const item = board.items.find(value => value.imagePlanning?.targetId === target.targetId)!;
      expect(item.imagePlanning?.purpose).toBe(target.purpose);
      expect(item.assetType).toBe(`${blueprint.suiteId}::${target.suiteShotId}`);
      expect(item.planningSource).toMatchObject({ kind: 'SUITE', suiteId: blueprint.suiteId, suiteVersion: blueprint.suiteVersion, shotId: target.suiteShotId });
    }
    const used = board.items.map(item => item.planningSource?.kind === 'SUITE' ? item.planningSource.shotId : null);
    expect(new Set(used).size).toBe(used.length);
    expect(used.slice().sort()).toEqual(blueprint.shots.filter(shot => shot.purpose !== 'SKU').map(shot => shot.shotId).sort());
    const calls = f.server.state.counts.chat;
    await expect(f.backend.invoke('createProductImagePlanningJob', command)).resolves.toMatchObject({ id: job.id, reused: true });
    expect(f.server.state.counts.chat).toBe(calls);
    await expect(f.save({ config: { ...f.planning().config, mainCount: counts.mainCount + 1 } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('未绑定蓝图的旧套图分镜入口明确拒绝，不发送规划请求', async () => {
    const f = await setup();
    const suite = f.context.catalog.listSuites().find(value => value.shots.length > 0)!;
    await expect(f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: f.planning().revision, planningMode: 'MANUAL', requestedSuiteShots: [suite.shots[0]!.assetType] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('套图') });
    expect(f.server.state.counts.chat).toBe(0);
  });

  it('16画面/32候选来自显式共图；拆组19画面且每批最多12个目标', async () => {
    const f = await setup();
    expect(f.server.state.counts.chat).toBe(0);
    expect(resolveProductImageTargets(f.planning())).toHaveLength(16);
    const pending = await f.submit('ALL', '保留用户要求的背景方向');
    await waitJob(f.backend, pending.id);
    const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    expect(board.items).toHaveLength(16);
    expect(board.items.reduce((sum, item) => sum + item.candidateCount, 0)).toBe(32);
    expect(f.payloads.map(payload => payload.productImageBatch.targets.length)).toEqual([5, 1, 1, 1, 8]);
    expect(f.payloads.every(payload => payload.userInstruction === '保留用户要求的背景方向')).toBe(true);
    expect(f.payloads.slice(1).every(payload => payload.productImageBatch.campaignStyleLock === LOCK)).toBe(true);
    expect(board.storyboard!.campaignStyleLock).toBe(LOCK);
    const expected = resolveProductImageTargets(f.planning());
    for (const target of expected) {
      const item = board.items.find(item => item.imagePlanning?.targetId === target.targetId)!;
      expect(item.imagePlanning).toMatchObject({ purpose: target.purpose, skus: target.skus, productAssetIds: target.productAssetIds, sourceRevision: 1 });
    }
    const keys = f.context.requestLedger.summaries(pending.id).map(request => request.requestKey);
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(5);
    expect(keys.every((key, index) => key.startsWith(`product-plan:batch:${String(index + 1).padStart(3, '0')}:`))).toBe(true);
    expect(f.context.repository.listJobs(f.project.id).filter(job => job.type === 'PLAN')).toHaveLength(1);
    expect(f.server.state.counts['image-generation'] + f.server.state.counts['image-edit']).toBe(0);
    await f.save({ config: { ...f.planning().config, shareImages: false, detailCount: 24 } });
    const expanded = resolveProductImageTargets(f.planning());
    expect(expanded).toHaveLength(35);
    const batches = productPlanningBatches(expanded);
    expect(batches.every(batch => batch.length <= 12)).toBe(true);
    expect(batches.filter(batch => batch[0]!.purpose === 'DETAIL').map(batch => batch.length)).toEqual([12, 12]);
    await f.save({ config: { ...f.planning().config, detailCount: 8 } });
    expect(resolveProductImageTargets(f.planning())).toHaveLength(19);
  });

  it('IPC回执丢失后同键重放仍返回已成功的原Job，STALE发布后也不创建新意图', async () => {
    const f = await setup();
    const key = randomUUID();
    const input = { projectId: f.project.id, expectedRevision: 1, scope: 'STALE' as const, regenerationKey: key, userInstruction: '用户本次规划要求' };
    const first = await f.backend.invoke('createProductImagePlanningJob', input);
    const queuedReplay = await f.backend.invoke('createProductImagePlanningJob', input);
    expect(queuedReplay).toMatchObject({ id: first.id, reused: true });
    await waitJob(f.backend, first.id);
    const completedReplay = await f.backend.invoke('createProductImagePlanningJob', input);
    expect(completedReplay).toMatchObject({ id: first.id, reused: true, status: 'SUCCEEDED' });
    expect(f.server.state.counts.chat).toBe(5);
    expect(f.context.repository.listJobs(f.project.id).filter(job => job.type === 'PLAN')).toHaveLength(1);
  });

  it('全部回执完成但原子发布失败时不暴露半成品；同任务重试重放5批而不再POST', async () => {
    const f = await setup();
    const publish = vi.spyOn(f.context.repository, 'createPlanningConfigSnapshot').mockImplementationOnce(() => { throw new Error('synthetic publication failure'); });
    try {
      const job = await f.submit();
      await waitJob(f.backend, job.id, 'FAILED');
      await f.context.scheduler.waitForIdle([job.id]);
      expect(f.context.repository.listStoryboardItems(f.project.id)).toEqual([]);
      expect(f.server.state.counts.chat).toBe(5);
      expect(f.context.requestLedger.summaries(job.id).every(request => request.state === 'COMPLETED' && request.localState === 'PENDING')).toBe(true);
      const frozen = JSON.stringify(new RuntimeStore((f.context.repository as any).db).get(job.id)!.snapshot);
      await expect(f.backend.invoke('confirmStoryboard', { projectId: f.project.id, version: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
      await f.backend.invoke('retryJob', { jobId: job.id });
      await waitJob(f.backend, job.id);
      expect(f.server.state.counts.chat).toBe(5);
      expect((await f.backend.invoke('getStoryboard', { projectId: f.project.id })).items).toHaveLength(16);
      expect(JSON.stringify(new RuntimeStore((f.context.repository as any).db).get(job.id)!.snapshot)).toBe(frozen);
    } finally { publish.mockRestore(); }
  });

  it('局部更新只替换受影响目标，保留其他手工描述、排序和候选设置及历史行', async () => {
    const f = await setup();
    const first = await f.plan();
    const manual = first.items.find(item => item.imagePlanning?.purpose === 'MAIN')!;
    await f.backend.invoke('updateStoryboardItem', { itemId: manual.id, promptInstruction: 'USER MANUAL COMPOSITION', candidateCount: 3, displayName: '用户手工构图' });
    const beforeManual = f.context.repository.getStoryboardItem(manual.id)!;
    const changed = f.planning().skus.map((sku, index) => index === 0 ? { ...sku, name: '用户更改规格' } : sku);
    const saved = await f.save({ skus: changed });
    const affected = first.items.find(item => item.imagePlanning?.imageGroupId === f.planning().imageGroups[0]!.id)!;
    expect(saved.staleItemIds).toEqual([affected.id]);
    await expect(f.confirm()).rejects.toMatchObject({ code: 'CONFLICT' });
    const after = await f.plan('STALE');
    expect(after.items).toHaveLength(16);
    expect(f.payloads).toHaveLength(6);
    expect(f.payloads[5]!.productImageBatch.campaignStyleLock).toBe(LOCK);
    expect(f.context.repository.getStoryboardItem(manual.id)).toEqual(beforeManual);
    expect(f.context.repository.getStoryboardItem(affected.id)?.planningSuperseded).toBe(true);
    expect(after.items.some(item => item.id === affected.id)).toBe(false);
    expect(f.context.repository.listStoryboardItems(f.project.id)).toHaveLength(17);
    await expect(f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [affected.id] })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(f.backend.invoke('confirmStoryboard', { projectId: f.project.id, version: first.storyboard!.version })).rejects.toMatchObject({ code: 'CONFLICT' });
    await f.confirm();
    // 仅减少数量时有需要退役的目标；本地PLAN保留其余内容，不制造付费模型调用。
    await f.save({ config: { ...f.planning().config, mainCount: 4 } });
    const retiredOnly = await f.plan('STALE');
    expect(retiredOnly.items).toHaveLength(15);
    expect(f.payloads).toHaveLength(6);
    await f.confirm();
    await f.save({ config: { mainCount: 0, detailCount: 0, skuImagesPerGroup: 1, shareImages: false }, skus: [], imageGroups: [] });
    await f.backend.invoke('deleteProvider', { providerId: f.provider.id });
    expect((await f.plan('STALE')).items).toEqual([]);
    expect(f.payloads).toHaveLength(6);
  });

  it.each(['catalog', 'project', 'storyboard', 'asset'] as const)('%s在响应等待期间变化时拒绝迟到发布，保留已存在规划', async change => {
    let hold = false;
    const entered = deferred(), release = deferred();
    const f = await setup({ beforeReply: async () => { if (hold) { entered.resolve(); await release.promise; } } });
    const original = await f.plan();
    const ids = original.items.map(item => item.id);
    hold = true;
    const pending = await f.submit();
    await entered.promise;
    try {
      if (change === 'catalog') await f.save({ skus: f.planning().skus.map((sku, index) => index === 0 ? { ...sku, name: '目录发生变化' } : sku) });
      if (change === 'project') await f.backend.invoke('updateProject', { projectId: f.project.id, verifiedFacts: ['用户新确认事实'] });
      if (change === 'storyboard') await f.backend.invoke('updateStoryboardItem', { itemId: ids[0]!, promptInstruction: 'USER EDIT WHILE PLANNING' });
      if (change === 'asset') await f.backend.invoke('updateAsset', { assetId: f.style.id, role: 'LAYOUT_REFERENCE' });
    } finally { release.resolve(); }
    await waitJob(f.backend, pending.id, 'FAILED');
    expect(f.context.repository.listStoryboardItems(f.project.id).map(item => item.id)).toEqual(ids);
    expect(f.context.repository.listPlanningConfigSnapshots(f.project.id)).toHaveLength(1);
  });

  it('第二批外部响应UNKNOWN时不发布；更换目录、意图、普通规划入口都不能绕过屏障', async () => {
    const f = await setup();
    f.server.control.addFault({ kind: 'chat', at: 2, fault: { type: 'drop' } });
    const pending = await f.submit();
    await waitJob(f.backend, pending.id, 'UNKNOWN');
    expect(f.context.repository.listStoryboardItems(f.project.id)).toEqual([]);
    expect(f.context.requestLedger.summaries(pending.id).map(row => row.state)).toEqual(['COMPLETED', 'UNKNOWN']);
    await f.save({ skus: f.planning().skus.map(sku => ({ ...sku, id: randomUUID() })), imageGroups: [] });
    await expect(f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: f.planning().revision, regenerationKey: randomUUID() })).rejects.toMatchObject({ code: 'EXTERNAL_UNKNOWN' });
    await expect(f.backend.invoke('createPlanningJob', { projectId: f.project.id, planningMode: 'AI', targetImageCount: 1, regenerationKey: randomUUID() })).rejects.toMatchObject({ code: 'EXTERNAL_UNKNOWN' });
    await expect(f.backend.invoke('retryJob', { jobId: pending.id })).rejects.toMatchObject({ code: 'RETRY_UNSAFE' });
    expect(f.server.state.counts.chat).toBe(2);
  });

  it('排队时取消不调用Provider，运行中取消仍保留未知窗口且不发布半成品', async () => {
    const entered = deferred(), release = deferred();
    const f = await setup({ beforeReply: async () => { entered.resolve(); await release.promise; } });
    const queued = await f.submit();
    // 冻结后、setImmediate调度认领前取消。
    await f.backend.invoke('cancelJob', { jobId: queued.id });
    await waitJob(f.backend, queued.id, 'CANCELLED');
    expect(f.server.state.counts.chat).toBe(0);
    const pending = await f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: 1, regenerationKey: randomUUID() });
    await entered.promise;
    try { await f.backend.invoke('cancelJob', { jobId: pending.id }); } finally { release.resolve(); }
    await waitJob(f.backend, pending.id, 'UNKNOWN');
    expect(f.context.repository.listStoryboardItems(f.project.id)).toEqual([]);
  });

  it('排队PLAN返回冲突，请求在途返回未知屏障；目录保存仍为本地草稿操作', async () => {
    const entered = deferred(), release = deferred();
    const f = await setup({ beforeReply: async () => { entered.resolve(); await release.promise; } });
    const pending = await f.submit();
    try {
      expect(f.context.repository.getJob(pending.id)?.status).toBe('QUEUED');
      expect(f.context.requestLedger.summaries(pending.id)).toEqual([]);
      await expect(f.submit('ALL', '另一个付费意图')).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(f.backend.invoke('createPlanningJob', { projectId: f.project.id, planningMode: 'MANUAL', requestedTypes: ['hero-image'] })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(f.server.state.counts.chat).toBe(0);
      await entered.promise;
      expect(f.context.repository.getJob(pending.id)?.status).toBe('RUNNING');
      expect(f.context.requestLedger.summaries(pending.id)).toEqual([{ requestKey: 'product-plan:batch:001:model:0', state: 'IN_FLIGHT', localState: 'PENDING' }]);
      await f.save({ config: { ...f.planning().config, mainCount: 6 } });
      // Provider尚未给出完整回执，屏障按逐请求账本识别未知窗口，不能只看Job仍在RUNNING。
      await expect(f.submit()).rejects.toMatchObject({ code: 'EXTERNAL_UNKNOWN' });
      await expect(f.backend.invoke('createPlanningJob', { projectId: f.project.id, planningMode: 'MANUAL', requestedTypes: ['hero-image'] })).rejects.toMatchObject({ code: 'EXTERNAL_UNKNOWN' });
      expect(f.server.state.counts.chat).toBe(1);
    } finally { release.resolve(); }
    await waitJob(f.backend, pending.id, 'FAILED');
  });

  it('SKU像素保护从规划、编辑分镜到实际请求都只带显式商品子集；普通分镜仍带全部truth', async () => {
    const f = await setup({ mode: 'PIXEL_PROTECTED' });
    const board = await f.plan();
    const sku = board.items.find(item => item.imagePlanning?.imageGroupId === f.planning().imageGroups[1]!.id)!;
    const main = board.items.find(item => item.imagePlanning?.purpose === 'MAIN')!;
    const selectedCode = f.planning().skus[2]!.code;
    const skuPayloads = f.payloads.filter(payload => payload.productImageBatch.targets.some((target: any) => target.skus.some((member: any) => member.code === selectedCode)));
    expect(skuPayloads).toHaveLength(1);
    const skuPayload = skuPayloads[0]!;
    expect(skuPayload.productImageBatch.targets[0].skus.every((member: any) => !('id' in member))).toBe(true);
    expect(skuPayload.assets.filter((asset: any) => asset.kind === 'PRODUCT').map((asset: any) => asset.handle)).toEqual(['P2']);
    await expect(f.backend.invoke('updateStoryboardItem', { itemId: sku.id, referencedAssets: [f.truths[0]!.id] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await f.backend.invoke('updateStoryboardItem', { itemId: sku.id, promptInstruction: 'Preserve P2 exactly with the specified neutral lighting.' });
    expect(f.context.repository.getStoryboardItem(sku.id)?.referencedAssets).toEqual([f.style.id, f.truths[1]!.id]);
    await f.confirm();
    const job = await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [sku.id], generationConfig: { candidateCount: 1 } });
    // invoke返回后修改目录不改变已冻结生成输入。
    const frozen = sku.imagePlanning;
    await f.save({ skus: f.planning().skus.map(member => ({ ...member, name: `${member.name}之后改名`, included: false })) });
    await waitJob(f.backend, job.jobs[0]!.id);
    const output = f.context.repository.listOutputs(f.project.id).find(output => output.jobId === job.jobs[0]!.id)!;
    expect(outputImagePlanning(output.generationSnapshot)).toEqual(frozen);
    expect(outputProvenance(output.generationSnapshot)!.attachments.filter(image => image.role === 'PRODUCT_TRUTH').map(image => [image.id, image.sha256, image.handle])).toEqual([[f.truths[1]!.id, sha(f.truths[1]!.bytes), 'P2']]);
    const request = f.imageRequests[0]!;
    expect(Object.values(request.files).flat().map(image => sha(image.data)).sort()).toEqual([sha(f.truths[1]!.bytes), sha(await sharp({ create: { width: 32, height: 24, channels: 4, background: '#777777' } }).png().toBuffer())].sort());
    expect(String(request.fields.prompt)).toContain('Image 1 (P2)');
    // 重新参与并更新规划后，仅选主图；普通保护语义仍附加所有商品图。
    await f.save({ skus: f.planning().skus.map(member => ({ ...member, included: true })) });
    await f.plan('STALE');
    await f.confirm();
    const ordinary = await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [main.id], generationConfig: { candidateCount: 1 } });
    await waitJob(f.backend, ordinary.jobs[0]!.id);
    const ordinaryOutput = f.context.repository.listOutputs(f.project.id).find(output => output.jobId === ordinary.jobs[0]!.id)!;
    expect(outputProvenance(ordinaryOutput.generationSnapshot)!.attachments.filter(image => image.role === 'PRODUCT_TRUTH')).toHaveLength(3);
  });

  it('生成UNKNOWN阻止更换目录/目标/分镜意图；单图再生成同键去重与候选锁保留', async () => {
    const f = await setup();
    const board = await f.plan(); await f.confirm();
    const item = board.items.find(item => item.imagePlanning?.purpose === 'SKU')!;
    f.server.control.failNext('image-edit', { type: 'drop' });
    const generated = await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [item.id], generationConfig: { candidateCount: 1 } });
    await waitJob(f.backend, generated.jobs[0]!.id, 'UNKNOWN');
    await f.save({ config: { ...f.planning().config, mainCount: 6 } });
    await expect(f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: f.planning().revision, regenerationKey: randomUUID() })).rejects.toMatchObject({ code: 'EXTERNAL_UNKNOWN' });
    const other = board.items.find(candidate => candidate.imagePlanning?.purpose === 'MAIN')!;
    await expect(f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [other.id], regenerationKey: randomUUID() })).rejects.toMatchObject({ code: 'EXTERNAL_UNKNOWN' });
    expect(f.server.state.counts['image-edit']).toBe(1);
  });

  it('超96画面、无画面、旧revision和未完成规划均在付费请求前拒绝', async () => {
    const f = await setup();
    await expect(f.backend.invoke('createProductImagePlanningJob', { projectId: f.project.id, expectedRevision: 0 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await f.save({ config: { mainCount: 0, detailCount: 0, skuImagesPerGroup: 1, shareImages: false }, skus: [], imageGroups: [] });
    await expect(f.submit()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const sku = { id: randomUUID(), name: '一个用户规格', code: null, attributes: [], productAssetIds: [f.truths[0]!.id], included: true };
    await f.save({ config: { mainCount: 12, detailCount: 24, skuImagesPerGroup: 4, shareImages: false }, skus: Array.from({ length: 16 }, (_, i) => ({ ...sku, id: randomUUID(), name: `用户规格${i}` })) });
    await expect(f.submit()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(f.server.state.counts.chat).toBe(0);
  });
});

describe('用途和SKU不可变成图归属', () => {
  it('候选、显式再生成、编辑后代和ZIP都沿用输出原快照；公开API忽略伪造字段', async () => {
    const f = await setup();
    const board = await f.plan(); await f.confirm();
    const item = board.items.find(item => item.imagePlanning?.purpose === 'SKU')!;
    const originalContext = item.imagePlanning!;
    const submit = (regenerationKey?: string) => f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [item.id], generationConfig: { candidateCount: 2 }, ...(regenerationKey ? { regenerationKey, revision: 'retry' } : {}) });
    const first = await submit();
    for (const job of first.jobs) await waitJob(f.backend, job.id);
    const original = f.context.repository.listOutputs(f.project.id).find(output => output.jobId === first.jobs[0]!.id)!;
    expect((await submit()).jobs.map(job => job.id)).toEqual(first.jobs.map(job => job.id));
    const key = randomUUID();
    const regen = await submit(key);
    for (const job of regen.jobs) await waitJob(f.backend, job.id);
    expect((await submit(key)).jobs.map(job => job.id)).toEqual(regen.jobs.map(job => job.id));
    expect(f.context.repository.listOutputs(f.project.id)).toHaveLength(4);
    const session = await f.backend.invoke('createEditSession', { projectId: f.project.id, outputId: original.id });
    const mask = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#ffffff' } }).png().toBuffer();
    const turn = await f.backend.invoke('createEditTurn', { sessionId: session.id, message: '仅编辑背景', editMask: file(mask, 'mask.png') });
    await waitJob(f.backend, turn.planJobId);
    const childId = candidateIdFor(turn.planJobId, 0); await waitJob(f.backend, childId);
    const edited = f.context.repository.listOutputs(f.project.id).find(output => output.jobId === childId)!;
    expect(outputImagePlanning(edited.generationSnapshot)).toEqual(originalContext);
    expect(edited.parentOutputId).toBe(original.id);
    await f.save({ skus: f.planning().skus.map(sku => ({ ...sku, name: '目录现在不同', included: false })) });
    for (const dto of [await f.backend.invoke('getOutput', { outputId: original.id }), ...(await f.backend.invoke('listOutputs', { projectId: f.project.id })).items, ...(await f.backend.invoke('getProject', { projectId: f.project.id })).outputs]) {
      expect(dto.imagePlanning).toEqual(originalContext);
      expect(JSON.stringify(dto)).not.toMatch(/generationSnapshot|storagePath|encryptedApiKey|provenance/);
    }
    const chosen = [edited, original];
    const archive = await f.backend.invoke('createExportJob', { projectId: f.project.id, outputIds: chosen.map(output => output.id) });
    await waitJob(f.backend, archive.job.id);
    const stored = f.context.repository.getExportByJobId(archive.job.id)!;
    const files = unzip(await f.context.storage.read(stored.storagePath!));
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
    expect(manifest.storyboard.map((entry: any) => entry.outputId)).toEqual(chosen.map(output => output.id));
    expect(manifest.storyboard.every((entry: any) => JSON.stringify(entry.imagePlanning) === JSON.stringify(originalContext))).toBe(true);
    expect([...files.keys()].filter(name => name !== 'manifest.json').every(name => name.includes('_SKU_01_SKU-1+SKU-2_'))).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain('目录现在不同');
    const forged = projectPublic(operations.getOutput.output, { ...original, imagePlanning: { ...originalContext, purpose: 'DETAIL' }, generationSnapshot: null });
    expect(forged).not.toHaveProperty('imagePlanning');
    expect(outputImagePlanning({ ...original.generationSnapshot!, imagePlanning: { ...originalContext, storagePath: 'private/path' } } as any)).toBeUndefined();
    // 新ALL规划替代旧项后，旧产物仍可按明确的再生成意图沿用原规格。
    await f.save({ skus: f.planning().skus.map(sku => ({ ...sku, included: true })) });
    await f.plan('ALL');
    expect(f.context.repository.getStoryboardItem(item.id)?.planningSuperseded).toBe(true);
    const historical = await submit(randomUUID());
    for (const job of historical.jobs) await waitJob(f.backend, job.id);
    expect(outputImagePlanning(f.context.repository.listOutputs(f.project.id).find(output => output.jobId === historical.jobs[0]!.id)!.generationSnapshot)).toEqual(originalContext);
  });
});
