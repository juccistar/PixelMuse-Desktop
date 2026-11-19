import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Type } from '@sinclair/typebox';
import { ECOM_TEMPLATES } from '@ecomgen/ecom-skill';
import { createBackend } from '../../src/index.js';
import { registerDomainCommands } from '../../src/commands/index.js';
import { EXECUTOR_TYPES, type CommandContext, type ExecutorMap } from '../../src/runtime/ports.js';

it('wires awaited named handlers to the real scheduler and same-connection companion records',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ecomgen-command-integration-'));
  let context!:CommandContext;
  const executions:string[]=[];
  const executors=Object.fromEntries(EXECUTOR_TYPES.map(type=>[type,{snapshotSchema:Type.Any(),execute:async(ctx:any)=>{
    if(type!=='EXPORT')throw new Error('unexpected executor');
    expect(ctx.repository.getExportByJobId(ctx.job.id)).toBeDefined();
    expect(ctx.snapshot.input.outputIds).toHaveLength(1);executions.push(ctx.job.id);
  }}])) as ExecutorMap;
  const backend=await createBackend({dataDir:root,masterKey:Buffer.alloc(32,7).toString('base64'),version:'isolated-test'},()=>undefined,{commands:ctx=>{context=ctx;return registerDomainCommands(ctx);},executors,fetch:async()=>{throw new Error('network forbidden');}});
  try{
    const provider=await backend.invoke('createProvider',{name:'fake',baseUrl:'http://127.0.0.1:1/v1',apiKey:'fake-only',reasoningProtocol:'openai',models:[{id:'r',supportsVision:true,supportsThinking:false,supportsTools:false,supportsStructuredOutput:true},{id:'gpt-image-1',supportsVision:false,supportsThinking:false,supportsTools:false,supportsStructuredOutput:false,imageApiKind:'openai_images'}]});
    const project=await backend.invoke('createProject',{name:'export',reasoningProviderId:provider.id,reasoningModelId:'r',imageProviderId:provider.id,imageModelId:'gpt-image-1',defaultMode:'CREATIVE'});
    const r=context.repository;
    r.saveStoryboard(project.id,'consistent','CONFIRMED',[{assetType:ECOM_TEMPLATES[0]!.id,displayName:'one',shotRole:null,templateVariant:null,candidateCount:1,referencedAssets:[],mode:'CREATIVE',status:'GENERATED',promptInstruction:'Keep product identity',compiledPrompt:null,factClaims:[],riskFlags:[],sortOrder:0}]);
    const item=r.listStoryboardItems(project.id)[0]!;
    const source=r.createJob({id:randomUUID(),projectId:project.id,storyboardItemId:item.id,type:'GENERATE',input:{},status:'SUCCEEDED'});
    const png=await sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer();const stored=await context.storage.putOutput(project.id,png,'.png',source.id);
    const output=r.createOutput({projectId:project.id,storyboardItemId:item.id,jobId:source.id,candidateIndex:1,generationSnapshot:null,storagePath:stored.path,hash:stored.hash});
    const bundle=await backend.invoke('createExportJob',{projectId:project.id,outputIds:[output.id]});expect(bundle.export!.jobId).toBe(bundle.job.id);expect(bundle.reused).toBe(false);expect(bundle.job.storyboardItemId).toBeNull();expect(bundle.job).not.toHaveProperty('input');
    for(let i=0;i<100&&r.getJob(bundle.job.id)!.status==='QUEUED';i++)await new Promise<void>(resolve=>setImmediate(resolve));
    for(let i=0;i<100&&r.getJob(bundle.job.id)!.status==='RUNNING';i++)await new Promise<void>(resolve=>setImmediate(resolve));
    expect((await backend.invoke('getJob',{jobId:bundle.job.id})).status).toBe('SUCCEEDED');expect(executions).toEqual([bundle.job.id]);
    const duplicate=await backend.invoke('createExportJob',{projectId:project.id,outputIds:[output.id]});expect(duplicate.reused).toBe(true);expect(duplicate.job.id).toBe(bundle.job.id);
    await expect(backend.invoke('createExportJob',{projectId:project.id,outputIds:[randomUUID()]})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  }finally{await backend.close();await rm(root,{recursive:true,force:true});}
});
