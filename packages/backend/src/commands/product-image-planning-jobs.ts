import { randomUUID } from 'node:crypto';
import { resolveTemplatesWithUser } from '@ecomgen/ecom-skill';
import { compiledUserTemplates } from './projects.js';
import { requestFingerprint } from '@ecomgen/core';
import { resolveProductImageTargets, type Input } from '@ecomgen/contracts';
import { getProjectImagePlanningState, productImageTargetFingerprint } from '../product-image-planning.js';
import { assertNoImageWork, currentPlanningItems, productPlanningTargetsToRefresh, planningAssetsFingerprint, planningSourceChanged } from '../execution/product-image-planning.js';
import { copySuiteReferences } from '../suite-planning.js';
import { ensureProject, verifyModel } from './helpers.js';
import { ApiError, type CommandFlow, type CommandScope } from './support.js';

/** 保存目录与付费规划分离；新自主/套图路径按版本冻结，候选数仅由本地执行配置控制。 */
export function registerProductImagePlanningJobCommands(ctx: CommandScope) {
  return {
    createProductImagePlanningJob: function* (input: Input<'createProductImagePlanningJob'>): CommandFlow<unknown> {
      const { repository } = ctx;
      ensureProject(repository, input.projectId);
      const project = repository.getProject(input.projectId)!;
      const userInstruction = input.userInstruction?.trim() || undefined;
      const styleInstruction = input.styleInstruction?.trim() || undefined;
      let state = getProjectImagePlanningState(repository, input.projectId);
      if (state.revision !== input.expectedRevision) throw new ApiError('CONFLICT', '规格目录已变化，请刷新后重新规划。');
      const suiteBlueprint = state.config.suiteBlueprint;
      const planningMode = input.planningMode ?? 'AI';
      const requestedTypes = (input.requestedTypes ?? []).map(value => {
        const template = resolveTemplatesWithUser([value], compiledUserTemplates(repository))[0];
        if (!template) throw new ApiError('VALIDATION_ERROR', '所选模板不存在。');
        return template.id;
      });
      const requestedSuiteShots = input.requestedSuiteShots ?? [];
      if (requestedSuiteShots.length) throw new ApiError('VALIDATION_ERROR', '请先选择套图并将镜头绑定到图片数量，再提交规划。');
      if (suiteBlueprint && requestedTypes.length) throw new ApiError('VALIDATION_ERROR', '套图镜头与单图模板不能混用。');
      if (planningMode === 'MANUAL' && !requestedTypes.length && !suiteBlueprint) throw new ApiError('VALIDATION_ERROR', '请先选择套图镜头。');
      if (planningMode === 'AI' && requestedTypes.length) throw new ApiError('VALIDATION_ERROR', '自主规划不接受人工分类模板。');
      // 显式单模板入口保留原来源校验；工作台新主流程只使用视觉规划版本2。
      const legacyTemplates = planningMode === 'MANUAL' && requestedTypes.length > 0;
      const selection = { planningMode: legacyTemplates ? 'MANUAL' as const : 'AI' as const, requestedTypes, requestedSuiteShots: [], ...(legacyTemplates ? {} : { planningVersion: 2 as const }), ...(suiteBlueprint ? { suiteBlueprint } : {}), ...(styleInstruction ? { styleInstruction } : {}), ...(input.referenceSourceProjectId ? { referenceSourceProjectId: input.referenceSourceProjectId } : {}) };
      const selectionFingerprint = requestFingerprint(selection);
      // 回执丢失后同键查询原任务，不能因规划发布改变版本而新增付费请求。
      if (input.regenerationKey) {
        const prior = repository.listJobs(project.id).find(job => {
          const frozen = job.input.productImagePlanning as { state?: { revision?: number }; scope?: string } | undefined;
          return job.type === 'PLAN' && job.input.regenerationKey === input.regenerationKey && frozen?.state?.revision === input.expectedRevision && frozen.scope === (input.scope ?? 'ALL') && (job.input.userInstruction || undefined) === userInstruction && job.input.selectionFingerprint === selectionFingerprint;
        });
        if (prior) {
          if (prior.status === 'UNKNOWN' || ctx.requestLedger.hasUnknown(prior.id)) throw new ApiError('EXTERNAL_UNKNOWN', '此规划任务已中断，请先重试或结束该任务。');
          return { ...prior, reused: true };
        }
      }
      assertNoImageWork(repository, ctx.requestLedger, project.id);
      if (suiteBlueprint || input.referenceSourceProjectId) {
        yield* copySuiteReferences(ctx, project.id, suiteBlueprint ?? { version: 1, suiteId: 'references', suiteName: '共享参考', suiteVersion: '1', styleLock: '用户选择的参考图', shots: [] }, input.referenceSourceProjectId);
        state = getProjectImagePlanningState(repository, input.projectId);
        if (state.revision !== input.expectedRevision || repository.getProject(project.id)?.planningRevision !== project.planningRevision) throw new ApiError('CONFLICT', '复制参考图期间项目配置已变化，请刷新后重新规划。');
        assertNoImageWork(repository, ctx.requestLedger, project.id);
      }
      const allTargets = resolveProductImageTargets(state);
      const scope = input.scope ?? 'ALL';
      if (!allTargets.length && scope !== 'STALE') throw new ApiError('VALIDATION_ERROR', '请先配置至少一个规划画面。');
      if (allTargets.length > 96) throw new ApiError('VALIDATION_ERROR', '一次最多规划96个画面，请减少数量或参与规格。');
      const items = currentPlanningItems(repository.listStoryboardItems(project.id)).map(item => ({ ...item, planningStale: Boolean(item.planningStale || planningSourceChanged(repository, item)) }));
      const targets = scope === 'STALE' ? productPlanningTargetsToRefresh(allTargets, items) : allTargets;
      const targetIds = new Set(allTargets.map(target => target.targetId));
      const retiredTargetIds = items.flatMap(item => item.imagePlanning && !targetIds.has(item.imagePlanning.targetId) ? [item.imagePlanning.targetId] : []);
      if (!targets.length && !retiredTargetIds.length) throw new ApiError('CONFLICT', '当前没有需要更新的规划画面。');
      if (!legacyTemplates && targets.length) {
        verifyModel(repository, project.reasoningProviderId, project.reasoningModelId, 'reasoning');
        const reasoning = repository.getProvider(project.reasoningProviderId!)?.models.find(model => model.id === project.reasoningModelId);
        if (!reasoning?.supportsVision) throw new ApiError('CAPABILITY_UNSUPPORTED', '参考图驱动规划需要支持视觉的推理模型，请先更换模型。');
        verifyModel(repository, project.imageProviderId, project.imageModelId, 'image');
      }
      const assets = repository.listAssets(project.id);
      for (const target of targets) {
        if (target.productAssetIds.some(id => !assets.some(asset => asset.id === id && asset.projectId === project.id && asset.role === 'PRODUCT_TRUTH' && asset.mimeType.startsWith('image/')))) throw new ApiError('VALIDATION_ERROR', '规格产品图必须是当前项目的商品真值图片。');
        if ((!legacyTemplates || project.defaultMode === 'PIXEL_PROTECTED') && !(target.purpose === 'SKU' ? target.productAssetIds.length : assets.some(asset => asset.role === 'PRODUCT_TRUTH' && asset.mimeType.startsWith('image/')))) throw new ApiError('VALIDATION_ERROR', '视觉规划需要真实商品图，每个参与规格也需要明确选择商品图。');
      }
      const frozenInput = {
        userInstruction, ...selection, selectionFingerprint,
        productImagePlanning: {
          targetSelections: legacyTemplates ? allTargets.map((target, index) => ({ targetId: target.targetId, assetType: requestedTypes[index % requestedTypes.length]! })) : undefined,
          state, targets, retiredTargetIds, scope, projectRevision: project.planningRevision,
          storyboardVersion: repository.getStoryboard(project.id)?.version ?? 0,
          assetsFingerprint: planningAssetsFingerprint(assets),
          campaignStyleLock: scope === 'STALE' && !suiteBlueprint ? repository.getStoryboard(project.id)?.campaignStyleLock : suiteBlueprint?.styleLock,
          targetFingerprints: allTargets.map(target => ({ targetId: target.targetId, fingerprint: productImageTargetFingerprint(target) })),
        },
        ...(input.regenerationKey ? { regenerationKey: input.regenerationKey } : {}),
      };
      const fingerprint = requestFingerprint({ type: 'PLAN', projectId: project.id, input: frozenInput });
      const existing = repository.findJobByFingerprint(project.id, fingerprint);
      if (existing && existing.status !== 'UNKNOWN' && !ctx.requestLedger.hasUnknown(existing.id)) return { ...existing, reused: true };
      if (targets.length) verifyModel(repository, project.reasoningProviderId, project.reasoningModelId, 'reasoning');
      const job = repository.createJob({ id: randomUUID(), projectId: project.id, storyboardItemId: null, type: 'PLAN', input: frozenInput, requestFingerprint: fingerprint, providerId: project.reasoningProviderId, modelId: project.reasoningModelId, estimatedCost: { status: 'UNKNOWN', unit: 'provider-defined' } });
      yield ctx.queue(job);
      return { ...job, reused: false };
    },
  };
}
export const productImagePlanningJobCommands = registerProductImagePlanningJobCommands;
