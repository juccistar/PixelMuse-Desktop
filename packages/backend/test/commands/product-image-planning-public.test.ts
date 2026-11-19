import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { operations, resolveProductImageTargets, type ProjectImagePlanning, type ProjectSku, type SaveProjectImagePlanningInput } from '@ecomgen/contracts';
import { createBackend, type Backend, type CommandContext } from '../../src/index.js';
import { registerDomainCommands } from '../../src/commands/index.js';
import { imagePlanningContext, planningAssetsFingerprint, projectPlanningFactsFingerprint } from '../../src/execution/product-image-planning.js';
import type { SqliteDatabase, StoryboardItemRecord } from '@ecomgen/core';
import { productImageTargetFingerprint } from '../../src/product-image-planning.js';

const sku = (name: string): ProjectSku => ({ id: randomUUID(), name, code: null, attributes: [], productAssetIds: [], included: true });
function input(state: ProjectImagePlanning): SaveProjectImagePlanningInput {
  return structuredClone({ projectId: state.projectId, expectedRevision: state.revision, config: state.config, skus: state.skus, imageGroups: state.imageGroups });
}

describe('product image planning through the real Backend public boundary', () => {
  let root: string, backend: Backend, context: CommandContext, projectId: string;
  const events = vi.fn();
  const network = vi.fn(async () => { throw new Error('network forbidden'); });
  const get = () => backend.invoke('getProjectImagePlanning', { projectId });
  const save = (draft: SaveProjectImagePlanningInput) => backend.invoke('saveProjectImagePlanning', draft);
  const seedItems = (state: ProjectImagePlanning) => {
    context.repository.saveStoryboard(projectId, '保留视觉锁', 'DRAFT', resolveProductImageTargets(state).map((target, sortOrder) => ({
      assetType: 'hero-image', displayName: target.name, shotRole: null, templateVariant: null, candidateCount: 2,
      referencedAssets: target.productAssetIds, mode: 'CREATIVE' as const, status: 'DRAFT' as const,
      promptInstruction: `保留手工内容 ${sortOrder}`, compiledPrompt: '保留编译内容', factClaims: [], riskFlags: [], sortOrder,
      imagePlanning: { ...imagePlanningContext(target, state.revision), projectFactsFingerprint: projectPlanningFactsFingerprint(context.repository.getProject(projectId)!), assetsFingerprint: planningAssetsFingerprint(context.repository.listAssets(projectId)) },
    })));
    return context.repository.listStoryboardItems(projectId);
  };
  const truth = () => context.repository.createAsset({
    projectId, role: 'PRODUCT_TRUTH', mimeType: 'image/png', storagePath: `assets/${randomUUID()}.png`,
    hash: randomUUID(), originalName: '用户图片.png', width: 8, height: 8,
  });
  const confirm = () => backend.invoke('confirmStoryboard', { projectId, version: context.repository.getStoryboard(projectId)!.version });
  const outputFor = async (item: StoryboardItemRecord, legacy = false) => {
    const job = context.repository.createJob({ id: randomUUID(), projectId: item.projectId, storyboardItemId: item.id, type: 'GENERATE', status: 'SUCCEEDED', input: {} });
    const stored = await context.storage.putOutput(item.projectId, Buffer.from('isolated-output'), 'png', job.id);
    return context.repository.createOutput({ projectId: item.projectId, storyboardItemId: item.id, jobId: job.id, candidateIndex: 1,
      storagePath: stored.path, hash: stored.hash, generationSnapshot: legacy ? null : {
        providerId: randomUUID(), modelId: 'isolated-model', resolution: '1K', aspectRatio: 'AUTO', size: '8x8', candidateIndex: 1, imagePlanning: item.imagePlanning,
      } });
  };

  beforeEach(async () => {
    events.mockClear(); network.mockClear();
    root = await mkdtemp(join(tmpdir(), 'ecomgen-product-planning-public-'));
    backend = await createBackend({ dataDir: root, masterKey: Buffer.alloc(32, 7).toString('base64'), version: 'isolated-test' }, events, {
      commands: current => { context = current; return registerDomainCommands(current); },
      fetch: network,
    });
    projectId = context.repository.createProject({
      name: '实际商品', category: null, productDescription: null, verifiedFacts: [], prohibitedClaims: [], brandGuidelines: {},
      platformTargets: ['TAOBAO'], targetMarket: null, copyLanguage: null,
      reasoningProviderId: null, reasoningModelId: null, imageProviderId: null, imageModelId: null,
      defaultMode: 'CREATIVE', imageResolution: '1K', imageAspectRatio: 'AUTO', candidatesPerType: 2,
    }).id;
  });
  afterEach(async () => {
    try { await backend?.close(); } finally { if (root) await rm(root, { recursive: true, force: true }); }
  });

  it('persists adoption and detail order across reopen, rejects stale writes and allows unadoption', async () => {
    const draft = input(await get()); draft.config.detailCount = 2;
    const state = (await save(draft)).planning, items = seedItems(state);
    const first = items.find(item => item.imagePlanning?.targetId === 'DETAIL:1')!;
    const second = items.find(item => item.imagePlanning?.targetId === 'DETAIL:2')!;
    const output = await outputFor(first);
    expect(await backend.invoke('getProjectWorkbench', { projectId })).toEqual({ projectId, revision: 0, adoptions: [], detailOrder: [], updatedAt: null });
    events.mockClear();
    const saved = await backend.invoke('saveProjectWorkbench', { projectId, expectedRevision: 0, adoptions: [{ targetId: 'DETAIL:1', outputId: output.id }], detailOrder: ['DETAIL:2', 'DETAIL:1'] });
    expect(saved.revision).toBe(1);
    expect(events.mock.calls.some(([event]) => event.topic === 'outputs' && event.projectId === projectId)).toBe(true);
    await expect(backend.invoke('saveProjectWorkbench', { projectId, expectedRevision: 0, adoptions: [], detailOrder: [] })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(backend.invoke('saveProjectWorkbench', { projectId, expectedRevision: 1, adoptions: [{ targetId: second.imagePlanning!.targetId, outputId: output.id }], detailOrder: [] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(backend.invoke('saveProjectWorkbench', { projectId, expectedRevision: 1, adoptions: [], detailOrder: ['MAIN:1'] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await backend.invoke('getProjectWorkbench', { projectId })).toEqual(saved);
    // 分镜后来归属变化不改变产物生成时冻结的采用身份。
    (context.repository as unknown as { db: SqliteDatabase }).db.prepare('UPDATE storyboard_items SET image_planning_json=?,planning_superseded=1 WHERE id=?').run(JSON.stringify(second.imagePlanning), first.id);
    await backend.close();
    backend = await createBackend({ dataDir: root, masterKey: Buffer.alloc(32, 7).toString('base64'), version: 'isolated-test' }, events, {
      commands: current => { context = current; return registerDomainCommands(current); }, fetch: network,
    });
    expect(await backend.invoke('getProjectWorkbench', { projectId })).toEqual(saved);
    await expect(backend.invoke('saveProjectWorkbench', { projectId, expectedRevision: 1, adoptions: saved.adoptions, detailOrder: saved.detailOrder })).resolves.toMatchObject({ revision: 2 });
    await expect(backend.invoke('saveProjectWorkbench', { projectId, expectedRevision: 2, adoptions: [], detailOrder: ['DETAIL:2'] })).resolves.toMatchObject({ revision: 3, adoptions: [], detailOrder: ['DETAIL:2'] });
    expect(network).not.toHaveBeenCalled();
  });

  it('accepts legacy storyboard identity and rejects duplicate or foreign adoption targets atomically', async () => {
    const items = seedItems(await get()), item = items[0]!;
    (context.repository as unknown as { db: SqliteDatabase }).db.prepare('UPDATE storyboard_items SET image_planning_json=NULL WHERE id=?').run(item.id);
    const legacy = await outputFor(item, true);
    const valid = { projectId, expectedRevision: 0, adoptions: [{ targetId: item.id, outputId: legacy.id }], detailOrder: [item.id] };
    await expect(backend.invoke('saveProjectWorkbench', { ...valid, adoptions: [...valid.adoptions, ...valid.adoptions] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const foreign = context.repository.createProject({ ...context.repository.getProject(projectId)!, name: '其他项目' });
    await expect(backend.invoke('saveProjectWorkbench', { ...valid, projectId: foreign.id, detailOrder: [] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await backend.invoke('getProjectWorkbench', { projectId })).toMatchObject({ revision: 0, adoptions: [] });
    await expect(backend.invoke('saveProjectWorkbench', valid)).resolves.toMatchObject({ revision: 1, adoptions: valid.adoptions, detailOrder: [item.id] });
  });

  it('cancels a middle target without renumbering surviving targets or requiring another paid plan', async () => {
    const draft = input(await get()); draft.config.mainCount = 3;
    const original = (await save(draft)).planning, items = seedItems(original);
    const removed = items.find(item => item.imagePlanning?.targetId === 'MAIN:2')!;
    await backend.invoke('deleteStoryboardItem', { itemId: removed.id });
    const current = await get();
    expect(current.config).toMatchObject({ mainCount: 3, excludedTargetIds: ['MAIN:2'] });
    expect(current.revision).toBe(original.revision + 1);
    expect(resolveProductImageTargets(current).map(target => [target.targetId, target.ordinal])).toEqual([['MAIN:1', 1], ['MAIN:3', 3]]);
    expect(context.repository.getStoryboardItem(removed.id)).toMatchObject({ planningSuperseded: true });
    expect((await backend.invoke('getStoryboard', { projectId })).items.map(item => item.imagePlanning!.targetId)).toEqual(['MAIN:1', 'MAIN:3']);
    await expect(confirm()).resolves.toMatchObject({ status: 'CONFIRMED' });
    await expect(backend.invoke('createProductImagePlanningJob', { projectId, expectedRevision: current.revision, scope: 'STALE' })).rejects.toMatchObject({ code: 'CONFLICT', message: '当前没有需要更新的规划画面。' });
    expect(network).not.toHaveBeenCalled();
  });

  it.each(['facts', 'assets'] as const)('invalidates only ungenerated planning when %s change and blocks confirmation', async change => {
    const draft = input(await get()); draft.config.mainCount = 2;
    const state = (await save(draft)).planning, items = seedItems(state);
    await outputFor(items[0]!);
    if (change === 'facts') await backend.invoke('updateProject', { projectId, verifiedFacts: ['用户新确认事实'] });
    else truth();
    const board = await backend.invoke('getStoryboard', { projectId });
    expect(board.items.map(item => Boolean(item.planningStale))).toEqual([false, true]);
    if (change === 'facts') expect((await backend.invoke('getProject', { projectId })).items.map(item => Boolean(item.planningStale))).toEqual([false, true]);
    await expect(confirm()).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(backend.invoke('createProductImagePlanningJob', { projectId, expectedRevision: state.revision, scope: 'STALE' })).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(context.repository.listJobs(projectId).filter(job => job.type === 'PLAN')).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });

  it('records the frozen output set for all-output exports without exposing private job input', async () => {
    const item = seedItems(await get())[0]!, output = await outputFor(item);
    const exported = await backend.invoke('createExportJob', { projectId });
    await backend.invoke('cancelJob', { jobId: exported.job.id });
    await context.scheduler.waitForIdle([exported.job.id]);
    await outputFor(item);
    const records = await backend.invoke('listProjectExports', { projectId });
    expect(records.items).toEqual([expect.objectContaining({ id: exported.export!.id, jobId: exported.job.id, outputIds: [output.id], longImage: false, downloadUrl: null })]);
    expect(JSON.stringify(records)).not.toMatch(/storagePath|exportedOutputIds|requestFingerprint/);
    expect(await backend.invoke('getProjectWorkbench', { projectId })).toMatchObject({ revision: 0, adoptions: [] });
  });

  it('lists export records newest first and exposes only successful public artifact URLs', async () => {
    const item = seedItems(await get())[0]!, output = await outputFor(item);
    const successfulJob = context.repository.createJob({ id: randomUUID(), projectId, storyboardItemId: null, type: 'EXPORT', status: 'SUCCEEDED', input: { outputIds: [output.id], longImage: { targetWidth: 750 }, privateReceipt: 'must-not-leak' } });
    const stored = await context.storage.putOutput(projectId, Buffer.from('isolated-export-record'), 'zip');
    const succeeded = context.repository.createExport({ projectId, jobId: successfulJob.id, status: 'SUCCEEDED', storagePath: stored.path });
    const failedJob = context.repository.createJob({ id: randomUUID(), projectId, storyboardItemId: null, type: 'EXPORT', status: 'FAILED', input: { outputIds: [output.id] } });
    const failed = context.repository.createExport({ projectId, jobId: failedJob.id, status: 'FAILED', storagePath: null });
    const db = (context.repository as unknown as { db: SqliteDatabase }).db;
    db.prepare('UPDATE exports SET created_at=? WHERE id=?').run('2026-11-06T00:00:00.000Z', succeeded.id);
    db.prepare('UPDATE exports SET created_at=? WHERE id=?').run('2026-11-07T00:00:00.000Z', failed.id);
    const result = await backend.invoke('listProjectExports', { projectId });
    expect(result.items.map(record => record.id)).toEqual([failed.id, succeeded.id]);
    expect(result.items[0]).toMatchObject({ status: 'FAILED', downloadUrl: null, longImage: false });
    expect(result.items[1]).toMatchObject({ status: 'SUCCEEDED', outputIds: [output.id], downloadUrl: `ecomgen-resource://EXPORT/${succeeded.id}`, longImage: true });
    expect(JSON.stringify(result)).not.toMatch(/storagePath|privateReceipt|must-not-leak/);
  });

  it('rejects a path-shaped attribute on first save without persisting an unreadable catalog', async () => {
    const defaults = await get(), draft = input(defaults), member = sku('蓝色');
    member.attributes = [{ name: '型号', value: 'C:\\Blue' }]; draft.skus = [member];
    expect(Value.Check(operations.saveProjectImagePlanning.input, draft)).toBe(true);
    await expect(save(draft)).rejects.toMatchObject({ code: 'PRIVATE_OUTPUT' });
    expect(context.repository.getProjectImagePlanning(projectId)).toBeUndefined();
    await expect(get()).resolves.toEqual(defaults);
    expect(events).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });

  it('rolls back revision, catalog and both stale-flag transitions when the public response is rejected', async () => {
    const draft = input(await get()); draft.config.mainCount = 0; draft.skus = [sku('蓝色'), sku('红色')];
    const original = (await save(draft)).planning, items = seedItems(original);
    const renamed = input(original); renamed.skus[0]!.name = '蓝色新名称';
    const current = (await save(renamed)).planning;
    const before = context.repository.listStoryboardItems(projectId), histories = context.repository.listStoryboardVersions(projectId);
    expect(before.map(item => Boolean(item.planningStale))).toEqual([true, false]);
    events.mockClear();
    const invalid = input(current);
    invalid.skus[0]!.name = original.skus[0]!.name; // 提交前会尝试清除原有 stale。
    invalid.skus[1]!.attributes = [{ name: '型号', value: 'C:\\Blue' }]; // 同时会尝试设置另一个 stale。
    expect(Value.Check(operations.saveProjectImagePlanning.input, invalid)).toBe(true);
    await expect(save(invalid)).rejects.toMatchObject({ code: 'PRIVATE_OUTPUT' });
    expect(context.repository.getProjectImagePlanning(projectId)).toEqual(current);
    expect(context.repository.listStoryboardItems(projectId)).toEqual(before);
    expect(context.repository.listStoryboardVersions(projectId)).toEqual(histories);
    expect(before.map(item => item.id)).toEqual(items.map(item => item.id));
    await expect(get()).resolves.toEqual(current);
    expect(context.repository.listJobs(projectId)).toEqual([]);
    expect(events).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });

  it('keeps overridden member refs in snapshots without requiring a model refresh until effective group refs change', async () => {
    const a = truth(), b = truth(), c = truth();
    const draft = input(await get()); draft.config.mainCount = 0; draft.config.shareImages = true;
    const first = sku('蓝色大号'), second = sku('蓝色小号');
    first.code = 'BLUE-L'; first.attributes = [{ name: '尺码', value: 'L' }]; first.productAssetIds = [b.id];
    second.code = 'BLUE-S'; second.attributes = [{ name: '尺码', value: 'S' }]; second.productAssetIds = [a.id];
    draft.skus = [first, second];
    const groupId = randomUUID();
    draft.imageGroups = [{ id: groupId, name: '用户确认同外观', skuIds: [first.id, second.id], productAssetIds: [a.id] }];
    const original = (await save(draft)).planning, item = seedItems(original)[0]!;
    const target = resolveProductImageTargets(original)[0]!, fingerprint = productImageTargetFingerprint(target);
    const snapshot = structuredClone(item.imagePlanning!);
    expect(target.targetId).toBe(`SKU:${groupId}:1`);
    expect(target.productAssetIds).toEqual([a.id]);
    expect(snapshot!.skus.find(member => member.id === first.id)!.productAssetIds).toEqual([b.id]);

    const changedMember = input(original); changedMember.skus[0]!.productAssetIds = [c.id];
    const saved = await save(changedMember), updatedTarget = resolveProductImageTargets(saved.planning)[0]!;
    expect(saved.planning.revision).toBe(original.revision + 1);
    expect(saved.staleItemIds).toEqual([]);
    expect(updatedTarget.targetId).toBe(target.targetId);
    expect(updatedTarget.productAssetIds).toEqual([a.id]);
    expect(updatedTarget.skus.find(member => member.id === first.id)!.productAssetIds).toEqual([c.id]);
    expect(productImageTargetFingerprint(updatedTarget)).toBe(fingerprint);
    expect(context.repository.getStoryboardItem(item.id)).toEqual(item);
    expect(item.imagePlanning!.sourceRevision).toBeLessThan(saved.planning.revision);
    // 未配置任何模型；STALE 应确认无工作，而不是因为目录 revision 变化要求推理模型。
    await expect(backend.invoke('createProductImagePlanningJob', { projectId, expectedRevision: saved.planning.revision, scope: 'STALE' }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: '当前没有需要更新的规划画面。' });
    await expect(confirm()).resolves.toMatchObject({ status: 'CONFIRMED' });
    expect(context.repository.getStoryboardItem(item.id)!.imagePlanning).toEqual(snapshot);
    expect(context.repository.listJobs(projectId)).toEqual([]);

    events.mockClear();
    await expect(save(input(saved.planning))).resolves.toEqual(saved);
    expect(events).not.toHaveBeenCalled();
    const changedGroup = input(saved.planning); changedGroup.imageGroups[0]!.productAssetIds = [b.id];
    const effectiveChange = await save(changedGroup), effectiveTarget = resolveProductImageTargets(effectiveChange.planning)[0]!;
    expect(effectiveTarget.targetId).toBe(target.targetId);
    expect(effectiveTarget.productAssetIds).toEqual([b.id]);
    expect(productImageTargetFingerprint(effectiveTarget)).not.toBe(fingerprint);
    expect(effectiveChange.staleItemIds).toEqual([item.id]);
    expect(context.repository.getStoryboardItem(item.id)).toMatchObject({ planningStale: true, imagePlanning: snapshot });
    await expect(confirm()).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(backend.invoke('createProductImagePlanningJob', { projectId, expectedRevision: effectiveChange.planning.revision, scope: 'STALE' }))
      .rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(context.repository.listJobs(projectId)).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });
});
