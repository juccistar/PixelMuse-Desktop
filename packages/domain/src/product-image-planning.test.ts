import { describe, expect, it } from 'vitest';
import { DEFAULT_PRODUCT_IMAGE_PLANNING_CONFIG, resolveProductImageTargets, suitePlanningCounts, validateSuitePlanningBlueprint, type SuitePlanningBlueprint, type ProjectImagePlanning, type ProjectSku } from './product-image-planning.js';

const sku = (id: string, ref: string): ProjectSku => ({ id, name: `规格 ${id}`, code: null, attributes: [{ name: '容量', value: '用户填写' }], productAssetIds: [ref], included: true });
const directory = (): ProjectImagePlanning => ({ projectId: 'project', revision: 1, updatedAt: null,
  config: { ...DEFAULT_PRODUCT_IMAGE_PLANNING_CONFIG, mainCount: 5, detailCount: 8, shareImages: true },
  skus: Array.from({ length: 6 }, (_, index) => sku(`sku-${index}`, `asset-${Math.floor(index / 2)}`)),
  imageGroups: Array.from({ length: 3 }, (_, index) => ({ id: `group-${index}`, name: `用户确认 ${index}`, skuIds: [`sku-${index * 2}`, `sku-${index * 2 + 1}`], productAssetIds: [] })),
});

describe('suite planning targets', () => {
  const blueprint = (): SuitePlanningBlueprint => ({ version: 1, suiteId: 'suite', suiteName: '套图', suiteVersion: 'v1', styleLock: '风格', shots: [
    { shotId: 'm1', purpose: 'MAIN', displayName: '主图', intent: '意图', promptTemplate: '提示' },
    { shotId: 's1', purpose: 'SKU', displayName: '规格', intent: '意图', promptTemplate: '提示' },
    { shotId: 'd1', purpose: 'DETAIL', displayName: '详情', intent: '意图', promptTemplate: '提示' },
  ] });
  it('derives counts and stable shot identities independent of count fields and order', () => {
    const state = directory(); state.config.suiteBlueprint = blueprint();
    expect(suitePlanningCounts(state.config.suiteBlueprint)).toEqual({ mainCount: 1, detailCount: 1, skuImagesPerGroup: 1 });
    const first = resolveProductImageTargets(state);
    expect(first.map(target => target.targetId)).toEqual(['MAIN:m1', 'SKU:group-0:s1', 'SKU:group-1:s1', 'SKU:group-2:s1', 'DETAIL:d1']);
    expect(first.every(target => target.suiteShotId && target.suiteVersion === 'v1')).toBe(true);
    state.config.suiteBlueprint.shots.unshift({ ...state.config.suiteBlueprint.shots[0]!, shotId: 'm2' });
    expect(resolveProductImageTargets(state).find(target => target.targetId === 'MAIN:m1')?.ordinal).toBe(2);
    state.config.excludedTargetIds = ['MAIN:m2'];
    expect(resolveProductImageTargets(state).some(target => target.targetId === 'MAIN:m2')).toBe(false);
  });
  it('skips SKU expansion for zero SKU shots and rejects duplicate identities and excessive capacity', () => {
    const state = directory(); state.config.suiteBlueprint = blueprint();
    state.config.suiteBlueprint.shots = state.config.suiteBlueprint.shots.filter(shot => shot.purpose !== 'SKU');
    expect(suitePlanningCounts(state.config.suiteBlueprint).skuImagesPerGroup).toBe(1);
    expect(resolveProductImageTargets(state).filter(target => target.purpose === 'SKU')).toHaveLength(0);
    state.config.suiteBlueprint.shots.push({ ...state.config.suiteBlueprint.shots[0]! });
    expect(() => validateSuitePlanningBlueprint(state.config.suiteBlueprint!)).toThrow('unique');
    state.config.suiteBlueprint.shots = Array.from({ length: 13 }, (_, i) => ({ ...blueprint().shots[0]!, shotId: String(i) }));
    expect(() => validateSuitePlanningBlueprint(state.config.suiteBlueprint!)).toThrow('capacity');
  });
});

describe('explicit product image target resolution', () => {
  it('counts 16 shared frames / 32 candidates and 19 independent frames / 38 candidates', () => {
    const state = directory(); const shared = resolveProductImageTargets(state);
    expect(shared).toHaveLength(16); expect(shared.length * 2).toBe(32);
    expect(shared.filter(target => target.purpose === 'SKU').map(target => target.targetId)).toEqual(['SKU:group-0:1', 'SKU:group-1:1', 'SKU:group-2:1']);
    state.config.shareImages = false; const independent = resolveProductImageTargets(state);
    expect(independent).toHaveLength(19); expect(independent.length * 2).toBe(38);
    expect(independent.filter(target => target.purpose === 'SKU').every(target => target.imageGroupId === null && target.skus.length === 1)).toBe(true);
    expect(state.skus.map(member => member.id)).toEqual(Array.from({ length: 6 }, (_, index) => `sku-${index}`));
  });
  it('never guesses groups from attributes, excludes nonparticipants and preserves stable target identity on reorder', () => {
    const state = directory(); state.imageGroups = []; state.skus[1]!.included = false;
    const ids = resolveProductImageTargets(state).filter(target => target.purpose === 'SKU').map(target => target.targetId);
    expect(ids).toHaveLength(5); state.skus.reverse();
    expect(resolveProductImageTargets(state).filter(target => target.purpose === 'SKU').map(target => target.targetId).sort()).toEqual(ids.sort());
  });
  it('uses explicit group references, otherwise only included member references deduplicated', () => {
    const state = directory(); state.skus[0]!.productAssetIds = ['asset-blue']; state.skus[1]!.productAssetIds = ['asset-red']; state.skus[1]!.included = false;
    const group = state.imageGroups[0]!; group.productAssetIds = ['explicit'];
    let target = resolveProductImageTargets(state).find(target => target.imageGroupId === group.id)!;
    expect(target.productAssetIds).toEqual(['explicit']); expect(target.skus.map(member => member.id)).toEqual(['sku-0']);
    group.productAssetIds = []; target = resolveProductImageTargets(state).find(target => target.imageGroupId === group.id)!;
    expect(target.productAssetIds).toEqual(['asset-blue']);
    state.skus[0]!.included = false;
    expect(resolveProductImageTargets(state).some(target => target.imageGroupId === group.id)).toBe(false);
  });
  it('excludes individual requirements without shifting surviving main, SKU or detail ordinals', () => {
    const state = directory(); state.config.skuImagesPerGroup = 3;
    const before = resolveProductImageTargets(state);
    state.config.excludedTargetIds = ['MAIN:2', 'SKU:group-0:2', 'DETAIL:3'];
    expect(resolveProductImageTargets(state)).toEqual(before.filter(target => !state.config.excludedTargetIds!.includes(target.targetId)));
    expect(resolveProductImageTargets(state).find(target => target.targetId === 'SKU:group-0:3')?.ordinal).toBe(3);
    state.config.mainCount = 6;
    expect(resolveProductImageTargets(state).filter(target => target.purpose === 'MAIN').map(target => target.ordinal)).toEqual([1, 3, 4, 5, 6]);
  });
  it('separates per-group image count from candidates and returns detached business snapshots', () => {
    const state = directory(); state.config.skuImagesPerGroup = 3;
    const targets = resolveProductImageTargets(state); expect(targets).toHaveLength(22);
    const target = targets.find(target => target.purpose === 'SKU')!;
    target.skus[0]!.attributes[0]!.value = '不得改变目录'; target.productAssetIds.push('new');
    expect(state.skus[0]!.attributes[0]!.value).toBe('用户填写'); expect(state.skus[0]!.productAssetIds).toEqual(['asset-0']);
  });
});
