import { startPipelineStep, nextPipelineStep, type JobRecord, type SqliteDatabase } from '@ecomgen/core';
import { RuntimeStore } from '../runtime/state.js';
import type { CommandContext, ExecutionContext, ExecutorMap, JobRuntimeRecord, JobTerminalStatus, RegisterExecutors } from '../runtime/ports.js';
import { createExecutionContext, candidateIdFor, generationKeyFor } from './context.js';
import { BackendError } from '../validation.js';
import type { FrozenJobSnapshot } from '../runtime/state.js';
import { executionSnapshotSchema, readKey, type ExecutionInputs } from './snapshot.js';
import { assertProjectImageWorkAllowed } from './image-work-barrier.js';
import { executePlan } from './job-plan.js';
import { executeCopywriting } from './job-copywrite.js';
import { executeGeneration } from './job-generation.js';
import { executeExport } from './job-export.js';
import { executeEditPlan, executeEditGeneration } from './job-edit.js';
import { executeLayerPlan, executeLayerExport } from './job-layers.js';
import { executeSuiteForge } from './job-suite-forge.js';
import { executeModelCast } from './job-model-cast.js';
import { executePatternExtract, executePatternForge, executePatternDerive, executePatternVariant, executePatternTileCheck } from './job-patterns.js';
import { executePrintPack } from './job-print-pack.js';
import { executeDraftGenerate, executeDraftEdit, executeDraftCutout, executeDraftProcess } from './job-pattern-drafts.js';

export { createExecutionContext, generationKeyFor, candidateIdFor, JobCancelled } from './context.js';
export { createExecutionSnapshot, executionSnapshotSchema } from './snapshot.js';

function isDraftBatch(job: JobRecord, snapshot: FrozenJobSnapshot): boolean {
  return job.type.startsWith('PATTERN_DRAFT_') && typeof snapshot.input.batchId === 'string';
}

/** 旧补偿可能已转走部分槽位；只恢复仍属于原代次的槽位，原持久快照保持不变。 */
function draftResumeSnapshot(context: CommandContext, job: JobRecord, snapshot: FrozenJobSnapshot): FrozenJobSnapshot {
  if (!isDraftBatch(job, snapshot)) return snapshot;
  const frozen = snapshot.effective.execution as unknown as ExecutionInputs;
  const store = new RuntimeStore((context.repository as unknown as {db: SqliteDatabase}).db, context.clock);
  const retained: NonNullable<ExecutionInputs['slots']> = [];
  let ownsCompleted = false;
  for (const expected of frozen.slots ?? []) {
    const slot = context.repository.listDraftSlots(expected.batchId).find(entry => entry.index === expected.index);
    const resolvingOwn=context.interruptionRetry?.jobId===job.id&&slot?.jobId===job.id;
    if (!slot || (!resolvingOwn && (slot.status === 'UNKNOWN' || (slot.jobId && context.requestLedger.hasUnknown(slot.jobId)))))
      throw new BackendError('EXTERNAL_UNKNOWN', '草稿槽位缺少可靠状态或存在中断任务。');
    if (slot.jobId === job.id && slot.attempt === expected.attempt) {
      // 成功槽位是终态；候选行缺失可能是用户主动删除，不能以回执重建。
      if (slot.status === 'SUCCEEDED') ownsCompleted = true;
      else retained.push(expected);
      continue;
    }
    // 仅承认另一个持久冻结任务的更高代次；同任务 attempt 漂移、无主槽位仍按过期执行拒绝。
    const successor = slot.jobId && slot.jobId !== job.id && slot.attempt > expected.attempt ? store.get(slot.jobId) : undefined;
    const successorInputs = successor?.snapshot.effective.execution as unknown as ExecutionInputs | undefined;
    if (!successor || successor.snapshot.jobId !== slot.jobId || successor.snapshot.type !== job.type || successor.snapshot.input.batchId !== snapshot.input.batchId || successor.snapshot.input.draftId !== snapshot.input.draftId || !successorInputs?.slots?.some(entry => entry.batchId === expected.batchId && entry.index === expected.index && entry.attempt === slot.attempt))
      throw new BackendError('STALE_SLOT_ATTEMPT', '草稿槽位代次已变化，不能恢复该任务。');
  }
  if (!retained.length && !ownsCompleted) throw new BackendError('STALE_SLOT_ATTEMPT', '该任务已没有可恢复的草稿槽位。');
  const view = structuredClone(snapshot);
  view.input.slots = retained.map(slot => slot.index);
  // 快照来自已校验 JSON；只替换槽位列表，避免把任意领域对象重新写入持久快照。
  (view.effective.execution as unknown as ExecutionInputs).slots = retained;
  return view;
}

/** 显式补偿仅为已完整拒绝且没有成功回执的槽位建立新付费意图。 */
export function compensateDraftJob(context: CommandContext, job: JobRecord): { jobs: JobRecord[]; replaced: boolean } {
  const repo = context.repository;
  const connection = (repo as unknown as { db: SqliteDatabase }).db;
  if (!connection?.inTransaction) throw new Error('TRANSACTION_REQUIRED');
  const store = new RuntimeStore(connection, context.clock), runtime = store.get(job.id);
  if (!runtime || !isDraftBatch(job, runtime.snapshot) || runtime.snapshot.jobId !== job.id || runtime.snapshot.type !== job.type || job.preservedHistory || !job.retryable || !['FAILED', 'CANCELLED'].includes(job.status))
    throw new BackendError('RETRY_UNSAFE', '草稿原任务不能安全恢复。');
  if (context.requestLedger.hasUnknown(job.id) || runtime.requests.some(request => request.state !== 'COMPLETED'))
    throw new BackendError('EXTERNAL_UNKNOWN', '未知外部结果不能通过失败补偿重发。');
  store.validate(executionSnapshotSchema, runtime.snapshot);
  const view = draftResumeSnapshot(context, job, runtime.snapshot);
  const execution = view.effective.execution as unknown as ExecutionInputs;
  const receipts = context.requestLedger.forJob(job.id, context.signal);
  const summaries = context.requestLedger.summaries(job.id);
  const rejected = (execution.slots ?? []).filter(slot => {
    if (repo.listDraftSlots(slot.batchId).find(entry => entry.index === slot.index)?.status !== 'FAILED') return false;
    const requests = summaries.filter(request => request.requestKey.startsWith(`${generationKeyFor(job.id, slot.index)}:`) || request.requestKey.startsWith(`cutout:${slot.index}:`));
    return requests.length > 0 && requests.every(request => {
      if (request.localState !== 'PENDING') return false;
      const receipt = receipts.receipt(request.requestKey);
      if (!receipt || receipt.status < 400 || receipt.status >= 500 || receipt.status === 408) return false;
      // 保守识别完整错误响应；任何成功回执或带图结果都继续使用原请求证据。
      try {
        const body = JSON.parse(Buffer.from(receipt.bodyBase64, 'base64').toString('utf8'));
        return body && typeof body === 'object' && !Array.isArray(body) && Boolean(body.error) && Object.keys(body).every(key => key === 'error');
      } catch { return false; }
    });
  });
  if (!rejected.length) return { jobs: [context.scheduler.retry(job.id)], replaced: false };
  const indices = rejected.map(slot => slot.index);
  const intent = execution.intent;
  const replacement = repo.createJob({ id: context.idFactory(), type: job.type, ...intent,
    input: { ...view.input, slots: indices, replacementOf: job.id }, requestFingerprint: null, estimatedCost: job.estimatedCost });
  repo.assignDraftSlotsToJob(String(view.input.batchId), indices, replacement.id, true);
  const snapshot = structuredClone(runtime.snapshot);
  snapshot.jobId = replacement.id; snapshot.createdAt = context.clock(); snapshot.input = JSON.parse(JSON.stringify(replacement.input));
  const replacementInputs = snapshot.effective.execution as unknown as ExecutionInputs;
  replacementInputs.slots = repo.listDraftSlotsByJobId(replacement.id).map(slot => ({ batchId: slot.batchId, index: slot.index, attempt: slot.attempt }));
  context.scheduler.freeze(replacement.id, snapshot);
  // enqueue 只安排提交后的扫描；整批同步事务失败时所有新意图与槽位转移一起回滚。
  context.scheduler.enqueue(replacement.id);
  const jobs = (execution.slots ?? []).some(slot => !indices.includes(slot.index)) ? [context.scheduler.retry(job.id), replacement] : [replacement];
  return { jobs, replaced: true };
}

/** 显式穷尽分派；未知类型必须失败，不能落到导出或伪成功。 */
export async function executeDomainJob(context: ExecutionContext, job: JobRecord = context.job): Promise<void> {
  if (job.id !== context.snapshot.jobId || job.type !== context.snapshot.type) throw new Error('Execution snapshot does not match task');
  // 只在新执行代次建立恢复视图；执行中仍逐次检查本代次的全部槽位，拒绝迟到写入。
  if (context.attempt > 1) context = {...context, snapshot: draftResumeSnapshot(context, job, context.snapshot)};
  const ctx = createExecutionContext(context);
  const inputs=context.snapshot.effective.execution as unknown as ExecutionInputs;
  if(!inputs?.intent)throw new Error('Frozen task intent is missing');
  if (context.attempt > 1 && isDraftBatch(job, context.snapshot) && inputs.slots?.length === 0) return;
  const frozen = { ...job, ...inputs.intent, input: context.snapshot.input };
  switch (job.type) {
    case 'PLAN': await executePlan(ctx, frozen); break;
    case 'COPYWRITE': await executeCopywriting(ctx, frozen); break;
    case 'GENERATE': await executeGeneration(ctx, frozen, context.signal); break;
    case 'EXPORT': await executeExport(ctx, frozen); break;
    case 'EDIT_PLAN': await executeEditPlan(ctx, frozen); break;
    case 'EDIT_GENERATE': await executeEditGeneration(ctx, frozen, context.signal); break;
    case 'LAYER_PLAN': await executeLayerPlan(ctx, frozen); break;
    case 'LAYER_EXPORT': await executeLayerExport(ctx, frozen, context.signal); break;
    case 'SUITE_FORGE': await executeSuiteForge(ctx, frozen); break;
    case 'MODEL_CAST': await executeModelCast(ctx, frozen, context.signal); break;
    case 'PATTERN_EXTRACT': await executePatternExtract(ctx, frozen, context.signal); break;
    case 'PATTERN_FORGE': await executePatternForge(ctx, frozen, context.signal); break;
    case 'PATTERN_DERIVE': await executePatternDerive(ctx, frozen); break;
    case 'PATTERN_VARIANT': await executePatternVariant(ctx, frozen, context.signal); break;
    case 'PATTERN_TILE_CHECK': await executePatternTileCheck(ctx, frozen); break;
    case 'PRINT_PACK': await executePrintPack(ctx, frozen); break;
    case 'PATTERN_DRAFT_GENERATE': await executeDraftGenerate(ctx, frozen, context.signal); break;
    case 'PATTERN_DRAFT_EDIT': await executeDraftEdit(ctx, frozen, context.signal); break;
    case 'PATTERN_DRAFT_CUTOUT': await executeDraftCutout(ctx, frozen, context.signal); break;
    case 'PATTERN_DRAFT_PROCESS': await executeDraftProcess(ctx, frozen); break;
    default: throw new Error(`UNKNOWN_JOB_TYPE: ${String(job.type)}`);
  }
  context.checkpoint(() => {
    if (isDraftBatch(job, context.snapshot)) {
      // 已转走的旧槽位回执不能被这次本地结算误标为已提交。
      for (const slot of (context.snapshot.effective.execution as unknown as ExecutionInputs).slots ?? []) {
        ctx.commitCandidate(generationKeyFor(job.id, slot.index));
        ctx.commitCandidate(`cutout:${slot.index}`);
      }
    } else {
      for (const request of context.requestLedger.summaries(job.id)) if (request.state === 'COMPLETED' && request.localState !== 'COMMITTED') context.external.committed(request.requestKey);
    }
  });
}

/** 自动后续任务继承原有效配置，只替换这一步产生的领域输入。 */
function freezeSuccessor(context: CommandContext, job: JobRecord, runtime: JobRuntimeRecord): void {
  const snapshot = structuredClone(runtime.snapshot);
  snapshot.jobId = job.id; snapshot.type = job.type; snapshot.input = JSON.parse(JSON.stringify(job.input)); snapshot.createdAt = context.clock();
  const execution = snapshot.effective.execution as unknown as ExecutionInputs;
  execution.intent={providerId:job.providerId,modelId:job.modelId,projectId:job.projectId,storyboardItemId:job.storyboardItemId};
  const repo = context.repository;
  const turnId = job.input.editTurnId ?? job.input.turnId;
  if (typeof turnId === 'string') execution.reads[readKey('getEditTurn',[turnId])] = repo.getEditTurn(turnId);
  if (typeof job.input.patternId === 'string') {
    const pattern=repo.getPattern(job.input.patternId);
    execution.reads[readKey('getPattern',[job.input.patternId])] = pattern;
    if(pattern?.fileHash && !snapshot.resources.some(resource=>resource.ref.kind==='PATTERN'&&resource.ref.id===pattern.id)) snapshot.resources.push({ref:{kind:'PATTERN',id:pattern.id},hash:pattern.fileHash});
  }
  const step = repo.getPatternPipelineStepByJobId(job.id);
  if (step) execution.pipeline = {id:step.pipelineId,stepId:step.id,jobId:job.id}; else delete execution.pipeline;
  execution.slots = repo.listDraftSlotsByJobId(job.id).map(slot=>({batchId:slot.batchId,index:slot.index,attempt:slot.attempt}));
  context.scheduler.freeze(job.id, JSON.parse(JSON.stringify(snapshot)));
  context.scheduler.enqueue(job.id);
}

/** 在调度器的同步终态事务中完成编辑与流水线推进。 */
export function settleDomainJob(context: CommandContext, job: JobRecord, status: JobTerminalStatus, runtime: JobRuntimeRecord): void {
  const repo = context.repository;
  const turnId = job.input.editTurnId ?? job.input.turnId;
  if (typeof turnId === 'string' && (job.type === 'EDIT_PLAN' || job.type === 'EDIT_GENERATE')) {
    const turn = repo.getEditTurn(turnId);
    if (turn && status !== 'SUCCEEDED' && turn.status !== 'SUCCEEDED') repo.updateEditTurn(turn.id,{status,error:job.error});
    if (turn && status === 'SUCCEEDED' && job.type === 'EDIT_PLAN' && turn.status === 'GENERATING') {
      const childId = candidateIdFor(job.id, 0);
      let child = repo.getJob(childId);
      if (!child) {
        if (job.projectId) assertProjectImageWorkAllowed(repo,context.requestLedger,job.projectId,{exceptJobId:job.id});
        const config = (turn.annotations as Record<string,unknown>).generationConfig as Record<string,unknown> | undefined;
        const reads = (runtime.snapshot.effective.execution as unknown as ExecutionInputs).reads;
        const project = reads[readKey('getProject',[job.projectId])] as {imageProviderId:string;imageModelId:string};
        child = repo.createJob({id:childId,projectId:job.projectId,storyboardItemId:null,type:'EDIT_GENERATE',input:{editTurnId:turn.id,turnId:turn.id},requestFingerprint:null,providerId:typeof config?.imageProviderId==='string'?config.imageProviderId:project.imageProviderId,modelId:typeof config?.imageModelId==='string'?config.imageModelId:project.imageModelId,estimatedCost:{status:'UNKNOWN',unit:'provider-defined'}});
        freezeSuccessor(context,child,runtime);
      }
    }
  }
  const step = repo.getPatternPipelineStepByJobId(job.id);
  if (!step || status !== 'SUCCEEDED') return;
  const execution = runtime.snapshot.effective.execution as unknown as ExecutionInputs;
  if (!execution.pipeline || execution.pipeline.stepId !== step.id || execution.pipeline.jobId !== job.id) throw new Error('STALE_PIPELINE_GENERATION');
  const pipeline = repo.getPatternPipeline(step.pipelineId);
  if (!pipeline || step.status === 'SUCCEEDED') return;
  let patternId = pipeline.patternId;
  if (step.step === 'SOURCE') {
    const candidates = repo.listPatternsByJobId(job.id).filter(pattern=>pattern.storagePath);
    const count=typeof job.input.candidateCount==='number'?job.input.candidateCount:1;
    let produced=candidates.find(pattern=>pattern.id===candidateIdFor(job.id,1));
    for(let index=2;!produced&&index<=count;index++)produced=candidates.find(pattern=>pattern.id===candidateIdFor(job.id,index));
    produced ??= candidates.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))[0];
    if (!produced) throw new Error('Pipeline source completed without artwork');
    patternId = produced.id; repo.updatePatternPipeline(pipeline.id,{patternId});
  }
  if (!patternId) throw new Error('Pipeline has no source pattern');
  const pattern = repo.getPattern(patternId);
  const detail = step.step === 'TILE_CHECK' ? {tileable:pattern?.tileable??null,tileableScore:pattern?.tileableScore??null,repeatLayout:pipeline.repeatLayout} : null;
  repo.updatePatternPipelineStep(step.id,{status:'SUCCEEDED',detail});
  if (step.step === 'TILE_CHECK' && pipeline.layout === 'TILE' && pipeline.repeatLayout !== 'MIRROR' && pattern?.tileable !== 'VERIFIED') {
    repo.updatePatternPipeline(pipeline.id,{status:'AWAITING_INPUT',blockReason:'SEAM_RISK'});return;
  }
  const next = nextPipelineStep(pipeline.steps,step);
  if (!next) {repo.updatePatternPipeline(pipeline.id,{status:'SUCCEEDED',blockReason:null});return;}
  const created = startPipelineStep(repo,pipeline,next,patternId);
  freezeSuccessor(context,created.job,runtime);
}

/** 查询和执行共用领域前置检查；只读取关联，不产生任务或改变状态。 */
export function assertDomainRetryAllowed(context: CommandContext, job: JobRecord, runtime: JobRuntimeRecord): ExecutionInputs {
  const repo=context.repository;
  const intent=(runtime.snapshot.effective.execution as unknown as ExecutionInputs)?.intent;
  if(!intent||intent.projectId!==job.projectId||intent.storyboardItemId!==job.storyboardItemId||intent.providerId!==job.providerId||intent.modelId!==job.modelId||JSON.stringify(runtime.snapshot.input)!==JSON.stringify(job.input))throw new BackendError('STALE_JOB_INTENT','任务归属或冻结输入已变化。');
  if(!['FAILED','CANCELLED'].includes(job.status)||job.preservedHistory||!job.retryable)throw new BackendError('RETRY_UNSAFE','任务当前不可重试。');
  const interruption=context.interruptionRetry?.jobId===job.id;
  if((!interruption&&context.requestLedger.hasUnknown(job.id))||runtime.requests.some(request=>request.state!=='COMPLETED'&&!(interruption&&request.state==='UNKNOWN')))throw new BackendError('EXTERNAL_UNKNOWN','外部请求尚未处理。');
  if(job.type==='GENERATE'&&job.projectId&&job.storyboardItemId&&repo.listJobs(job.projectId).some(other=>other.id!==job.id&&!(interruption&&context.interruptionRetry?.cohort.includes(other.id))&&other.type==='GENERATE'&&other.storyboardItemId===job.storyboardItemId&&['QUEUED','RUNNING','UNKNOWN'].includes(other.status)))throw new BackendError('STALE_JOB_INTENT','此画面已有其他活动生成任务。');
  if(job.projectId && ['PLAN','GENERATE','EDIT_PLAN','EDIT_GENERATE'].includes(job.type)) assertProjectImageWorkAllowed(repo,context.requestLedger,job.projectId,{exceptJobId:job.id,exceptJobIds:interruption?context.interruptionRetry?.cohort:undefined});
  if((job.type==='LAYER_PLAN'&&!repo.getLayerPlanByJobId(job.id))||(job.type==='LAYER_EXPORT'&&!repo.getLayerExportByJobId(job.id))||(job.type==='PRINT_PACK'&&!repo.getPrintPackByJobId(job.id))||(job.type==='EXPORT'&&!repo.getExportByJobId(job.id)))throw new BackendError('STALE_JOB_INTENT','任务关联记录已缺失。');
  const frozen=draftResumeSnapshot(context,job,runtime.snapshot).effective.execution as unknown as ExecutionInputs;
  for(const expected of frozen.slots??[]) {
    const slot=repo.listDraftSlots(expected.batchId).find(slot=>slot.index===expected.index);
    if(!slot||slot.jobId!==job.id||slot.attempt!==expected.attempt||(slot.status==='UNKNOWN'&&!interruption))throw new BackendError('STALE_SLOT_ATTEMPT','草稿槽位已变化，请回到草稿批次处理。');
  }
  if(frozen.pipeline) {
    const step=repo.getPatternPipelineStepByJobId(job.id),pipeline=repo.getPatternPipeline(frozen.pipeline.id);
    if(!step||!pipeline||step.id!==frozen.pipeline.stepId||(step.status==='UNKNOWN'&&!interruption)||pipeline.steps.some(entry=>entry.position>step.position&&(entry.jobId||entry.status==='UNKNOWN')))throw new BackendError('STALE_PIPELINE_GENERATION','流水线步骤已变化，请回到流水线处理。');
  }
  const turnId=job.input.editTurnId??job.input.turnId;
  if(typeof turnId==='string') {
    const turn=repo.getEditTurn(turnId);
    if(!turn||turn.projectId!==job.projectId||(turn.status==='UNKNOWN'&&!interruption))throw new BackendError('EXTERNAL_UNKNOWN','编辑轮次缺失或仍处于中断状态。');
    if(job.projectId&&repo.listJobs(job.projectId).some(other=>other.id!==job.id&&(other.input.editTurnId===turnId||other.input.turnId===turnId)&&['QUEUED','RUNNING','UNKNOWN'].includes(other.status)))throw new BackendError('STALE_JOB_INTENT','编辑轮次已有其他活动任务。');
  }
  return frozen;
}
/** 显式重试复用同一冻结输入与可靠回执；已核实失败的请求保留在独立历史。 */
export function retryDomainJob(context: CommandContext, job: JobRecord, runtime: JobRuntimeRecord): JobRecord {
  const repo=context.repository;
  const connection=(repo as unknown as {db:SqliteDatabase}).db;
  if(!connection?.inTransaction)throw new Error('TRANSACTION_REQUIRED');
  const frozen=assertDomainRetryAllowed(context,job,runtime);
  for(const expected of frozen.slots??[]) {
    const slot=repo.listDraftSlots(expected.batchId).find(slot=>slot.index===expected.index)!;
    if(slot.status!=='SUCCEEDED')repo.updateDraftSlot(slot.batchId,slot.index,{status:'QUEUED',error:null});
  }
  if(frozen.pipeline) {
    const step=repo.getPatternPipelineStepByJobId(job.id)!,pipeline=repo.getPatternPipeline(frozen.pipeline.id)!;
    for(const downstream of pipeline.steps.filter(entry=>entry.position>step.position)) if(downstream.status==='CANCELLED')repo.updatePatternPipelineStep(downstream.id,{status:'PENDING',error:null});
    repo.updatePatternPipelineStep(step.id,{status:'QUEUED',error:null});repo.updatePatternPipeline(pipeline.id,{status:'RUNNING',blockReason:null});
  }
  const turnId=job.input.editTurnId??job.input.turnId;
  if(typeof turnId==='string') {
    const turn=repo.getEditTurn(turnId)!;
    if(turn.status!=='SUCCEEDED')repo.updateEditTurn(turnId,{status:job.type==='EDIT_PLAN'?'PLANNING':'GENERATING',error:null});
  }
  const plan=repo.getLayerPlanByJobId(job.id);if(plan&&plan.status!=='SUCCEEDED')repo.updateLayerPlan(plan.id,{status:'QUEUED',error:null});
  const layer=repo.getLayerExportByJobId(job.id);if(layer&&!layer.psdStoragePath)repo.updateLayerExport(layer.id,{status:'QUEUED',error:null});
  const pack=repo.getPrintPackByJobId(job.id);if(pack&&pack.status!=='SUCCEEDED')repo.updatePrintPack(pack.id,{status:'QUEUED',error:null});
  const archive=repo.getExportByJobId(job.id);if(archive&&archive.status!=='SUCCEEDED')repo.updateExport(archive.id,{status:'QUEUED'});
  new RuntimeStore(connection,context.clock).mutate(job.id,state=>{state.phase='READY';state.runToken=null;});
  return repo.updateJob(job.id,{status:'QUEUED',cancelRequested:false,error:null,progress:0})!;
}

/** B 的精确注册 API，可直接作为 createBackend 的 integrations.executors。 */
export const registerExecutors: RegisterExecutors = (_context): ExecutorMap => ({
  PLAN: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  COPYWRITE: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  GENERATE: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  EXPORT: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  EDIT_PLAN: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  EDIT_GENERATE: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  LAYER_PLAN: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  LAYER_EXPORT: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  SUITE_FORGE: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  MODEL_CAST: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  PATTERN_EXTRACT: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  PATTERN_FORGE: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  PATTERN_DERIVE: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  PATTERN_VARIANT: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  PATTERN_TILE_CHECK: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  PRINT_PACK: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  PATTERN_DRAFT_GENERATE: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  PATTERN_DRAFT_EDIT: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  PATTERN_DRAFT_CUTOUT: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
  PATTERN_DRAFT_PROCESS: {snapshotSchema:executionSnapshotSchema,execute:executeDomainJob,settle:settleDomainJob,retry:retryDomainJob,checkRetry:assertDomainRetryAllowed},
});
