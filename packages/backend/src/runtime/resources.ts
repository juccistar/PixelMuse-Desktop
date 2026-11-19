import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import type { LocalAssetStore } from '@ecomgen/core';
import { ResourceRefSchema, type ResourceRef } from '@ecomgen/contracts';
import { BackendError } from '../validation.js';
import { RuntimeStore } from './state.js';
import type { ResourceRegistryPort } from './ports.js';
export const ResourcePayloadSchema=Type.Object({
 version:Type.Literal(1),ref:ResourceRefSchema,relativePath:Type.String({minLength:1,maxLength:32767}),mimeType:Type.String({minLength:1,maxLength:120}),
 hash:Type.String({pattern:'^[a-f0-9]{64}$'}),owners:Type.Array(Type.String({minLength:1,maxLength:240}),{uniqueItems:true}),
 publication:Type.Union([Type.Literal('PUBLISHED'),Type.Literal('RETIRING')]),
},{additionalProperties:false});
export type ResourcePayload=Static<typeof ResourcePayloadSchema>;
export const CleanupPayloadSchema=Type.Object({version:Type.Literal(1),resourceId:Type.String(),attempts:Type.Integer({minimum:0}),lastError:Type.Optional(Type.Literal('CLEANUP_FAILED'))},{additionalProperties:false});
export const resourceKey=(ref:ResourceRef)=>`${ref.kind}:${ref.id}${'index'in ref?':'+ref.index:''}`;
/** 受管文件登记与持久清理意图共享业务连接；路径永不进入公开 DTO。 */
export class ResourceRegistry implements ResourceRegistryPort {
 private cleanupPromise:Promise<void>|undefined;
 constructor(private readonly store:RuntimeStore,private readonly storage:Pick<LocalAssetStore,'absolute'>,
  private readonly historical?:{prepare(ref:ResourceRef):Promise<void>;owners(ref:ResourceRef):string[]}){}
 private pathKey(relativePath:string):string {
  const absolute=this.storage.absolute(relativePath);
  return process.platform==='win32'?absolute.toLowerCase():absolute;
 }
 private get(key:string):ResourcePayload|undefined {
  const row=this.store.db.prepare('SELECT payload FROM desktop_resources WHERE id=?').get(key) as {payload:string}|undefined;
  return row?this.store.decode(ResourcePayloadSchema,row.payload):undefined;
 }
 private pendingCleanup(record:ResourcePayload):boolean {
  return !record.owners.length&&!!this.store.db.prepare('SELECT 1 FROM desktop_cleanup_queue WHERE id=?').get(resourceKey(record.ref));
 }
 private save(record:ResourcePayload):void {
  this.store.validate(ResourcePayloadSchema,record);
  this.store.db.prepare('INSERT INTO desktop_resources(id,payload,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(resourceKey(record.ref),JSON.stringify(record),this.store.clock());
 }
 register(input:{ref:ResourceRef;relativePath:string;mimeType:string;hash:string;owners:string[]}):void {
  this.store.validate(ResourceRefSchema,input.ref);
  if(isAbsolute(input.relativePath)||win32.isAbsolute(input.relativePath)||input.relativePath.split(/[\\/]/).some(part=>!part||part==='.'||part==='..')||input.relativePath.includes(':'))throw new BackendError('INVALID_RESOURCE','资源路径无效。');
  this.storage.absolute(input.relativePath);
  input={...input,owners:[...new Set([...input.owners,...(this.historical?.owners(input.ref)??[])])]};
  this.store.transaction(()=>{
   // 清理在事务外 await 文件删除；同路径的新别名必须等它完成，避免发布后被迟到删除。
   const rows=this.store.db.prepare('SELECT payload FROM desktop_resources').all() as {payload:string}[];
   if(rows.some(row=>{const other=this.store.decode(ResourcePayloadSchema,row.payload);return other.publication==='RETIRING'&&this.pathKey(other.relativePath)===this.pathKey(input.relativePath);}))throw new BackendError('RESOURCE_RETIRING','资源正在回收，请重试。');
   const existing=this.get(resourceKey(input.ref));
   if(existing){
    if(existing.relativePath!==input.relativePath||existing.hash!==input.hash||existing.mimeType!==input.mimeType||existing.publication!=='PUBLISHED')throw new BackendError('RESOURCE_CONFLICT','资源身份已使用。');
    existing.owners=[...new Set([...existing.owners,...input.owners])];this.save(existing);return;
   }
   this.save({version:1,...structuredClone(input),owners:[...new Set(input.owners)],publication:'PUBLISHED'});
  });
 }
 async resolve(ref:ResourceRef):Promise<{path:string;mimeType:string;hash:string}> {
  this.store.validate(ResourceRefSchema,ref);
  if(!this.get(resourceKey(ref)))await this.historical?.prepare(ref);
  const record=this.get(resourceKey(ref));if(!record||record.publication!=='PUBLISHED')throw new BackendError('NOT_FOUND','资源不存在。');
  const historyOwners=this.historical?.owners(ref)??[];
  if(historyOwners.some(owner=>!record.owners.includes(owner)))this.store.transaction(()=>{
   record.owners=[...new Set([...record.owners,...historyOwners])];this.save(record);
   this.store.db.prepare('DELETE FROM desktop_cleanup_queue WHERE id=?').run(resourceKey(ref));
  });
  // 清理意图先撤销无主资源的访问；物理删除仍延后，历史引用可先恢复所有权。
  if(this.pendingCleanup(record))throw new BackendError('NOT_FOUND','资源不存在。');
  const hash=createHash('sha256');
  try{for await(const chunk of createReadStream(this.storage.absolute(record.relativePath)))hash.update(chunk);}catch{throw new BackendError('RESOURCE_UNAVAILABLE','资源文件不可用。');}
  if(hash.digest('hex')!==record.hash)throw new BackendError('RESOURCE_CHANGED','资源文件校验失败。');
  const current=this.get(resourceKey(ref));if(!current||current.publication!=='PUBLISHED'||current.hash!==record.hash||this.pendingCleanup(current))throw new BackendError('RESOURCE_UNAVAILABLE','资源已回收。');
  return {path:this.storage.absolute(record.relativePath),mimeType:record.mimeType,hash:record.hash};
 }
 retain(ref:ResourceRef,owner:string):void {
  this.store.transaction(()=>{const record=this.get(resourceKey(ref));if(!record||record.publication!=='PUBLISHED')throw new BackendError('NOT_FOUND','资源不存在。');record.owners=[...new Set([...record.owners,owner])];this.save(record);this.store.db.prepare('DELETE FROM desktop_cleanup_queue WHERE id=?').run(resourceKey(ref));});
 }
 release(ref:ResourceRef,owner:string):void {this.store.transaction(()=>{const record=this.get(resourceKey(ref));if(record){record.owners=record.owners.filter(value=>value!==owner);this.save(record);}});}
 scheduleCleanup(ref:ResourceRef):void {
  this.store.validate(ResourceRefSchema,ref);const key=resourceKey(ref);
  this.store.transaction(()=>{const record=this.get(key);if(!record)return;if(record.owners.length)throw new BackendError('RESOURCE_IN_USE','资源仍被任务或历史引用。');
   const payload={version:1,resourceId:key,attempts:0};this.store.validate(CleanupPayloadSchema,payload);
   this.store.db.prepare('INSERT OR IGNORE INTO desktop_cleanup_queue(id,payload,created_at) VALUES (?,?,?)').run(key,JSON.stringify(payload),this.store.clock());
  });
 }
 /** 任意失败保留清理意图；重启后可重复执行，不删除新增引用。 */
 cleanup():Promise<void> {
  if(!this.cleanupPromise)this.cleanupPromise=this.performCleanup().finally(()=>{this.cleanupPromise=undefined;});
  return this.cleanupPromise;
 }
 private async performCleanup():Promise<void> {
  // 只复用本轮的路径比较键，不缓存文件安全结论；实际删除仍重新校验受管路径。
  const pathKeys=new Map<string,string>();
  const comparisonKey=(relativePath:string):string=>{
   let key=pathKeys.get(relativePath);
   if(key===undefined){key=this.pathKey(relativePath);pathKeys.set(relativePath,key);}
   return key;
  };
  const rows=this.store.db.prepare('SELECT id FROM desktop_cleanup_queue ORDER BY created_at,id').all() as {id:string}[];
  for(const row of rows){
   // 上一个文件删除期间，后续意图及所有权可能已被撤销或更新。
   const queued=this.store.db.prepare('SELECT payload FROM desktop_cleanup_queue WHERE id=?').get(row.id) as {payload:string}|undefined;
   if(!queued)continue;
   const intent=this.store.decode(CleanupPayloadSchema,queued.payload);
   const record=this.store.transaction(()=>{
    const resource=this.get(intent.resourceId);if(!resource)return undefined;
    const historyOwners=this.historical?.owners(resource.ref)??[];
    if(historyOwners.length){resource.owners=[...new Set([...resource.owners,...historyOwners])];resource.publication='PUBLISHED';this.save(resource);}
    if(resource.owners.length){this.store.db.prepare('DELETE FROM desktop_cleanup_queue WHERE id=?').run(row.id);return undefined;}
    resource.publication='RETIRING';this.save(resource);return resource;
   });
   try{
    if(record){
     const key=comparisonKey(record.relativePath);
     const otherRows=this.store.db.prepare('SELECT id,payload FROM desktop_resources WHERE id<>?').all(row.id) as {id:string;payload:string}[];
     const shared=otherRows.some(other=>comparisonKey(this.store.decode(ResourcePayloadSchema,other.payload).relativePath)===key);
     if(!shared)await rm(this.storage.absolute(record.relativePath),{force:true});
    }
    this.store.transaction(()=>{if(record)this.store.db.prepare('DELETE FROM desktop_resources WHERE id=?').run(row.id);this.store.db.prepare('DELETE FROM desktop_cleanup_queue WHERE id=?').run(row.id);});
   }catch{
    intent.attempts++;intent.lastError='CLEANUP_FAILED';this.store.validate(CleanupPayloadSchema,intent);
    this.store.db.prepare('UPDATE desktop_cleanup_queue SET payload=? WHERE id=?').run(JSON.stringify(intent),row.id);
   }
  }
 }
}
