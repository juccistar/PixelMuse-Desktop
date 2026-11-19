import { createHash } from 'node:crypto';
import type { SecretBox } from '@ecomgen/core';
import { RequestDescriptorSchema, ResponseReceiptSchema, type ExternalRequestScope, type RequestDescriptor, type ResponseReceipt } from '@ecomgen/domain';
import { BackendError } from '../validation.js';
import { RuntimeStore, type RequestRecord } from './state.js';
import type { RequestLedgerPort } from './ports.js';
import { UsageStore, notifyUsage } from './usage-store.js';
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const MAX_RESPONSE_BYTES=96*1024*1024;
/** 一份任务运行 JSON 中逐请求记账，回执与本地提交分开，绝不自动重发未知请求。 */
export class RequestLedger implements RequestLedgerPort {
 private readonly usage:UsageStore;
 constructor(private readonly store:RuntimeStore,private readonly secrets:Pick<SecretBox,'encrypt'|'decrypt'>,private readonly network:typeof fetch=fetch,private readonly onUsageChange?:()=>void){this.usage=new UsageStore(store.db);}
 private notify(jobId:string):void {
  if(!this.onUsageChange)return;
  try{
   const state=()=>JSON.stringify(this.store.db.prepare('SELECT entry_json FROM desktop_usage_records WHERE job_id=? ORDER BY request_key').all(jobId));
   const expected=this.store.db.inTransaction?state():undefined;
   notifyUsage(this.store.db,this.onUsageChange,expected===undefined?undefined:()=>state()===expected);
  }catch{/* 通知快照失败也不能改变付费调用行为。 */}
 }
 private recordCompletion(jobId:string,request:RequestRecord,receipt:ResponseReceipt):void {
  try{
   const existing=this.usage.get(jobId,request.usageKey ?? request.descriptor.requestKey);
   if(existing?.state==='COMPLETED')return;
   const before=JSON.stringify(existing);
   this.usage.complete(jobId,request,receipt);
   if(before!==JSON.stringify(this.usage.get(jobId,request.usageKey ?? request.descriptor.requestKey)))this.notify(jobId);
  }catch{/* 下次有界回填可修复；不能改变可靠回执或触发重发。 */}
 }
 hasUnknown(jobId:string):boolean {return this.store.get(jobId)?.requests.some(request=>request.state==='UNKNOWN'||request.state==='IN_FLIGHT')??false;}
 summaries(jobId:string){return (this.store.get(jobId)?.requests??[]).map(request=>({requestKey:request.descriptor.requestKey,state:request.state==='VERIFIED_FAILED'?'UNKNOWN' as const:request.state,localState:request.localState}));}
 recover(jobId:string):boolean {
  let changed=false;
  const result=this.store.mutate(jobId,record=>{for(const request of record.requests)if(request.state==='IN_FLIGHT'){request.state='UNKNOWN';this.usage.unknown(jobId,request.usageKey ?? request.descriptor.requestKey);changed=true;}return record.requests.some(request=>request.state==='UNKNOWN');});
  if(changed)this.notify(jobId);return result;
 }
 forJob(jobId:string,signal:AbortSignal,assertCurrent:()=>void=()=>undefined,replayOnly=false):ExternalRequestScope {
  const find=(key:string)=>this.store.get(jobId)?.requests.find(request=>request.descriptor.requestKey===key);
  const read=(record:RequestRecord|undefined):ResponseReceipt|null=>{
   if(!record||record.state!=='COMPLETED')return null;
   if(!record.encryptedReceipt)throw new BackendError('INVALID_RECEIPT','请求回执不完整。');
   let plain:string;try{plain=this.secrets.decrypt(record.encryptedReceipt);}catch{throw new BackendError('INVALID_RECEIPT','请求回执无法验证。');}
   if(digest(plain)!==record.responseHash)throw new BackendError('INVALID_RECEIPT','请求回执无法验证。');
   return this.store.decode(ResponseReceiptSchema,plain);
  };
  const mutate=(key:string,update:(record:RequestRecord)=>void)=>{
   assertCurrent();this.store.mutate(jobId,record=>{const request=record.requests.find(value=>value.descriptor.requestKey===key);if(!request)throw new BackendError('REQUEST_NOT_STARTED','请求尚未登记。');update(request);
    if(record.requests.every(value=>value.state==='COMPLETED'))this.store.db.prepare('UPDATE jobs SET provider_task_id=NULL WHERE id=?').run(jobId);
   });
  };
  const response=(receipt:ResponseReceipt)=>new Response([101,103,204,205,304].includes(receipt.status)?null:Buffer.from(receipt.bodyBase64,'base64'),{status:receipt.status,headers:receipt.headers});
  const scope:ExternalRequestScope={
   jobId,signal,
   begin:descriptor=>{
    signal.throwIfAborted();assertCurrent();this.store.validate(RequestDescriptorSchema,descriptor);
    // 内层 SAVEPOINT 不等于持久提交；在外层事务提交前绝不能发出付费请求。
    if(this.store.db.inTransaction)throw new BackendError('EXTERNAL_TRANSACTION','外部请求必须在业务事务提交后发送。');
    let replay:ResponseReceipt|null=null,replayed:RequestRecord|undefined;
    this.store.mutate(jobId,record=>{
     const existing=record.requests.find(request=>request.descriptor.requestKey===descriptor.requestKey);
     if(existing){
      if(existing.descriptor.fingerprint!==descriptor.fingerprint||existing.descriptor.purpose!==descriptor.purpose||existing.descriptor.model?.providerId!==descriptor.model?.providerId||existing.descriptor.model?.modelId!==descriptor.model?.modelId)throw new BackendError('REQUEST_CONFLICT','请求键与已冻结输入不一致。');
      if(existing.state!=='COMPLETED')throw new BackendError('EXTERNAL_UNKNOWN','外部请求结果未知，禁止自动重发。');
      replay=read(existing);replayed=existing;return;
     }
     // 中断后的本地恢复不能隐式继续多阶段网络调用。
     if(replayOnly)throw new BackendError('REPLAY_ONLY','本地恢复缺少完整回执，禁止发送新请求。');
     // 一个任务中的未知窗口不能经更换请求键绕过，候选/草稿补偿也受同一检查保护。
     if(record.requests.some(request=>request.state==='UNKNOWN'))throw new BackendError('EXTERNAL_UNKNOWN','任务有中断请求，请先重试或结束该任务。');
     const historical=(record.requestHistory??[]).filter(request=>request.descriptor.requestKey===descriptor.requestKey);
     // 已归档的未知请求仍绑定原输入，不能换模型或指纹绕开冻结意图。
     if(historical.some(request=>(request.descriptor.fingerprint!==descriptor.fingerprint&&!(request.state==='COMPLETED'&&request.rejectedEditPlan===true&&record.snapshot.type==='EDIT_PLAN'))||request.descriptor.purpose!==descriptor.purpose||request.descriptor.model?.providerId!==descriptor.model?.providerId||request.descriptor.model?.modelId!==descriptor.model?.modelId))throw new BackendError('REQUEST_CONFLICT','请求键与原冻结输入不一致。');
     const request:RequestRecord={descriptor:structuredClone(descriptor),state:'IN_FLIGHT',localState:'PENDING',startedAt:this.store.clock(),...(historical.length?{usageKey:`interruption-retry:${digest(JSON.stringify([descriptor.requestKey,historical.length]))}`}:{})};
     record.requests.push(request);
     // 计量快照与发送标记必须原子提交，失败时仍不会发出网络请求。
     this.usage.begin(jobId,request,record.snapshot);
     this.store.db.prepare('UPDATE jobs SET provider_task_id=? WHERE id=?').run('__EXTERNAL_REQUEST_STARTED__',jobId);
    });
    if(replayed&&replay)this.recordCompletion(jobId,replayed,replay);
    else this.notify(jobId);
    return {replay};
   },
   complete:(key,receipt)=>{
    this.store.validate(ResponseReceiptSchema,receipt);
    const plain=JSON.stringify(receipt),hash=digest(plain),encrypted=this.secrets.encrypt(plain);
    let completed:RequestRecord|undefined;
    mutate(key,request=>{
     completed=request;
     if(request.state==='COMPLETED'){
      if(request.responseHash!==hash)throw new BackendError('RECEIPT_CONFLICT','不能覆盖已保存的响应。');return;
     }
     // 收到可靠的完整迟到回执可收敛 UNKNOWN；不会重新发送网络请求。
     request.state='COMPLETED';request.encryptedReceipt=encrypted;request.responseHash=hash;request.completedAt=this.store.clock();
    });
    // 完整加密回执已提交后才提取计量。统计异常不得使可靠回执失效或触发重发。
    if(completed)this.recordCompletion(jobId,completed,receipt);
   },
   unknown:key=>{
    let changed=false;
    mutate(key,request=>{if(request.state!=='COMPLETED'){const usageKey=request.usageKey??key;changed=this.usage.get(jobId,usageKey)?.state!=='UNKNOWN';request.state='UNKNOWN';this.usage.unknown(jobId,usageKey);}});
    if(changed)this.notify(jobId);
   },
   committed:key=>mutate(key,request=>{if(request.state!=='COMPLETED')throw new BackendError('EXTERNAL_UNKNOWN','回执不完整，不能提交本地产物。');request.localState='COMMITTED';}),
   receipt:key=>read(find(key)),
   capture:async(descriptor,source)=>{
    const started=find(descriptor.requestKey);
    if(!started||started.descriptor.fingerprint!==descriptor.fingerprint)throw new BackendError('REQUEST_NOT_STARTED','必须在发送网络请求前登记请求。');
    if(started.state==='COMPLETED')return response(read(started)!);
    const chunks:Uint8Array[]=[];let bytes=0;
    const reader=source.body?.getReader();
    const abort=()=>{void reader?.cancel(signal.reason).catch(()=>undefined);};
    signal.addEventListener('abort',abort,{once:true});
    try{
     signal.throwIfAborted();
     if(reader)while(true){const next=await reader.read();signal.throwIfAborted();if(next.done)break;bytes+=next.value.byteLength;
      if(bytes>MAX_RESPONSE_BYTES){await reader.cancel();throw new BackendError('RESPONSE_TOO_LARGE','服务响应超过容量上限。');}chunks.push(next.value);
     }
     const receipt:ResponseReceipt={status:source.status,headers:[...source.headers.entries()],bodyBase64:Buffer.concat(chunks).toString('base64')};
     // 此提交早于 JSON/SSE 解码、结构校验和 CDN 下载。
     scope.complete(descriptor.requestKey,receipt);return response(receipt);
    }catch(error){try{scope.unknown(descriptor.requestKey);}catch{/* fencing 已拒绝旧尝试。 */}throw error;}
    finally{signal.removeEventListener('abort',abort);reader?.releaseLock();}
   },
   fetch:async(descriptor,input,init)=>{
    const {replay}=scope.begin(descriptor);if(replay)return response(replay);
    try{
     const signals=[signal,...(init?.signal?[init.signal]:[]),...(input instanceof Request?[input.signal]:[])];
     const result=await this.network(input,{...init,signal:AbortSignal.any(signals)});
     return await scope.capture(descriptor,result);
    }catch(error){try{scope.unknown(descriptor.requestKey);}catch{/* 保留原网络错误。 */}throw error;}
   },
  };
  return scope;
 }
}
