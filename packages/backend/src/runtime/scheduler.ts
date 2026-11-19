import { Value } from '@sinclair/typebox/value';
import { parseJsonResponse } from '@ecomgen/agent';
import { EDIT_EXECUTION_MODES, EDIT_OPERATIONS, type ResponseReceipt } from '@ecomgen/domain';
import type { EcomRepository, JobRecord } from '@ecomgen/core';
import { BackendError, safeError } from '../validation.js';
import { hasStoryboardOutput } from '../execution/product-image-planning.js';
import { FrozenJobSnapshotSchema, RuntimeStore, type FrozenJobSnapshot, type JobRuntimeRecord } from './state.js';
import { RequestLedger } from './request-ledger.js';
import { EXECUTOR_TYPES, type CommandContext, type DomainExecutor, type ExecutionContext, type ExecutorMap, type ExecutorType, type JobTerminalStatus, type SchedulerPort } from './ports.js';

/** 唯一持久队列；enqueue 只安排下一次扫描，不另建内存任务队列。 */
export class PersistentScheduler implements SchedulerPort {
 private executors:Partial<ExecutorMap>={};
 private active=new Map<string,{controller:AbortController;done:Promise<void>}>();
 private scheduled:NodeJS.Immediate|undefined;
 private closing=false;
 private maintenance=false;
 private started=false;
 constructor(private readonly store:RuntimeStore,private readonly repository:EcomRepository,private readonly ledger:RequestLedger,
  private readonly context:()=>CommandContext,private concurrency=2) {
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>16)throw new BackendError('INVALID_OPTIONS','并发数量无效。');
 }
 get activeCount():number{return this.active.size;}
 setConcurrency(value:number):void {
  if(!Number.isInteger(value)||value<1||value>16)throw new BackendError('INVALID_OPTIONS','并发数量无效。');
  this.concurrency=value;this.wake();
 }
 /** 维护只暂停认领，不取消活动任务或修改持久任务状态。 */
 pauseForMaintenance():void {this.maintenance=true;if(this.scheduled){clearImmediate(this.scheduled);this.scheduled=undefined;}}
 resumeAfterMaintenance():void {this.maintenance=false;this.wake();}
 get hasPendingWork():boolean {return this.active.size>0||!!this.store.db.prepare("SELECT 1 FROM jobs WHERE preserved_history=0 AND status IN ('QUEUED','RUNNING') LIMIT 1").get();}
 register(executors:ExecutorMap):void {
  if(this.started)throw new BackendError('RUNTIME_STARTED','启动后不能替换执行器。');
  for(const type of EXECUTOR_TYPES)if(!executors[type]?.execute||!executors[type].snapshotSchema)throw new BackendError('EXECUTOR_REQUIRED',`缺少任务执行器：${type}`);
  for(const type of Object.keys(executors))if(!(EXECUTOR_TYPES as readonly string[]).includes(type))throw new BackendError('UNKNOWN_JOB_TYPE','任务类型未注册。');
  this.executors={...executors};
 }
 private executor(type:string):DomainExecutor {
  const definition=this.executors[type as ExecutorType];if(!definition)throw new BackendError('EXECUTOR_REQUIRED','任务执行器尚未接入。');return definition;
 }
 freeze(jobId:string,snapshot:FrozenJobSnapshot):void {
  if(this.closing)throw new BackendError('CLOSING','后台正在关闭。');
  const job=this.requireJob(jobId);
  if(job.status!=='QUEUED'||job.preservedHistory||job.type!==snapshot.type)throw new BackendError('INVALID_SNAPSHOT','任务不能执行此快照。');
  this.store.validate(FrozenJobSnapshotSchema,snapshot);const definition=this.executor(job.type);
  if(!Value.Check(definition.snapshotSchema,snapshot))throw new BackendError('INVALID_SNAPSHOT','任务有效输入不完整。');
  if(job.requestFingerprint){
   const existing=this.store.db.prepare("SELECT id,status FROM jobs WHERE id<>? AND project_id IS ? AND request_fingerprint=? AND status IN ('QUEUED','RUNNING','UNKNOWN') LIMIT 1").get(jobId,job.projectId,job.requestFingerprint) as {id:string;status:string}|undefined;
   if(existing)throw new BackendError(existing.status==='UNKNOWN'?'EXTERNAL_UNKNOWN':'JOB_CONFLICT',existing.status==='UNKNOWN'?'相同输入的任务已中断，请先重试或结束该任务。':'相同输入已有活动任务。');
  }
  this.store.create(jobId,structuredClone(snapshot));
  for(const resource of snapshot.resources)this.context().resources.retain(resource.ref,`job:${jobId}`);
 }
 enqueue(jobId:string):void {
  const job=this.requireJob(jobId),runtime=this.store.get(jobId);
  if(!runtime||runtime.phase!=='READY'||job.status!=='QUEUED'||job.preservedHistory)throw new BackendError('NOT_EXECUTABLE','任务尚未完成持久快照或不能重新入队。');
  this.executor(job.type);this.wake();
 }
 start():void {
  if(this.started)return;this.started=true;
  // 旧进程可能在并发请求尚未退出时结算；只规范化可信账本，损坏证据原样保留。
  for(const {id} of this.store.db.prepare("SELECT id FROM jobs WHERE preserved_history=0 AND status='UNKNOWN'").all() as {id:string}[]){
   try {const runtime=this.store.get(id);if(runtime?.phase==='SETTLED'&&runtime.requests.some(request=>request.state==='IN_FLIGHT'))this.store.transaction(()=>this.ledger.recover(id));}catch{/* 无法验证的旧证据不自动修复。 */}
  }
  // 不调用旧 recoverInterruptedJobs：它没有逐请求账本，也不能判断完整回执后的安全本地续跑。
  const ids=this.store.db.prepare("SELECT id FROM jobs WHERE preserved_history=0 AND status IN ('RUNNING','QUEUED') ORDER BY created_at,id").all() as {id:string}[];
  for(const {id}of ids)this.store.transaction(()=>{
   const job=this.requireJob(id);let runtime:JobRuntimeRecord|undefined;
   try{
    runtime=this.store.get(id);
    if(runtime&&(runtime.snapshot.jobId!==id||runtime.snapshot.type!==job.type||runtime.phase==='SETTLED'))throw new BackendError('INVALID_RUNTIME','运行记录与任务不一致。');
   }catch{
    this.quarantine(job,'INVALID_RUNTIME','运行记录无法验证，已保留原始历史。');return;
   }
   if(!runtime){this.quarantine(job,'SNAPSHOT_REQUIRED','历史任务缺少完整执行快照，不能自动执行。');return;}
   // 即使任务行仍为 QUEUED，已有未知窗口也不能经状态不一致绕过恢复屏障。
   const unknown=this.ledger.recover(id);
   if(unknown){this.finish(job,'UNKNOWN',this.store.get(id)!);return;}
   if(job.cancelRequested){this.finish(job,'CANCELLED',runtime);return;}
   if(job.status==='RUNNING'||runtime.phase!=='READY'){
    // 编辑/流水线的成功结算可能新建付费子任务，重启不能隐式授权这些后续请求。
    if(runtime.requests.length&&!this.supportsLocalReplay(job)){
     this.finish(job,'FAILED',runtime,new BackendError('REPLAY_REQUIRES_CONFIRMATION','已保留完整回执，请在原业务页面明确重试后继续。'));return;
    }
    this.repository.updateJob(id,{status:'QUEUED',progress:0});
    this.store.mutate(id,record=>{record.phase='READY';record.runToken=null;if(record.requests.length)record.replayOnly=true;});
    this.associations(job,'QUEUED',null);
   }
  });
  if(Object.keys(this.executors).length)this.wake();
 }
 private wake():void {
  if(this.closing||this.maintenance||!this.started||this.scheduled)return;
  this.scheduled=setImmediate(()=>{this.scheduled=undefined;this.pump();});
 }
 private pump():void {
  while(!this.closing&&!this.maintenance&&this.active.size<this.concurrency){
   const claimed=this.store.transaction(()=>{
    // 只有已冻结且 READY 的记录可以认领；未冻结意图不会抢占或卡住其他任务。
    const rows=this.store.db.prepare("SELECT j.id FROM jobs j JOIN desktop_job_runtime r ON r.job_id=j.id WHERE j.status='QUEUED' AND j.preserved_history=0 ORDER BY j.created_at,j.id").all() as {id:string}[];
    for(const {id}of rows){
     const job=this.requireJob(id),runtime=this.store.get(id);if(!runtime||runtime.phase!=='READY')continue;
     this.executor(job.type);
     if(job.cancelRequested){this.finish(job,'CANCELLED',runtime);continue;}
     // 同画面的修订只由首候选执行；其余候选等待持久结果，不占用执行槽位。
     const promptOwnerId = job.type === 'GENERATE' && typeof job.input.sharedPromptOwnerId === 'string' ? job.input.sharedPromptOwnerId : undefined;
     if (promptOwnerId && promptOwnerId !== job.id) {
      const owner = this.repository.getJob(promptOwnerId);
      if (!owner || owner.projectId !== job.projectId || owner.storyboardItemId !== job.storyboardItemId || owner.input.sharedPromptOwnerId !== owner.id) {
       this.finish(job,'FAILED',runtime,new BackendError('INVALID_DEPENDENCY','共享提示词的修订任务无效。'));continue;
      }
      if (!this.repository.getGenerationPrompt(promptOwnerId)) {
       if (owner.status === 'QUEUED' || owner.status === 'RUNNING') continue;
       this.finish(job,'FAILED',runtime,new BackendError('PROMPT_PREPARATION_FAILED','该画面的提示词修订尚未完成，请先重试修订任务，再重试此候选。'));continue;
      }
     }
     this.store.mutate(id,record=>{record.phase='EXECUTING';record.attempt++;record.runToken=this.context().idFactory();});
     this.repository.updateJob(id,{status:'RUNNING',progress:0,error:null});this.associations(job,'RUNNING',null);
     return {job:this.requireJob(id),runtime:this.store.get(id)!};
    }
    return undefined;
   });
   if(!claimed)break;
   const controller=new AbortController();
   // 先登记 active 再进入执行，允许同步查询/取消准确看见认领结果。
   const done=Promise.resolve().then(()=>this.execute(claimed.job,claimed.runtime,controller.signal)).finally(()=>{this.active.delete(claimed.job.id);this.wake();});
   this.active.set(claimed.job.id,{controller,done});this.changed(claimed.job);
  }
 }
 private async execute(job:JobRecord,runtime:JobRuntimeRecord,signal:AbortSignal):Promise<void> {
  const base=this.context(),definition=this.executor(job.type);
  const assertCurrent=()=>{
   const current=this.requireJob(job.id),state=this.store.get(job.id);
   if(current.status!=='RUNNING'||state?.phase!=='EXECUTING'||state.runToken!==runtime.runToken||state.attempt!==runtime.attempt)throw new BackendError('STALE_ATTEMPT','任务执行代次已失效。');
  };
  const context:ExecutionContext={...base,job,snapshot:deepFreeze(structuredClone(runtime.snapshot)),signal,attempt:runtime.attempt,
   external:this.ledger.forJob(job.id,signal,assertCurrent,runtime.replayOnly===true),assertCurrent,
   progress:(progress,detail)=>{
    assertCurrent();signal.throwIfAborted();if(!Number.isFinite(progress)||progress<0||progress>100)throw new BackendError('INVALID_PROGRESS','任务进度无效。');
    this.repository.updateJob(job.id,{progress,...(detail?{progressDetail:detail}:{})});this.changed(job);
   },
   checkpoint:callback=>base.transaction(()=>{assertCurrent();signal.throwIfAborted();if(this.requireJob(job.id).cancelRequested)throw new BackendError('CANCELLED','任务已取消。');return callback();}),
  };
  try{
   if(!Value.Check(definition.snapshotSchema,context.snapshot))throw new BackendError('INVALID_SNAPSHOT','执行快照校验失败。');
   for(const resource of context.snapshot.resources){const resolved=await base.resources.resolve(resource.ref);if(resolved.hash!==resource.hash)throw new BackendError('RESOURCE_CHANGED','冻结输入资源已变化。');}
   signal.throwIfAborted();assertCurrent();await definition.execute(context);
   base.transaction(()=>{assertCurrent();const current=this.requireJob(job.id);
    const status:JobTerminalStatus=this.ledger.hasUnknown(job.id)?'UNKNOWN':signal.aborted||current.cancelRequested?'CANCELLED':'SUCCEEDED';
    this.finish(current,status,this.store.get(job.id)!);
   });
  }catch(error){
   try{base.transaction(()=>{assertCurrent();const current=this.requireJob(job.id);const status:JobTerminalStatus=this.ledger.hasUnknown(job.id)?'UNKNOWN':signal.aborted||current.cancelRequested?'CANCELLED':'FAILED';this.finish(current,status,this.store.get(job.id)!,safeError(error));});}
   catch{
    // 领域结算钩子失败时不伪造成功；保留回执与产物，以便显式修复本地尾阶段。
    this.store.transaction(()=>{
     const current=this.repository.getJob(job.id),state=this.store.get(job.id);if(!current||current.status!=='RUNNING'||state?.runToken!==runtime.runToken)return;
     const status=this.ledger.hasUnknown(job.id)?'UNKNOWN':'FAILED';
     if(status==='UNKNOWN')this.ledger.recover(job.id);
     this.repository.updateJob(job.id,{status,retryable:status!=='UNKNOWN',error:{code:'SETTLEMENT_FAILED',message:'领域结算失败，已保留请求回执和产物。'}});
     this.store.mutate(job.id,record=>{record.phase='SETTLED';record.runToken=null;});
     this.associations(current,status,{code:'SETTLEMENT_FAILED',message:'领域结算失败。'});
    });
   }
  }finally{this.changed(job);}
 }
 /** 无法验证的持久证据不能降级成可重试失败；原 JSON 留存供人工核实。 */
 private quarantine(job:JobRecord,code:string,message:string):void {
  const status=job.status==='RUNNING'||job.providerTaskId?'UNKNOWN':'FAILED';
  const error={code:status==='UNKNOWN'?'EXTERNAL_UNKNOWN':code,message};
  this.repository.updateJob(job.id,{status,retryable:false,error});
  this.associations(job,status,error);
 }
 private finish(job:JobRecord,status:JobTerminalStatus,runtime:JobRuntimeRecord,error?:BackendError):void {
  // 终结后旧代次回执会被 fencing 拒绝；先把未完成请求纳入可核实的 UNKNOWN。
  if(status==='UNKNOWN'){this.ledger.recover(job.id);runtime=this.store.get(job.id)!;}
  const safe=status==='UNKNOWN'?{code:'EXTERNAL_UNKNOWN',message:'任务已中断，可选择重试或结束；应用不会自动重发。'}:status==='FAILED'?{code:error?.code??'EXECUTION_FAILED',message:error?.message??'任务执行失败。'}:null;
  this.repository.updateJob(job.id,{status,progress:status==='SUCCEEDED'?100:job.progress,retryable:error?.code!=='VERIFIED_EXTERNAL_FAILURE'&&(status==='FAILED'||status==='CANCELLED'),error:safe});
  this.associations(job,status,safe);
  const definition=this.executors[job.type as ExecutorType];
  const pipelineStep=this.repository.getPatternPipelineStepByJobId(job.id);
  if(status==='SUCCEEDED'&&pipelineStep&&!definition?.settle)throw new BackendError('DOMAIN_SETTLEMENT_REQUIRED','流水线缺少原子推进结算器。');
  const settlement:unknown=definition?.settle?.(this.context(),this.requireJob(job.id),status,runtime);
  if(settlement&&typeof (settlement as {then?:unknown}).then==='function'){
   void Promise.resolve(settlement).catch(()=>undefined);
   throw new BackendError('ASYNC_TRANSACTION','领域结算不能执行异步操作。');
  }
  if(status==='SUCCEEDED'&&pipelineStep&&this.repository.getPatternPipelineStepByJobId(job.id)?.status!=='SUCCEEDED')throw new BackendError('DOMAIN_SETTLEMENT_REQUIRED','流水线步骤未完成原子结算。');
  this.store.mutate(job.id,record=>{record.phase='SETTLED';record.runToken=null;});
 }
 /** 非成功状态及认领/恢复同步关联记录；成功推进依赖 D 的原子 settle 钩子。 */
 private associations(job:JobRecord,status:'QUEUED'|'RUNNING'|JobTerminalStatus,error:Record<string,unknown>|null):void {
  const repo=this.repository;
  if(job.type==='GENERATE'&&job.projectId&&job.storyboardItemId&&status==='CANCELLED'&&error?.code==='INTERRUPTED_ENDED'){
   const item=repo.getStoryboardItem(job.storyboardItemId);
   // 结束最后一个中断候选才解除画面忙碌；既有成图与其他活动候选不能被旧任务回退。
   const otherActive=repo.listJobs(job.projectId).some(other=>other.id!==job.id&&other.type==='GENERATE'&&other.storyboardItemId===job.storyboardItemId&&['QUEUED','RUNNING','UNKNOWN'].includes(other.status));
   if(item?.projectId===job.projectId&&item.status==='GENERATING'&&!otherActive)repo.updateStoryboardItem(item.id,{status:hasStoryboardOutput(repo,item)?'GENERATED':'CONFIRMED'});
  }
  const plan=repo.getLayerPlanByJobId(job.id);if(plan&&plan.status!=='SUCCEEDED')repo.updateLayerPlan(plan.id,{status:status as typeof plan.status,error});
  const layer=repo.getLayerExportByJobId(job.id);if(layer&&layer.status!=='SUCCEEDED'&&!layer.psdStoragePath)repo.updateLayerExport(layer.id,{status:status as typeof layer.status,error});
  const pack=repo.getPrintPackByJobId(job.id);if(pack&&pack.status!=='SUCCEEDED')repo.updatePrintPack(pack.id,{status:status as typeof pack.status,error});
  const archive=repo.getExportByJobId(job.id);if(archive&&archive.status!=='SUCCEEDED')repo.updateExport(archive.id,{status});
  const verifiedFailure=(status==='FAILED'&&['VERIFIED_EXTERNAL_FAILURE','INTERRUPTED_RETRY'].includes(String(error?.code)))||(status==='CANCELLED'&&error?.code==='INTERRUPTED_ENDED');
  for(const slot of repo.listDraftSlotsByJobId(job.id))if(slot.status!=='SUCCEEDED'&&(slot.status!=='UNKNOWN'||verifiedFailure))repo.updateDraftSlot(slot.batchId,slot.index,{status,error});
  const turnId=typeof job.input.editTurnId==='string'?job.input.editTurnId:typeof job.input.turnId==='string'?job.input.turnId:undefined;
  if(turnId&&status!=='SUCCEEDED'){
   const reassigned=error?.code==='INTERRUPTED_ENDED'&&job.projectId&&repo.listJobs(job.projectId).some(other=>other.id!==job.id&&(other.input.editTurnId??other.input.turnId)===turnId&&['QUEUED','RUNNING','UNKNOWN'].includes(other.status));
   const turn=repo.getEditTurn(turnId);if(!reassigned&&turn&&turn.status!=='SUCCEEDED'&&(turn.status!=='UNKNOWN'||verifiedFailure))repo.updateEditTurn(turnId,{status:status==='QUEUED'||status==='RUNNING'?job.type==='EDIT_PLAN'?'PLANNING':'GENERATING':status,error});
  }
  const step=repo.getPatternPipelineStepByJobId(job.id);
  if(step&&step.status!=='SUCCEEDED'&&status!=='SUCCEEDED'){
   const pipeline=repo.getPatternPipeline(step.pipelineId);
   // jobId 反查与 runtime token 共同隔离旧步骤/新代次，不会迟到推进新流水线。
   if(pipeline&&pipeline.status!=='SUCCEEDED'){
    repo.updatePatternPipelineStep(step.id,{status,error});
    if(error?.code==='INTERRUPTED_ENDED'&&pipeline.steps.some(other=>other.id!==step.id&&['QUEUED','RUNNING','UNKNOWN'].includes(other.status)))return;
    repo.updatePatternPipeline(step.pipelineId,status==='UNKNOWN'
     ?{status:'AWAITING_INPUT',blockReason:'EXTERNAL_RESULT_UNKNOWN'}
     :{status:status==='QUEUED'||status==='RUNNING'?'RUNNING':status,blockReason:null});
    if(status==='CANCELLED')for(const downstream of pipeline.steps)if(downstream.position>step.position&&downstream.status==='PENDING')repo.updatePatternPipelineStep(downstream.id,{status:'CANCELLED',error:null});
   }
  }
 }
 private supportsLocalReplay(job:JobRecord):boolean {
  return ['PLAN','COPYWRITE','GENERATE','SUITE_FORGE','MODEL_CAST'].includes(job.type)&&!this.repository.getPatternPipelineStepByJobId(job.id);
 }
 /** 只允许不会自动创建付费后续任务的本地尾阶段恢复。 */
 localRecovery(jobId:string):{available:boolean;reason:string} {
  const job=this.requireJob(jobId),action=this.actions(jobId).retry;
  if(!action.available)return {available:false,reason:action.reason??'任务当前不可恢复。'};
  if(!this.supportsLocalReplay(job))return {available:false,reason:'此流程可能创建后续任务，请在对应业务页面明确处理。'};
  const runtime=this.store.get(job.id)!;
  if(!runtime.requests.length||runtime.requests.some(request=>request.state!=='COMPLETED'))return {available:false,reason:'没有可验证的完整回执，无法进行本地恢复。'};
  try {
   const scope=this.ledger.forJob(job.id,new AbortController().signal);
   for(const request of runtime.requests)if(!scope.receipt(request.descriptor.requestKey))throw new Error('missing');
  }catch{return {available:false,reason:'完整回执无法验证，不能进行本地恢复。'};}
  return {available:true,reason:'只重放已保存回执；需要新的模型请求时将停止，并保留已恢复结果。'};
 }
 recoverLocally(jobId:string):JobRecord {
  const capability=this.localRecovery(jobId);
  if(!capability.available)throw new BackendError('RECOVERY_UNAVAILABLE',capability.reason);
  return this.retry(jobId,true);
 }
 /** 查询与显式重试共用只读领域检查，不能用试执行模拟能力。 */
 actions(jobId:string):{cancel:{available:boolean;reason:string|null};retry:{available:boolean;reason:string|null};end:{available:boolean;reason:string|null}} {
  const job=this.requireJob(jobId);
  const canCancel=!job.preservedHistory&&['QUEUED','RUNNING'].includes(job.status)&&!job.cancelRequested;
  let reason:string|null=null;
  if(job.preservedHistory)reason='历史任务只读。';
  else if(job.status==='UNKNOWN'){
   try {this.checkInterruption(job,[]);}catch(error){reason=error instanceof BackendError?error.message:'中断任务无法验证。';}
  }
  else if(!['FAILED','CANCELLED'].includes(job.status)||!job.retryable)reason='当前状态不允许重试。';
  else if(this.active.has(jobId))reason='任务仍在退出。';
  else {
   try {
    const runtime=this.store.get(jobId);
    if(!runtime||this.ledger.hasUnknown(jobId))reason='缺少执行快照或任务仍处于中断状态。';
    else {
     const definition=this.executor(job.type);
     if(definition.retry) {
      if(definition.checkRetry)definition.checkRetry(this.context(),job,runtime);
      else reason='此任务缺少领域重试前置检查，请回到原业务页面处理。';
     } else if(this.repository.getPatternPipelineStepByJobId(jobId)||this.repository.listDraftSlotsByJobId(jobId).length||['EDIT_PLAN','EDIT_GENERATE'].includes(job.type))reason='请使用对应领域的重试操作。';
    }
   }catch(error){reason=error instanceof BackendError?error.message:'关联记录无法验证，请回到原业务页面处理。';}
  }
  let endReason:string|null=null;
  try {this.checkInterruption(job,[],false);}catch(error){endReason=error instanceof BackendError?error.message:'中断任务无法验证。';}
  return {cancel:{available:canCancel,reason:canCancel?null:'任务已结束、正在取消或属于只读历史。'},retry:{available:reason===null,reason},end:{available:endReason===null,reason:endReason}};
 }
 private checkInterruption(job:JobRecord,cohort:readonly string[],forRetry=true):JobRuntimeRecord {
  if(job.preservedHistory||job.status!=='UNKNOWN'||this.active.has(job.id))throw new BackendError('INTERRUPTION_UNAVAILABLE','任务不是可处理的中断状态，或仍在退出。');
  const runtime=this.store.get(job.id);
  if(!runtime||runtime.phase!=='SETTLED'||runtime.runToken!==null||runtime.snapshot.jobId!==job.id||runtime.snapshot.type!==job.type||!runtime.requests.some(request=>request.state==='UNKNOWN')||runtime.requests.some(request=>request.state==='IN_FLIGHT'))throw new BackendError('INVALID_RUNTIME','中断任务的快照或请求记录无法验证。');
  const definition=this.executor(job.type);
  if(!Value.Check(definition.snapshotSchema,runtime.snapshot))throw new BackendError('INVALID_SNAPSHOT','任务有效输入不完整。');
  if(new Set(runtime.requests.map(request=>request.descriptor.requestKey)).size!==runtime.requests.length)throw new BackendError('INVALID_RUNTIME','当前请求标识重复，无法验证中断记录。');
  const receipts=this.ledger.forJob(job.id,new AbortController().signal);
  for(const request of runtime.requests)if(request.state==='COMPLETED'&&!receipts.receipt(request.descriptor.requestKey))throw new BackendError('INVALID_RECEIPT','完整回执无法验证。');
  // 结束不会执行快照或创建新工作；重试专用的项目/后续任务检查不能阻止本地结束。
  if(!forRetry)return runtime;
  if(definition.checkRetry){
   definition.checkRetry({...this.context(),interruptionRetry:{jobId:job.id,cohort}},{...job,status:'FAILED',retryable:true},runtime);
  }else if(definition.retry||this.repository.getPatternPipelineStepByJobId(job.id)||this.repository.listDraftSlotsByJobId(job.id).length||['EDIT_PLAN','EDIT_GENERATE'].includes(job.type))throw new BackendError('DOMAIN_RETRY_REQUIRED','任务关联无法验证。');
  return runtime;
 }
 /** 用户明确选择后，归档未知请求，保留完整回执；整个状态转换由同一事务保护。 */
 private resolveOne(jobId:string,action:'RETRY'|'END',cohort:readonly string[]=[]):JobRecord {
  return this.context().transaction(()=>{
   const job=this.requireJob(jobId);
   if(action==='RETRY'&&job.status==='FAILED')return this.retry(jobId,false,cohort);
   const runtime=this.checkInterruption(job,cohort,action==='RETRY');
   this.store.mutate(jobId,state=>{
    const unknown=state.requests.filter(request=>request.state==='UNKNOWN');
    (state.requestHistory??=[]).push(...unknown);
    state.requests=state.requests.filter(request=>request.state!=='UNKNOWN');
    (state.interruptions??=[]).push({action,recordedAt:this.context().clock(),attempt:runtime.attempt,requests:unknown.map(request=>({requestKey:request.descriptor.requestKey,startedAt:request.startedAt,...(request.usageKey?{usageKey:request.usageKey}:{})}))});
   });
   const code=action==='RETRY'?'INTERRUPTED_RETRY':'INTERRUPTED_ENDED';
   const error={code,message:action==='RETRY'?'中断任务已由用户选择重试。':'中断任务已由用户结束。'};
   this.repository.updateJob(jobId,{status:action==='RETRY'?'FAILED':'CANCELLED',retryable:false,error});
   this.associations(job,action==='RETRY'?'FAILED':'CANCELLED',error);
   if(action==='RETRY'){
    this.repository.updateJob(jobId,{retryable:true});
    return this.retry(jobId,false,cohort);
   }
   return this.requireJob(jobId);
  });
 }
 resolveInterruptions(input:{jobId:string;action:'RETRY'|'END'}|{projectId:string;action:'RETRY'|'END'}|{jobIds:readonly string[];action:'RETRY'|'END'}):{items:Array<{jobId:string;status:'RETRIED'|'ENDED'|'SKIPPED'|'FAILED';reason:string|null}>} {
  const ids='jobId' in input?[input.jobId]:'jobIds' in input?[...new Set(input.jobIds)]:(this.store.db.prepare("SELECT id FROM jobs WHERE project_id=? AND preserved_history=0 AND (status='UNKNOWN' OR (?='RETRY' AND status='FAILED' AND retryable=1)) ORDER BY created_at,id").all(input.projectId,input.action) as {id:string}[]).map(row=>row.id);
  const items:Array<{jobId:string;status:'RETRIED'|'ENDED'|'SKIPPED'|'FAILED';reason:string|null}>=[];
  // 只恢复显式选中的既有意图；同画面候选必须属于同一批次且稳定序号不同。
  const candidates=!('jobId' in input)&&input.action==='RETRY'?ids.map(id=>this.requireJob(id)).filter(job=>job.type==='GENERATE'&&job.storyboardItemId&&job.requestFingerprint):[];
  const cohort=candidates.filter(job=>candidates.filter(other=>other.requestFingerprint===job.requestFingerprint).length===1&&candidates.filter(other=>other.id!==job.id&&other.storyboardItemId===job.storyboardItemId).every(other=>typeof job.input.generationBatchId==='string'&&job.input.generationBatchId===other.input.generationBatchId&&Number.isInteger(job.input.candidateIndex)&&Number.isInteger(other.input.candidateIndex)&&job.input.candidateIndex!==other.input.candidateIndex)).map(job=>job.id);
  if(cohort.length>1){
   const ready:string[]=[];
   for(const id of cohort){
    try {
     const job=this.requireJob(id);
     if(job.status==='UNKNOWN')this.checkInterruption(job,cohort);
     else {
      const runtime=this.store.get(id),definition=this.executor(job.type);
      if(this.active.has(id)||!runtime||runtime.phase!=='SETTLED'||!definition.checkRetry)throw new BackendError('RETRY_UNSAFE','批次任务无法验证。');
      definition.checkRetry({...this.context(),interruptionRetry:{jobId:id,cohort}},job,runtime);
     }
     ready.push(id);
    }catch(error){items.push({jobId:id,status:'FAILED',reason:error instanceof BackendError?error.message:'任务未通过重试检查。'});}
   }
   try {
    this.context().transaction(()=>{for(const id of ready)this.resolveOne(id,'RETRY',cohort);});
    for(const id of ready){this.changed(this.requireJob(id));items.push({jobId:id,status:'RETRIED',reason:null});}
   }catch(error){for(const id of ready)items.push({jobId:id,status:'FAILED',reason:error instanceof BackendError?error.message:'批量重试未通过检查。'});}
  }
  for(const jobId of ids){
   if(cohort.length>1&&cohort.includes(jobId))continue;
   try {const job=this.requireJob(jobId);if(job.preservedHistory||(job.status!=='UNKNOWN'&&!(input.action==='RETRY'&&job.status==='FAILED'&&job.retryable))){items.push({jobId,status:'SKIPPED',reason:'任务当前不可处理。'});continue;}
    const result=this.resolveOne(jobId,input.action);this.changed(result);items.push({jobId,status:input.action==='RETRY'?'RETRIED':'ENDED',reason:null});
   }catch(error){items.push({jobId,status:'FAILED',reason:error instanceof BackendError?error.message:'任务处理失败。'});}
  }
  return {items};
 }
 cancel(jobId:string):JobRecord {
  const result=this.context().transaction(()=>{
   const job=this.requireJob(jobId);if(['SUCCEEDED','FAILED','CANCELLED','UNKNOWN'].includes(job.status))return job;
   this.repository.updateJob(jobId,{cancelRequested:true});
   if(job.status==='QUEUED'){
    const runtime=this.store.get(jobId);if(runtime)this.finish(this.requireJob(jobId),this.ledger.hasUnknown(jobId)?'UNKNOWN':'CANCELLED',runtime);
    else this.repository.updateJob(jobId,{status:'CANCELLED',retryable:false});
   }
   return this.requireJob(jobId);
  });
  this.active.get(jobId)?.controller.abort(new BackendError('CANCELLED','任务已取消。'));this.changed(result);return result;
 }
 retry(jobId:string,replayOnly=false,cohort:readonly string[]=[]):JobRecord {
  const result=this.context().transaction(()=>{
   const job=this.requireJob(jobId);const runtime=this.store.get(jobId);
   if(job.preservedHistory||!runtime||!job.retryable||!['FAILED','CANCELLED'].includes(job.status)||this.ledger.hasUnknown(jobId))throw new BackendError('RETRY_UNSAFE','此任务不能直接重试，请先处理其中断状态。');
   if(this.active.has(jobId))throw new BackendError('TASK_ACTIVE','任务仍在退出。');
   const definition=this.executor(job.type);
   // 旧版将规划校验错误折叠为 INTERNAL_ERROR；仅在完整回执明确证明枚举无效时兼容。
   let rejectEditPlan=['EDIT_PLAN_INVALID','EDIT_PLAN_EMPTY','EDIT_PLAN_MASK_REQUIRED'].includes(String(job.error?.code));
   if(!replayOnly&&job.type==='EDIT_PLAN'&&job.status==='FAILED'&&job.error?.code==='INTERNAL_ERROR'&&runtime.requests.length===1){
    const request=runtime.requests[0]!;
    if(request.state==='COMPLETED'&&request.localState==='PENDING'&&request.descriptor.purpose==='MODEL'){
     try {const receipt=this.ledger.forJob(jobId,new AbortController().signal).receipt(request.descriptor.requestKey);rejectEditPlan=!!receipt&&legacyInvalidEditPlan(receipt);}catch{/* 无法验证的回执原样保留。 */}
    }
   }
   if(!replayOnly&&job.type==='EDIT_PLAN'&&job.status==='FAILED'&&rejectEditPlan){
    this.store.mutate(jobId,state=>{
     const rejected=state.requests.filter(request=>request.state==='COMPLETED'&&request.localState==='PENDING'&&request.descriptor.purpose==='MODEL');
     (state.requestHistory??=[]).push(...rejected.map(request=>({...request,rejectedEditPlan:true})));
     state.requests=state.requests.filter(request=>!rejected.includes(request));
    });
   }
   if(definition.retry){
    const retryContext=cohort.length?{...this.context(),interruptionRetry:{jobId,cohort}}:this.context();
    const retried=definition.retry(retryContext,job,runtime),state=this.store.get(retried.id),stored=this.requireJob(retried.id);
    if(!state)throw new BackendError('SNAPSHOT_REQUIRED','重试任务缺少快照。');
    if(stored.status!=='QUEUED'||stored.preservedHistory||state.phase!=='READY'||this.ledger.hasUnknown(stored.id))throw new BackendError('RETRY_UNSAFE','领域重试未创建安全的排队意图。');
    this.store.mutate(stored.id,record=>{record.replayOnly=replayOnly;});
    return stored;
   }
   if(this.repository.getPatternPipelineStepByJobId(jobId)||this.repository.listDraftSlotsByJobId(jobId).length||['EDIT_PLAN','EDIT_GENERATE'].includes(job.type))throw new BackendError('DOMAIN_RETRY_REQUIRED','请使用对应领域的重试操作。');
   this.repository.updateJob(jobId,{status:'QUEUED',cancelRequested:false,error:null,progress:0});
   this.store.mutate(jobId,record=>{record.phase='READY';record.runToken=null;record.replayOnly=replayOnly;});this.associations(job,'QUEUED',null);
   return this.requireJob(jobId);
  });
  this.enqueue(result.id);this.changed(result);return result;
 }
 async waitForIdle(jobIds:readonly string[]):Promise<void> { await Promise.all(jobIds.map(id=>this.active.get(id)?.done)); }
 async close():Promise<void> {
  if(this.closing){await Promise.all([...this.active.values()].map(value=>value.done));return;}
  this.closing=true;if(this.scheduled){clearImmediate(this.scheduled);this.scheduled=undefined;}
  for(const {controller}of this.active.values())controller.abort(new BackendError('CLOSING','后台正在关闭。'));
  await Promise.all([...this.active.values()].map(value=>value.done));
 }
 private requireJob(id:string):JobRecord {const job=this.repository.getJob(id);if(!job)throw new BackendError('NOT_FOUND','任务不存在。');return job;}
 private changed(job:JobRecord):void {this.context().events.publish({topic:'jobs',aggregateId:job.id,...(job.projectId?{projectId:job.projectId}:{})});}
}
// 只识别可完整解析的 OpenAI chat SSE；其他协议、截断和非枚举错误保留原回执。
function legacyInvalidEditPlan(receipt:ResponseReceipt):boolean {
 if(receipt.status!==200||!receipt.headers.some(([name,value])=>name.toLowerCase()==='content-type'&&value.toLowerCase().includes('text/event-stream')))return false;
 try {
  const events=Buffer.from(receipt.bodyBase64,'base64').toString('utf8').split(/\r?\n\r?\n/).filter(Boolean);
  let text='',done=false,stopped=false;
  for(const event of events){
   const lines=event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart());
   if(lines.length!==1||done)return false;
   if(lines[0]==='[DONE]'){done=true;continue;}
   const value=JSON.parse(lines[0]!) as {usage?:unknown;choices?:Array<{index?:number;delta?:{content?:unknown;tool_calls?:unknown};finish_reason?:unknown}>};
   // OpenAI 可在 stop 后单独发送 choices=[] 的用量块；它不改变已完成的模型文本。
   if(stopped&&Array.isArray(value.choices)&&value.choices.length===0&&value.usage&&typeof value.usage==='object')continue;
   if(!Array.isArray(value.choices)||value.choices.length!==1)return false;
   const choice=value.choices[0]!;
   if(choice.index!==0||choice.delta?.tool_calls||stopped)return false;
   if(choice.delta?.content!=null){if(typeof choice.delta.content!=='string')return false;text+=choice.delta.content;}
   if(choice.finish_reason!=null){if(choice.finish_reason!=='stop')return false;stopped=true;}
  }
  if(!done||!stopped)return false;
  const plan=parseJsonResponse(text) as {operation?:unknown;executionMode?:unknown}|null;
  if(!plan||typeof plan!=='object'||Array.isArray(plan))return false;
  return (typeof plan.operation==='string'&&!EDIT_OPERATIONS.some(value=>value===plan.operation))||(typeof plan.executionMode==='string'&&!EDIT_EXECUTION_MODES.some(value=>value===plan.executionMode));
 }catch{return false;}
}
function deepFreeze<T>(value:T):T {if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}return value;}
