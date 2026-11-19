import type { JobRecord } from '@ecomgen/core';
import { userAssetKindForRole } from '@ecomgen/domain';
import type { ImageAspectRatio, ImageResolution, PlanningMode } from '@ecomgen/domain';
import { planStoryboard, type PlannerInput, type PlannedStoryboardItem } from '@ecomgen/agent';
import { buildReasoningModel } from '@ecomgen/providers';
import { assignImageHandles, imageHandle, selectVisionAssets, visionAttachmentMetadata } from './visual-assets.js';
import { projectIdFor, type WorkerContext } from './context.js';
import { assertProductPlanningPublicationFresh, currentPlanningItems, imagePlanningContext, projectPlanningFactsFingerprint, productPlanningBatches, type FrozenProductImagePlanning } from './product-image-planning.js';

type PlanInput = { planningVersion?: 2; planningMode?: PlanningMode; requestedTypes?: string[]; requestedSuiteShots?: string[]; userInstruction?: string; styleInstruction?: string; suiteBlueprint?: PlannerInput['suiteBlueprint']; candidatesPerType?: number; targetImageCount?: number; imageResolution?: ImageResolution; imageAspectRatio?: ImageAspectRatio; productImagePlanning?: FrozenProductImagePlanning };

export async function executePlan(ctx: WorkerContext, job: JobRecord): Promise<void> {
  const { repository, suiteCatalog, secrets, events, updateJob, throwIfCancelled, projectFor, providerFor, visionImageContents, compiledUserTemplates, configuredWebResearch } = ctx;
  throwIfCancelled(job);
  if (repository.listPlanningConfigSnapshots(projectIdFor(job)).some(snapshot => snapshot.sourceJobId === job.id)) return;
  // 套图与模板使用提交时冻结的文档，排队期间的目录变更不改变本次任务。
  const project = projectFor(job);
  const input = job.input as PlanInput;
  await updateJob(job, { progress: 10 });
  const assets = repository.listAssets(project.id);
  const imageHandles = assignImageHandles(assets);
  const webResearch = project.webResearchEnabled ? configuredWebResearch() : undefined;
  repository.createWebResearchAudit(job.id, webResearch ? 'AVAILABLE' : project.webResearchEnabled ? 'UNAVAILABLE' : 'DISABLED');
  const base: Omit<PlannerInput, 'assets' | 'model' | 'apiKey'> = {
    projectName: project.name, productCategory: project.category, productDescription: project.productDescription,
    verifiedFacts: project.verifiedFacts, prohibitedClaims: project.prohibitedClaims, brandGuidelines: project.brandGuidelines,
    platformTargets: project.platformTargets, targetMarket: project.targetMarket, copyLanguage: project.copyLanguage,
    promptLanguage: project.promptLanguage, defaultMode: project.defaultMode,
    planningMode: input.planningMode ?? 'AI', requestedTypes: input.requestedTypes, requestedSuiteShots: input.requestedSuiteShots,
    ...(input.planningVersion === 2 ? { planningVersion: 2, suiteBlueprint: input.suiteBlueprint, styleInstruction: input.styleInstruction } : { suites: suiteCatalog.listSuites(), userTemplates: compiledUserTemplates() }),
    userInstruction: input.userInstruction,
    imageAspectRatio: input.imageAspectRatio ?? project.imageAspectRatio, imageResolution: input.imageResolution ?? project.imageResolution,
    candidatesPerType: input.candidatesPerType ?? project.candidatesPerType, targetImageCount: input.targetImageCount,
  };
  const makeInput = async (selectedAssets: typeof assets, prefix: string): Promise<PlannerInput> => {
    const provider = providerFor(project.reasoningProviderId);
    const model = provider.models.find(candidate => candidate.id === project.reasoningModelId);
    if (!model) throw new Error('Configured reasoning model no longer exists in its provider');
    return {
      ...base, ...ctx.agentOptions(prefix, provider.id, model.id),
      model: buildReasoningModel({ providerId: provider.id, modelId: model.id, baseUrl: provider.baseUrl, protocol: provider.reasoningProtocol, supportsVision: model.supportsVision, supportsThinking: model.supportsThinking, supportsStructuredOutput: model.supportsStructuredOutput }),
      apiKey: secrets.decrypt(provider.encryptedApiKey),
      assets: selectedAssets.map(asset => ({ id: asset.id, handle: imageHandle(imageHandles, asset.id), role: asset.role, kind: userAssetKindForRole(asset.role), name: asset.originalName, mimeType: asset.mimeType })),
      referenceImages: model.supportsVision ? await visionImageContents(selectedAssets) : undefined,
      visionAttachments: visionAttachmentMetadata(selectedAssets.map(asset => ({ ...asset, name: asset.originalName })), imageHandles),
      webResearch: webResearch ? {
        ...webResearch, external: ctx.agentOptions(input.productImagePlanning ? `${prefix}:research` : 'research', provider.id, model.id).external,
        audit: { onSearchStarted: () => repository.recordWebResearchSearch(job.id), onSourceAttempt: attempt => repository.recordWebResearchAttempt({ jobId: job.id, ...attempt }) },
      } : undefined,
    };
  };
  const frozen = input.productImagePlanning;
  let campaignStyleLock = frozen?.campaignStyleLock ?? '';
  let items: Array<PlannedStoryboardItem & { imagePlanning?: ReturnType<typeof imagePlanningContext>; planningStale?: boolean; planningSuperseded?: boolean }>;
  if (frozen) {
    const selections = new Map(frozen.targetSelections?.map(entry => [entry.targetId, entry.assetType]));
    // 同模板可覆盖不同业务目标，但每次规划仍保持原有视觉任务去重约束。
    const batches = productPlanningBatches(frozen.targets).flatMap(group => {
      if (input.planningMode !== 'MANUAL') return [group];
      const chunks: typeof group[] = [];
      for (const target of group) {
        const selected = selections.get(target.targetId);
        if (!selected) throw new Error('Missing frozen template assignment');
        let chunk = chunks.at(-1);
        if (!chunk || chunk.some(entry => selections.get(entry.targetId) === selected)) { chunk = []; chunks.push(chunk); }
        chunk.push(target);
      }
      return chunks;
    });
    if ((!batches.length && (frozen.scope !== 'STALE' || !frozen.retiredTargetIds?.length)) || frozen.targets.length > 96 || new Set(frozen.targets.map(target => target.targetId)).size !== frozen.targets.length) throw new Error('Invalid frozen product planning targets');
    items = [];
    for (const [batchIndex, targets] of batches.entries()) {
      throwIfCancelled(job);
      ctx.runtime.checkpoint(() => assertProductPlanningPublicationFresh(ctx.runtime.repository, project.id, frozen));
      const first = targets[0]!;
      const truthIds = new Set(first.productAssetIds);
      const scopedAssets = first.purpose === 'SKU' ? assets.filter(asset => asset.role !== 'PRODUCT_TRUTH' || truthIds.has(asset.id)) : assets;
      const plannerInput = await makeInput(selectVisionAssets(scopedAssets), `product-plan:batch:${String(batchIndex + 1).padStart(3, '0')}`);
      const plan = await planStoryboard({
        ...plannerInput, planningMode: input.planningMode ?? 'AI', targetImageCount: targets.length,
        ...(input.suiteBlueprint ? { suiteBlueprint: { ...input.suiteBlueprint, shots: targets.map(target => {
          const shot = input.suiteBlueprint!.shots.find(shot => shot.shotId === target.suiteShotId);
          if (!shot || shot.purpose !== target.purpose) throw new Error('Frozen suite shot does not match its target');
          return shot;
        }) } } : {}),
        requestedTypes: input.planningMode === 'MANUAL' ? (input.requestedTypes?.length ? targets.map(target => selections.get(target.targetId)!) : []) : input.requestedTypes,
        requestedSuiteShots: input.planningMode === 'MANUAL' && input.requestedSuiteShots?.length ? targets.map(target => selections.get(target.targetId)!) : [],
        productImageBatch: {
          purpose: first.purpose,
          targets: targets.map(target => ({ name: target.name, ordinal: target.ordinal, skus: target.skus.map(({ name, code, attributes }) => ({ name, code, attributes })), productHandles: target.purpose === 'SKU' ? target.productAssetIds.map(id => imageHandle(imageHandles, id)) : plannerInput.assets.filter(asset => asset.kind === 'PRODUCT').map(asset => asset.handle) })),
          ...(campaignStyleLock ? { campaignStyleLock } : {}),
        },
      });
      throwIfCancelled(job);
      if (plan.items.length !== targets.length || !plan.campaignStyleLock.trim() || (campaignStyleLock && plan.campaignStyleLock !== campaignStyleLock)) throw new Error('Product planning batch is incomplete or changed the campaign style lock');
      campaignStyleLock ||= plan.campaignStyleLock;
      const orderedItems = input.planningMode === 'MANUAL' ? targets.map(target => {
        const item = plan.items.find(entry => entry.assetType === selections.get(target.targetId));
        if (!item) throw new Error('Planning result lost its assigned template');
        return item;
      }) : plan.items;
      for (const [index, item] of orderedItems.entries()) {
        const target = targets[index]!;
        // 身份与商品附件由后端目标分配，模型不能把一组规格指向另一组。
        const referencedAssets = target.purpose === 'SKU'
          ? [...new Set([...item.referencedAssets.filter(id => assets.some(asset => asset.id === id && asset.role !== 'PRODUCT_TRUTH')), ...target.productAssetIds])]
          : item.referencedAssets;
        // 模式已严格校验；候选数由Agent本地绑定冻结配置，不进入模型提示词或回复。
        items.push({ ...item, referencedAssets, sortOrder: frozen.targets.findIndex(entry => entry.targetId === target.targetId), imagePlanning: { ...imagePlanningContext(target, frozen.state.revision), projectFactsFingerprint: projectPlanningFactsFingerprint(project), assetsFingerprint: frozen.assetsFingerprint }, planningStale: false, planningSuperseded: false });
      }
      await updateJob(job, { progress: 10 + Math.round(65 * (batchIndex + 1) / batches.length), progressDetail: { completedBatches: batchIndex + 1, totalBatches: batches.length, completedScenes: items.length, totalScenes: frozen.targets.length } });
    }
  } else {
    const plan = await planStoryboard(await makeInput(selectVisionAssets(assets), job.type.toLowerCase()));
    campaignStyleLock = plan.campaignStyleLock;
    items = plan.items;
  }
  throwIfCancelled(job);
  const storyboard = repository.transaction(() => {
    // 必须读取 live 仓库；冻结代理只用于模型输入，不能用于发布新鲜度判断。
    if (frozen) {
      const live = ctx.runtime.repository;
      assertProductPlanningPublicationFresh(live, project.id, frozen);
      const replacing = new Set(frozen.targets.map(target => target.targetId));
      const currentTargets = new Set(frozen.targetFingerprints.map(target => target.targetId));
      for (const old of currentPlanningItems(live.listStoryboardItems(project.id))) {
        if (old.imagePlanning && (frozen.scope === 'ALL' || replacing.has(old.imagePlanning.targetId) || !currentTargets.has(old.imagePlanning.targetId))) repository.updateStoryboardItem(old.id, { planningSuperseded: true });
      }
    }
    const board = repository.saveStoryboard(project.id, campaignStyleLock, 'DRAFT', items.map(item => ({ ...item, status: 'DRAFT', compiledPrompt: null, imageProviderId: project.imageProviderId, imageModelId: project.imageModelId, imageResolution: input.imageResolution ?? project.imageResolution, imageAspectRatio: input.imageAspectRatio ?? project.imageAspectRatio })));
    repository.createPlanningConfigSnapshot({
      projectId: project.id, sourceJobId: job.id,
      payload: {
        project: {
          name: project.name, category: project.category, productDescription: project.productDescription,
          verifiedFacts: project.verifiedFacts, prohibitedClaims: project.prohibitedClaims, brandGuidelines: project.brandGuidelines,
          platformTargets: project.platformTargets, targetMarket: project.targetMarket, copyLanguage: project.copyLanguage, promptLanguage: project.promptLanguage,
          reasoningProviderId: project.reasoningProviderId, reasoningModelId: project.reasoningModelId,
          imageProviderId: project.imageProviderId, imageModelId: project.imageModelId, defaultMode: project.defaultMode,
          imageResolution: input.imageResolution ?? project.imageResolution, imageAspectRatio: input.imageAspectRatio ?? project.imageAspectRatio,
          candidatesPerType: input.candidatesPerType ?? project.candidatesPerType, webResearchEnabled: project.webResearchEnabled,
        },
        planning: { planningVersion: input.planningVersion ?? 1, planningMode: input.planningMode ?? 'AI', requestedTypes: input.requestedTypes ?? [], requestedSuiteShots: input.requestedSuiteShots ?? [], ...(input.suiteBlueprint ? { suiteBlueprint: input.suiteBlueprint } : {}), ...(input.styleInstruction ? { styleInstruction: input.styleInstruction } : {}), targetImageCount: frozen ? frozen.targets.length : input.targetImageCount ?? null, userInstruction: input.userInstruction ?? null },
      },
    });
    return board;
  });
  await updateJob(job, { progress: 90 });
  await events.publish(project.id, 'storyboard.updated', { storyboard });
}
