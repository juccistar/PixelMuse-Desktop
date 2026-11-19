import { Value } from '@sinclair/typebox/value';
import { IMAGE_ASPECT_RATIOS, SuitePlanningBlueprintSchema, suitePlanningCounts, validateSuitePlanningBlueprint, type ImageAspectRatio, type SuitePlanningBlueprint } from '@ecomgen/contracts';
import { requestFingerprint, type EcomRepository, type SuiteCatalog } from '@ecomgen/core';
import { BackendError } from './validation.js';
import type { CommandFlow, CommandScope } from './commands/support.js';
import { assertProjectAssetCapacity } from './commands/helpers.js';

/** 项目套图是显式版本化的镜头实例，不按商品品类自动选型。 */
export function normalizeSuiteBlueprint(value: SuitePlanningBlueprint): SuitePlanningBlueprint {
  if (!Value.Check(SuitePlanningBlueprintSchema, value)) throw new BackendError('VALIDATION_ERROR', '套图镜头配置无效。');
  try { validateSuitePlanningBlueprint(value); }
  catch { throw new BackendError('VALIDATION_ERROR', '套图镜头身份不能重复，且必须遵守各用途的数量上限。'); }
  if (!value.shots.length) throw new BackendError('VALIDATION_ERROR', '套图至少需要一个镜头。');
  const { suiteVersion: _version, ...content } = structuredClone(value);
  return { ...content, suiteVersion: requestFingerprint(content) };
}

/** 老套图用途仅作为可编辑初值；实际数量始终取确认后的镜头清单。 */
export function suiteBlueprintFromCatalog(catalog: SuiteCatalog, suiteId: string): SuitePlanningBlueprint {
  const suite = catalog.getSuite(suiteId);
  if (!suite) throw new BackendError('NOT_FOUND', '所选套图不存在。');
  return normalizeSuiteBlueprint({
    version: 1, suiteId: suite.id, suiteName: suite.name, suiteVersion: 'pending', styleLock: suite.styleLock.lockText,
    ...(suite.referenceAssets?.length ? { referenceAssets: structuredClone(suite.referenceAssets) } : {}),
    shots: suite.shots.map(shot => ({
      shotId: shot.shotId, purpose: shot.purpose ?? (shot.shotRole === 'HERO' ? 'MAIN' : shot.shotRole === 'VARIANT' ? 'SKU' : 'DETAIL'),
      displayName: shot.displayName, intent: shot.intent?.trim() || shot.displayName, promptTemplate: shot.promptTemplate,
      ...(shot.aspectRatio && IMAGE_ASPECT_RATIOS.includes(shot.aspectRatio as ImageAspectRatio) ? { aspectRatio: shot.aspectRatio as ImageAspectRatio } : {}),
    })),
  });
}

/** 候选数与镜头数分别保存；套图镜头数不接受另一份互相冲突的计数。 */
export function assertSuiteCounts(config: { mainCount: number; detailCount: number; skuImagesPerGroup: number; suiteBlueprint?: SuitePlanningBlueprint }): void {
  if (!config.suiteBlueprint) return;
  const counts = suitePlanningCounts(config.suiteBlueprint);
  if (counts.mainCount !== config.mainCount || counts.detailCount !== config.detailCount || counts.skuImagesPerGroup !== config.skuImagesPerGroup) {
    throw new BackendError('VALIDATION_ERROR', '套图数量必须与镜头清单一致，请在镜头编辑中增删画面。');
  }
}

/** 共享来源只允许明确的参考图片；跨商品不复制商品真值。 */
export function assertSuiteReferences(repository: EcomRepository, references: NonNullable<SuitePlanningBlueprint['referenceAssets']>): void {
  for (const ref of references) {
    const asset = repository.getAsset(ref.assetId);
    if (!asset || asset.projectId !== ref.projectId || asset.role === 'PRODUCT_TRUTH' || !asset.mimeType.startsWith('image/')) {
      throw new BackendError('VALIDATION_ERROR', '套图参考图已缺失，或引用了其他商品的商品真值；请重新选择参考图。');
    }
  }
}

/** 文件复制在事务外；每张结果登记为目标项目受管参考，重复使用按内容去重。 */
export function* copySuiteReferences(ctx: CommandScope, projectId: string, blueprint: SuitePlanningBlueprint, referenceSourceProjectId?: string): CommandFlow<void> {
  const refs = [...(blueprint.referenceAssets ?? [])];
  if (referenceSourceProjectId) {
    if (!ctx.repository.getProject(referenceSourceProjectId)) throw new BackendError('NOT_FOUND', '共享参考图的项目不存在。');
    refs.push(...ctx.repository.listAssets(referenceSourceProjectId).filter(asset => asset.role !== 'PRODUCT_TRUTH' && asset.mimeType.startsWith('image/')).map(asset => ({ projectId: referenceSourceProjectId, assetId: asset.id })));
  }
  assertSuiteReferences(ctx.repository, refs);
  const unique = [...new Map(refs.map(ref => [ref.assetId, ref])).values()];
  const existing = ctx.repository.listAssets(projectId);
  const newHashes = new Set(unique.flatMap(ref => {
    const source = ctx.repository.getAsset(ref.assetId)!;
    const same = existing.find(asset => asset.hash === source.hash);
    if (same?.role === 'PRODUCT_TRUTH') throw new BackendError('VALIDATION_ERROR', '共享参考图与当前商品真值图片相同，请重新选择参考。');
    return same ? [] : [source.hash];
  }));
  if (existing.filter(asset => asset.role !== 'PRODUCT_TRUTH' && asset.mimeType.startsWith('image/')).length + newHashes.size > 6) {
    throw new BackendError('VALIDATION_ERROR', '共享后参考图超过6张，请先调整当前项目参考图。');
  }
  for (const ref of unique) {
    const source = ctx.repository.getAsset(ref.assetId)!;
    if (ctx.repository.listAssets(projectId).some(asset => asset.hash === source.hash)) continue;
    const bytes: Buffer = yield ctx.storage.read(source.storagePath);
    const stored: { path: string; hash: string } = yield ctx.storage.putAsset(projectId, source.originalName, bytes);
    if (stored.hash !== source.hash) throw new BackendError('RESOURCE_CHANGED', '套图参考图内容已变化，请重新选择。');
    if (!ctx.repository.getProject(projectId)) throw new BackendError('NOT_FOUND', '目标项目已不存在。');
    if (ctx.repository.listAssets(projectId).some(asset => asset.hash === source.hash)) continue;
    assertProjectAssetCapacity(ctx.repository, projectId, source.role);
    ctx.repository.createAsset({ projectId, role: source.role, storagePath: stored.path, hash: stored.hash, originalName: source.originalName, mimeType: source.mimeType, width: source.width, height: source.height });
  }
}
