import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { EcomRepository, DesktopHistoryRepository, LocalAssetStore, SecretBox, SuiteCatalog, openDatabase, startPipelineStep, pipelineStepPlan, type JobRecord } from '@ecomgen/core';
import { MODEL_SPEC_DEFAULTS, POD_PRINT_SPEC_VERSION } from '@ecomgen/domain';
import { RuntimeStore } from '../../src/runtime/state.js';
import { RequestLedger } from '../../src/runtime/request-ledger.js';
import { ResourceRegistry } from '../../src/runtime/resources.js';
import { PersistentScheduler } from '../../src/runtime/scheduler.js';
import { InvalidationEvents } from '../../src/runtime/events.js';
import { EXECUTOR_TYPES, type CommandContext, type ExecutionContext, type ExecutorType } from '../../src/runtime/ports.js';
import { registerExecutors, createExecutionSnapshot, createExecutionContext, executeDomainJob, generationKeyFor, candidateIdFor, settleDomainJob } from '../../src/execution/index.js';

const cleanups: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const clean of cleanups.splice(0).reverse())await clean();vi.unstubAllGlobals();});
const png = (red=120,alpha=1)=>sharp({create:{width:24,height:24,channels:4,background:{r:red,g:40,b:180,alpha}}}).png().toBuffer();
function sse(text: string): Response {
 const chunk=(delta:unknown,finish_reason:string|null=null)=>`data: ${JSON.stringify({id:'mock',object:'chat.completion.chunk',created:1,model:'reasoner',choices:[{index:0,delta,finish_reason}]})}\n\n`;
 return new Response(chunk({role:'assistant',content:''})+chunk({content:text})+chunk({},'stop')+'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'ecomgen-execution-')),db=openDatabase(':memory:'),repository=new EcomRepository(db),storage=new LocalAssetStore(root),secrets=new SecretBox(randomBytes(32));await storage.initialize();
 const store=new RuntimeStore(db),ledger=new RequestLedger(store,secrets),resources=new ResourceRegistry(store,storage),events=new InvalidationEvents(store,()=>undefined);
 let context:CommandContext;const scheduler=new PersistentScheduler(store,repository,ledger,()=>context,1);
 context={repository,history:new DesktopHistoryRepository(db),storage,secrets,catalog:new SuiteCatalog({dataDir:root,repository}),scheduler,resources,events,requestLedger:ledger,clock:store.clock,idFactory:randomUUID,signal:new AbortController().signal,transaction:work=>events.transaction(work)};
 const executionErrors: unknown[]=[];
 const definitions=registerExecutors(context);
 for(const definition of Object.values(definitions)){const execute=definition.execute;definition.execute=async execution=>{try{await execute(execution);}catch(error){executionErrors.push(error);throw error;}};}
 scheduler.register(definitions);
 const provider=repository.saveProvider({name:'fake',baseUrl:'https://fake.invalid/v1',encryptedApiKey:secrets.encrypt('isolated-test-key'),reasoningProtocol:'openai',models:[{id:'reasoner',supportsVision:true,supportsThinking:false,supportsTools:true,supportsStructuredOutput:true,imageApiKind:null},{id:'gpt-image-1.5',supportsVision:false,supportsThinking:false,supportsTools:false,supportsStructuredOutput:false,imageApiKind:'openai_images'},{id:'sam',supportsVision:false,supportsThinking:false,supportsTools:false,supportsStructuredOutput:false,imageApiKind:null}]});
 const project=repository.createProject({name:'cup',category:null,productDescription:null,verifiedFacts:['ceramic'],prohibitedClaims:[],brandGuidelines:{},platformTargets:['TAOBAO'],targetMarket:null,copyLanguage:null,promptLanguage:'EN',reasoningProviderId:provider.id,reasoningModelId:'reasoner',imageProviderId:provider.id,imageModelId:'gpt-image-1.5',defaultMode:'CREATIVE',imageResolution:'1K',imageAspectRatio:'1:1',candidatesPerType:2});
 repository.saveUserTemplate({id:'custom-test',name:'测试模板',prompt:'Commercial cup photograph',defaultSize:'1024x1024',supportsImageReference:true});
 repository.saveStoryboard(project.id,'consistent light','CONFIRMED',[{assetType:'custom-test',displayName:'杯子首图',shotRole:'HERO',templateVariant:null,candidateCount:2,referencedAssets:[],mode:'CREATIVE',status:'CONFIRMED',promptInstruction:'Commercial ceramic cup on a wooden table',compiledPrompt:null,factClaims:[],riskFlags:[],sortOrder:0,imageProviderId:provider.id,imageModelId:'gpt-image-1.5',imageResolution:'1K',imageAspectRatio:'1:1'}]);
 const item=repository.listStoryboardItems(project.id)[0]!;
 const original=await png();const source=await storage.putAsset(project.id,'truth.png',original);
 repository.createAsset({projectId:project.id,kind:'PRODUCT',role:'PRODUCT_TRUTH',storagePath:source.path,hash:source.hash,mimeType:'image/png',width:24,height:24,originalName:'truth.png'});
 const sourceJob=repository.createJob({id:randomUUID(),projectId:project.id,storyboardItemId:item.id,type:'GENERATE',input:{}});
 const stored=await storage.putOutput(project.id,original);
 const output=repository.createOutput({projectId:project.id,storyboardItemId:item.id,jobId:sourceJob.id,candidateIndex:1,storagePath:stored.path,hash:stored.hash,width:24,height:24,generationKey:generationKeyFor(sourceJob.id,1)});
 repository.updateJob(sourceJob.id,{status:'SUCCEEDED'});
 const patternFile=await storage.putPatternArtifact('pattern-fixture','pattern',original);
 const pattern=repository.createPattern({id:'pattern-fixture',name:'花朵',sourceType:'UPLOADED',sourceJobId:null,sourceAssetHash:null,parentPatternId:null,storagePath:patternFile.path,fileHash:patternFile.hash,width:24,height:24,tags:[]});
 context.transaction(()=>resources.register({ref:{kind:'PATTERN',id:pattern.id},relativePath:patternFile.path,hash:patternFile.hash,mimeType:'image/png',owners:[`pattern:${pattern.id}`]}));
 let responseText='{}',imageCalls=0,failImage=0;const requests:Array<{url:string;body:any;headers:Headers}>=[];
 const network:typeof fetch=async(input,init)=>{
   const url=input instanceof Request?input.url:String(input);const body=init?.body instanceof FormData?Object.fromEntries(init.body.entries()):JSON.parse(String(init?.body??'{}'));requests.push({url,body,headers:new Headers(init?.headers)});
   if(url.includes('/chat/completions'))return sse(responseText);
   if(body.layer_decomposition)return Response.json({data:[{z_index:1,name:'cup',bounding_box:{normalized:[0,0,1000,1000]},url:`data:image/png;base64,${(await png(5)).toString('base64')}`}]});
   if(url.includes('/images/')){imageCalls++;if(imageCalls===failImage)throw new Error('connection lost after send');return Response.json({data:[{b64_json:(await png(80+imageCalls)).toString('base64')}]});}
   if(url.includes('/v1/'))return Response.json({masks:[{data:(await sharp(Buffer.alloc(24*24,255),{raw:{width:24,height:24,channels:1}}).png().toBuffer()).toString('base64'),width:24,height:24,bbox:{x:0,y:0,width:1,height:1}}]});
   throw new Error(`Unexpected fake endpoint: ${url}`);
 };
 vi.stubGlobal('fetch',network);
 const add=(type:ExecutorType,input:Record<string,unknown>,options:{project?:boolean;item?:boolean;reasoning?:boolean;before?:(job:JobRecord)=>void}={})=>context.transaction(()=>{
   const job=repository.createJob({id:randomUUID(),projectId:options.project?project.id:null,storyboardItemId:options.item?item.id:null,type,input,providerId:provider.id,modelId:options.reasoning?'reasoner':'gpt-image-1.5'});
   options.before?.(job);scheduler.freeze(job.id,createExecutionSnapshot(context,job));return job;
 });
 const run=async(job:JobRecord,status='SUCCEEDED')=>{scheduler.start();scheduler.enqueue(job.id);await vi.waitFor(()=>expect(['SUCCEEDED','FAILED','CANCELLED','UNKNOWN']).toContain(repository.getJob(job.id)!.status),{timeout:15000,interval:10});await scheduler.waitForIdle([job.id]);const current=repository.getJob(job.id)!;if(current.status!==status&&executionErrors.length)throw executionErrors.at(-1);expect(current.status).toBe(status);return current;};
 const waitForCompletion=async(job:JobRecord)=>{
   // retry 通过 setImmediate 认领任务；先离开 QUEUED，waitForIdle 才能等到本次执行的 Promise。
   await vi.waitFor(()=>expect(['RUNNING','SUCCEEDED','FAILED','CANCELLED','UNKNOWN']).toContain(repository.getJob(job.id)?.status));
   await scheduler.waitForIdle([job.id]);
 };
 const exec=(job:JobRecord):ExecutionContext=>{
   repository.updateJob(job.id,{status:'RUNNING'});store.mutate(job.id,state=>{state.phase='EXECUTING';state.runToken='direct';state.attempt=1;});
   return {...context,job:repository.getJob(job.id)!,snapshot:store.get(job.id)!.snapshot,attempt:1,external:ledger.forJob(job.id,context.signal),assertCurrent:()=>{if(repository.getJob(job.id)?.status!=='RUNNING')throw new Error('STALE_ATTEMPT');},progress:progress=>{repository.updateJob(job.id,{progress});},checkpoint:work=>context.transaction(work)};
 };
 cleanups.push(async()=>{await scheduler.close();db.close();await rm(root,{recursive:true,force:true});});
 return {root,db,repository,storage,secrets,store,ledger,resources,scheduler,context,provider,project,item,output,pattern,add,run,waitForCompletion,exec,requests,setText:(value:unknown,fenced=false)=>{responseText=fenced?'```json\n'+JSON.stringify(value)+'\n```':JSON.stringify(value);},failImage:(number:number)=>{failImage=number;},get imageCalls(){return imageCalls;}};
}

describe('完整执行器与持久业务结果',()=>{
 it('完整注册20类型，未知分派明确拒绝',async()=>{
  const f=await fixture();expect(Object.keys(registerExecutors(f.context))).toEqual([...EXECUTOR_TYPES]);
  const job=f.add('EXPORT',{}, {project:true});const context=f.exec(job);
  await expect(executeDomainJob({...context,snapshot:{...context.snapshot,type:'BAD' as never}},{...job,type:'BAD' as never})).rejects.toThrow('UNKNOWN_JOB_TYPE');
 });
 it('GENERATE读取冻结模型/模板/事实，并登记可解析产物；已有结果不再修订提示词',async()=>{
  const f=await fixture();f.setText({prompt:'Commercial ceramic cup on a brighter wooden table'});const job=f.add('GENERATE',{candidateIndex:2,revision:'make it brighter'},{project:true,item:true});
  f.repository.deleteUserTemplate('custom-test');f.repository.updateProject(f.project.id,{name:'changed',verifiedFacts:['changed']});
  f.repository.saveProvider({...f.provider,baseUrl:'https://changed.invalid/v1',encryptedApiKey:f.secrets.encrypt('changed-key')});
  await f.run(job);expect(f.imageCalls).toBe(1);const result=f.repository.getOutputByGenerationKey(generationKeyFor(job.id,2))!;
  expect(result.candidateIndex).toBe(2);expect((await f.resources.resolve({kind:'OUTPUT',id:result.id})).hash).toBe(result.hash);
  const before=f.requests.length;expect(f.requests.filter(request=>request.url.includes('/chat/completions'))).toHaveLength(1);expect(f.requests.every(request=>request.url.startsWith('https://fake.invalid/')&&request.headers.get('authorization')==='Bearer isolated-test-key')).toBe(true);
  const duplicate=f.exec(job);await executeDomainJob(duplicate);expect(f.imageCalls).toBe(1);expect(f.requests.length).toBe(before);
 });
 it('PATTERN_FORGE/VARIANT/DERIVE/TILE_CHECK执行真实处理并保留稳定候选与血缘',async()=>{
  const f=await fixture();const forge=f.add('PATTERN_FORGE',{theme:'flowers',background:'WHITE',candidateCount:2});await f.run(forge);
  expect(f.repository.getPattern(candidateIdFor(forge.id,1))?.storagePath).toBeTruthy();expect(f.repository.getPattern(candidateIdFor(forge.id,2))?.storagePath).toBeTruthy();
  const derive=f.add('PATTERN_DERIVE',{patternId:f.pattern.id,hueShift:90});await f.run(derive);expect(f.repository.listPatternsByJobId(derive.id)[0]?.parentPatternId).toBe(f.pattern.id);
  const variant=f.add('PATTERN_VARIANT',{patternId:f.pattern.id,axis:'STYLE',preset:'WATERCOLOR',background:'WHITE',candidateCount:2});await f.run(variant);expect(f.repository.listPatternsByJobId(variant.id)).toHaveLength(2);
  const check=f.add('PATTERN_TILE_CHECK',{patternId:f.pattern.id});await f.run(check);expect(f.repository.getPattern(f.pattern.id)?.tileable).toBe('VERIFIED');expect(f.repository.getPattern(f.pattern.id)?.fileHash).toBe(f.pattern.fileHash);
 });
 it('MODEL_CAST的每个候选有独立请求键，重放不会按完成数量重发',async()=>{
  const f=await fixture();const model=f.repository.createModel({name:'model',spec:MODEL_SPEC_DEFAULTS,notes:''});
  const job=f.add('MODEL_CAST',{modelId:model.id,spec:model.spec,candidateCount:2,aspectRatio:'1:1'});await f.run(job);
  expect(f.repository.listModelPortraits(model.id)).toHaveLength(2);expect(f.ledger.summaries(job.id).map(row=>row.localState)).toEqual(['COMMITTED','COMMITTED']);
  await executeDomainJob(f.exec(job));expect(f.imageCalls).toBe(2);
 });
 it('草稿 GENERATE/EDIT/PROCESS/CUTOUT有真实候选与alpha，未知槽位阻止通用和补偿重试',async()=>{
  const f=await fixture();const draft=f.repository.createPatternDraft({name:'draft',composeType:'REPEAT',conditions:{}});
  const batch=(operation:any,parentCandidateId:string|null,snapshot:Record<string,unknown>,type:ExecutorType)=>{
   const {batch}=f.repository.createDraftBatch({draftId:draft.id,operation,parentCandidateId,providerId:f.provider.id,imageModelId:'gpt-image-1.5',candidateCount:1,instruction:null,snapshot:{...snapshot,parentCandidateId},clientKey:randomUUID()});
   const job=f.add(type,{draftId:draft.id,batchId:batch.id,slots:[1],task:'BATCH'},{before:job=>f.repository.assignDraftSlotsToJob(batch.id,[1],job.id,false)});return {batch,job};
  };
  const generate=batch('GENERATE',null,{theme:'flower',background:'WHITE'},'PATTERN_DRAFT_GENERATE');await f.run(generate.job);const parent=f.repository.listDraftCandidates(draft.id)[0]!;
  const edit=batch('EDIT',parent.id,{instruction:'blue flowers',background:'WHITE'},'PATTERN_DRAFT_EDIT');await f.run(edit.job);
  const recolor=batch('RECOLOR',parent.id,{recolor:{hueShift:90}},'PATTERN_DRAFT_PROCESS');await f.run(recolor.job);
  const cutout=batch('CUTOUT',parent.id,{segmentation:{providerId:f.provider.id,modelId:'sam',protocol:'grounded_sam'}},'PATTERN_DRAFT_CUTOUT');await f.run(cutout.job);
  const check=f.add('PATTERN_DRAFT_PROCESS',{draftId:draft.id,candidateId:parent.id,task:'TILE_CHECK'});await f.run(check);
  expect(f.repository.listDraftCandidates(draft.id)).toHaveLength(4);expect(f.repository.getDraftCandidate(parent.id)?.tileable).toBe('VERIFIED');
  const unknown=batch('GENERATE',null,{theme:'flower',background:'WHITE'},'PATTERN_DRAFT_GENERATE');f.failImage(f.imageCalls+1);await f.run(unknown.job,'UNKNOWN');
  expect(f.repository.listDraftSlots(unknown.batch.id)[0]?.status).toBe('UNKNOWN');expect(()=>f.scheduler.retry(unknown.job.id)).toThrow();
  expect(()=>f.repository.assignDraftSlotsToJob(unknown.batch.id,[1],randomUUID(),true)).toThrow();
 });
 it('PATTERN_EXTRACT与SAM图层导出使用原始像素并生成真实PSD/PNG',async()=>{
  const f=await fixture();const extraction=f.repository.createPattern({name:'extract',sourceType:'EXTRACTED',sourceJobId:null,sourceAssetHash:f.output.hash,parentPatternId:null,storagePath:null,fileHash:null,width:null,height:null,tags:[]});
  const extract=f.add('PATTERN_EXTRACT',{patternId:extraction.id,sourcePath:f.output.storagePath,protocol:'grounded_sam',segmentationProviderId:f.provider.id,segmentationModelId:'sam'});await f.run(extract);
  expect(f.repository.getPattern(extraction.id)?.width).toBe(24);
  const layer=f.add('LAYER_EXPORT',{segmentationProviderId:f.provider.id,segmentationModelId:'sam',segmentationProtocol:'grounded_sam',elements:[{id:'box',name:'cup',source:'manual',bbox:{x:0,y:0,width:1,height:1}}]},{project:true,before:job=>f.repository.createLayerExport({projectId:f.project.id,outputId:f.output.id,jobId:job.id,planId:null,status:'QUEUED',includeBackground:true,psdStoragePath:null,layerFiles:null,error:null})});
  await f.run(layer);const exported=f.repository.getLayerExportByJobId(layer.id)!;expect(exported.layerFiles).toHaveLength(3);expect((await f.storage.read(exported.psdStoragePath!)).subarray(0,4).toString()).toBe('8BPS');
  expect((await f.resources.resolve({kind:'LAYER_PSD',id:exported.id})).mimeType).toBe('image/vnd.adobe.photoshop');
 });
 it('Seedream提示词分层仅以模型alpha取源像素，不混入生成RGB',async()=>{
  const f=await fixture();const job=f.add('LAYER_EXPORT',{segmentationProviderId:f.provider.id,segmentationModelId:'sam',segmentationProtocol:'seedream_layerize',elements:[{id:'cup',name:'cup',source:'prompt',bbox:null}]},{project:true,before:job=>f.repository.createLayerExport({projectId:f.project.id,outputId:f.output.id,jobId:job.id,planId:null,status:'QUEUED',includeBackground:false,psdStoragePath:null,layerFiles:null,error:null})});await f.run(job);
  const record=f.repository.getLayerExportByJobId(job.id)!;const element=record.layerFiles!.find(file=>file.kind==='element')!;expect(await sharp(await f.storage.read(element.storagePath)).ensureAlpha().raw().toBuffer()).toEqual(await sharp(await f.storage.read(f.output.storagePath)).ensureAlpha().raw().toBuffer());expect(f.ledger.summaries(job.id)[0]?.state).toBe('COMPLETED');
 });
 it('PLAN/COPYWRITE/LISTING/LAYER_PLAN走实际Pi SSE与逐轮账本',async()=>{
  const f=await fixture();
  f.setText({campaignStyleLock:'clean',items:[{assetType:'custom-test',displayName:'清晨杯子',shotRole:'HERO',templateVariant:null,candidateCount:2,referencedAssets:['P1'],mode:'CREATIVE',promptInstruction:'Commercial ceramic cup on a clean table',factClaims:[],riskFlags:[]}]});
  const plan=f.add('PLAN',{planningMode:'MANUAL',requestedTypes:['custom-test']},{project:true,reasoning:true});await f.run(plan);expect(f.repository.listPlanningConfigSnapshots(f.project.id)[0]?.sourceJobId).toBe(plan.id);
  f.setText({productName:'ceramic cup',coreSellingPoints:['ceramic'],suitableAudience:'adults',expectedScenarios:'daily use'});const copy=f.add('COPYWRITE',{target:'PRODUCT_DESCRIPTION'},{project:true,reasoning:true});await f.run(copy);expect(f.repository.getCopywritingResult(copy.id)?.content).toContain('ceramic');
  f.setText({title:'Ceramic Flower Art',description:'Flower artwork for printed gifts',tags:['flower'],bullets:[]});const listing=f.add('COPYWRITE',{target:'LISTING',patternId:f.pattern.id,platform:'ETSY'},{reasoning:true});await f.run(listing);expect(f.repository.getPatternListingResult(listing.id)?.patternId).toBe(f.pattern.id);
  f.setText({elements:[{name:'杯身',promptEn:'cup body'}]});const layer=f.add('LAYER_PLAN',{reasoningProviderId:f.provider.id,reasoningModelId:'reasoner'},{project:true,reasoning:true,before:job=>f.repository.createLayerPlan({projectId:f.project.id,outputId:f.output.id,jobId:job.id,outputHash:f.output.hash,status:'QUEUED',elements:[],error:null})});await f.run(layer);expect(f.repository.getLayerPlanByJobId(layer.id)?.elements[0]?.promptEn).toBe('cup body');
  for(const job of [plan,copy,listing,layer])expect(f.ledger.summaries(job.id)[0]?.localState).toBe('COMMITTED');
 });
 it('EDIT_PLAN确认/NEED_INPUT不提前生图，无确认计划原子创建一个子任务并保存谱系',async()=>{
  const f=await fixture();const session=f.repository.createEditSession({id:randomUUID(),projectId:f.project.id,currentOutputId:f.output.id,status:'ACTIVE',memorySummary:{}});
  const turn=()=>f.repository.createEditTurn({id:randomUUID(),sessionId:session.id,projectId:f.project.id,baseOutputId:f.output.id,status:'PLANNING',message:'change the background',annotations:{},editMaskPath:null,editMaskHash:null,protectMaskPath:null,protectMaskHash:null,referenceAssetIds:[],plan:null,error:null});
  const first=turn();f.setText({operation:'NATURAL_FUSION',executionMode:'NEED_INPUT',userSummary:'请补充',prompt:'',targetDescription:'cup',targetConfidence:0.4,clarification:'Choose the background',targetAnnotationIds:[],memoryPatch:{}});
  const need=f.add('EDIT_PLAN',{editTurnId:first.id,turnId:first.id},{project:true,reasoning:true});await f.run(need);expect(f.repository.getEditTurn(first.id)?.status).toBe('NEED_INPUT');expect(f.imageCalls).toBe(0);
  const second=turn();f.setText({operation:'NATURAL_FUSION',executionMode:'MODEL_DIRECTED',userSummary:'调整背景',prompt:'Change background only',targetDescription:'background',targetConfidence:0.9,clarification:null,targetAnnotationIds:[],memoryPatch:{summary:'new background'}});
  const planning=f.add('EDIT_PLAN',{editTurnId:second.id,turnId:second.id},{project:true,reasoning:true});await f.run(planning);expect(f.repository.getEditTurn(second.id)?.status).toBe('AWAITING_CONFIRMATION');expect(f.imageCalls).toBe(0);
  f.repository.updateEditTurn(second.id,{status:'GENERATING'});
  const generate=f.add('EDIT_GENERATE',{editTurnId:second.id,turnId:second.id},{project:true});await f.run(generate);const outputs=f.repository.listEditOutputs(session.id);expect(outputs).toHaveLength(2);expect(outputs.every(out=>out.parentOutputId===f.output.id&&out.editTurnId===second.id)).toBe(true);
 });
 it('无效编辑规划仅在明确重试后重新请求，保留回执和计量',async()=>{
  const f=await fixture();const session=f.repository.createEditSession({id:randomUUID(),projectId:f.project.id,currentOutputId:f.output.id,status:'ACTIVE',memorySummary:{}});
  const turn=f.repository.createEditTurn({id:randomUUID(),sessionId:session.id,projectId:f.project.id,baseOutputId:f.output.id,status:'PLANNING',message:'change color',annotations:{},editMaskPath:null,editMaskHash:null,protectMaskPath:null,protectMaskHash:null,referenceAssetIds:[],plan:null,error:null});
  f.setText({operation:'EDIT_IMAGE',executionMode:'MASKED_EDIT',userSummary:'调整',prompt:'edit',targetDescription:'cup',targetConfidence:1});
  const job=f.add('EDIT_PLAN',{editTurnId:turn.id},{project:true,reasoning:true});await f.run(job,'FAILED');
  expect(f.repository.getJob(job.id)?.error?.code).toBe('EDIT_PLAN_INVALID');expect(f.requests.filter(r=>r.url.includes('/chat/completions'))).toHaveLength(1);
  const original=f.store.get(job.id)!.requests[0]!;expect(original.state).toBe('COMPLETED');
  f.setText({operation:'NATURAL_FUSION',executionMode:'NEED_INPUT',userSummary:'请补充',prompt:'',targetDescription:'cup',targetConfidence:0.4,clarification:'请选择颜色',targetAnnotationIds:[],memoryPatch:{}});
  expect(f.scheduler.resolveInterruptions({jobId:job.id,action:'RETRY'}).items[0]?.status).toBe('RETRIED');await f.waitForCompletion(job);
  expect(f.repository.getJob(job.id)?.status).toBe('SUCCEEDED');expect(f.repository.getEditTurn(turn.id)?.status).toBe('NEED_INPUT');expect(f.imageCalls).toBe(0);
  expect(f.requests.filter(r=>r.url.includes('/chat/completions'))).toHaveLength(2);expect(f.store.get(job.id)?.requestHistory).toContainEqual({...original,rejectedEditPlan:true});
  expect((f.db.prepare('SELECT request_key FROM desktop_usage_records WHERE job_id=?').all(job.id))).toHaveLength(2);
 });
 it.each([false,true])('旧 INTERNAL_ERROR 的非法规划可在用户重试后跨提示指纹恢复（围栏=%s）',async fenced=>{
  const f=await fixture();const session=f.repository.createEditSession({id:randomUUID(),projectId:f.project.id,currentOutputId:f.output.id,status:'ACTIVE',memorySummary:{}});
  const turn=f.repository.createEditTurn({id:randomUUID(),sessionId:session.id,projectId:f.project.id,baseOutputId:f.output.id,status:'PLANNING',message:'change color',annotations:{},editMaskPath:null,editMaskHash:null,protectMaskPath:null,protectMaskHash:null,referenceAssetIds:[],plan:null,error:null});
  f.setText({operation:'EDIT_IMAGE',executionMode:'MASKED_EDIT',userSummary:'调整',prompt:'edit',targetDescription:'cup',targetConfidence:1},fenced);
  const job=f.add('EDIT_PLAN',{editTurnId:turn.id},{project:true,reasoning:true});await f.run(job,'FAILED');
  f.repository.updateJob(job.id,{error:{code:'INTERNAL_ERROR',message:'操作失败，请重试。'}});
  f.store.mutate(job.id,state=>{state.requests[0]!.descriptor.fingerprint='a'.repeat(64);});
  const original=f.store.get(job.id)!.requests[0]!;expect(f.requests).toHaveLength(1);
  f.setText({operation:'NATURAL_FUSION',executionMode:'NEED_INPUT',userSummary:'请补充',prompt:'',targetDescription:'cup',targetConfidence:0.4,clarification:'请选择颜色',targetAnnotationIds:[],memoryPatch:{}});
  expect(f.scheduler.resolveInterruptions({jobId:job.id,action:'RETRY'}).items[0]?.status).toBe('RETRIED');await f.waitForCompletion(job);
  expect(f.repository.getJob(job.id)?.status).toBe('SUCCEEDED');expect(f.repository.getEditTurn(turn.id)?.status).toBe('NEED_INPUT');
  expect(f.requests).toHaveLength(2);expect(f.imageCalls).toBe(0);expect(f.store.get(job.id)?.requestHistory).toContainEqual({...original,rejectedEditPlan:true});
  expect(f.db.prepare('SELECT request_key FROM desktop_usage_records WHERE job_id=?').all(job.id)).toHaveLength(2);
 });
 it('旧 INTERNAL_ERROR 的有效完整规划遇到新指纹时保留回执且不发送请求',async()=>{
  const f=await fixture();const session=f.repository.createEditSession({id:randomUUID(),projectId:f.project.id,currentOutputId:f.output.id,status:'ACTIVE',memorySummary:{}});
  const makeTurn=()=>f.repository.createEditTurn({id:randomUUID(),sessionId:session.id,projectId:f.project.id,baseOutputId:f.output.id,status:'PLANNING',message:'change color',annotations:{},editMaskPath:null,editMaskHash:null,protectMaskPath:null,protectMaskHash:null,referenceAssetIds:[],plan:null,error:null});
  f.setText({operation:'NATURAL_FUSION',executionMode:'NEED_INPUT',userSummary:'请补充',prompt:'',targetDescription:'cup',targetConfidence:0.4,clarification:'请选择颜色',targetAnnotationIds:[],memoryPatch:{}});
  const validTurn=makeTurn(),valid=f.add('EDIT_PLAN',{editTurnId:validTurn.id},{project:true,reasoning:true});await f.run(valid);
  const receipt=f.store.get(valid.id)!.requests[0]!;
  const turn=makeTurn();f.setText({operation:'EDIT_IMAGE',executionMode:'MASKED_EDIT',userSummary:'调整',prompt:'edit',targetDescription:'cup',targetConfidence:1});
  const job=f.add('EDIT_PLAN',{editTurnId:turn.id},{project:true,reasoning:true});await f.run(job,'FAILED');
  f.repository.updateJob(job.id,{error:{code:'INTERNAL_ERROR',message:'操作失败，请重试。'}});
  f.store.mutate(job.id,state=>{const request=state.requests[0]!;request.encryptedReceipt=receipt.encryptedReceipt;request.responseHash=receipt.responseHash;request.descriptor.fingerprint='a'.repeat(64);});
  const original=f.store.get(job.id)!.requests[0]!,calls=f.requests.length;
  f.scheduler.retry(job.id);await f.waitForCompletion(job);
  expect(f.repository.getJob(job.id)?.status).toBe('FAILED');
  expect(f.requests).toHaveLength(calls);expect(f.store.get(job.id)?.requests).toContainEqual(original);expect(f.store.get(job.id)?.requestHistory??[]).toHaveLength(0);
 });
 it('蒙版编辑规划可要求补充，且不创建生图任务',async()=>{
  const f=await fixture();const session=f.repository.createEditSession({id:randomUUID(),projectId:f.project.id,currentOutputId:f.output.id,status:'ACTIVE',memorySummary:{}});
  const mask=await sharp(Buffer.alloc(24*24,255),{raw:{width:24,height:24,channels:1}}).png().toBuffer();const stored=await f.storage.putEditArtifact(f.project.id,session.id,'need-input-mask','mask.png',mask);
  const turn=f.repository.createEditTurn({id:randomUUID(),sessionId:session.id,projectId:f.project.id,baseOutputId:f.output.id,status:'PLANNING',message:'change color',annotations:{},editMaskPath:stored.path,editMaskHash:stored.hash,protectMaskPath:null,protectMaskHash:null,referenceAssetIds:[],plan:null,error:null});
  f.setText({operation:'PRECISE_INPAINT',executionMode:'NEED_INPUT',userSummary:'请补充',prompt:'',targetDescription:'cup',targetConfidence:0.4,clarification:'请选择颜色',targetAnnotationIds:[],memoryPatch:{}});
  const job=f.add('EDIT_PLAN',{editTurnId:turn.id},{project:true,reasoning:true});await f.run(job);expect(f.repository.getEditTurn(turn.id)?.status).toBe('NEED_INPUT');expect(f.imageCalls).toBe(0);expect(f.repository.getJob(candidateIdFor(job.id,0))).toBeFalsy();
 });
 it('PRINT_PACK和EXPORT写出可解析PNG/ZIP，含长图与印刷manifest',async()=>{
  const f=await fixture();const pack=f.add('PRINT_PACK',{patternId:f.pattern.id,layout:'TILE',repeatLayout:'MIRROR'},{before:job=>f.repository.createPrintPack({patternId:f.pattern.id,jobId:job.id,specId:'mug-11oz-wrap',specVersion:POD_PRINT_SPEC_VERSION,status:'QUEUED'})});await f.run(pack);
  const record=f.repository.getPrintPackByJobId(pack.id)!;expect(record.files.map(file=>file.kind)).toContain('SEAMLESS_TILE');expect(record.manifest?.seam).toBe('by-construction');
  const job=f.add('EXPORT',{outputIds:[f.output.id],longImage:{targetWidth:320,sliceHeight:640}},{project:true,before:job=>f.repository.createExport({projectId:f.project.id,jobId:job.id,status:'QUEUED',storagePath:null})});await f.run(job);const exported=f.repository.getExportByJobId(job.id)!;expect((await f.storage.read(exported.storagePath!)).subarray(0,2).toString()).toBe('PK');await expect(f.resources.resolve({kind:'EXPORT',id:exported.id})).resolves.toBeTruthy();
 });
 it('SUITE_FORGE保存经过契约验证的草稿，并复用任务结果',async()=>{
  const f=await fixture();f.setText({name:'清爽杯子套图',category:{l1:'家居',l2:'杯具',leaf:'陶瓷杯'},styleLock:{lockText:'Consistent warm lighting'},shots:[{shotId:'hero',order:1,shotRole:'HERO',displayName:'杯子主图',promptTemplate:'Photograph {product_description}, {style_lock}'}]});
  const job=f.add('SUITE_FORGE',{sources:[{storagePath:f.output.storagePath,hash:f.output.hash,originalName:'source.png',mimeType:'image/png'}]},{reasoning:true});await f.run(job);
  expect(f.repository.getSuiteForgeResult(job.id)?.payload.name).toBe('清爽杯子套图');const before=f.requests.length;await executeDomainJob(f.exec(job));expect(f.requests.length).toBe(before);
 });
 it('完整回执之后本地落盘失败，显式重试重放回执而不再次POST',async()=>{
  const f=await fixture();const job=f.add('GENERATE',{}, {project:true,item:true});const put=vi.spyOn(f.storage,'putOutput').mockRejectedValueOnce(new Error('isolated disk failure'));
  await f.run(job,'FAILED');expect(f.ledger.summaries(job.id)[0]?.state).toBe('COMPLETED');await f.scheduler.waitForIdle([job.id]);f.scheduler.retry(job.id);
  await f.waitForCompletion(job);expect(f.repository.getJob(job.id)?.status).toBe('SUCCEEDED');expect(f.imageCalls).toBe(1);expect(f.repository.getOutputByGenerationKey(generationKeyFor(job.id,1))).toBeTruthy();put.mockRestore();
 });
 it('草稿安全重试保留成功槽位，只重放缺失槽位的完整回执',async()=>{
  const f=await fixture();const draft=f.repository.createPatternDraft({name:'draft',composeType:'PLACEMENT',conditions:{}});const {batch}=f.repository.createDraftBatch({draftId:draft.id,operation:'GENERATE',parentCandidateId:null,providerId:f.provider.id,imageModelId:'gpt-image-1.5',candidateCount:2,instruction:null,snapshot:{theme:'flowers',background:'WHITE'},clientKey:randomUUID()});
  const job=f.add('PATTERN_DRAFT_GENERATE',{draftId:draft.id,batchId:batch.id,slots:[1,2]},{before:job=>f.repository.assignDraftSlotsToJob(batch.id,[1,2],job.id,false)});
  const put=vi.spyOn(f.storage,'putDraftCandidate').mockRejectedValueOnce(new Error('isolated disk failure'));await f.run(job,'FAILED');expect(f.repository.listDraftSlots(batch.id).map(slot=>slot.status)).toEqual(['FAILED','SUCCEEDED']);
  const successful=f.repository.listDraftCandidates(draft.id)[0]!;f.scheduler.retry(job.id);await f.waitForCompletion(job);expect(f.repository.getJob(job.id)?.status).toBe('SUCCEEDED');
  expect(f.imageCalls).toBe(2);expect(f.repository.listDraftCandidates(draft.id)).toHaveLength(2);expect(f.repository.getDraftCandidate(successful.id)).toEqual(successful);put.mockRestore();
 });
 it('编辑安全重试保留原任务快照与回执，继续缺失候选并同步turn',async()=>{
  const f=await fixture();const session=f.repository.createEditSession({id:randomUUID(),projectId:f.project.id,currentOutputId:f.output.id,status:'ACTIVE',memorySummary:{}});const turn=f.repository.createEditTurn({id:randomUUID(),sessionId:session.id,projectId:f.project.id,baseOutputId:f.output.id,status:'GENERATING',message:'adjust scene',annotations:{},editMaskPath:null,editMaskHash:null,protectMaskPath:null,protectMaskHash:null,referenceAssetIds:[],plan:{operation:'SCENE_ADJUST',executionMode:'MODEL_DIRECTED',prompt:'Adjust background only',compositePolicy:'PROVIDER_RESULT'},error:null});
  const job=f.add('EDIT_GENERATE',{editTurnId:turn.id},{project:true});const put=vi.spyOn(f.storage,'putOutput').mockRejectedValueOnce(new Error('isolated disk failure'));await f.run(job,'FAILED');const snapshot=JSON.stringify(f.store.get(job.id)?.snapshot);
  f.scheduler.retry(job.id);await f.waitForCompletion(job);expect(f.repository.getJob(job.id)?.status).toBe('SUCCEEDED');expect(f.repository.getEditTurn(turn.id)?.status).toBe('SUCCEEDED');expect(f.imageCalls).toBe(2);expect(f.repository.listEditOutputs(session.id)).toHaveLength(2);expect(JSON.stringify(f.store.get(job.id)?.snapshot)).toBe(snapshot);put.mockRestore();
 });
 it('无需确认的蒙版编辑只创建一个冻结子任务，自动执行并保留候选',async()=>{
  const f=await fixture();const session=f.repository.createEditSession({id:randomUUID(),projectId:f.project.id,currentOutputId:f.output.id,status:'ACTIVE',memorySummary:{}});
  const mask=await sharp(Buffer.alloc(24*24,255),{raw:{width:24,height:24,channels:1}}).png().toBuffer();const stored=await f.storage.putEditArtifact(f.project.id,session.id,'turn-mask','mask.png',mask);
  const turn=f.repository.createEditTurn({id:randomUUID(),sessionId:session.id,projectId:f.project.id,baseOutputId:f.output.id,status:'PLANNING',message:'change color',annotations:{},editMaskPath:stored.path,editMaskHash:stored.hash,protectMaskPath:null,protectMaskHash:null,referenceAssetIds:[],plan:null,error:null});
  f.setText({operation:'PRECISE_INPAINT',executionMode:'MASKED',userSummary:'改变颜色',prompt:'Change the selected color only',targetDescription:'cup',targetConfidence:1,clarification:null,targetAnnotationIds:[],memoryPatch:{}});
  const job=f.add('EDIT_PLAN',{editTurnId:turn.id},{project:true,reasoning:true});await f.run(job);const child=f.repository.getJob(candidateIdFor(job.id,0))!;expect(child.type).toBe('EDIT_GENERATE');
  // 子任务在父任务结算后独立调度；沿用 run() 的15秒等待边界，避免默认1秒受并行负载影响。
  await vi.waitFor(()=>expect(['SUCCEEDED','FAILED','CANCELLED','UNKNOWN']).toContain(f.repository.getJob(child.id)?.status),{timeout:15000,interval:10});
  expect(f.repository.getJob(child.id)?.status).toBe('SUCCEEDED');expect(f.repository.listEditOutputs(session.id)).toHaveLength(2);expect(f.repository.getEditTurn(turn.id)?.status).toBe('SUCCEEDED');
 });
 it('上下文拒绝旧slot attempt和已结束job的迟到写入',async()=>{
  const f=await fixture();const draft=f.repository.createPatternDraft({name:'draft',composeType:'PLACEMENT',conditions:{}});const {batch}=f.repository.createDraftBatch({draftId:draft.id,operation:'GENERATE',parentCandidateId:null,providerId:f.provider.id,imageModelId:'gpt-image-1.5',candidateCount:1,instruction:null,snapshot:{theme:'flowers'},clientKey:randomUUID()});
  const job=f.add('PATTERN_DRAFT_GENERATE',{draftId:draft.id,batchId:batch.id,slots:[1]},{before:job=>f.repository.assignDraftSlotsToJob(batch.id,[1],job.id,false)});const runtime=f.exec(job);const ctx=createExecutionContext(runtime);
  f.repository.updateDraftSlot(batch.id,1,{attempt:9});expect(()=>ctx.repository.updateDraftSlot(batch.id,1,{status:'SUCCEEDED'})).toThrow('STALE_SLOT_ATTEMPT');
  f.repository.updateJob(job.id,{status:'CANCELLED'});expect(()=>ctx.repository.createPattern({name:'late',sourceType:'GENERATED',sourceJobId:job.id,sourceAssetHash:null,parentPatternId:null,storagePath:null,fileHash:null,width:null,height:null,tags:[]})).toThrow('STALE_ATTEMPT');
 });
 it('SOURCE→验缝→规格包→Listing逐步冻结并真实完成，不重复推进',async()=>{
  const f=await fixture();f.setText({title:'Printed Ceramic Flower',description:'Artwork for everyday gifts',tags:['flower'],bullets:[]});
  const pipeline=f.repository.createPatternPipeline({patternId:null,specId:'mug-11oz-wrap',specVersion:POD_PRINT_SPEC_VERSION,layout:'TILE',repeatLayout:'MIRROR',listingPlatform:'ETSY',listingProviderId:f.provider.id,listingModelId:'reasoner',listingHints:{sellingPoints:null,bannedWords:null},requestFingerprint:null,steps:pipelineStepPlan(true)});
  const source=f.add('PATTERN_FORGE',{theme:'flowers',candidateCount:2,background:'WHITE'},{before:job=>f.repository.updatePatternPipelineStep(pipeline.steps[0]!.id,{jobId:job.id,status:'QUEUED'})});await f.run(source);
  await vi.waitFor(()=>expect(f.repository.getPatternPipeline(pipeline.id)?.status).toBe('SUCCEEDED'),{timeout:15000,interval:20});
  const result=f.repository.getPatternPipeline(pipeline.id)!;expect(result.patternId).toBe(candidateIdFor(source.id,1));expect(result.steps.map(step=>step.status)).toEqual(['SUCCEEDED','SUCCEEDED','SUCCEEDED','SUCCEEDED']);expect(new Set(result.steps.map(step=>step.jobId)).size).toBe(4);
  expect(f.repository.getPatternListingResult(result.steps[3]!.jobId!)?.patternId).toBe(result.patternId);
 });
 it('流水线验缝闸门保留风险，镜像继续创建并冻结下一步；旧步骤不能推进',async()=>{
  const f=await fixture();const pipeline=f.repository.createPatternPipeline({patternId:f.pattern.id,specId:'mug-11oz-wrap',specVersion:POD_PRINT_SPEC_VERSION,layout:'TILE',repeatLayout:'STRAIGHT',listingPlatform:'ETSY',listingProviderId:f.provider.id,listingModelId:'reasoner',listingHints:{sellingPoints:null,bannedWords:null},requestFingerprint:null,steps:pipelineStepPlan(false)});
  const job=f.context.transaction(()=>{const created=startPipelineStep(f.repository,pipeline,pipeline.steps[0]!,f.pattern.id);f.scheduler.freeze(created.job.id,createExecutionSnapshot(f.context,created.job));return created.job;});
  const runtime=f.store.get(job.id)!;f.repository.updatePatternPipelineStep(pipeline.steps[0]!.id,{status:'RUNNING'});
  f.repository.setPatternTileable(f.pattern.id,{status:'FAILED',score:0,algorithmVersion:'test'});f.context.transaction(()=>settleDomainJob(f.context,job,'SUCCEEDED',runtime));expect(f.repository.getPatternPipeline(pipeline.id)).toMatchObject({status:'AWAITING_INPUT',blockReason:'SEAM_RISK'});
  f.repository.updatePatternPipelineStep(pipeline.steps[0]!.id,{status:'RUNNING'});f.repository.updatePatternPipeline(pipeline.id,{repeatLayout:'MIRROR'});f.context.transaction(()=>settleDomainJob(f.context,job,'SUCCEEDED',runtime));
  const next=f.repository.getPatternPipeline(pipeline.id)!.steps[1]!;expect(next.jobId).toBeTruthy();expect(f.store.get(next.jobId!)?.snapshot.type).toBe('PRINT_PACK');
 });
});
