import { operations, resolveProductImageTargets, type ProjectImagePlanning, type SaveProjectImagePlanningInput } from '@ecomgen/contracts';
import { requestFingerprint, type EcomRepository } from '@ecomgen/core';
import type { CommandContext, CommandHandlers } from '../runtime/ports.js';
import { assertPublicOutput, BackendError, check } from '../validation.js';
import { getProjectImagePlanningState, productImageTargetFingerprint } from '../product-image-planning.js';
import { assertSuiteCounts, assertSuiteReferences, normalizeSuiteBlueprint } from '../suite-planning.js';

const invalid = (message: string): never => { throw new BackendError('VALIDATION_ERROR', message); };
const key = (value: string) => value.trim().normalize('NFKC').toLocaleLowerCase('en-US');

/** 校验完整目录，包括暂未参与的规格与未启用的显式共图组。 */
function validateDirectory(repository: EcomRepository, input: SaveProjectImagePlanningInput): void {
  const ids = new Set<string>(), codes = new Set<string>();
  const skus = new Map(input.skus.map(sku => [sku.id, sku]));
  const validReferences = new Set(repository.listAssets(input.projectId)
    .filter(asset => asset.projectId === input.projectId && asset.role === 'PRODUCT_TRUTH' && asset.mimeType.startsWith('image/')).map(asset => asset.id));
  const references = (assetIds: string[]) => {
    if (assetIds.some(id => !validReferences.has(id))) invalid('产品参考必须选择当前项目的商品真值图片。');
  };
  for (const sku of input.skus) {
    if (ids.has(key(sku.id))) invalid('SKU ID 不能重复。');
    ids.add(key(sku.id));
    if (sku.code !== null) {
      if (codes.has(key(sku.code))) invalid('SKU 编码不能重复。');
      codes.add(key(sku.code));
    }
    const names = new Set<string>();
    for (const attribute of sku.attributes) {
      if (names.has(key(attribute.name))) invalid('同一 SKU 的规格属性名不能重复。');
      names.add(key(attribute.name));
    }
    references(sku.productAssetIds);
  }
  const members = new Set<string>();
  for (const group of input.imageGroups) {
    // 组与独立 SKU 共用 targetId 命名空间，不能让两个目标碰撞。
    if (ids.has(key(group.id))) invalid('图片组 ID 不能重复或与 SKU ID 相同。');
    ids.add(key(group.id));
    for (const id of group.skuIds) {
      if (!skus.has(id)) invalid('图片组包含不存在的 SKU。');
      if (members.has(key(id))) invalid('一个 SKU 最多只能属于一个共享图片组。');
      members.add(key(id));
    }
    references(group.productAssetIds);
    const effectiveRefs = group.productAssetIds.length ? group.productAssetIds : [...new Set(group.skuIds.flatMap(id => {
      const sku = skus.get(id)!; return sku.included ? sku.productAssetIds : [];
    }))];
    if (effectiveRefs.length > 6) invalid('同一图片组最多使用 6 张产品参考图。');
  }
}

const content = (state: Pick<ProjectImagePlanning, 'config' | 'skus' | 'imageGroups'>) => ({ config: state.config, skus: state.skus, imageGroups: state.imageGroups });

/** 目录保存只进行本地原子写入；付费规划由独立 PLAN 命令启动。 */
export function registerProductImagePlanningCommands(context: CommandContext): CommandHandlers {
  return {
    getProjectImagePlanning: (_ctx, input) => {
      check(operations.getProjectImagePlanning.input, input);
      return getProjectImagePlanningState(context.repository, input.projectId);
    },
    saveProjectImagePlanning: (_ctx, input) => {
      check(operations.saveProjectImagePlanning.input, input);
      const result = context.transaction(() => {
        const repository = context.repository;
        const current = getProjectImagePlanningState(repository, input.projectId);
        if (current.revision !== input.expectedRevision) throw new BackendError('CONFLICT', '规格目录已被修改，请刷新后再保存。');
        validateDirectory(repository, input);
        const config = structuredClone(input.config);
        if (config.suiteBlueprint) {
          config.suiteBlueprint = normalizeSuiteBlueprint(config.suiteBlueprint);
          assertSuiteCounts(config);
          assertSuiteReferences(repository, config.suiteBlueprint.referenceAssets ?? []);
        }
        const items = repository.listStoryboardItems(input.projectId);
        const outputItems = new Set(repository.listOutputs(input.projectId).map(output => output.storyboardItemId));
        const next: ProjectImagePlanning = {
          projectId: current.projectId, revision: current.revision + 1,
          ...structuredClone(content(input)), config, updatedAt: context.clock(),
        };
        const targets = new Map(resolveProductImageTargets(next).map(target => [target.targetId, productImageTargetFingerprint(target)]));
        const staleItemIds = items.filter(item => item.imagePlanning && !item.planningSuperseded && item.status !== 'GENERATED' && !outputItems.has(item.id)
          && targets.get(item.imagePlanning.targetId) !== item.imagePlanning.sourceFingerprint).map(item => item.id);
        const changed = requestFingerprint(content(current)) !== requestFingerprint(content(next));
        if (changed) {
          const stale = new Set(staleItemIds);
          for (const item of items) {
            if (!item.imagePlanning || item.planningSuperseded || item.status === 'GENERATED' || outputItems.has(item.id)) continue;
            // 仅更新独立失效标记，保留手工提示词、模型、版本和不可变来源快照。
            if (Boolean(item.planningStale) !== stale.has(item.id)) repository.updateStoryboardItem(item.id, { planningStale: stale.has(item.id) });
          }
        }
        const response = { planning: changed ? repository.saveProjectImagePlanning(next) : current, staleItemIds };
        // Backend 的外层检查晚于提交；在此复用同一公开边界，让失败连同目录和失效标记一起回滚。
        check(operations.saveProjectImagePlanning.output, response, true);
        assertPublicOutput(response);
        return { ...response, changed };
      });
      if (result.changed) {
        context.events.publish({ topic: 'projects', projectId: input.projectId });
        context.events.publish({ topic: 'storyboards', projectId: input.projectId });
      }
      return { planning: result.planning, staleItemIds: result.staleItemIds };
    },
  };
}
