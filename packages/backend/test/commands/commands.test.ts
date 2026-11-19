import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import sharp from 'sharp';
import { Value } from '@sinclair/typebox/value';
import { ECOM_TEMPLATES } from '@ecomgen/ecom-skill';
import { EcomRepository, DesktopHistoryRepository, LocalAssetStore, SecretBox, SuiteCatalog, openDatabase } from '@ecomgen/core';
import { MODEL_SPEC_DEFAULTS, operations, type Input, type Operation, type Output } from '@ecomgen/contracts';
import { registerDomainCommands, RUNTIME_OWNED_COMMANDS } from '../../src/commands/index.js';
import { RuntimeStore } from '../../src/runtime/state.js';
import { ResourceRegistry } from '../../src/runtime/resources.js';
import { RequestLedger } from '../../src/runtime/request-ledger.js';
import { PersistentScheduler } from '../../src/runtime/scheduler.js';
import { registerExecutors } from '../../src/execution/index.js';
import type { CommandContext } from '../../src/runtime/ports.js';
import { assertPublicOutput, BackendError } from '../../src/validation.js';

describe('named domain commands on canonical SQLite', () => {
  let root: string, context: CommandContext, handlers: ReturnType<typeof registerDomainCommands>, db: ReturnType<typeof openDatabase>, store: RuntimeStore;
  let enqueued: string[], events: unknown[], png: Buffer;
  const invoke = async <K extends Operation>(name: K, input: Input<K>): Promise<Output<K>> => {
    expect(Value.Check(operations[name].input, input), JSON.stringify([...Value.Errors(operations[name].input,input)])).toBe(true);
    const result = await (handlers[name] as any)(context, input);
    expect(Value.Check(operations[name].output, result), `${name}: ${JSON.stringify([...Value.Errors(operations[name].output,result)])}`).toBe(true);
    assertPublicOutput(result); return result as Output<K>;
  };
  const provider = () => context.repository.saveProvider({ name: 'isolated', baseUrl: 'http://127.0.0.1:1/v1', encryptedApiKey: context.secrets.encrypt('fake-key-private'), reasoningProtocol: 'openai', models: [
    { id:'reason',supportsVision:true,supportsThinking:false,supportsTools:false,supportsStructuredOutput:true,imageApiKind:null },
    { id:'gpt-image-1',supportsVision:false,supportsThinking:false,supportsTools:false,supportsStructuredOutput:false,imageApiKind:'openai_images' },
    { id:'sam',supportsVision:false,supportsThinking:false,supportsTools:false,supportsStructuredOutput:false,imageApiKind:null,segmentationProtocol:'fal' },
  ] });
  const project = async (mode: 'CREATIVE'|'PIXEL_PROTECTED' = 'CREATIVE') => { const p = provider(); return invoke('createProject',{name:'new',reasoningProviderId:p.id,reasoningModelId:'reason',imageProviderId:p.id,imageModelId:'gpt-image-1',defaultMode:mode}); };
  const file = (bytes=png) => ({name:'generated.png',mimeType:'image/png' as const,base64:bytes.toString('base64')});
  const seedStoryboard = async (count=1) => {
    const p=await project(); const r=context.repository;
    r.saveStoryboard(p.id,'cohesive','DRAFT',Array.from({length:count},(_,index)=>({assetType:ECOM_TEMPLATES[0]!.id,displayName:`shot ${index}`,shotRole:null,templateVariant:null,candidateCount:2,referencedAssets:[],mode:'CREATIVE' as const,status:'DRAFT' as const,promptInstruction:'Preserve exact identity',compiledPrompt:null,factClaims:[],riskFlags:[],sortOrder:index})));
    return {project:p,items:r.listStoryboardItems(p.id),storyboard:r.getStoryboard(p.id)!};
  };
  const seedOutput = async () => {
    const seeded=await seedStoryboard();const r=context.repository;
    const job=r.createJob({id:randomUUID(),projectId:seeded.project.id,storyboardItemId:seeded.items[0]!.id,type:'GENERATE',input:{},status:'SUCCEEDED'});
    const stored=await context.storage.putOutput(seeded.project.id,png,'png',job.id);
    const output=r.createOutput({projectId:seeded.project.id,storyboardItemId:seeded.items[0]!.id,jobId:job.id,candidateIndex:1,generationSnapshot:null,storagePath:stored.path,hash:stored.hash,width:12,height:12,generationKey:job.id});
    return {...seeded,output};
  };
  beforeEach(async () => {
    root=await mkdtemp(join(tmpdir(),'ecomgen-commands-')); db=openDatabase(join(root,'test.sqlite')); const repository=new EcomRepository(db), storage=new LocalAssetStore(root); await storage.initialize();
    const secrets=new SecretBox(Buffer.alloc(32,9)); store=new RuntimeStore(db); const resources=new ResourceRegistry(store,storage), requestLedger=new RequestLedger(store,secrets,async()=>{throw new Error('unexpected external call');});
    const catalog=new SuiteCatalog({dataDir:root,repository,logger:()=>undefined}); await catalog.refresh(); const listSuites=catalog.listSuites.bind(catalog); catalog.listSuites=()=>listSuites().slice(0,2); enqueued=[];events=[];
    context={repository,storage,secrets,catalog,history:new DesktopHistoryRepository(db),resources,requestLedger,clock:()=>new Date().toISOString(),idFactory:randomUUID,signal:new AbortController().signal,transaction:cb=>store.transaction(cb),events:{publish:e=>{events.push(e);}},scheduler:{freeze:(id,snapshot)=>store.create(id,snapshot),enqueue:id=>{expect(db.inTransaction).toBe(false);expect(store.get(id)).toBeDefined();enqueued.push(id);},cancel:id=>repository.updateJob(id,{status:'CANCELLED',cancelRequested:true})!,waitForIdle:async()=>{},retry:()=>{throw new BackendError('CONFLICT','test retry disabled');}}};
    handlers=registerDomainCommands(context);
    png=await sharp({create:{width:12,height:12,channels:4,background:{r:200,g:50,b:10,alpha:1}}}).png().toBuffer();
  });
  afterEach(async()=>{db?.close();await rm(root,{recursive:true,force:true});});
  it('registers every declared domain operation exactly once',()=>{
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(operations).filter(n=>!(RUNTIME_OWNED_COMMANDS as readonly string[]).includes(n)).sort());
  });
  it('projects copywriting targets safely and atomically blocks instruction while description is active',async()=>{
    const p=await project(); await invoke('uploadAsset',{projectId:p.id,file:file(),kind:'PRODUCT'});
    const description=await invoke('createCopywritingJob',{projectId:p.id,target:'PRODUCT_DESCRIPTION',regenerationKey:'description-private'});
    expect(description.copywritingTarget).toBe('PRODUCT_DESCRIPTION');
    const detail=await invoke('getProject',{projectId:p.id});
    expect(detail.jobs.find(job=>job.id===description.id)).toMatchObject({copywritingTarget:'PRODUCT_DESCRIPTION'});
    expect(JSON.stringify(detail.jobs)).not.toMatch(/description-private|"input"/);
    await expect(invoke('createCopywritingJob',{projectId:p.id,target:'PLANNING_INSTRUCTION',regenerationKey:'instruction'})).rejects.toMatchObject({code:'CONFLICT'});
    context.repository.updateJob(description.id,{status:'RUNNING'});
    await expect(invoke('createCopywritingJob',{projectId:p.id,target:'PLANNING_INSTRUCTION',regenerationKey:'instruction'})).rejects.toMatchObject({code:'CONFLICT'});
    context.repository.updateJob(description.id,{status:'UNKNOWN',retryable:false});
    const instruction=await invoke('createCopywritingJob',{projectId:p.id,target:'PLANNING_INSTRUCTION',regenerationKey:'instruction'});
    expect(instruction.copywritingTarget).toBe('PLANNING_INSTRUCTION');
    const malformed=context.repository.createJob({id:randomUUID(),projectId:p.id,storyboardItemId:null,type:'COPYWRITE',input:{target:'private-target',secret:'private-input'},status:'FAILED'});
    const nonCopy=context.repository.createJob({id:randomUUID(),projectId:p.id,storyboardItemId:null,type:'PLAN',input:{target:'PRODUCT_DESCRIPTION'},status:'FAILED'});
    const jobs=(await invoke('getProject',{projectId:p.id})).jobs;
    expect(jobs.find(job=>job.id===malformed.id)).not.toHaveProperty('copywritingTarget');
    expect(jobs.find(job=>job.id===nonCopy.id)).not.toHaveProperty('copywritingTarget');
    expect(JSON.stringify(jobs)).not.toMatch(/private-target|private-input|"input"/);
  });
  it('keeps provider credentials private and preserves omitted keys',async()=>{
    const p=await invoke('createProvider',{name:'fake',baseUrl:'http://127.0.0.1:1',reasoningProtocol:'openai',apiKey:'fake-key-private',models:[{id:'r',supportsVision:true,supportsThinking:false,supportsTools:false,supportsStructuredOutput:true}]});
    expect(p.hasApiKey).toBe(true); const original=context.repository.getProvider(p.id)!.encryptedApiKey;
    await invoke('updateProvider',{providerId:p.id,name:'renamed'});
    expect(context.repository.getProvider(p.id)!.encryptedApiKey).toBe(original);
    const list=await invoke('listProviders',{}); expect(JSON.stringify(list)).not.toMatch(/fake-key-private|encryptedApiKey/);
  });
  it('rejects incompatible model declarations',async()=>{
    await expect(invoke('createProvider',{name:'bad',baseUrl:'http://127.0.0.1:1',reasoningProtocol:'openai',apiKey:'fake',models:[{id:'bad',supportsVision:true,supportsThinking:false,supportsTools:false,supportsStructuredOutput:false,imageApiKind:'openai_images',segmentationProtocol:'fal'}]})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  });
  it('allows CREATIVE planning without truth, freezes complete inputs, reuses duplicate',async()=>{
    const p=await project(); const job=await invoke('createPlanningJob',{projectId:p.id,targetImageCount:3}); expect(job.reused).toBe(false);expect(enqueued).toEqual([job.id]);
    const frozen=store.get(job.id)!.snapshot; expect((frozen.effective.execution as any).reads[`getProject:["${p.id}"]`].name).toBe('new');
    await invoke('updateProject',{projectId:p.id,productDescription:'new facts'});
    expect((store.get(job.id)!.snapshot.effective.execution as any).reads[`getProject:["${p.id}"]`].productDescription).toBe(null);
    const current=await invoke('createPlanningJob',{projectId:p.id,targetImageCount:3});expect(current.id).not.toBe(job.id);
    const duplicate=await invoke('createPlanningJob',{projectId:p.id,targetImageCount:3});expect(duplicate.id).toBe(current.id);expect(duplicate.reused).toBe(true);
  });
  it('rejects unknown templates and invalid planning semantic branches before writing',async()=>{
    const p=await project();await expect(invoke('createPlanningJob',{projectId:p.id,requestedTypes:['unknown-template']})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    await expect(invoke('createPlanningJob',{projectId:p.id,planningMode:'MANUAL',targetImageCount:2,requestedTypes:['unknown-template']})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    expect(context.repository.listJobs(p.id)).toEqual([]);
  });
  it('requires actual truth for protected planning and retains immutable file resources',async()=>{
    const p=await project('PIXEL_PROTECTED');await expect(invoke('createPlanningJob',{projectId:p.id})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    const asset=await invoke('uploadAsset',{projectId:p.id,file:file(),kind:'PRODUCT'});const job=await invoke('createPlanningJob',{projectId:p.id});
    expect(store.get(job.id)!.snapshot.resources).toContainEqual({ref:{kind:'ASSET',id:asset.id},hash:context.repository.getAsset(asset.id)!.hash});
    const handle=await invoke('downloadAsset',{assetId:asset.id});expect(handle.ref).toEqual({kind:'ASSET',id:asset.id});
  });
  it('validates real image bytes, deduplication and separate asset capacity',async()=>{
    const p=await project(); await invoke('uploadAsset',{projectId:p.id,file:file(),kind:'PRODUCT'});
    await expect(invoke('uploadAsset',{projectId:p.id,file:file(),kind:'REFERENCE'})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    for(let i=0;i<5;i++){const image=await sharp({create:{width:12,height:12,channels:3,background:{r:i*20,g:100,b:150}}}).png().toBuffer();await invoke('uploadAsset',{projectId:p.id,file:file(image),kind:'PRODUCT'});}
    const extra=await sharp(png).negate().png().toBuffer();await expect(invoke('uploadAsset',{projectId:p.id,file:file(extra),kind:'PRODUCT'})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    await invoke('uploadAsset',{projectId:p.id,file:file(extra),kind:'REFERENCE'});
    await expect(invoke('uploadAsset',{projectId:p.id,file:{name:'bad.png',mimeType:'image/png',base64:Buffer.from('bad bytes').toString('base64')},kind:'REFERENCE'})).rejects.toMatchObject({code:'INVALID_IMAGE'});
  });
  it('keeps project lifecycle and library copies independent',async()=>{
    const a=await project(),b=await project();const asset=await invoke('uploadAsset',{projectId:a.id,file:file(),kind:'PRODUCT'});
    const copied=await invoke('copyLibraryAssetToProject',{projectId:b.id,itemId:`asset:${asset.id}`,kind:'REFERENCE'});
    expect(context.repository.getAsset(copied.id)!.storagePath).not.toBe(context.repository.getAsset(asset.id)!.storagePath);
    await expect(invoke('deleteProject',{projectId:a.id})).rejects.toMatchObject({code:'CONFLICT'});
    await invoke('updateProject',{projectId:a.id,archived:true});await invoke('deleteProject',{projectId:a.id});expect(context.repository.getProject(a.id)).toBeUndefined();expect(await context.storage.exists(context.repository.getAsset(copied.id)!.storagePath)).toBe(true);
  });
  it('uses CAS on drafts and refuses reusing client keys with different inputs',async()=>{
    const draft=await invoke('createPatternDraft',{name:'test'});const changed=await invoke('updatePatternDraft',{draftId:draft.id,expectedRevision:draft.revision,name:'renamed'});
    await expect(invoke('updatePatternDraft',{draftId:draft.id,expectedRevision:draft.revision,name:'stale'})).rejects.toMatchObject({code:'CONFLICT'});
    expect(changed.revision).toBeGreaterThan(draft.revision);
    const p=provider();const input={draftId:draft.id,clientKey:'first',operation:'GENERATE' as const,theme:'flowers',providerId:p.id,imageModelId:'gpt-image-1',candidateCount:3};
    const batch=await invoke('createDraftBatch',input);expect(batch.batch.slots).toHaveLength(3);expect(store.get(batch.job!.id)).toBeDefined();expect(batch.reused).toBe(false);
    expect((await invoke('createDraftBatch',input)).reused).toBe(true);
    await expect(invoke('createDraftBatch',{...input,theme:'different'})).rejects.toMatchObject({code:'CONFLICT'});
  });
  it('rolls back all companion records if freeze fails',async()=>{
    const p=await project();context.scheduler.freeze=()=>{throw new Error('injected freeze failure');};
    await expect(invoke('createPlanningJob',{projectId:p.id})).rejects.toThrow('injected');expect(context.repository.listJobs(p.id)).toEqual([]);expect(enqueued).toEqual([]);
  });
  it('advances storyboard confirmation CAS after editing and rejects cross-project references',async()=>{
    const a=await seedStoryboard(),b=await project();const asset=await invoke('uploadAsset',{projectId:b.id,file:file(),kind:'PRODUCT'});
    await expect(invoke('updateStoryboardItem',{itemId:a.items[0]!.id,referencedAssets:[asset.id]})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    await invoke('updateStoryboardItem',{itemId:a.items[0]!.id,promptInstruction:'updated final prompt'});
    await expect(invoke('confirmStoryboard',{projectId:a.project.id,version:a.storyboard.version})).rejects.toMatchObject({code:'CONFLICT'});
    const fresh=context.repository.getStoryboard(a.project.id)!;await invoke('confirmStoryboard',{projectId:a.project.id,version:fresh.version});
    expect(context.repository.listStoryboardVersions(a.project.id)).toHaveLength(2);
  });
  it('creates every generation candidate atomically and reuses frozen jobs',async()=>{
    const a=await seedStoryboard(2);await invoke('confirmStoryboard',{projectId:a.project.id,version:a.storyboard.version});
    const result=await invoke('createGenerationJobs',{projectId:a.project.id,storyboardItemIds:a.items.map(i=>i.id),generationConfig:{candidateCount:3}});
    expect(result.jobs).toHaveLength(6);expect(enqueued).toHaveLength(6);expect(result.reused).toBe(false);
    for(const j of result.jobs)expect(store.get(j.id)).toBeDefined();
    const dup=await invoke('createGenerationJobs',{projectId:a.project.id,storyboardItemIds:a.items.map(i=>i.id),generationConfig:{candidateCount:3}});expect(dup.jobs.map(j=>j.id)).toEqual(result.jobs.map(j=>j.id));expect(dup.reused).toBe(true);
    const total=context.repository.listJobs(a.project.id).length;
    await expect(invoke('createGenerationJobs',{projectId:a.project.id,storyboardItemIds:[a.items[0]!.id,randomUUID()]})).rejects.toMatchObject({code:'VALIDATION_ERROR'});expect(context.repository.listJobs(a.project.id)).toHaveLength(total);
  });
  it('rolls back generation jobs on a late freeze failure',async()=>{
    const a=await seedStoryboard(2);await invoke('confirmStoryboard',{projectId:a.project.id,version:a.storyboard.version});let count=0;
    context.scheduler.freeze=(id,snapshot)=>{store.create(id,snapshot);if(++count===2)throw new Error('second freeze failed');};
    await expect(invoke('createGenerationJobs',{projectId:a.project.id,storyboardItemIds:a.items.map(i=>i.id)})).rejects.toThrow('second freeze');expect(context.repository.listJobs(a.project.id)).toEqual([]);expect(enqueued).toEqual([]);expect(db.prepare('SELECT COUNT(*) n FROM desktop_job_runtime').get()).toEqual({n:0});
  });
  it('validates export ownership and commits its companion in the frozen transaction',async()=>{
    const a=await seedOutput(),b=await seedOutput();
    await expect(invoke('createExportJob',{projectId:a.project.id,outputIds:[b.output.id]})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    const result=await invoke('createExportJob',{projectId:a.project.id,outputIds:[a.output.id],longImage:{targetWidth:750}});expect(result.export!.jobId).toBe(result.job.id);expect(store.get(result.job.id)).toBeDefined();expect(result.reused).toBe(false);
    expect((await invoke('createExportJob',{projectId:a.project.id,outputIds:[a.output.id],longImage:{targetWidth:750}})).reused).toBe(true);
  });
  it('guards stale automatic layer plans, bounds geometry and supports manual/prompt layering',async()=>{
    const a=await seedOutput();const p=context.repository.getProvider(a.project.reasoningProviderId!)!;
    await invoke('updateProject',{projectId:a.project.id,segmentationModel:{providerId:p.id,modelId:'sam'}});
    const plan=await invoke('createLayerPlan',{outputId:a.output.id});expect(store.get(plan.jobId)).toBeDefined();
    await expect(invoke('createLayerExport',{outputId:a.output.id,planId:randomUUID(),elements:[{id:'el-1',name:'object',source:'auto'}]})).rejects.toMatchObject({code:'CONFLICT'});
    await expect(invoke('createLayerExport',{outputId:a.output.id,elements:[{id:'manual',name:'object',source:'manual',bbox:{x:0.9,y:0,width:0.2,height:0.5}}]})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    const result=await invoke('createLayerExport',{outputId:a.output.id,elements:[{id:'manual',name:'object',source:'manual',bbox:{x:0.1,y:0.1,width:0.3,height:0.3}},{id:'prompt',name:'title',source:'prompt'}]});expect(result.layerExport.jobId).toBe(result.job.id);expect(store.get(result.job.id)).toBeDefined();
    const history=await invoke('listLayerExports',{outputId:a.output.id});expect(history.exports).toHaveLength(1);
  });
  it('freezes edit masks, reference ownership, turn, and approval together',async()=>{
    const a=await seedOutput(),b=await seedOutput();const session=await invoke('createEditSession',{projectId:a.project.id,outputId:a.output.id});
    const temp=await invoke('uploadEditReferenceAsset',{sessionId:session.id,file:file(),purpose:'STYLE'});
    await expect(invoke('createEditTurn',{sessionId:session.id,baseOutputId:b.output.id,message:'change lighting'})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    const wrong=await sharp({create:{width:2,height:2,channels:4,background:'white'}}).png().toBuffer();await expect(invoke('createEditTurn',{sessionId:session.id,message:'change lighting',editMask:file(wrong)})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    const turn=await invoke('createEditTurn',{sessionId:session.id,message:'change lighting',editMask:file(),referenceSelections:JSON.stringify([{id:temp.id,source:'TEMPORARY',purpose:'STYLE'}])});
    expect(store.get(turn.planJobId)).toBeDefined();expect(context.repository.getEditReferenceAsset(temp.id)!.turnId).toBe(turn.turnId);
    await expect(invoke('deleteEditReferenceAsset',{sessionId:session.id,referenceAssetId:temp.id})).rejects.toMatchObject({code:'CONFLICT'});
    const fetched=await invoke('getEditTurn',{turnId:turn.turnId});expect(JSON.stringify(fetched)).not.toMatch(/storagePath|editMaskPath/);
    context.repository.updateEditTurn(turn.turnId,{status:'AWAITING_CONFIRMATION',plan:{prompt:'new lighting',requiresConfirmation:true}});
    const approved=await invoke('approveEditTurn',{turnId:turn.turnId});expect(approved.turn.status).toBe('GENERATING');expect(store.get(approved.job.id)).toBeDefined();
    await invoke('updateEditSessionMemory',{sessionId:session.id,outputId:a.output.id,summary:'preserve brand',constraints:['logo']});expect((await invoke('getEditSession',{sessionId:session.id})).memorySummary.summary).toBe('preserve brand');
  });
  it('only compensates failed draft slots and blocks UNKNOWN',async()=>{
    const draft=await invoke('createPatternDraft',{}),p=provider();const batch=await invoke('createDraftBatch',{draftId:draft.id,clientKey:'compensate',operation:'GENERATE',theme:'flowers',providerId:p.id,imageModelId:'gpt-image-1',candidateCount:3});
    context.repository.updateJob(batch.job!.id,{status:'FAILED',retryable:true});context.repository.updateDraftSlot(batch.batch.id,1,{status:'SUCCEEDED'});context.repository.updateDraftSlot(batch.batch.id,2,{status:'FAILED'});context.repository.updateDraftSlot(batch.batch.id,3,{status:'FAILED'});
    store.mutate(batch.job!.id,state=>{state.phase='SETTLED';state.runToken=null;});
    const frozen=structuredClone(store.get(batch.job!.id)!.snapshot);
    // 使用真实领域重试，同时保持本测试的队列未启动；成功槽位和原快照必须保留。
    const scheduler=new PersistentScheduler(store,context.repository,context.requestLedger,()=>context);
    scheduler.register(registerExecutors(context));context.scheduler.retry=id=>scheduler.retry(id);
    try {
      const retried=await invoke('retryFailedDraftBatch',{draftId:draft.id,batchId:batch.batch.id});
      expect(retried.job.id).toBe(batch.job!.id);expect(store.get(retried.job.id)!.snapshot).toEqual(frozen);
      expect(retried.batch.slots.map(slot=>slot.status)).toEqual(['SUCCEEDED','QUEUED','QUEUED']);
      expect(retried.batch.slots.map(slot=>slot.jobId)).toEqual([batch.job!.id,batch.job!.id,batch.job!.id]);
      expect(context.repository.listJobsByType('PATTERN_DRAFT_GENERATE',100)).toHaveLength(1);
      context.repository.updateJob(retried.job.id,{status:'UNKNOWN',retryable:false});context.repository.updateDraftSlot(batch.batch.id,2,{status:'UNKNOWN'});
      const count=context.repository.listJobsByType('PATTERN_DRAFT_GENERATE',100).length;await expect(invoke('retryFailedDraftBatch',{draftId:draft.id,batchId:batch.batch.id})).rejects.toMatchObject({code:'EXTERNAL_UNKNOWN'});expect(context.repository.listJobsByType('PATTERN_DRAFT_GENERATE',100)).toHaveLength(count);
    } finally {await scheduler.close();}
  });
  it('imports a pattern and creates print/listing/pipeline intents with actual companions',async()=>{
    const pattern=await invoke('uploadPattern',{file:file(),name:'flowers'}),p=provider();const specs=await invoke('listPodPrintSpecs',{}),specId=specs.items[0]!.id;
    const pack=await invoke('createPrintPackJob',{patternId:pattern.id,specId});expect(pack.printPack!.jobId).toBe(pack.job.id);expect(store.get(pack.job.id)).toBeDefined();
    const listing=await invoke('createPatternListingJob',{patternId:pattern.id,providerId:p.id,modelId:'reason',platform:'ETSY'});expect(context.repository.getJob(listing.id)!.input.target).toBe('LISTING');
    const pipeline=await invoke('createPatternPipeline',{patternId:pattern.id,specId,listingPlatform:'ETSY',listingProviderId:p.id,listingModelId:'reason'});expect(pipeline.steps[0]!.jobId).toBeTruthy();expect(store.get(pipeline.steps[0]!.jobId!)).toBeDefined();expect(pipeline.reused).toBe(false);
    expect((await invoke('createPatternPipeline',{patternId:pattern.id,specId,listingPlatform:'ETSY',listingProviderId:p.id,listingModelId:'reason'})).reused).toBe(true);
    const step=context.repository.getPatternPipelineStepByJobId(pipeline.steps[0]!.jobId!)!;context.repository.updatePatternPipelineStep(step.id,{status:'UNKNOWN'});
    await expect(invoke('cancelPatternPipeline',{pipelineId:pipeline.id})).rejects.toMatchObject({code:'EXTERNAL_UNKNOWN'});await expect(invoke('retryPatternPipelineStep',{pipelineId:pipeline.id,step:step.step})).rejects.toMatchObject({code:'EXTERNAL_UNKNOWN'});
  });
  it('discovers saved/overridden models and probes reasoning without a paid POST',async()=>{
    const requests:string[]=[];const server=createServer((req,res)=>{requests.push(req.method+' '+req.url);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'reason'},{id:'a'},{id:'reason'}]}));});
    server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as {port:number};
    try{const p=provider();context.repository.saveProvider({...p,baseUrl:`http://127.0.0.1:${address.port}/v1`});
      const discovered=await invoke('discoverProviderModels',{providerId:p.id});expect(discovered.models).toEqual(['a','reason']);
      const probe=await invoke('testProviderConnection',{providerId:p.id,modelId:'reason',kind:'reasoning'});expect(probe.modelAvailable).toBe(true);expect(requests.length).toBeGreaterThan(0);expect(requests.every(r=>r==='GET /v1/models')).toBe(true);
    }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it('preserves search source priority and key semantics',async()=>{
    const source=await invoke('createSearchSource',{name:'local',kind:'searxng',priority:90});expect(source.hasApiKey).toBe(false);
    const secure=await invoke('createSearchSource',{name:'brave',kind:'brave',apiKey:'fake-search-key',priority:10});const encrypted=context.repository.getSearchSource(secure.id)!.encryptedApiKey;
    await invoke('updateSearchSource',{sourceId:secure.id,name:'renamed'});expect(context.repository.getSearchSource(secure.id)!.encryptedApiKey).toBe(encrypted);
    expect((await invoke('listSearchSources',{})).items.map(s=>s.id)).toEqual([secure.id,source.id]);
    await expect(invoke('createSearchSource',{name:'missing',kind:'tavily',priority:0})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    await invoke('deleteSearchSource',{sourceId:source.id});expect((await invoke('listSearchSources',{})).items).toHaveLength(1);
  });
  it('keeps copywriting separate until adopted by an explicit project update',async()=>{
    const p=await project();await expect(invoke('createCopywritingJob',{projectId:p.id,target:'PRODUCT_DESCRIPTION',regenerationKey:'one'})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    await invoke('uploadAsset',{projectId:p.id,file:file(),kind:'PRODUCT'});const job=await invoke('createCopywritingJob',{projectId:p.id,target:'PRODUCT_DESCRIPTION',regenerationKey:'one'});context.repository.updateJob(job.id,{status:'SUCCEEDED'});context.repository.saveCopywritingResult({jobId:job.id,projectId:p.id,target:'PRODUCT_DESCRIPTION',content:'real copy result'});
    expect((await invoke('getCopywritingResult',{jobId:job.id})).content).toBe('real copy result');expect(context.repository.getProject(p.id)!.productDescription).toBe(null);
    await invoke('updateProject',{projectId:p.id,productDescription:'real copy result'});expect(context.repository.getProject(p.id)!.productDescription).toBe('real copy result');
  });
  it('preserves media ordinals, explicit candidate finalization, and immutable batch references',async()=>{
    const draft=await invoke('createPatternDraft',{}),p=provider();const media=await invoke('createDraftMedia',{draftId:draft.id,file:file(),role:'REFERENCE',notes:'flowers'});expect(media.ordinal).toBe(1);
    const batch=await invoke('createDraftBatch',{draftId:draft.id,clientKey:'reference',operation:'GENERATE',theme:'use @图1',providerId:p.id,imageModelId:'gpt-image-1',candidateCount:1});const frozen=store.get(batch.job!.id)!;expect(frozen.snapshot.resources.some(r=>r.ref.kind==='DRAFT_MEDIA'&&r.ref.id===media.id)).toBe(true);
    const stored=await context.storage.putDraftCandidate(draft.id,randomUUID(),png,'.png');
    const candidate=context.repository.createDraftCandidate({draftId:draft.id,batchId:batch.batch.id,slotIndex:1,parentCandidateId:null,storagePath:stored.path,fileHash:stored.hash,mimeType:'image/png',width:12,height:12,transform:'GENERATE',hasAlpha:true});context.repository.updateDraftSlot(batch.batch.id,1,{status:'SUCCEEDED'});context.repository.updateJob(batch.job!.id,{status:'SUCCEEDED'});
    const finalized=await invoke('finalizeDraftCandidate',{draftId:draft.id,candidateId:candidate.id,clientKey:'final'});expect(finalized.reused).toBe(false);expect((await invoke('finalizeDraftCandidate',{draftId:draft.id,candidateId:candidate.id,clientKey:'again'})).pattern.id).toBe(finalized.pattern.id);
    await expect(invoke('downloadDraftCandidateFile',{draftId:randomUUID(),candidateId:candidate.id})).rejects.toMatchObject({code:'NOT_FOUND'});
    const before=context.repository.getDraftMedia(media.id)!.storagePath;await invoke('deleteDraftMedia',{draftId:draft.id,mediaId:media.id});expect(await context.storage.exists(before)).toBe(true);
  });
  it('reclaims failed file preparation and preserves successful published aliases',async()=>{
    const pattern=await invoke('uploadPattern',{file:file(),name:'keep'}),p=provider();const path=context.repository.getPattern(pattern.id)!.storagePath!;
    context.scheduler.freeze=()=>{throw new Error('frozen failure after file preparation');};
    await expect(invoke('createSuiteForgeJob',{providerId:p.id,modelId:'reason',files:[file()],name:'failed'})).rejects.toThrow('frozen failure');
    expect(context.repository.listJobsByType('SUITE_FORGE',100)).toEqual([]);
    const staged=(db.prepare('SELECT payload FROM desktop_resources').all() as {payload:string}[]).map(row=>JSON.parse(row.payload)).filter(row=>row.ref.id.startsWith('stage-'));expect(staged.length).toBeGreaterThan(1);
    await new ResourceRegistry(store,context.storage).cleanup();
    expect(await context.storage.exists(path)).toBe(true);for(const resource of staged.filter(row=>row.relativePath!==path))expect(await context.storage.exists(resource.relativePath)).toBe(false);
  });
  it('keeps UNKNOWN project evidence while provider deletion clears current selections',async()=>{
    const p=await project();const job=context.repository.createJob({id:randomUUID(),projectId:p.id,storyboardItemId:null,type:'PLAN',input:{},providerId:p.reasoningProviderId,status:'UNKNOWN',retryable:false});
    await invoke('updateProject',{projectId:p.id,archived:true});await expect(invoke('deleteProject',{projectId:p.id})).rejects.toMatchObject({code:'EXTERNAL_UNKNOWN'});
    await invoke('deleteProvider',{providerId:p.reasoningProviderId!});expect(context.repository.getJob(job.id)!.status).toBe('UNKNOWN');expect(context.repository.getProject(p.id)!.reasoningProviderId).toBe(null);
  });
  it('waits for new provider jobs that arrive during deletion before removing the provider',async()=>{
    const p=await project();const first=context.repository.createJob({id:randomUUID(),projectId:p.id,storyboardItemId:null,type:'PLAN',input:{},providerId:p.reasoningProviderId});let newcomer:string|undefined,calls=0;
    context.scheduler.waitForIdle=async()=>{if(++calls===1)newcomer=context.repository.createJob({id:randomUUID(),projectId:p.id,storyboardItemId:null,type:'PLAN',input:{},providerId:p.reasoningProviderId}).id;};
    await invoke('deleteProvider',{providerId:p.reasoningProviderId!});expect(calls).toBe(2);expect(context.repository.getJob(first.id)!.status).toBe('CANCELLED');expect(context.repository.getJob(newcomer!)!.status).toBe('CANCELLED');expect(context.repository.getProvider(p.reasoningProviderId!)).toBeUndefined();
  });
  it('preserves a model if another cast intent arrives while deletion waits',async()=>{
    const model=await invoke('createModel',{name:'keep',spec:MODEL_SPEC_DEFAULTS}),p=provider();context.repository.createJob({id:randomUUID(),projectId:null,storyboardItemId:null,type:'MODEL_CAST',input:{modelId:model.id},providerId:p.id});
    context.scheduler.waitForIdle=async()=>{context.repository.createJob({id:randomUUID(),projectId:null,storyboardItemId:null,type:'MODEL_CAST',input:{modelId:model.id},providerId:p.id});};
    await expect(invoke('deleteModel',{modelId:model.id})).rejects.toMatchObject({code:'CONFLICT'});expect(context.repository.getModel(model.id)).toBeDefined();
  });
  it('supports stable model identities and immutable reference-face revisions',async()=>{
    const model=await invoke('createModel',{name:'model',spec:MODEL_SPEC_DEFAULTS});const first=await invoke('uploadModelReferenceFace',{modelId:model.id,file:file()});const secondBytes=await sharp(png).negate().png().toBuffer();
    const second=await invoke('uploadModelReferenceFace',{modelId:model.id,file:file(secondBytes)});expect(second.referenceFaceUrl).not.toBe(first.referenceFaceUrl);
    const p=provider();const cast=await invoke('createModelCastJob',{modelId:model.id,providerId:p.id,imageModelId:'gpt-image-1',aspectRatio:'1:1',candidateCount:2});expect(store.get(cast.id)!.snapshot.resources.some(r=>r.ref.kind==='MODEL_FACE')).toBe(true);
  });
});
