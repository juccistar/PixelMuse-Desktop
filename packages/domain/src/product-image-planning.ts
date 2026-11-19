import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { ImageAspectRatio } from './enums.js';

const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const uuid = () => Type.String({ format: 'uuid' });
const text = (maximum: number) => Type.String({ minLength: 1, maxLength: maximum, pattern: '\\S' });
const references = () => Type.Array(uuid(), { maxItems: 6, uniqueItems: true });

/** 图片用途独立于模板类型与画面角色。 */
export const ProductImagePurposeSchema = Type.Union([Type.Literal('MAIN'), Type.Literal('SKU'), Type.Literal('DETAIL')]);
export type ProductImagePurpose = Static<typeof ProductImagePurposeSchema>;
/** 自定义规格采用数组，属性名不能变成对象私有字段。 */
export const SkuAttributeSchema = object({ name: text(40), value: text(120) });
export type SkuAttribute = Static<typeof SkuAttributeSchema>;
export const ProjectSkuSchema = object({
  id: uuid(), name: text(120), code: Type.Union([text(80), Type.Null()]),
  attributes: Type.Array(SkuAttributeSchema, { maxItems: 8 }), productAssetIds: references(), included: Type.Boolean(),
});
export type ProjectSku = Static<typeof ProjectSkuSchema>;
/** 共图成员必须显式保存；不根据属性猜测同外观。 */
export const SkuImageGroupSchema = object({
  id: uuid(), name: text(120), skuIds: Type.Array(uuid(), { minItems: 1, maxItems: 60, uniqueItems: true }), productAssetIds: references(),
});
export type SkuImageGroup = Static<typeof SkuImageGroupSchema>;
/** 新规划来源与历史模板来源明确区分。 */
export const StoryboardPlanningSourceSchema = Type.Union([
  object({ version: Type.Literal(1), kind: Type.Literal('MODEL_DIRECT'), intent: Type.String({ maxLength: 4000 }), referenceIntent: Type.String({ maxLength: 4000 }) }),
  object({ version: Type.Literal(1), kind: Type.Literal('SUITE'), intent: Type.String({ maxLength: 4000 }), referenceIntent: Type.String({ maxLength: 4000 }), suiteId: text(120), suiteVersion: text(120), shotId: text(64), aspectRatio: Type.Optional(ImageAspectRatio) }),
]);
export type StoryboardPlanningSource = Static<typeof StoryboardPlanningSourceSchema>;
/** 保存于项目配置中的套图实例。 */
export const SuitePlanningBlueprintSchema = object({
  version: Type.Literal(1), suiteId: text(120), suiteName: text(120), suiteVersion: text(120), styleLock: text(4000),
  referenceAssets: Type.Optional(Type.Array(object({ projectId: uuid(), assetId: uuid() }), { maxItems: 6 })),
  shots: Type.Array(object({ shotId: text(64), purpose: ProductImagePurposeSchema, displayName: text(120), intent: text(4000), promptTemplate: text(20000), aspectRatio: Type.Optional(ImageAspectRatio) }), { maxItems: 40 }),
});
export type SuitePlanningBlueprint = Static<typeof SuitePlanningBlueprintSchema>;
/** 验证镜头身份和各用途容量。 */
export function validateSuitePlanningBlueprint(blueprint: SuitePlanningBlueprint): void {
  const ids = new Set<string>();
  for (const shot of blueprint.shots) {
    if (!shot.shotId.trim() || ids.has(shot.shotId)) throw new Error('Suite shot IDs must be non-empty and unique');
    ids.add(shot.shotId);
  }
  const counts = suitePlanningCounts(blueprint);
  if (blueprint.shots.length > 40 || counts.mainCount > 12 || counts.detailCount > 24 || counts.skuImagesPerGroup > 4) throw new Error('Suite shot capacity exceeded');
}
/** SKU 为零时兼容既有最小值，目标展开仍以镜头清单为准。 */
export function suitePlanningCounts(blueprint: SuitePlanningBlueprint): { mainCount: number; detailCount: number; skuImagesPerGroup: number } {
  return { mainCount: blueprint.shots.filter(shot => shot.purpose === 'MAIN').length, detailCount: blueprint.shots.filter(shot => shot.purpose === 'DETAIL').length, skuImagesPerGroup: Math.max(1, blueprint.shots.filter(shot => shot.purpose === 'SKU').length) };
}
export const ProductImagePlanningConfigSchema = object({
  mainCount: Type.Integer({ minimum: 0, maximum: 12 }), detailCount: Type.Integer({ minimum: 0, maximum: 24 }),
  skuImagesPerGroup: Type.Integer({ minimum: 1, maximum: 4 }), shareImages: Type.Boolean(),
  suiteBlueprint: Type.Optional(SuitePlanningBlueprintSchema),
  excludedTargetIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 300, uniqueItems: true })),
});
export type ProductImagePlanningConfig = Static<typeof ProductImagePlanningConfigSchema>;
export const ProjectImagePlanningSchema = object({
  projectId: uuid(), revision: Type.Integer({ minimum: 0 }), config: ProductImagePlanningConfigSchema,
  skus: Type.Array(ProjectSkuSchema, { maxItems: 60 }), imageGroups: Type.Array(SkuImageGroupSchema, { maxItems: 60 }),
  updatedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});
export type ProjectImagePlanning = Static<typeof ProjectImagePlanningSchema>;
export const ProductImageSkuSnapshotSchema = object({
  id: uuid(), name: text(120), code: Type.Union([text(80), Type.Null()]),
  attributes: Type.Array(SkuAttributeSchema, { maxItems: 8 }), productAssetIds: references(),
});
export type ProductImageSkuSnapshot = Static<typeof ProductImageSkuSnapshotSchema>;
/** 公开业务快照；不含凭据、路径或私有生成证据。 */
export const ProductImagePlanningContextSchema = object({
  purpose: ProductImagePurposeSchema, targetId: Type.String({ minLength: 1, maxLength: 200 }),
  imageGroupId: Type.Union([uuid(), Type.Null()]), ordinal: Type.Integer({ minimum: 1, maximum: 24 }),
  sourceRevision: Type.Integer({ minimum: 0 }), sourceFingerprint: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  skus: Type.Array(ProductImageSkuSnapshotSchema, { maxItems: 60 }), productAssetIds: references(),
  projectFactsFingerprint: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  assetsFingerprint: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
});
export type ProductImagePlanningContext = Static<typeof ProductImagePlanningContextSchema>;
/** 单次提交的总画面限制；目录保存允许暂时超过该值。 */
export const MAX_PRODUCT_IMAGE_TARGETS = 96;
export const DEFAULT_PRODUCT_IMAGE_PLANNING_CONFIG: Readonly<ProductImagePlanningConfig> = Object.freeze({ mainCount: 1, detailCount: 0, skuImagesPerGroup: 1, shareImages: false });
export interface ProductImageTarget {
  targetId: string;
  suiteShotId?: string;
  suiteVersion?: string;
  purpose: ProductImagePurpose;
  ordinal: number;
  imageGroupId: string | null;
  name: string;
  skus: ProductImageSkuSnapshot[];
  productAssetIds: string[];
}
const snapshot = (sku: ProjectSku): ProductImageSkuSnapshot => ({
  id: sku.id, name: sku.name, code: sku.code, attributes: sku.attributes.map(attribute => ({ ...attribute })), productAssetIds: [...sku.productAssetIds],
});
/** 纯解析显式目录；项目归属和真值角色在 Backend 保存及提交时校验。 */
export function resolveProductImageTargets(state: ProjectImagePlanning): ProductImageTarget[] {
  if (state.config.suiteBlueprint) validateSuitePlanningBlueprint(state.config.suiteBlueprint);
  const targets: ProductImageTarget[] = [];
  const add = (purpose: ProductImagePurpose, count: number, identity: string | null, name: string, skus: ProjectSku[] = [], productAssetIds: string[] = [], imageGroupId: string | null = null) => {
    const shots = state.config.suiteBlueprint?.shots.filter(shot => shot.purpose === purpose);
    const length = shots ? shots.length : count;
    for (let ordinal = 1; ordinal <= length; ordinal++) {
      const shot = shots?.[ordinal - 1];
      const key = shot?.shotId ?? String(ordinal);
      targets.push({
        targetId: purpose === 'SKU' ? `SKU:${identity}:${key}` : `${purpose}:${key}`,
        ...(shot ? { suiteShotId: shot.shotId, suiteVersion: state.config.suiteBlueprint!.suiteVersion } : {}),
        purpose, ordinal, imageGroupId, name: shot?.displayName ?? `${name} ${ordinal}`, skus: skus.map(snapshot), productAssetIds: [...productAssetIds],
      });
    }
  };
  add('MAIN', state.config.mainCount, null, '主图');
  const included = state.skus.filter(sku => sku.included);
  const byId = new Map(included.map(sku => [sku.id, sku]));
  const grouped = new Set<string>();
  if (state.config.shareImages) for (const group of state.imageGroups) {
    const members = group.skuIds.flatMap(id => { const sku = byId.get(id); return sku ? [sku] : []; });
    if (!members.length) continue;
    members.forEach(sku => grouped.add(sku.id));
    const refs = group.productAssetIds.length ? group.productAssetIds : [...new Set(members.flatMap(sku => sku.productAssetIds))];
    add('SKU', state.config.skuImagesPerGroup, group.id, group.name, members, refs, group.id);
  }
  for (const sku of included) if (!grouped.has(sku.id)) add('SKU', state.config.skuImagesPerGroup, sku.id, sku.name, [sku], sku.productAssetIds);
  add('DETAIL', state.config.detailCount, null, '详情图');
  // 取消画面保留原 ordinal，避免已有产物在减少需求后被重新归给另一目标。
  const excluded = new Set(state.config.excludedTargetIds ?? []);
  return targets.filter(target => !excluded.has(target.targetId));
}
