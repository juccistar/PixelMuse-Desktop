import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import type { SqliteDatabase } from '@ecomgen/core';
import { JobType, RequestDescriptorSchema } from '@ecomgen/domain';
import { ResourceRefSchema } from '@ecomgen/contracts';
import { BackendError } from '../validation.js';

/** 快照允许完整领域 JSON，实际任务结构另由 D 的 snapshotSchema 强制校验。 */
export const JsonValueSchema = Type.Recursive(Self=>Type.Union([Type.Null(),Type.Boolean(),Type.Number(),Type.String(),Type.Array(Self),Type.Record(Type.String(),Self)]));
const JsonObject=Type.Record(Type.String(),JsonValueSchema);
export const FrozenJobSnapshotSchema=Type.Object({
 version:Type.Literal(1),jobId:Type.String({minLength:1,maxLength:160}),type:JobType,createdAt:Type.String(),
 input:JsonObject,effective:JsonObject,
 resources:Type.Array(Type.Object({ref:ResourceRefSchema,hash:Type.String({pattern:'^[a-f0-9]{64}$'})},{additionalProperties:false}),{maxItems:1000}),
},{additionalProperties:false});
export type FrozenJobSnapshot=Static<typeof FrozenJobSnapshotSchema>;
export const RequestRecordSchema=Type.Object({
 descriptor:RequestDescriptorSchema,state:Type.Union([Type.Literal('IN_FLIGHT'),Type.Literal('COMPLETED'),Type.Literal('UNKNOWN'),Type.Literal('VERIFIED_FAILED')]),
 localState:Type.Union([Type.Literal('PENDING'),Type.Literal('COMMITTED')]),
 encryptedReceipt:Type.Optional(Type.String({minLength:1})),responseHash:Type.Optional(Type.String({pattern:'^[a-f0-9]{64}$'})),
 startedAt:Type.String(),completedAt:Type.Optional(Type.String()),usageKey:Type.Optional(Type.String({minLength:1,maxLength:240})),
 rejectedEditPlan:Type.Optional(Type.Boolean()),
},{additionalProperties:false});
export type RequestRecord=Static<typeof RequestRecordSchema>;
export const JobRuntimeSchema=Type.Object({
 version:Type.Literal(1),snapshot:FrozenJobSnapshotSchema,
 phase:Type.Union(['READY','EXECUTING','SETTLED'].map(value=>Type.Literal(value))),attempt:Type.Integer({minimum:0}),
 runToken:Type.Union([Type.String(),Type.Null()]),requests:Type.Array(RequestRecordSchema),
 requestHistory:Type.Optional(Type.Array(RequestRecordSchema)),
 interruptions:Type.Optional(Type.Array(Type.Object({action:Type.Union([Type.Literal('RETRY'),Type.Literal('END')]),recordedAt:Type.String(),attempt:Type.Integer({minimum:0}),requests:Type.Array(Type.Object({requestKey:Type.String({minLength:1,maxLength:240}),startedAt:Type.String(),usageKey:Type.Optional(Type.String({minLength:1,maxLength:240}))},{additionalProperties:false}))},{additionalProperties:false}))),
 preservedHistory:Type.Optional(JsonValueSchema),
 replayOnly:Type.Optional(Type.Boolean()),
 reviews:Type.Optional(Type.Array(Type.Object({requestKey:Type.String({minLength:1,maxLength:240}),requestStartedAt:Type.Optional(Type.String()),outcome:Type.Union([Type.Literal('UNRESOLVED'),Type.Literal('NOT_EXECUTED'),Type.Literal('FAILED')]),encryptedEvidence:Type.String({minLength:1}),recordedAt:Type.String()},{additionalProperties:false}))),
},{additionalProperties:false});
export type JobRuntimeRecord=Static<typeof JobRuntimeSchema>;

// 只复用 schema 的校验程序；持久数据仍逐次读取、解析并完整校验，不缓存任务或校验结果。
const validators=new WeakMap<TSchema,(value:unknown)=>boolean>();

/** 三张运行表由 core canonical schema 创建，本模块绝不另建表或连接。 */
export class RuntimeStore {
 constructor(readonly db:SqliteDatabase,readonly clock:()=>string=()=>new Date().toISOString()){}
 transaction<T>(callback:()=>T):T {
  const run=()=>{const result=callback();if(result&&typeof (result as {then?:unknown}).then==='function'){
   void Promise.resolve(result).catch(()=>undefined);throw new BackendError('ASYNC_TRANSACTION','事务内不能执行异步操作。');
  }return result;};
  // better-sqlite3 的嵌套事务使用 SAVEPOINT，内层异常被捕获时也不能留下部分写入。
  return this.db.transaction(run).immediate();
 }
 get(jobId:string):JobRuntimeRecord|undefined {
  const row=this.db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get(jobId) as {payload:string}|undefined;
  return row?this.decode(JobRuntimeSchema,row.payload):undefined;
 }
 create(jobId:string,snapshot:FrozenJobSnapshot,preservedHistory?:unknown):void {
  if(!this.db.inTransaction)throw new BackendError('TRANSACTION_REQUIRED','冻结必须与任务及关联记录同一事务提交。');
  if(jobId!==snapshot.jobId)throw new BackendError('INVALID_SNAPSHOT','快照任务身份不匹配。');
  const payload={version:1,snapshot,phase:'READY',attempt:0,runToken:null,requests:[],...(preservedHistory===undefined?{}:{preservedHistory})};
  this.validate(JobRuntimeSchema,payload);
  this.db.prepare('INSERT INTO desktop_job_runtime(job_id,payload,updated_at) VALUES (?,?,?)').run(jobId,JSON.stringify(payload),this.clock());
 }
 mutate<T>(jobId:string,update:(record:JobRuntimeRecord)=>T):T {
  return this.transaction(()=>{
   const current=this.get(jobId);if(!current)throw new BackendError('RUNTIME_REQUIRED','任务没有完整执行快照。');
   const immutable=JSON.stringify([current.snapshot,current.preservedHistory]);
   const result=update(current);
   if(result&&typeof (result as {then?:unknown}).then==='function'){
    void Promise.resolve(result).catch(()=>undefined);throw new BackendError('ASYNC_TRANSACTION','事务内不能执行异步操作。');
   }
   if(JSON.stringify([current.snapshot,current.preservedHistory])!==immutable)throw new BackendError('IMMUTABLE_SNAPSHOT','不能覆盖历史快照。');
   this.validate(JobRuntimeSchema,current);
   this.db.prepare('UPDATE desktop_job_runtime SET payload=?,updated_at=? WHERE job_id=?').run(JSON.stringify(current),this.clock(),jobId);
   return result;
  });
 }
 validate(schema:TSchema,value:unknown):void {
  let check=validators.get(schema);
  if(!check){
   try{const compiled=TypeCompiler.Compile(schema);check=value=>compiled.Check(value);}
   // 编译器不支持的既有 schema 仍沿用解释器语义，不能阻止合法历史快照打开。
   catch{check=value=>Value.Check(schema,value);}
   validators.set(schema,check);
  }
  if(!check(value))throw new BackendError('INVALID_RUNTIME','持久运行数据无效。');
 }
 decode<T extends TSchema>(schema:T,payload:string):Static<T> {
  let parsed:unknown;try{parsed=JSON.parse(payload);}catch{throw new BackendError('INVALID_RUNTIME','持久运行数据无效。');}
  this.validate(schema,parsed);return parsed as Static<T>;
 }
}
