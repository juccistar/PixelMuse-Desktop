import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { EcomRepository, openDatabase, type StoryboardItemRecord } from '@ecomgen/core';
import { operations, resolveProductImageTargets, type ProjectImagePlanning, type ProjectSku, type SaveProjectImagePlanningInput } from '@ecomgen/contracts';
import { registerProductImagePlanningCommands } from '../../src/commands/product-image-planning.js';
import { getProjectImagePlanningState, productImageTargetFingerprint } from '../../src/product-image-planning.js';
import type { CommandContext } from '../../src/runtime/ports.js';

let db: ReturnType<typeof openDatabase>, repository: EcomRepository, context: CommandContext;
let handlers: ReturnType<typeof registerProductImagePlanningCommands>, projectId: string;
const time = '2026-11-07T12:00:00.000Z';
function project() {
  const id = randomUUID();
  db.prepare('INSERT INTO projects(id,name,platform_targets_json,default_mode,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, '实际商品', '["TAOBAO"]', 'CREATIVE', time, time);
  return id;
}
const sku = (name = '用户规格'): ProjectSku => ({ id: randomUUID(), name, code: null, attributes: [], productAssetIds: [], included: true });
function input(state: ProjectImagePlanning): SaveProjectImagePlanningInput {
  return structuredClone({ projectId: state.projectId, expectedRevision: state.revision, config: state.config, skus: state.skus, imageGroups: state.imageGroups });
}
const save = (value: SaveProjectImagePlanningInput) => handlers.saveProjectImagePlanning!(context, value) as { planning: ProjectImagePlanning; staleItemIds: string[] };
const get = () => handlers.getProjectImagePlanning!(context, { projectId }) as ProjectImagePlanning;
function asset(role: 'PRODUCT_TRUTH' | 'STYLE_REFERENCE' = 'PRODUCT_TRUTH', owner = projectId, mimeType = 'image/png') {
  return repository.createAsset({ projectId: owner, role, mimeType, storagePath: `assets/${randomUUID()}.png`, hash: randomUUID(), originalName: '用户图片.png', width: 8, height: 8 });
}
function seedItems(state: ProjectImagePlanning) {
  const items = resolveProductImageTargets(state).map((target, sortOrder) => ({
    assetType: 'hero-image', displayName: target.name, shotRole: null, templateVariant: null, candidateCount: 2,
    referencedAssets: target.productAssetIds, mode: 'CREATIVE' as const, status: 'DRAFT' as const,
    promptInstruction: `手工内容 ${sortOrder}`, compiledPrompt: '保留编译内容', factClaims: [], riskFlags: [], sortOrder,
    imagePlanning: { purpose: target.purpose, targetId: target.targetId, imageGroupId: target.imageGroupId, ordinal: target.ordinal,
      sourceRevision: state.revision, sourceFingerprint: productImageTargetFingerprint(target), skus: target.skus, productAssetIds: target.productAssetIds },
  }));
  repository.saveStoryboard(projectId, '保留视觉锁', 'DRAFT', items);
  return repository.listStoryboardItems(projectId);
}
function output(item: StoryboardItemRecord) {
  const job = repository.createJob({ id: randomUUID(), projectId, storyboardItemId: item.id, type: 'GENERATE', input: { private: true }, status: 'SUCCEEDED' });
  return repository.createOutput({ projectId, storyboardItemId: item.id, jobId: job.id, candidateIndex: 1, generationSnapshot: null, storagePath: 'outputs/original.png', hash: 'original' });
}

beforeEach(() => {
  db = openDatabase(':memory:'); repository = new EcomRepository(db); projectId = project();
  context = { repository, clock: () => time, transaction: callback => repository.transaction(callback), events: { publish: vi.fn() } } as unknown as CommandContext;
  handlers = registerProductImagePlanningCommands(context);
});
afterEach(() => db.close());

describe('atomic project image planning directory commands', () => {
  it('reads revision zero defaults without sample data or writes and rejects absent projects', () => {
    expect(get()).toEqual({ projectId, revision: 0, config: { mainCount: 1, detailCount: 0, skuImagesPerGroup: 1, shareImages: false }, skus: [], imageGroups: [], updatedAt: null });
    expect(repository.getProjectImagePlanning(projectId)).toBeUndefined();
    const draft = get(); draft.skus.push(sku()); expect(get().skus).toEqual([]);
    expect(() => getProjectImagePlanningState(repository, randomUUID())).toThrow('项目不存在');
  });
  it('round-trips custom attributes and explicit groups, increments CAS once and retains no-op revision and timestamp', () => {
    const draft = input(get()), truth = asset();
    const first = sku('手工名称'); first.code = 'BLUE-L'; first.attributes = [{ name: '颜色', value: '蓝色' }, { name: '容量', value: '500ml' }]; first.productAssetIds = [truth.id];
    const second = sku('第二规格'); draft.skus = [first, second]; draft.config.shareImages = true;
    draft.imageGroups = [{ id: randomUUID(), name: '用户确认同外观', skuIds: [first.id, second.id], productAssetIds: [truth.id] }];
    const saved = save(draft); expect(saved.planning.revision).toBe(1); expect(saved.staleItemIds).toEqual([]);
    expect(get()).toEqual(saved.planning); expect(Value.Check(operations.getProjectImagePlanning.output, get())).toBe(true);
    expect(save(input(get())).planning).toEqual(saved.planning);
    const old = input(get()); const newer = input(get()); newer.skus[0]!.name = '新名称';
    expect(save(newer).planning.revision).toBe(2);
    expect(() => save(old)).toThrow('刷新'); expect(get().skus[0]!.name).toBe('新名称');
    expect(repository.listJobs(projectId)).toEqual([]);
  });
  it('keeps a revision-zero no-op as computed defaults', () => {
    expect(save(input(get())).planning.revision).toBe(0); expect(repository.getProjectImagePlanning(projectId)).toBeUndefined();
    expect(context.events.publish).not.toHaveBeenCalled();
  });
  it.each(['style', 'foreign', 'non-image', 'missing'] as const)('rejects %s references in SKU and group without persisting', variant => {
    const reference = variant === 'missing' ? randomUUID() : asset(variant === 'style' ? 'STYLE_REFERENCE' : 'PRODUCT_TRUTH', variant === 'foreign' ? project() : projectId, variant === 'non-image' ? 'application/pdf' : 'image/png').id;
    const draft = input(get()); const member = sku(); draft.skus = [member]; member.productAssetIds = [reference];
    expect(() => save(draft)).toThrow('商品真值');
    member.productAssetIds = []; draft.imageGroups = [{ id: randomUUID(), name: '组', skuIds: [member.id], productAssetIds: [reference] }];
    expect(() => save(draft)).toThrow('商品真值'); expect(get().revision).toBe(0);
  });
  it.each(['sku-id', 'code', 'attribute', 'group-id', 'member', 'unknown-member', 'target-collision'] as const)('rejects duplicate or invalid %s atomically', variant => {
    const draft = input(get()); const first = sku(), second = sku(); draft.skus = [first, second];
    if (variant === 'sku-id') second.id = first.id;
    if (variant === 'code') { first.code = 'Blue-1'; second.code = ' blue-1 '; }
    if (variant === 'attribute') first.attributes = [{ name: '颜色', value: '蓝' }, { name: ' 颜色 ', value: '红' }];
    const group = { id: randomUUID(), name: '组', skuIds: [first.id], productAssetIds: [] };
    if (variant === 'group-id') draft.imageGroups = [group, { ...group, skuIds: [second.id] }];
    if (variant === 'member') draft.imageGroups = [group, { ...group, id: randomUUID() }];
    if (variant === 'unknown-member') draft.imageGroups = [{ ...group, skuIds: [randomUUID()] }];
    if (variant === 'target-collision') draft.imageGroups = [{ ...group, id: second.id }];
    expect(() => save(draft)).toThrow(); expect(get().revision).toBe(0);
  });
  it('preserves bounded over-capacity catalogs so users can reduce participation before submitting planning', () => {
    const draft = input(get()); draft.config = { mainCount: 12, detailCount: 24, skuImagesPerGroup: 4, shareImages: false };
    draft.skus = Array.from({ length: 60 }, (_, index) => sku(`规格 ${index}`));
    expect(resolveProductImageTargets(save(draft).planning)).toHaveLength(276);
    draft.expectedRevision = 1; draft.skus.push(sku('第61项'));
    expect(() => save(draft)).toThrow('参数无效'); expect(get().skus).toHaveLength(60);
  });
  it('invalidates only affected ungenerated targets and preserves edited prompts, histories and immutable snapshots', () => {
    const draft = input(get()); draft.config.detailCount = 1; draft.skus = [sku('蓝色'), sku('红色'), sku('绿色')];
    const state = save(draft).planning, items = seedItems(state);
    const blue = items.find(item => item.imagePlanning!.skus[0]?.name === '蓝色')!;
    const red = items.find(item => item.imagePlanning!.skus[0]?.name === '红色')!;
    const green = items.find(item => item.imagePlanning!.skus[0]?.name === '绿色')!;
    repository.updateStoryboardItem(blue.id, { promptInstruction: '保留用户手工提示词' });
    repository.updateStoryboardItem(red.id, { status: 'GENERATED' }); output(red);
    output(green); // 即使状态未同步，已有候选也不能重写或失效。
    const histories = repository.listStoryboardVersions(projectId), outputs = repository.listOutputs(projectId);
    const next = input(state); for (const member of next.skus) member.name += '新名称';
    const saved = save(next); expect(saved.staleItemIds).toEqual([blue.id]);
    expect(repository.getStoryboardItem(blue.id)).toMatchObject({ planningStale: true, promptInstruction: '保留用户手工提示词', imagePlanning: blue.imagePlanning });
    for (const item of items.filter(item => item.id !== blue.id)) expect(repository.getStoryboardItem(item.id)).toEqual(item.id === red.id ? { ...item, status: 'GENERATED', updatedAt: repository.getStoryboardItem(red.id)!.updatedAt } : item);
    expect(repository.listStoryboardVersions(projectId)).toEqual(histories); expect(repository.listOutputs(projectId)).toEqual(outputs);
    const restore = input(saved.planning); restore.skus = state.skus;
    expect(save(restore).staleItemIds).toEqual([]); expect(repository.getStoryboardItem(blue.id)?.planningStale).toBe(false);
  });
  it('marks removed ordinals and membership changes while preserving independent targets and superseded rows', () => {
    const draft = input(get()); draft.config.mainCount = 2; draft.config.shareImages = true; draft.skus = [sku('A'), sku('B'), sku('C')];
    draft.imageGroups = [{ id: randomUUID(), name: '同外观', skuIds: draft.skus.slice(0, 2).map(member => member.id), productAssetIds: [] }];
    const state = save(draft).planning, items = seedItems(state);
    const group = items.find(item => item.imagePlanning?.imageGroupId)!;
    const secondMain = items.find(item => item.imagePlanning?.targetId === 'MAIN:2')!;
    const firstMain = items.find(item => item.imagePlanning?.targetId === 'MAIN:1')!;
    repository.updateStoryboardItem(firstMain.id, { planningSuperseded: true });
    const next = input(state); next.config.mainCount = 1; next.skus[1]!.included = false;
    const saved = save(next); expect(new Set(saved.staleItemIds)).toEqual(new Set([group.id, secondMain.id]));
    expect(repository.getStoryboardItem(firstMain.id)?.planningStale).toBe(false);
    repository.confirmStoryboard(projectId);
    expect(repository.getStoryboardItem(firstMain.id)?.status).toBe('DRAFT');
    expect(repository.getStoryboardItem(secondMain.id)?.status).toBe('DRAFT');
  });
  it('rolls back both stale changes and revision if the catalog write fails', () => {
    const draft = input(get()); draft.skus = [sku()]; const state = save(draft).planning; seedItems(state);
    const before = repository.listStoryboardItems(projectId);
    db.exec("CREATE TRIGGER fail_catalog BEFORE UPDATE ON desktop_project_image_planning BEGIN SELECT RAISE(ABORT,'injected catalog failure'); END");
    const next = input(state); next.skus[0]!.name = '应回滚';
    expect(() => save(next)).toThrow('injected'); expect(get()).toEqual(state); expect(repository.listStoryboardItems(projectId)).toEqual(before);
  });
});
