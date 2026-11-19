import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EcomRepository, DesktopHistoryRepository, LocalAssetStore, SecretBox, SuiteCatalog, openDatabase, type JobRecord } from '@ecomgen/core';
import { RuntimeStore, FrozenJobSnapshotSchema, type FrozenJobSnapshot } from '../../src/runtime/state.js';
import { RequestLedger } from '../../src/runtime/request-ledger.js';
import { ResourceRegistry } from '../../src/runtime/resources.js';
import { PersistentScheduler } from '../../src/runtime/scheduler.js';
import { InvalidationEvents } from '../../src/runtime/events.js';
import { createRuntimeCommands } from '../../src/business.js';
import { assertProjectImageWorkAllowed } from '../../src/execution/image-work-barrier.js';
import { EXECUTOR_TYPES, type CommandContext, type DomainExecutor, type ExecutionContext, type ExecutorMap, type ExecutorType } from '../../src/runtime/ports.js';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(execute:DomainExecutor['execute']=async()=>undefined,network:typeof fetch=fetch){
 const root=await mkdtemp(join(tmpdir(),'ecomgen-runtime-')),db=openDatabase(':memory:'),repository=new EcomRepository(db),storage=new LocalAssetStore(root),secrets=new SecretBox(randomBytes(32));await storage.initialize();
 const store=new RuntimeStore(db),ledger=new RequestLedger(store,secrets,network),resources=new ResourceRegistry(store,storage),eventsSeen:unknown[]=[];
 const events=new InvalidationEvents(store,event=>eventsSeen.push(event));let context:CommandContext;
 const scheduler=new PersistentScheduler(store,repository,ledger,()=>context,2);
 context={repository,history:new DesktopHistoryRepository(db),storage,secrets,catalog:new SuiteCatalog({dataDir:root,repository}),scheduler,resources,events,requestLedger:ledger,clock:store.clock,idFactory:randomUUID,signal:new AbortController().signal,transaction:callback=>events.transaction(callback)};
 const map=Object.fromEntries(EXECUTOR_TYPES.map(type=>[type,{snapshotSchema:FrozenJobSnapshotSchema,execute}])) as ExecutorMap;scheduler.register(map);
 cleanups.push(async()=>{await scheduler.close();db.close();await rm(root,{recursive:true,force:true});});
 const add=(type:ExecutorType='EXPORT',beforeFreeze?:(job:JobRecord)=>void)=>context.transaction(()=>{
  const job=repository.createJob({id:randomUUID(),projectId:null,storyboardItemId:null,type,input:{meaning:'original'}});
  beforeFreeze?.(job);
  const snapshot:FrozenJobSnapshot={version:1,jobId:job.id,type,input:{meaning:'original'},effective:{facts:['frozen'],parameters:{candidateCount:1}},resources:[],createdAt:store.clock()};
  scheduler.freeze(job.id,snapshot);return job;
 });
 return {root,db,repository,store,ledger,resources,events,eventsSeen,scheduler,context,add,map};
}
const terminal=async(f:Awaited<ReturnType<typeof fixture>>,id:string,status:string)=>vi.waitFor(()=>expect(f.repository.getJob(id)?.status).toBe(status),{timeout:5000,interval:5});
describe('唯一 SQLite 队列、恢复、取消和结算',()=>{
 it.each(['PLAN','COPYWRITE'] as const)('%s逐请求核实原子结束，显式重试另记用量并保留冻结输入',async type=>{
  let calls=0;
  const descriptors=[{requestKey:'first',fingerprint:'a'.repeat(64),purpose:'MODEL' as const},{requestKey:'second',fingerprint:'b'.repeat(64),purpose:'MODEL' as const}];
  const completed={requestKey:'completed',fingerprint:'c'.repeat(64),purpose:'MODEL' as const};
  const f=await fixture(async context=>{for(const descriptor of [completed,...descriptors])await context.external.fetch(descriptor,'http://fake.invalid');},async()=>{calls++;return new Response('{}');});
  const job=f.add(type),snapshot=JSON.stringify(f.store.get(job.id)!.snapshot);
  const scope=f.ledger.forJob(job.id,new AbortController().signal);
  scope.begin(completed);scope.complete('completed',{status:200,headers:[],bodyBase64:'e30='});
  for(const descriptor of descriptors)scope.begin(descriptor);
  f.repository.updateJob(job.id,{status:'RUNNING'});f.store.mutate(job.id,state=>{state.phase='EXECUTING';state.attempt=1;state.runToken='dead';});
  f.scheduler.start();expect(f.repository.getJob(job.id)!.status).toBe('UNKNOWN');
  const commands=createRuntimeCommands(f.context,f.store,'test',()=>f.scheduler.activeCount);
  expect((await commands.getJobActions!(f.context,{jobId:job.id})).retry.available).toBe(true);
  expect(await commands.resolveJobInterruptions!(f.context,{jobId:job.id,action:'RETRY'})).toEqual({items:[{jobId:job.id,status:'RETRIED',reason:null}]});
  expect(f.store.get(job.id)!.requestHistory?.map(request=>request.state)).toEqual(['UNKNOWN','UNKNOWN']);
  expect(f.store.get(job.id)!.interruptions?.[0]).toMatchObject({action:'RETRY',attempt:1,requests:[{requestKey:'first'},{requestKey:'second'}]});
  await terminal(f,job.id,'SUCCEEDED');await f.scheduler.waitForIdle([job.id]);
  expect(calls).toBe(2);expect(JSON.stringify(f.store.get(job.id)!.snapshot)).toBe(snapshot);
  const usage=f.db.prepare('SELECT request_key,entry_json FROM desktop_usage_records WHERE job_id=?').all(job.id) as {request_key:string;entry_json:string}[];
  expect(usage).toHaveLength(5);expect(new Set(usage.map(row=>row.request_key)).size).toBe(5);
  expect(usage.filter(row=>JSON.parse(row.entry_json).state==='UNKNOWN')).toHaveLength(2);
 });
 it('显式本地恢复重放回执，遇到后续新请求即停止且不访问网络',async()=>{
  let calls=0;
  const f=await fixture(async context=>{await context.external.fetch({requestKey:'first',fingerprint:'a'.repeat(64),purpose:'MODEL'},'http://fake.invalid');await context.external.fetch({requestKey:'next',fingerprint:'b'.repeat(64),purpose:'MODEL'},'http://fake.invalid');},async()=>{calls++;return new Response('{}');});
  const job=f.add('PLAN'),scope=f.ledger.forJob(job.id,new AbortController().signal);
  scope.begin({requestKey:'first',fingerprint:'a'.repeat(64),purpose:'MODEL'});scope.complete('first',{status:200,headers:[],bodyBase64:'e30='});
  f.repository.updateJob(job.id,{status:'FAILED',retryable:true});f.store.mutate(job.id,runtime=>{runtime.phase='SETTLED';});
  expect(f.scheduler.localRecovery(job.id).available).toBe(true);
  f.scheduler.recoverLocally(job.id);f.scheduler.start();await terminal(f,job.id,'FAILED');
  expect(calls).toBe(0);expect(f.store.get(job.id)!.requests).toHaveLength(1);
 });
 it('提前退出把未完成并发请求转为可核实UNKNOWN，旧代次迟到回执不得覆盖',async()=>{
  let old:ExecutionContext|undefined;
  const f=await fixture(async context=>{old=context;context.external.begin({requestKey:'pending',fingerprint:'e'.repeat(64),purpose:'IMAGE'});throw new Error('another concurrent operation failed');});
  const job=f.add('GENERATE');f.scheduler.start();await terminal(f,job.id,'UNKNOWN');await f.scheduler.waitForIdle([job.id]);
  expect(f.store.get(job.id)!.requests[0]!.state).toBe('UNKNOWN');
  expect(JSON.parse((f.db.prepare('SELECT entry_json FROM desktop_usage_records WHERE job_id=?').get(job.id) as {entry_json:string}).entry_json).state).toBe('UNKNOWN');
  expect(()=>old!.external.complete('pending',{status:200,headers:[],bodyBase64:'e30='})).toThrow(/代次已失效/);
  expect(f.scheduler.resolveInterruptions({jobId:job.id,action:'END'}).items[0]?.status).toBe('ENDED');
  expect(f.repository.getJob(job.id)!.status).toBe('CANCELLED');
  expect(()=>old!.external.complete('pending',{status:200,headers:[],bodyBase64:'e30='})).toThrow(/代次已失效/);
 });
 it('启动规范化旧已结算任务的IN_FLIGHT，不重发也不解除UNKNOWN',async()=>{
  let calls=0;const f=await fixture(async()=>{calls++;});const job=f.add('GENERATE');
  f.ledger.forJob(job.id,new AbortController().signal).begin({requestKey:'pending',fingerprint:'e'.repeat(64),purpose:'IMAGE'});
  f.repository.updateJob(job.id,{status:'UNKNOWN',retryable:false});f.store.mutate(job.id,state=>{state.phase='SETTLED';});
  f.scheduler.start();expect(f.store.get(job.id)!.requests[0]!.state).toBe('UNKNOWN');expect(f.repository.getJob(job.id)!.status).toBe('UNKNOWN');expect(calls).toBe(0);
 });
 it('完整20任务显式分派；重复 enqueue 不能重复认领，并发上限为2',async()=>{
  const seen:string[]=[],counts=new Map<string,number>();let concurrent=0,max=0;
  const f=await fixture(async context=>{seen.push(context.job.type);counts.set(context.job.id,(counts.get(context.job.id)??0)+1);concurrent++;max=Math.max(max,concurrent);await new Promise(resolve=>setImmediate(resolve));concurrent--;});
  const jobs=EXECUTOR_TYPES.map(type=>f.add(type));f.scheduler.start();for(const job of jobs){f.scheduler.enqueue(job.id);f.scheduler.enqueue(job.id);}
  await vi.waitFor(()=>expect(jobs.every(job=>f.repository.getJob(job.id)?.status==='SUCCEEDED')).toBe(true));
  expect(seen.sort()).toEqual([...EXECUTOR_TYPES].sort());expect([...counts.values()]).toEqual(jobs.map(()=>1));expect(max).toBe(2);
 });
 it('并发扩大立即补充认领，缩小等待已有任务完成并遵守维护暂停',async()=>{
  const releases=new Map<string,()=>void>();
  const f=await fixture(async context=>{await new Promise<void>(resolve=>releases.set(context.job.id,resolve));});
  f.scheduler.setConcurrency(1);const jobs=Array.from({length:4},()=>f.add());f.scheduler.start();
  await vi.waitFor(()=>expect(releases.size).toBe(1));
  f.scheduler.setConcurrency(3);await vi.waitFor(()=>expect(releases.size).toBe(3));
  f.scheduler.setConcurrency(1);f.scheduler.pauseForMaintenance();
  for(const release of releases.values())release();
  await vi.waitFor(()=>expect(f.scheduler.activeCount).toBe(0));
  expect(releases.size).toBe(3);f.scheduler.resumeAfterMaintenance();
  await vi.waitFor(()=>expect(releases.size).toBe(4));releases.get(jobs.find(job=>f.repository.getJob(job.id)?.status==='RUNNING')!.id)!();
  await vi.waitFor(()=>expect(f.scheduler.activeCount).toBe(0));
 });
 it('未知任务和缺失执行器明确拒绝，没有默认 EXPORT',async()=>{
  const f=await fixture();expect(()=>f.scheduler.register({EXPORT:f.map.EXPORT} as ExecutorMap)).toThrow();
  expect(()=>f.scheduler.register({...f.map,UNRECOGNIZED:f.map.EXPORT} as ExecutorMap)).toThrow();
 });
 it('快照、Job和关联记录一个事务；不可变快照和异步事务回滚',async()=>{
  const f=await fixture();let id='';
  expect(()=>f.context.transaction(()=>{const job=f.add();id=job.id;throw new Error('crash');})).toThrow();expect(f.repository.getJob(id)).toBeUndefined();expect(f.store.get(id)).toBeUndefined();
  const job=f.add();const original=JSON.stringify(f.store.get(job.id)?.snapshot);
  expect(()=>f.store.mutate(job.id,record=>{record.snapshot.effective={changed:true};})).toThrow();expect(JSON.stringify(f.store.get(job.id)?.snapshot)).toBe(original);
  expect(()=>f.context.transaction(()=>{f.repository.updateJob(job.id,{progress:20});return Promise.resolve();})).toThrow();expect(f.repository.getJob(job.id)?.progress).toBe(0);
  const raw=f.repository.createJob({id:randomUUID(),projectId:null,storyboardItemId:null,type:'EXPORT',input:{}});expect(()=>f.scheduler.enqueue(raw.id)).toThrow();
 });
 it('排队取消不执行；运行取消等待退出并持久 CANCELLED',async()=>{
  let entered!:()=>void;const began=new Promise<void>(resolve=>entered=resolve);let calls=0;
  const f=await fixture(async context=>{calls++;entered();await new Promise<void>(resolve=>context.signal.addEventListener('abort',()=>resolve(),{once:true}));context.signal.throwIfAborted();});
  const queued=f.add();f.scheduler.cancel(queued.id);expect(f.repository.getJob(queued.id)?.status).toBe('CANCELLED');
  const running=f.add();f.scheduler.start();f.scheduler.enqueue(running.id);await began;f.scheduler.cancel(running.id);await f.scheduler.waitForIdle([running.id]);
  expect(calls).toBe(1);expect(f.repository.getJob(running.id)?.status).toBe('CANCELLED');expect(f.store.get(running.id)?.phase).toBe('SETTLED');
 });
 it('迟到 checkpoint 在代次结束后被 fencing 拒绝',async()=>{
  let old:ExecutionContext|undefined;const f=await fixture(async context=>{old=context;context.checkpoint(()=>context.repository.updateJob(context.job.id,{progress:45}));});
  const job=f.add();f.scheduler.start();await terminal(f,job.id,'SUCCEEDED');
  expect(()=>old!.checkpoint(()=>f.repository.updateJob(job.id,{progress:9}))).toThrow();expect(f.repository.getJob(job.id)?.progress).toBe(100);
 });
 it('执行时读取冻结输入，返回的快照不可修改',async()=>{
  let frozen:unknown;const f=await fixture(async context=>{frozen=context.snapshot.effective;expect(()=>{context.snapshot.effective.facts=['overwritten'];}).toThrow();});
  const job=f.add();f.scheduler.start();await terminal(f,job.id,'SUCCEEDED');expect(frozen).toEqual({facts:['frozen'],parameters:{candidateCount:1}});
 });
 it('已存完整回执后本地失败，显式重试只重放本地尾阶段',async()=>{
  let attempts=0,networkCalls=0;
  const f=await fixture(async context=>{attempts++;await context.external.fetch({requestKey:'candidate:1',fingerprint:'a'.repeat(64),purpose:'IMAGE'},'http://fake.invalid',{method:'POST'});if(attempts===1)throw new Error('decode failed');context.checkpoint(()=>context.external.committed('candidate:1'));},async()=>{networkCalls++;return new Response('{"paid":true}');});
  const job=f.add('GENERATE');f.scheduler.start();await terminal(f,job.id,'FAILED');await f.scheduler.waitForIdle([job.id]);f.scheduler.retry(job.id);await terminal(f,job.id,'SUCCEEDED');
  expect(attempts).toBe(2);expect(networkCalls).toBe(1);expect(f.store.get(job.id)?.attempt).toBe(2);expect(f.ledger.summaries(job.id)[0]?.localState).toBe('COMMITTED');
 });
 it('IN_FLIGHT 崩溃恢复进入 UNKNOWN，草稿槽位与流水线同事务结算',async()=>{
  const f=await fixture();let batchId='',pipelineId='';
  const job=f.add('PATTERN_DRAFT_GENERATE',job=>{
   const draft=f.repository.createPatternDraft({name:'draft',composeType:'PLACEMENT',conditions:{}});
   const created=f.repository.createDraftBatch({draftId:draft.id,operation:'GENERATE',parentCandidateId:null,providerId:null,imageModelId:null,candidateCount:2,instruction:null,snapshot:{},clientKey:randomUUID()});batchId=created.batch.id;
   f.repository.assignDraftSlotsToJob(batchId,[1,2],job.id,false);
   const pipeline=f.repository.createPatternPipeline({patternId:null,specId:'test',specVersion:'1',layout:'CENTERED',repeatLayout:'GRID',listingPlatform:'ETSY',listingProviderId:randomUUID(),listingModelId:'fake',listingHints:{sellingPoints:null,bannedWords:null},requestFingerprint:null,steps:[{step:'SOURCE',position:0},{step:'TILE_CHECK',position:1}]});pipelineId=pipeline.id;
   f.repository.updatePatternPipelineStep(pipeline.steps[0]!.id,{jobId:job.id,status:'RUNNING'});
  });
  f.repository.updateJob(job.id,{status:'RUNNING'});f.store.mutate(job.id,runtime=>{runtime.phase='EXECUTING';runtime.runToken='old';runtime.attempt=1;});
  f.ledger.forJob(job.id,new AbortController().signal).begin({requestKey:'slot:1',fingerprint:'b'.repeat(64),purpose:'IMAGE'});
  f.scheduler.start();expect(f.repository.getJob(job.id)?.status).toBe('UNKNOWN');expect(f.repository.listDraftSlots(batchId).map(slot=>slot.status)).toEqual(['UNKNOWN','UNKNOWN']);expect(f.repository.getPatternPipeline(pipelineId)).toMatchObject({status:'AWAITING_INPUT',blockReason:'EXTERNAL_RESULT_UNKNOWN'});
  expect(()=>f.scheduler.retry(job.id)).toThrow();expect(f.store.get(job.id)?.snapshot.input).toEqual({meaning:'original'});
  // 结束只收敛已有领域关联，不执行重试或推进后续任务。
  expect(f.scheduler.resolveInterruptions({jobId:job.id,action:'END'}).items[0]?.status).toBe('ENDED');
  expect(f.repository.listDraftSlots(batchId).map(slot=>slot.status)).toEqual(['CANCELLED','CANCELLED']);
  expect(f.repository.getPatternPipeline(pipelineId)).toMatchObject({status:'CANCELLED',blockReason:null});
  expect(f.repository.getJob(job.id)?.status).toBe('CANCELLED');
 });
 it('损坏运行 JSON 仍保留已发出请求的 UNKNOWN，不降级为可重试失败',async()=>{
  const f=await fixture(),job=f.add('PLAN');
  f.repository.updateJob(job.id,{status:'RUNNING',providerTaskId:'__EXTERNAL_REQUEST_STARTED__'});
  f.db.prepare('UPDATE desktop_job_runtime SET payload=? WHERE job_id=?').run('{corrupt',job.id);
  f.scheduler.start();expect(f.repository.getJob(job.id)).toMatchObject({status:'UNKNOWN',retryable:false});
  expect((f.db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get(job.id) as {payload:string}).payload).toBe('{corrupt');
 });
 it.each(['missing','corrupt','settlement'] as const)('编辑任务%s隔离/结算失败仍同步真实editTurnId轮次',async mode=>{
  const f=await fixture();
  f.db.prepare('INSERT INTO projects(id,name,platform_targets_json,default_mode,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('edit-project','编辑隔离','[]','CREATIVE','time','time');
  f.repository.saveStoryboard('edit-project','','CONFIRMED',[{assetType:'hero-image',displayName:'主图',shotRole:null,templateVariant:null,candidateCount:1,referencedAssets:[],mode:'CREATIVE',status:'CONFIRMED',promptInstruction:'test',compiledPrompt:'test',factClaims:[],riskFlags:[],sortOrder:0}]);
  const item=f.repository.listStoryboardItems('edit-project')[0]!;
  const generation=f.repository.createJob({id:randomUUID(),projectId:'edit-project',storyboardItemId:item.id,type:'GENERATE',input:{}});
  const output=f.repository.createOutput({projectId:'edit-project',storyboardItemId:item.id,jobId:generation.id,candidateIndex:1,generationSnapshot:null,storagePath:'outputs/fixture.png',hash:'fixture'});
  const session=f.repository.createEditSession({id:randomUUID(),projectId:'edit-project',currentOutputId:output.id,status:'ACTIVE',memorySummary:{}});
  const turn=f.repository.createEditTurn({id:randomUUID(),sessionId:session.id,projectId:'edit-project',baseOutputId:output.id,status:'PLANNING',message:'test',annotations:{},editMaskPath:null,editMaskHash:null,protectMaskPath:null,protectMaskHash:null,referenceAssetIds:[],plan:null,error:null});
  const job=f.repository.createJob({id:randomUUID(),projectId:'edit-project',storyboardItemId:null,type:'EDIT_PLAN',input:{editTurnId:turn.id}});
  if(mode!=='missing')f.context.transaction(()=>f.scheduler.freeze(job.id,{version:1,jobId:job.id,type:'EDIT_PLAN',input:job.input,effective:{},resources:[],createdAt:f.store.clock()}));
  if(mode==='settlement'){f.map.EDIT_PLAN.settle=()=>{throw new Error('settlement failed');};f.scheduler.register(f.map);}
  else {f.repository.updateJob(job.id,{status:'RUNNING'});if(mode==='corrupt')f.db.prepare('UPDATE desktop_job_runtime SET payload=? WHERE job_id=?').run('{corrupt',job.id);}
  f.scheduler.start();await terminal(f,job.id,mode==='settlement'?'FAILED':'UNKNOWN');
  expect(f.repository.getEditTurn(turn.id)!.status).toBe(mode==='settlement'?'FAILED':'UNKNOWN');
 });
 it('QUEUED 状态不一致不能绕过未决请求恢复屏障',async()=>{
  let calls=0;const f=await fixture(async()=>{calls++;}),job=f.add('GENERATE');
  f.ledger.forJob(job.id,new AbortController().signal).begin({requestKey:'candidate:1',fingerprint:'d'.repeat(64),purpose:'IMAGE'});
  f.scheduler.start();expect(f.repository.getJob(job.id)).toMatchObject({status:'UNKNOWN',retryable:false});
  await new Promise(resolve=>setImmediate(resolve));expect(calls).toBe(0);expect(()=>f.scheduler.retry(job.id)).toThrow();
 });
 it('有完整回执的中断任务恢复为本地续跑，不再发送请求',async()=>{
  let calls=0;
  const f=await fixture(async context=>{await context.external.fetch({requestKey:'round:0',fingerprint:'c'.repeat(64),purpose:'MODEL'},'http://fake.invalid',{method:'POST'});},async()=>{calls++;return new Response('{}');});
  const job=f.add('PLAN');const external=f.ledger.forJob(job.id,new AbortController().signal);external.begin({requestKey:'round:0',fingerprint:'c'.repeat(64),purpose:'MODEL'});external.complete('round:0',{status:200,headers:[],bodyBase64:'e30='});
  f.repository.updateJob(job.id,{status:'RUNNING'});f.store.mutate(job.id,runtime=>{runtime.phase='EXECUTING';runtime.runToken='dead';runtime.attempt=1;});f.scheduler.start();await terminal(f,job.id,'SUCCEEDED');expect(calls).toBe(0);expect(f.store.get(job.id)?.attempt).toBe(2);
 });
 it.each(['EDIT_PLAN','COPYWRITE'] as const)('重启%s多阶段流程保留回执并等待明确继续，不运行会创建付费子任务的成功结算',async type=>{
  let executed=0,advanced=0;const f=await fixture(async()=>{executed++;});
  f.map[type].settle=(_context,_job,status)=>{if(status==='SUCCEEDED')advanced++;};f.scheduler.register(f.map);
  const job=f.add(type,type==='COPYWRITE'?job=>{
   const pipeline=f.repository.createPatternPipeline({patternId:null,specId:'test',specVersion:'1',layout:'CENTERED',repeatLayout:'GRID',listingPlatform:'ETSY',listingProviderId:randomUUID(),listingModelId:'fake',listingHints:{sellingPoints:null,bannedWords:null},requestFingerprint:null,steps:[{step:'SOURCE',position:0},{step:'TILE_CHECK',position:1}]});
   f.repository.updatePatternPipelineStep(pipeline.steps[0]!.id,{jobId:job.id,status:'RUNNING'});
  }:undefined);
  const scope=f.ledger.forJob(job.id,new AbortController().signal);scope.begin({requestKey:'first',fingerprint:'c'.repeat(64),purpose:'MODEL'});scope.complete('first',{status:200,headers:[],bodyBase64:'e30='});
  f.repository.updateJob(job.id,{status:'RUNNING'});f.store.mutate(job.id,runtime=>{runtime.phase='EXECUTING';runtime.runToken='interrupted';});
  f.scheduler.start();expect(f.repository.getJob(job.id)).toMatchObject({status:'FAILED',error:{code:'REPLAY_REQUIRES_CONFIRMATION'}});
  expect(executed).toBe(0);expect(advanced).toBe(0);expect(scope.receipt('first')).not.toBeNull();expect(f.scheduler.localRecovery(job.id).available).toBe(false);
 });
 it('重启重放缺少后续回执时禁止新网络请求',async()=>{
  let calls=0;
  const f=await fixture(async context=>{
   await context.external.fetch({requestKey:'first',fingerprint:'c'.repeat(64),purpose:'MODEL'},'http://fake.invalid');
   await context.external.fetch({requestKey:'second',fingerprint:'d'.repeat(64),purpose:'MODEL'},'http://fake.invalid');
  },async()=>{calls++;return new Response('{}');});
  const job=f.add('PLAN'),scope=f.ledger.forJob(job.id,new AbortController().signal);
  scope.begin({requestKey:'first',fingerprint:'c'.repeat(64),purpose:'MODEL'});
  scope.complete('first',{status:200,headers:[],bodyBase64:'e30='});
  f.repository.updateJob(job.id,{status:'RUNNING'});f.store.mutate(job.id,runtime=>{runtime.phase='EXECUTING';runtime.runToken='dead';runtime.attempt=1;});
  f.scheduler.start();await terminal(f,job.id,'FAILED');expect(calls).toBe(0);
  expect(f.store.get(job.id)?.requests.map(request=>request.descriptor.requestKey)).toEqual(['first']);
 });
 it('异步领域结算不能提交成功，结算中的同步写入随事务回滚',async()=>{
  const f=await fixture();f.map.EXPORT.settle=async context=>{context.repository.saveUserTemplate({id:'custom-1234abcd',name:'must rollback',prompt:'test',defaultSize:'1024x1024',supportsImageReference:true});throw new Error('async settlement');};
  f.scheduler.register(f.map);const job=f.add();f.scheduler.start();await terminal(f,job.id,'FAILED');await f.scheduler.waitForIdle([job.id]);
  expect(f.repository.listUserTemplates()).toEqual([]);expect(f.repository.getJob(job.id)?.error?.code).toBe('SETTLEMENT_FAILED');
 });
 it('领域重试未产生 READY 意图时回滚全部改动',async()=>{
  const f=await fixture(async()=>{throw new Error('local failure');});
  f.map.EXPORT.retry=(context,job)=>{context.repository.updateJob(job.id,{progress:72});return context.repository.getJob(job.id)!;};
  f.scheduler.register(f.map);const job=f.add();f.scheduler.start();await terminal(f,job.id,'FAILED');await f.scheduler.waitForIdle([job.id]);
  expect(()=>f.scheduler.retry(job.id)).toThrowError(expect.objectContaining({code:'RETRY_UNSAFE'}));expect(f.repository.getJob(job.id)?.progress).toBe(0);
 });
 it('重复当前请求键不能遮蔽后一个损坏回执',async()=>{
  const f=await fixture(),job=f.add('PLAN'),scope=f.ledger.forJob(job.id,new AbortController().signal);
  scope.begin({requestKey:'completed',fingerprint:'b'.repeat(64),purpose:'MODEL'});scope.complete('completed',{status:200,headers:[],bodyBase64:'e30='});
  scope.begin({requestKey:'pending',fingerprint:'a'.repeat(64),purpose:'MODEL'});f.scheduler.start();
  f.store.mutate(job.id,state=>{state.requests.push({...structuredClone(state.requests[0]!),encryptedReceipt:'broken'});});
  expect(f.scheduler.actions(job.id).retry.available).toBe(false);expect(f.scheduler.actions(job.id).end.available).toBe(false);
  expect(f.scheduler.resolveInterruptions({jobId:job.id,action:'END'}).items[0]).toMatchObject({status:'FAILED',reason:expect.stringContaining('重复')});
  expect(f.repository.getJob(job.id)?.status).toBe('UNKNOWN');expect(f.store.get(job.id)?.requestHistory).toBeUndefined();
 });
 it('结束不受仅重试需要的检查阻挡',async()=>{
  const f=await fixture(),job=f.add('PLAN');
  f.map.PLAN.checkRetry=()=>{throw new Error('retry unavailable');};f.scheduler.register(f.map);
  f.ledger.forJob(job.id,new AbortController().signal).begin({requestKey:'pending',fingerprint:'a'.repeat(64),purpose:'MODEL'});f.scheduler.start();
  expect(f.scheduler.actions(job.id).retry.available).toBe(false);expect(f.scheduler.actions(job.id).end.available).toBe(true);
  expect(f.scheduler.resolveInterruptions({jobId:job.id,action:'END'}).items[0]?.status).toBe('ENDED');
 });
 it('结束中断不访问网络并保留可靠回执',async()=>{
  let calls=0;const f=await fixture(async()=>{calls++;}),job=f.add('PLAN');
  const scope=f.ledger.forJob(job.id,new AbortController().signal);
  scope.begin({requestKey:'completed',fingerprint:'b'.repeat(64),purpose:'MODEL'});
  scope.complete('completed',{status:200,headers:[],bodyBase64:'e30='});
  scope.begin({requestKey:'pending',fingerprint:'a'.repeat(64),purpose:'MODEL'});
  f.scheduler.start();
  expect(f.scheduler.resolveInterruptions({jobId:job.id,action:'END'}).items[0]?.status).toBe('ENDED');
  expect(f.store.get(job.id)?.requests.map(request=>request.state)).toEqual(['COMPLETED']);
  expect(f.store.get(job.id)?.requestHistory?.map(request=>request.state)).toEqual(['UNKNOWN']);
  expect(f.store.get(job.id)?.interruptions?.[0]).toMatchObject({action:'END',requests:[{requestKey:'pending'}]});
  expect(f.scheduler.resolveInterruptions({jobId:job.id,action:'END'}).items[0]?.status).toBe('SKIPPED');
  expect(calls).toBe(0);
 });
 it('项目批量重试跨过分页并隔离其他项目的中断任务',async()=>{
  let calls=0;
  const f=await fixture(async context=>{await context.external.fetch({requestKey:'candidate',fingerprint:'a'.repeat(64),purpose:'IMAGE'},'http://fake.invalid');},async()=>{calls++;return new Response('{}');});
  f.map.GENERATE.checkRetry=(context,job)=>assertProjectImageWorkAllowed(context.repository,context.requestLedger,job.projectId!,{imagePlanning:true,exceptJobId:job.id,exceptJobIds:context.interruptionRetry?.cohort});
  f.scheduler.register(f.map);
  const addProject=(id:string,count:number)=>{
   f.db.prepare('INSERT INTO projects(id,name,platform_targets_json,default_mode,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,id,'[]','CREATIVE','time','time');
   f.repository.saveStoryboard(id,'','CONFIRMED',Array.from({length:count},(_,index)=>({assetType:'hero-image',displayName:String(index),shotRole:null,templateVariant:null,candidateCount:1,referencedAssets:[],mode:'CREATIVE' as const,status:'CONFIRMED' as const,promptInstruction:'test',compiledPrompt:'test',factClaims:[],riskFlags:[],sortOrder:index})));
   return f.repository.listStoryboardItems(id).map((item,index)=>{
    const job=f.context.transaction(()=>{
     const created=f.repository.createJob({id:randomUUID(),projectId:id,storyboardItemId:item.id,type:'GENERATE',input:{},requestFingerprint:`${id}-${index}`});
     f.scheduler.freeze(created.id,{version:1,jobId:created.id,type:'GENERATE',input:{},effective:{},resources:[],createdAt:f.store.clock()});return created;
    });
    f.ledger.forJob(job.id,new AbortController().signal).begin({requestKey:'candidate',fingerprint:'a'.repeat(64),purpose:'IMAGE'});
    f.repository.updateJob(job.id,{status:'RUNNING'});f.store.mutate(job.id,state=>{state.phase='EXECUTING';state.runToken='old';state.attempt=1;});return job;
   });
  };
  const all=addProject('batch-project',13),jobs=all.slice(0,12),invalid=all[12]!,other=addProject('other-project',1)[0]!;
  f.repository.updateJob(jobs[0]!.id,{cancelRequested:true});
  f.scheduler.start();
  f.store.mutate(invalid.id,state=>{state.requests.push(structuredClone(state.requests[0]!));});
  const result=f.scheduler.resolveInterruptions({projectId:'batch-project',action:'RETRY'});
  expect(result.items).toHaveLength(13);expect(result.items.filter(item=>item.status==='RETRIED')).toHaveLength(12);
  expect(result.items.find(item=>item.jobId===invalid.id)).toMatchObject({status:'FAILED',reason:expect.stringContaining('重复')});
  expect(f.repository.getJob(other.id)?.status).toBe('UNKNOWN');expect(f.repository.getJob(invalid.id)?.status).toBe('UNKNOWN');
  await vi.waitFor(()=>expect(jobs.every(job=>f.repository.getJob(job.id)?.status==='SUCCEEDED')).toBe(true));
  expect(calls).toBe(12);expect(f.store.get(other.id)?.requestHistory).toBeUndefined();expect(f.store.get(invalid.id)?.requestHistory).toBeUndefined();
 });
 it('事件只在提交后通知，回滚和订阅故障不影响持久状态',async()=>{
  const f=await fixture();f.context.transaction(()=>{f.events.publish({topic:'jobs'});expect(f.eventsSeen).toHaveLength(0);});expect(f.eventsSeen).toHaveLength(1);
  expect(()=>f.context.transaction(()=>{f.events.publish({topic:'jobs'});throw new Error('rollback');})).toThrow();expect(f.eventsSeen).toHaveLength(1);
  const bad=new InvalidationEvents(f.store,()=>{throw new Error('observer failed');});expect(()=>bad.transaction(()=>bad.publish({topic:'jobs'}))).not.toThrow();
 });
});
