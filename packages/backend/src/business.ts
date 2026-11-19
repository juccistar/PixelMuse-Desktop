import type { JobRecord } from '@ecomgen/core';
import type { CopywritingTarget } from '@ecomgen/domain';
import type { CommandContext, CommandHandlers } from './runtime/ports.js';
import type { RuntimeStore } from './runtime/state.js';
import { BackendError } from './validation.js';
import { DesktopHistoryResources } from './runtime/history.js';
import { createTaskHistoryCommands } from './runtime/task-history.js';
import { publicTaskError } from './public-task-error.js';
/** 运行时查询使用公开投影；原始输入、密文和 Provider 回执只留 Backend。 */
export function publicJob(job:JobRecord) {
 const target = job.type === 'COPYWRITE' ? job.input?.target : undefined;
 const copywritingTarget: CopywritingTarget | undefined = target === 'PRODUCT_DESCRIPTION' || target === 'PLANNING_INSTRUCTION' || target === 'LISTING' ? target : undefined;
 return {id:job.id,projectId:job.projectId,storyboardItemId:job.storyboardItemId,type:job.type,...(copywritingTarget ? {copywritingTarget} : {}),status:job.status,progress:Math.round(job.progress),retryable:job.retryable,
  requestFingerprint:job.requestFingerprint,providerId:job.providerId,modelId:job.modelId,cancelRequested:job.cancelRequested,estimatedCost:job.estimatedCost,actualCost:job.actualCost,
  error:publicTaskError(job.error,job.status),
  progressDetail:job.progressDetail&&typeof job.progressDetail.shotsGenerated==='number'&&(job.progressDetail.shotsTarget===null||typeof job.progressDetail.shotsTarget==='number')?{shotsGenerated:job.progressDetail.shotsGenerated,shotsTarget:job.progressDetail.shotsTarget}:null,
  createdAt:job.createdAt,updatedAt:job.updatedAt};
}
/** 运行时任务查询附带只读历史；领域命令与执行器共享同一仓库。 */
export function createRuntimeCommands(context:CommandContext,store:RuntimeStore,version:string,activeCount:()=>number):CommandHandlers {
 const requireJob=(id:string)=>{const job=context.repository.getJob(id);if(!job)throw new BackendError('NOT_FOUND','任务不存在。');return job;};
 const history=new DesktopHistoryResources(context);
 const projectJob=async(job:JobRecord)=>{const preserved=await history.project(job);return {...publicJob(job),...(preserved?{history:preserved}:{})};};
 return {
  ...createTaskHistoryCommands(context,store),
  getHealth:()=>({status:'ready',version,activeJobs:activeCount(),webResearchAvailable:context.repository.listSearchSources().some(source=>source.enabled)}),
  getJob:(_ctx,input)=>projectJob(requireJob(input.jobId)),
  cancelJob:(_ctx,input)=>publicJob(context.scheduler.cancel(input.jobId)),
  retryJob:(_ctx,input)=>publicJob(context.scheduler.retry(input.jobId)),
  listJobs:async(_ctx,input)=>{
   const where:string[]=[],values:unknown[]=[];
   if(input.projectId!==undefined){where.push('project_id IS ?');values.push(input.projectId);}
   if(input.type){where.push('type=?');values.push(input.type);}
   const rows=store.db.prepare(`SELECT id FROM jobs ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...values,input.limit??100) as {id:string}[];
   const items=[];for(const row of rows)items.push(await projectJob(requireJob(row.id)));
   return {items};
  },
  getJobRequests:(_ctx,input)=>{requireJob(input.jobId);return {items:context.requestLedger.summaries(input.jobId)};},
  getJobActions:(_ctx,input)=>context.scheduler.actions(input.jobId),
  getJobRecovery:(_ctx,input)=>{
   const recovery=context.scheduler.localRecovery(input.jobId);
   return {canRecover:recovery.available,recoveryReason:recovery.reason};
  },
  resolveJobInterruptions:(_ctx,input)=>context.scheduler.resolveInterruptions(input),
  recoverJobLocally:(_ctx,input)=>publicJob(context.scheduler.recoverLocally(input.jobId)),
  getResource:async(_ctx,input)=>{const resolved=await context.resources.resolve(input.ref);return {ref:input.ref,mimeType:resolved.mimeType};},
 };
}
