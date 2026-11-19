import { requestFingerprint, type AssetRecord, type EcomRepository, type ProjectRecord, type StoryboardItemRecord } from '@ecomgen/core';
import { resolveProductImageTargets, type ProductImagePlanningContext } from '@ecomgen/contracts';
import { getProjectImagePlanningState, productImageTargetFingerprint } from '../product-image-planning.js';
import type { RequestLedgerPort } from '../runtime/ports.js';
import { BackendError } from '../validation.js';
import { outputImagePlanning } from './snapshot.js';

export type ProductImageTarget = ReturnType<typeof resolveProductImageTargets>[number];
export interface FrozenProductImagePlanning {
  state: ReturnType<typeof getProjectImagePlanningState>;
  targets: ProductImageTarget[];
  retiredTargetIds: string[];
  scope: 'ALL' | 'STALE';
  projectRevision: number;
  storyboardVersion: number;
  assetsFingerprint: string;
  campaignStyleLock?: string;
  targetSelections?: Array<{ targetId: string; assetType: string }>;
  targetFingerprints: Array<{ targetId: string; fingerprint: string }>;
}

/** 当前视图保留未分类旧业务，历史产品规划只通过输出/历史入口查看。 */
export function currentPlanningItems<T extends { planningSuperseded?: boolean }>(items: T[]): T[] {
  return items.filter(item => !item.planningSuperseded);
}

/** 已成图保持原规格语义；只有缺失或受影响的未成图目标进入局部更新。 */
export function productPlanningTargetsToRefresh(targets: ProductImageTarget[], items: StoryboardItemRecord[]): ProductImageTarget[] {
  return targets.filter(target => {
    const existing = items.find(item => !item.planningSuperseded && item.imagePlanning?.targetId === target.targetId);
    return !existing || (existing.status !== 'GENERATED' && (existing.planningStale || existing.imagePlanning?.sourceFingerprint !== productImageTargetFingerprint(target)));
  });
}

/** 项目级屏障不能因换目标/分镜/目录版本而绕过未核实的付费请求。 */
export function assertNoImageWork(repository: EcomRepository, ledger: Pick<RequestLedgerPort, 'hasUnknown'>, projectId: string, options: { exceptJobId?: string; generation?: boolean; exceptJobIds?: readonly string[]; unknownOnly?: boolean } = {}): void {
  const jobs = repository.listJobs(projectId).filter(job => job.id !== options.exceptJobId && !options.exceptJobIds?.includes(job.id) && (job.type === 'PLAN' || (options.generation !== false && (job.type === 'GENERATE' || job.type === 'EDIT_GENERATE' || job.type === 'EDIT_PLAN'))));
  if (jobs.some(job => job.status === 'UNKNOWN' || ledger.hasUnknown(job.id))) throw new BackendError('EXTERNAL_UNKNOWN', '项目存在中断的规划或生成任务，请先重试或结束该任务。');
  if (!options.unknownOnly && jobs.some(job => job.status === 'QUEUED' || job.status === 'RUNNING')) throw new BackendError('CONFLICT', '项目正在规划或生成，请等待当前任务结束。');
}

/** 成图事实来自持久产物和冻结归属，不随再生成中的分镜状态消失。 */
export function hasStoryboardOutput(repository: EcomRepository, item: StoryboardItemRecord): boolean {
  return repository.listOutputs(item.projectId).some(output => {
    if (output.projectId !== item.projectId || output.storyboardItemId !== item.id) return false;
    if (!item.imagePlanning) return true;
    const frozen = outputImagePlanning(output.generationSnapshot);
    return Boolean(frozen && requestFingerprint(frozen) === requestFingerprint(item.imagePlanning));
  });
}

/** 业务事实与视觉方向影响已发布规划；生成模型/分辨率可单独更新。 */
export function projectPlanningFactsFingerprint(project: ProjectRecord): string {
  const { name, category, productDescription, verifiedFacts, prohibitedClaims, brandGuidelines, platformTargets, targetMarket, copyLanguage, promptLanguage, defaultMode } = project;
  return requestFingerprint({ name, category, productDescription, verifiedFacts, prohibitedClaims, brandGuidelines, platformTargets, targetMarket, copyLanguage, promptLanguage, defaultMode });
}

/** 已有产物的来源永久保留，未成图规划必须跟随商品事实变化失效。 */
export function planningSourceChanged(repository: EcomRepository, item: StoryboardItemRecord): boolean {
  const source = item.imagePlanning;
  if (!source || hasStoryboardOutput(repository, item)) return false;
  const project = repository.getProject(item.projectId);
  return Boolean(!project || (source.projectFactsFingerprint && source.projectFactsFingerprint !== projectPlanningFactsFingerprint(project)) || (source.assetsFingerprint && source.assetsFingerprint !== planningAssetsFingerprint(repository.listAssets(item.projectId))));
}

/** 生成中的冻结输入独立于此检查；只在用户提交新生成/确认时检查当前目录。 */
export function assertPlanningItemFresh(repository: EcomRepository, item: StoryboardItemRecord, historicalRegeneration = false): void {
  if (!item.imagePlanning) return;
  const generated = hasStoryboardOutput(repository, item);
  if (historicalRegeneration && generated) return;
  if (item.planningSuperseded) throw new BackendError('CONFLICT', '所选分镜已被替代或待更新，请更新规划后重选。');
  if (generated) return;
  if (item.planningStale || planningSourceChanged(repository, item)) throw new BackendError('CONFLICT', '所选分镜已被替代或待更新，请更新规划后重选。');
  const state = getProjectImagePlanningState(repository, item.projectId);
  const target = resolveProductImageTargets(state).find(target => target.targetId === item.imagePlanning!.targetId);
  if (!target || productImageTargetFingerprint(target) !== item.imagePlanning.sourceFingerprint) throw new BackendError('CONFLICT', '规格目录已变化，请更新受影响规划。');
}

/** 不允许用一次局部成功或历史分镜凑够当前需求数量。 */
export function assertPlanningComplete(repository: EcomRepository, projectId: string): void {
  const state = getProjectImagePlanningState(repository, projectId);
  const items = currentPlanningItems(repository.listStoryboardItems(projectId));
  const hasProductPlan = repository.listJobs(projectId).some(job => job.type === 'PLAN' && Boolean(job.input.productImagePlanning));
  if (!hasProductPlan && state.revision === 0) return;
  const targets = resolveProductImageTargets(state);
  if (!targets.length || targets.some(target => items.filter(item => item.imagePlanning?.targetId === target.targetId).length !== 1)) throw new BackendError('CONFLICT', '图片规划尚未完成，请先生成完整规划。');
  for (const item of items) assertPlanningItemFresh(repository, item);
}

/** 安全业务快照由确定性目标创建，模型不拥有用途和规格身份。 */
export function imagePlanningContext(target: ProductImageTarget, revision: number): ProductImagePlanningContext {
  return {
    purpose: target.purpose, targetId: target.targetId, imageGroupId: target.imageGroupId,
    ordinal: target.ordinal, sourceRevision: revision, sourceFingerprint: productImageTargetFingerprint(target),
    skus: structuredClone(target.skus), productAssetIds: [...target.productAssetIds],
  };
}

/** 主图/详情最多12张；每个SKU组独立请求，绝不混入其他规格商品图。 */
export function productPlanningBatches(targets: ProductImageTarget[]): ProductImageTarget[][] {
  const groups = new Map<string, ProductImageTarget[]>();
  for (const target of targets) {
    const key = target.purpose === 'SKU' ? `SKU:${target.imageGroupId ?? target.skus[0]?.id ?? target.targetId}` : target.purpose;
    const group = groups.get(key) ?? [];
    group.push(target); groups.set(key, group);
  }
  return [...groups.values()].flatMap(group => Array.from({ length: Math.ceil(group.length / 12) }, (_, index) => group.slice(index * 12, (index + 1) * 12)));
}

/** 附件事实会改变规划来源，路径与更新时间不参与业务身份。 */
export function planningAssetsFingerprint(assets: AssetRecord[]): string {
  return requestFingerprint(assets.map(asset => ({ id: asset.id, hash: asset.hash, role: asset.role, mimeType: asset.mimeType, name: asset.originalName })).sort((a, b) => a.id.localeCompare(b.id)));
}

/** 发布检查使用真实仓库；执行模型上下文则始终读取冻结仓库。 */
export function assertProductPlanningPublicationFresh(repository: EcomRepository, projectId: string, frozen: FrozenProductImagePlanning): void {
  const state = getProjectImagePlanningState(repository, projectId);
  const targets = resolveProductImageTargets(state);
  const current = targets.map(target => ({ targetId: target.targetId, fingerprint: productImageTargetFingerprint(target) }));
  if (state.revision !== frozen.state.revision || requestFingerprint(current) !== requestFingerprint(frozen.targetFingerprints) || repository.getProject(projectId)?.planningRevision !== frozen.projectRevision || (repository.getStoryboard(projectId)?.version ?? 0) !== frozen.storyboardVersion || planningAssetsFingerprint(repository.listAssets(projectId)) !== frozen.assetsFingerprint) {
    throw new BackendError('CONFLICT', '规划来源已变化，迟到结果未发布；请刷新后重新规划。');
  }
}
