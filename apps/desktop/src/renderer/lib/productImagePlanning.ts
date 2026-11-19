import { resolveProductImageTargets, type ProductImagePlanningContext, type ProjectImagePlanning } from '@ecomgen/contracts';
import type { StoryboardItem } from '../api/adapters/projectDetail';

export const IMAGE_PURPOSE_LABEL = { MAIN: '主图', SKU: 'SKU 图', DETAIL: '详情图', LEGACY: '已有 / 未分类' } as const;
export type ImagePurposeFilter = keyof typeof IMAGE_PURPOSE_LABEL | 'ALL';

/** 标签只取成图或分镜冻结快照，不能用今天的目录解释旧图。 */
export function imagePlanningLabel(context: ProductImagePlanningContext | undefined): string {
  if (!context) return IMAGE_PURPOSE_LABEL.LEGACY;
  return [IMAGE_PURPOSE_LABEL[context.purpose], context.skus.map(sku => [sku.name, sku.code].filter(Boolean).join(' · ')).join(' / ')].filter(Boolean).join(' · ');
}

/** 复用领域目标解析器，显式共图与独立 SKU 使用同一计数规则。 */
export function productImagePlanningTotals(planning: ProjectImagePlanning, candidates: number) {
  const targets = resolveProductImageTargets(planning);
  const skuTargets = targets.filter(target => target.purpose === 'SKU');
  return {
    targets,
    skuCount: planning.skus.filter(sku => sku.included).length,
    groupCount: new Set(skuTargets.map(target => target.imageGroupId ?? target.skus[0]?.id)).size,
    skuImageCount: skuTargets.length,
    frameCount: targets.length,
    candidateCount: targets.length * candidates,
  };
}

/** 只比较目标覆盖，不用目录 revision 推断所有旧画面过期；后台逐项标记真正受影响的画面。 */
export function productImagePlanningIncomplete(planning: ProjectImagePlanning, items: readonly StoryboardItem[]): boolean {
  if (planning.revision === 0 && !items.some(item => item.imagePlanning)) return false;
  const current = items.filter(item => item.imagePlanning && !item.planningSuperseded);
  const targets = resolveProductImageTargets(planning);
  const ids = new Set(targets.map(target => target.targetId));
  return current.length !== targets.length || current.some(item => !ids.has(item.imagePlanning!.targetId)) || targets.some(target => !current.some(item => item.imagePlanning!.targetId === target.targetId));
}
