import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import { operations } from '@ecomgen/contracts';
const catalog=JSON.parse(readFileSync(fileURLToPath(new URL('../../../contracts/command-catalog.json',import.meta.url)),'utf8')) as {operationCount:number;operations:Array<{operation:string;source:{operationId:string;method:string;path:string}|null;input:unknown;output:unknown;disposition:string}>};
const original=JSON.parse(readFileSync(fileURLToPath(new URL('../../../../migration-discovery/original-api-inventory.json',import.meta.url)),'utf8')) as {operations:Array<{operationId:string;method:string;path:string}>};
describe('完整具名契约目录',()=>{
 it('全部161操作可独立编译，不依赖旧 OpenAPI/路由注册器',()=>{
  expect(Object.keys(operations)).toHaveLength(161);
  expect(operations).toHaveProperty('resolveJobInterruptions');
  expect(operations).not.toHaveProperty('recordJobReview');
  for(const [name,contract]of Object.entries(operations)){
   expect(()=>TypeCompiler.Compile(contract.input),name+' input').not.toThrow();
   expect(()=>TypeCompiler.Compile(contract.output),name+' output').not.toThrow();
  }
 });
 it('离线目录覆盖全部实际操作和原131入口；只移除旧空操作与事件传输',()=>{
  expect(catalog.operationCount).toBe(161);expect(catalog.operations.filter(entry=>entry.source)).toHaveLength(131);
  const identity=(entry:{operationId:string;method:string;path:string})=>[entry.operationId,entry.method,entry.path].join(' ');
  expect(catalog.operations.flatMap(entry=>entry.source?[identity(entry.source)]:[]).sort()).toEqual(original.operations.map(identity).sort());
  expect(catalog.operations.filter(entry=>entry.input===null).map(entry=>entry.operation).sort()).toEqual(['noopPatternsPost','subscribeEvents']);
  for(const [name,contract]of Object.entries(operations)){
   const entry=catalog.operations.find(item=>item.operation===name);expect(entry,name).toBeDefined();
   expect(entry?.input,name+' input').toEqual(JSON.parse(JSON.stringify(contract.input)));expect(entry?.output,name+' output').toEqual(JSON.parse(JSON.stringify(contract.output)));
  }
 });
 it('提交明确返回 durable identity 与 reused，查询容许全局 UNKNOWN',()=>{
  const job={id:'11111111-1111-1111-1111-111111111111',projectId:null,type:'PLAN',status:'UNKNOWN',progress:0,retryable:false,createdAt:'2026-11-05T00:00:00.000Z'};
  expect(Value.Check(operations.getJob.output,job)).toBe(true);
  expect(Value.Check(operations.createPlanningJob.output,job)).toBe(false);
  expect(Value.Check(operations.createPlanningJob.output,{...job,reused:true})).toBe(true);
  expect(Value.Check(operations.getJob.output,{...job,encryptedApiKey:'private'})).toBe(false);
 });
 it('导出取消/未知终态可查询，提交产物不接受任意私有字段',()=>{
  const archive={id:'11111111-1111-1111-1111-111111111111',projectId:'22222222-2222-2222-2222-222222222222',status:'CANCELLED',createdAt:'2026-11-05T00:00:00.000Z'};
  expect(Value.Check(operations.getExport.output,archive)).toBe(true);expect(Value.Check(operations.getExport.output,{...archive,status:'UNKNOWN'})).toBe(true);
  const job={id:archive.id,projectId:archive.projectId,type:'EXPORT',status:'CANCELLED',progress:0,retryable:true,createdAt:archive.createdAt};
  expect(Value.Check(operations.createExportJob.output,{job,export:archive,reused:false})).toBe(true);
  expect(Value.Check(operations.createExportJob.output,{job,export:{...archive,storagePath:'private'},reused:false})).toBe(false);
 });
 it('公开 DTO 无密钥/路径/私有执行快照，资源 URL 不接受旧下载路径',()=>{
  const forbidden=new Set(['storagePath','psdStoragePath','editMaskPath','protectMaskPath','encryptedApiKey','encryptedKey','generationSnapshot','providerSnapshot','sealedCredential']);
  const visit=(value:unknown)=>{if(!value||typeof value!=='object')return;const object=value as Record<string,unknown>;if(object.properties)for(const key of Object.keys(object.properties))expect(forbidden.has(key),key).toBe(false);for(const child of Object.values(object))if(Array.isArray(child))child.forEach(visit);else visit(child);};
  for(const contract of Object.values(operations))visit(contract.output);
  const asset={id:'11111111-1111-1111-1111-111111111111',projectId:'22222222-2222-2222-2222-222222222222',role:'PRODUCT_TRUTH',mimeType:'image/png',createdAt:'2026-11-05T00:00:00.000Z'};
  expect(Value.Check(operations.uploadAsset.output,{...asset,url:'/api/v1/files/assets/private'})).toBe(false);
  expect(Value.Check(operations.uploadAsset.output,{...asset,url:'ecomgen-resource://ASSET/'+asset.id})).toBe(true);
 });
});
