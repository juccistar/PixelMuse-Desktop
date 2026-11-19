import { DEFAULT_PRODUCT_IMAGE_PLANNING_CONFIG, type ProductImageTarget, type ProjectImagePlanning } from '@ecomgen/domain';
import { requestFingerprint, type EcomRepository } from '@ecomgen/core';
import { BackendError } from './validation.js';

/** 未配置项目使用计算默认值；查询不会写入样例 SKU 或改变 revision。 */
export function getProjectImagePlanningState(repository: EcomRepository, projectId: string): ProjectImagePlanning {
  if (!repository.getProject(projectId)) throw new BackendError('NOT_FOUND', '项目不存在。');
  return repository.getProjectImagePlanning(projectId) ?? {
    projectId, revision: 0, config: { ...DEFAULT_PRODUCT_IMAGE_PLANNING_CONFIG }, skus: [], imageGroups: [], updatedAt: null,
  };
}

/** 指纹只包含该目标实际消费的业务信息，不受其他 SKU 或目录 revision 影响。 */
export function productImageTargetFingerprint(target: ProductImageTarget): string {
  return requestFingerprint({
    targetId: target.targetId, purpose: target.purpose, ordinal: target.ordinal,
    imageGroupId: target.imageGroupId, name: target.name,
    // 成员引用保留在不可变快照中；指纹只消费目标最终采用的引用，避免共图覆盖引起误失效。
    skus: [...target.skus].sort((left, right) => left.id.localeCompare(right.id)).map(sku => ({
      id: sku.id, name: sku.name, code: sku.code,
      attributes: [...sku.attributes].sort((left, right) => left.name.localeCompare(right.name)),
    })),
    productAssetIds: [...target.productAssetIds].sort(),
    ...(target.suiteShotId ? { suiteShotId: target.suiteShotId, suiteVersion: target.suiteVersion } : {}),
  });
}
