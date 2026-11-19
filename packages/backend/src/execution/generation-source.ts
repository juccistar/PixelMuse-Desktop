import { Value } from '@sinclair/typebox/value';
import { StoryboardPlanningSourceSchema, MAX_GENERATION_REFERENCE_IMAGES, type ImageAspectRatio } from '@ecomgen/contracts';
import { getTemplate, type EcomTemplate } from '@ecomgen/ecom-skill';
import type { StoryboardItemRecord } from '@ecomgen/core';
import type { SuiteDefinition } from '@ecomgen/ecom-suite';
import { BackendError } from '../validation.js';
import type { VisualAssetRecord } from './visual-assets.js';

/** 新来源只使用冻结的显式语义，历史模板仍需精确解析，未知ID不能降级。 */
export function generationSource(item: StoryboardItemRecord, userTemplates: () => EcomTemplate[], resolveShot: (id: string) => { suite: SuiteDefinition; shot: SuiteDefinition['shots'][number] } | undefined): { supportsImageReference: boolean; defaultSize: string; aspectRatio?: ImageAspectRatio } {
  if (item.planningSource) {
    if (!Value.Check(StoryboardPlanningSourceSchema, item.planningSource)) throw new BackendError('VALIDATION_ERROR', '分镜规划来源无效，请重新规划。');
    const source = item.planningSource;
    const expectedType = source.kind === 'MODEL_DIRECT' ? 'model-direct:v1' : `${source.suiteId}::${source.shotId}`;
    if (item.assetType !== expectedType || item.templateVariant !== null) throw new BackendError('VALIDATION_ERROR', '分镜来源与画面身份不一致，请重新规划。');
    return { supportsImageReference: true, defaultSize: '1024x1024', ...(source.kind === 'SUITE' && source.aspectRatio ? { aspectRatio: source.aspectRatio } : {}) };
  }
  const template = getTemplate(item.assetType) ?? userTemplates().find(template => template.id === item.assetType);
  const suite = template ? undefined : resolveShot(item.assetType);
  if (!template && !suite) throw new BackendError('VALIDATION_ERROR', `分镜引用的模板或套图不存在（${item.assetType}），请重新规划。`);
  return { supportsImageReference: template ? template.supports_image_reference : suite!.shot.supportsImageReference !== false, defaultSize: template?.defaultSize ?? '1024x1536', ...(suite?.shot.aspectRatio ? { aspectRatio: suite.shot.aspectRatio as ImageAspectRatio } : {}) };
}

/** 新视觉规划不能静默丢附件或留下未附图的句柄。 */
export function assertVisualGenerationReferences<T extends VisualAssetRecord>(item: StoryboardItemRecord, assets: T[], selected: T[], handles: Map<string, string>): void {
  if (!item.planningSource) return;
  if (item.referencedAssets.some(id => !assets.some(asset => asset.id === id && asset.mimeType.startsWith('image/')))) throw new BackendError('VALIDATION_ERROR', '分镜引用的图片已缺失，请重新选择素材。');
  if (item.referencedAssets.filter(id => assets.some(asset => asset.id === id && asset.role !== 'PRODUCT_TRUTH')).length > MAX_GENERATION_REFERENCE_IMAGES) throw new BackendError('VALIDATION_ERROR', '单画面最多使用4张参考图，请明确调整引用。');
  if (!selected.some(asset => asset.role === 'PRODUCT_TRUTH')) throw new BackendError('VALIDATION_ERROR', '参考图驱动生成需要当前商品的真实商品图。');
  const attached = new Set(selected.map(asset => handles.get(asset.id)));
  if ((item.promptInstruction.match(/\b[PR]\d+\b/g) ?? []).some(handle => !attached.has(handle))) throw new BackendError('VALIDATION_ERROR', '生图提示词引用了没有实际附加的图片，请调整提示词或参考图。');
}
