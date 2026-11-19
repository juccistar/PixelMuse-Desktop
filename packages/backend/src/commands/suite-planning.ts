import { randomUUID } from 'node:crypto';
import { requestFingerprint, type JobRecord, type SuitePlanningBatchRecord } from '@ecomgen/core';
import { operations, resolveProductImageTargets, suitePlanningCounts, type Input, type SuitePlanningBatch, type SaveProjectImagePlanningOutput } from '@ecomgen/contracts';
import { getProjectImagePlanningState } from '../product-image-planning.js';
import { normalizeSuiteBlueprint, suiteBlueprintFromCatalog } from '../suite-planning.js';
import { assertNoImageWork, assertPlanningComplete, currentPlanningItems, planningSourceChanged } from '../execution/product-image-planning.js';
import { publicTaskError } from '../public-task-error.js';
import { BackendError } from '../validation.js';
import { registerProductImagePlanningCommands } from './product-image-planning.js';
import { registerProductImagePlanningJobCommands } from './product-image-planning-jobs.js';
import { storyboardCommands } from './storyboard.js';
import { ensureProject, verifyModel } from './helpers.js';
import { type CommandFlow, type CommandScope } from './support.js';

type BatchEntry = SuitePlanningBatchRecord['payload']['entries'][number];
const message = (error: unknown) => error instanceof BackendError ? error.message : '此商品未通过检查，请进入项目处理后重试。';
function requireBatch(ctx: CommandScope, id: string): SuitePlanningBatchRecord {
  const batch = ctx.repository.getSuitePlanningBatch(id);
  if (!batch) throw new BackendError('NOT_FOUND', '套图批次不存在。');
  return batch;
}

/** 批次没有第二套任务状态，查询始终聚合canonical Job和产物。 */
function publicBatch(ctx: CommandScope, batch: SuitePlanningBatchRecord): SuitePlanningBatch {
  const { repository } = ctx;
  return {
    id: batch.id, suiteBlueprint: batch.payload.suiteBlueprint, phase: batch.payload.phase, createdAt: batch.createdAt, updatedAt: batch.updatedAt,
    entries: batch.payload.entries.map(entry => {
      const project = repository.getProject(entry.projectId);
      const plan = entry.planJobId ? repository.getJob(entry.planJobId) : undefined;
      const generationJobIds = entry.generationJobIds ?? [];
      const generations = generationJobIds.flatMap(id => { const job = repository.getJob(id); return job ? [job] : []; });
      let sceneCount = 0, ready = false;
      let error = entry.error ?? (!project ? '项目已删除。' : undefined);
      if (project) {
        try {
          const state = getProjectImagePlanningState(repository, project.id);
          sceneCount = resolveProductImageTargets({ ...state, config: { ...state.config, ...suitePlanningCounts(batch.payload.suiteBlueprint), suiteBlueprint: batch.payload.suiteBlueprint } }).length;
          const board = repository.getStoryboard(project.id);
          const items = currentPlanningItems(repository.listStoryboardItems(project.id));
          if (plan?.status === 'SUCCEEDED' && board && !generationJobIds.length && state.config.suiteBlueprint?.suiteVersion === batch.payload.suiteBlueprint.suiteVersion && items.length === sceneCount && items.every(item => item.planningSource?.kind === 'SUITE' && item.planningSource.suiteVersion === batch.payload.suiteBlueprint.suiteVersion && !item.planningStale && !planningSourceChanged(repository, item))) {
            assertNoImageWork(repository, ctx.requestLedger, project.id);
            assertPlanningComplete(repository, project.id);
            ready = true;
          }
        } catch (caught) { error ??= message(caught); }
      }
      const failed = generations.find(job => ['FAILED', 'CANCELLED', 'UNKNOWN'].includes(job.status)) ?? (plan && ['FAILED', 'CANCELLED', 'UNKNOWN'].includes(plan.status) ? plan : undefined);
      if (failed) error = publicTaskError(failed.error ?? { code: failed.status }, failed.status)?.message ?? '任务未完成。';
      return {
        projectId: entry.projectId, projectName: project?.name ?? '已删除项目',
        ...(plan ? { planJobId: plan.id, planStatus: plan.status, planProgress: plan.progress } : {}),
        generationJobIds, generationCompleted: generations.filter(job => job.status === 'SUCCEEDED').length, generationTotal: generationJobIds.length,
        sceneCount, candidateCount: project?.candidatesPerType ?? 1, ready, ...(error ? { error } : {}),
      };
    }),
  };
}

function* startPlanning(ctx: CommandScope, batch: SuitePlanningBatchRecord, entry: BatchEntry): CommandFlow<void> {
  const project = ctx.repository.getProject(entry.projectId);
  if (!project) throw new BackendError('NOT_FOUND', '项目已删除。');
  assertNoImageWork(ctx.repository, ctx.requestLedger, project.id);
  const state = getProjectImagePlanningState(ctx.repository, project.id);
  const blueprint = batch.payload.suiteBlueprint;
  const saved = registerProductImagePlanningCommands(ctx).saveProjectImagePlanning!(ctx, {
    projectId: project.id, expectedRevision: state.revision,
    config: { ...state.config, ...suitePlanningCounts(blueprint), suiteBlueprint: blueprint, excludedTargetIds: [] }, skus: state.skus, imageGroups: state.imageGroups,
  }) as SaveProjectImagePlanningOutput;
  const plan = (yield* registerProductImagePlanningJobCommands(ctx).createProductImagePlanningJob({
    projectId: project.id, expectedRevision: saved.planning.revision, regenerationKey: batch.id,
    ...(batch.payload.userInstruction ? { userInstruction: batch.payload.userInstruction } : {}),
    ...(batch.payload.referenceSourceProjectId ? { referenceSourceProjectId: batch.payload.referenceSourceProjectId } : {}),
  })) as JobRecord;
  entry.planJobId = plan.id;
  delete entry.error;
}

/** 跨商品只组织独立项目，规划后必须由用户再次明确触发生图。 */
export function suitePlanningCommands(ctx: CommandScope) {
  return {
    getSuitePlanningBlueprint: function* (input: Input<'getSuitePlanningBlueprint'>): CommandFlow<unknown> { return suiteBlueprintFromCatalog(ctx.catalog, input.suiteId); },
    listSuitePlanningBatches: function* (_input: Input<'listSuitePlanningBatches'>): CommandFlow<unknown> { return { items: ctx.repository.listSuitePlanningBatches().map(batch => publicBatch(ctx, batch)) }; },
    getSuitePlanningBatch: function* (input: Input<'getSuitePlanningBatch'>): CommandFlow<unknown> { return publicBatch(ctx, requireBatch(ctx, input.batchId)); },
    createSuitePlanningBatch: function* (input: Input<'createSuitePlanningBatch'>): CommandFlow<unknown> {
      const blueprint = normalizeSuiteBlueprint(input.suiteBlueprint);
      const instruction = input.userInstruction?.trim() || undefined;
      const prior = ctx.repository.findSuitePlanningBatchByRequestKey(input.regenerationKey);
      if (prior) {
        const intended = { suiteBlueprint: blueprint, projectIds: input.projectIds, userInstruction: instruction, referenceSourceProjectId: input.referenceSourceProjectId };
        const original = { suiteBlueprint: prior.payload.suiteBlueprint, projectIds: prior.payload.entries.map(entry => entry.projectId), userInstruction: prior.payload.userInstruction, referenceSourceProjectId: prior.payload.referenceSourceProjectId };
        if (requestFingerprint(intended) !== requestFingerprint(original)) throw new BackendError('CONFLICT', '此批次提交键已用于另一组商品或套图，请刷新后重新提交。');
        return publicBatch(ctx, prior);
      }
      const batch = ctx.repository.createSuitePlanningBatch({ id: randomUUID(), requestKey: input.regenerationKey, payload: {
        suiteBlueprint: blueprint, phase: 'PLANNING', entries: input.projectIds.map(projectId => ({ projectId })),
        ...(instruction ? { userInstruction: instruction } : {}), ...(input.referenceSourceProjectId ? { referenceSourceProjectId: input.referenceSourceProjectId } : {}),
      } });
      for (const entry of batch.payload.entries) {
        try { yield* startPlanning(ctx, batch, entry); }
        catch (error) { entry.error = message(error); }
        ctx.repository.updateSuitePlanningBatch(batch.id, batch.payload);
      }
      return publicBatch(ctx, requireBatch(ctx, batch.id));
    },
    generateSuitePlanningBatch: function* (input: Input<'generateSuitePlanningBatch'>): CommandFlow<unknown> {
      const batch = requireBatch(ctx, input.batchId);
      batch.payload.phase = 'GENERATION';
      for (const entry of batch.payload.entries) {
        if (entry.generationJobIds?.length) continue;
        const status = publicBatch(ctx, batch).entries.find(value => value.projectId === entry.projectId)!;
        if (!status.ready) { entry.error = status.error ?? '请先完成并检查此商品的完整规划。'; continue; }
        try {
          const board = ctx.repository.getStoryboard(entry.projectId)!;
          if (board.status !== 'CONFIRMED') yield* storyboardCommands(ctx).confirmStoryboard({ projectId: entry.projectId, version: board.version });
          entry.generationKey ??= randomUUID();
          // 在创建任务前持久化本次意图，桥接中断可用同键找回任务。
          ctx.repository.updateSuitePlanningBatch(batch.id, batch.payload);
          const result = (yield* storyboardCommands(ctx).createGenerationJobs({ projectId: entry.projectId, storyboardItemIds: currentPlanningItems(ctx.repository.listStoryboardItems(entry.projectId)).map(item => item.id), regenerationKey: entry.generationKey })) as { jobs: JobRecord[] };
          entry.generationJobIds = result.jobs.map(job => job.id);
          delete entry.error;
        } catch (error) { entry.error = message(error); }
        ctx.repository.updateSuitePlanningBatch(batch.id, batch.payload);
      }
      ctx.repository.updateSuitePlanningBatch(batch.id, batch.payload);
      return publicBatch(ctx, requireBatch(ctx, batch.id));
    },
    retrySuitePlanningBatch: function* (input: Input<'retrySuitePlanningBatch'>): CommandFlow<unknown> {
      const batch = requireBatch(ctx, input.batchId);
      for (const entry of batch.payload.entries) {
        try {
          const ids = batch.payload.phase === 'GENERATION' && entry.generationJobIds?.length ? entry.generationJobIds : entry.planJobId ? [entry.planJobId] : [];
          if (!ids.length) { yield* startPlanning(ctx, batch, entry); }
          const retryIds = ids.filter(id => { const job = ctx.repository.getJob(id); return job && ['FAILED', 'UNKNOWN'].includes(job.status); });
          if (retryIds.length) {
            const result = ctx.scheduler.resolveInterruptions({ jobIds: retryIds, action: 'RETRY' });
            const failed = result.items.find(item => item.status === 'FAILED');
            if (failed) throw new BackendError('CONFLICT', failed.reason ?? '任务暂时不能重试。');
          }
          for (const id of ids) if (ctx.repository.getJob(id)?.status === 'CANCELLED') ctx.scheduler.retry(id);
          delete entry.error;
        } catch (error) { entry.error = message(error); }
        ctx.repository.updateSuitePlanningBatch(batch.id, batch.payload);
      }
      return publicBatch(ctx, requireBatch(ctx, batch.id));
    },
    createStoryboardSuiteJob: function* (input: Input<'createStoryboardSuiteJob'>): CommandFlow<unknown> {
      ensureProject(ctx.repository, input.projectId);
      const project = ctx.repository.getProject(input.projectId)!;
      const storyboard = ctx.repository.getStoryboard(project.id);
      const items = currentPlanningItems(ctx.repository.listStoryboardItems(project.id));
      if (!storyboard || !items.length || items.length > 12) throw new BackendError('VALIDATION_ERROR', '请选择1到12个完整画面的规划保存为套图。');
      assertNoImageWork(ctx.repository, ctx.requestLedger, project.id);
      assertPlanningComplete(ctx.repository, project.id);
      verifyModel(ctx.repository, project.reasoningProviderId, project.reasoningModelId, 'reasoning');
      const refs = [...new Set(items.flatMap(item => item.referencedAssets))].flatMap(id => {
        const asset = ctx.repository.getAsset(id);
        return asset && asset.role !== 'PRODUCT_TRUTH' ? [{ projectId: project.id, assetId: id }] : [];
      });
      const jobInput = { storyboardSource: { name: input.name, campaignStyleLock: storyboard.campaignStyleLock, referenceAssets: refs, shots: items.map(item => ({ title: item.displayName, purpose: item.imagePlanning?.purpose ?? 'MAIN', intent: item.planningSource?.intent ?? item.displayName, referenceIntent: item.planningSource?.referenceIntent ?? '', prompt: item.promptInstruction })) }, regenerationKey: input.regenerationKey };
      const fingerprint = requestFingerprint({ type: 'SUITE_FORGE', projectId: project.id, input: jobInput });
      const existing = ctx.repository.findJobByFingerprint(project.id, fingerprint);
      if (existing) return existing;
      const job = ctx.repository.createJob({ id: randomUUID(), projectId: project.id, storyboardItemId: null, type: 'SUITE_FORGE', input: jobInput, requestFingerprint: fingerprint, providerId: project.reasoningProviderId, modelId: project.reasoningModelId });
      yield ctx.queue(job);
      return job;
    },
  };
}
