import { need, items, poll, sha256 } from './e2e-full-harness.mjs';
import { projectInput, plan, modelCapability, allPages } from './e2e-full-business.mjs';
import { modelSpec } from './e2e-full-patterns.mjs';
import { suiteReply } from './full-mock-provider.mjs';

export const additionalScenarios=[
  {id:'events-invalidation',title:'Desktop invalidation subscription triggers a resolved query after actual persisted project mutation',run:async c=>{
    const project=need(c.state.project,'Project unavailable');
    const before=await c.invoke('getProject',{projectId:project.id});
    await c.page.evaluate(()=>{window.__e2eChanges=[];});
    await c.invoke('updateProject',{projectId:project.id,name:before.name+' event-check'});
    const changes=await poll(()=>c.page.evaluate(()=>window.__e2eChanges),rows=>rows.some(row=>row.projectId===project.id||row.aggregateId===project.id),{label:'actual project invalidation event'});
    c.equal((await c.invoke('getProject',{projectId:project.id})).name,before.name+' event-check');
    c.check(changes.every(row=>Object.keys(row).every(key=>['topic','projectId','aggregateId','revision'].includes(key))),'events only invalidate; no raw rows/paths/secrets');
    await c.invoke('updateProject',{projectId:project.id,name:before.name});await c.evidence('invalidation-events',changes);
  }},
  {id:'asset-readable-formats',title:'Generated PNG/JPEG/WebP/AVIF/TIFF imports retain readable pixels from the published desktop format set',run:async c=>{
    const project=await c.invoke('createProject',projectInput(c,'Image format isolated'));
    const fileSchema=c.catalog.operations.find(row=>row.operation==='uploadAsset')?.input?.properties?.file;
    const accepted=fileSchema?.properties?.mimeType?.anyOf?.map(row=>row.const)??[];
    for(const [format,mimeType]of [['png','image/png'],['jpeg','image/jpeg'],['webp','image/webp'],['avif','image/avif'],['tiff','image/tiff']]){
      need(accepted.includes(mimeType),`Published desktop ${format.toUpperCase()} import is blocked by current ByteImport MIME schema`);
      const bytes=await c.sharp(c.mock.images.image).toFormat(format).toBuffer();
      const file={name:`synthetic.${format}`,mimeType,base64:bytes.toString('base64')};
      const asset=await c.invoke('uploadAsset',{projectId:project.id,file,kind:'REFERENCE',role:'STYLE_REFERENCE'});
      const saved=await c.imageRef({kind:'ASSET',id:asset.id});c.equal(saved.metadata.width,c.mock.images.width);c.equal(saved.metadata.height,c.mock.images.height);
    }
  }},
  {id:'asset-domain-limits',title:'Six product and six reference image limits are independent, with real distinct content',run:async c=>{
    const p=await c.invoke('createProject',projectInput(c,'Asset limit isolated'));
    for(const [kind,role]of [['PRODUCT','PRODUCT_TRUTH'],['REFERENCE','STYLE_REFERENCE']]) {
      for(let index=0;index<6;index++) {
        const bytes=await c.sharp({create:{width:32,height:32,channels:4,background:{r:20+index*25,g:kind==='PRODUCT'?90:180,b:45,alpha:1}}}).png().toBuffer();
        await c.invoke('uploadAsset',{projectId:p.id,file:{name:`${kind}-${index}.png`,mimeType:'image/png',base64:bytes.toString('base64')},kind,role});
      }
      const bytes=await c.sharp({create:{width:32,height:32,channels:4,background:'#c33faa'}}).png().toBuffer();
      await c.rejects('uploadAsset',{projectId:p.id,file:{name:`seventh-${kind}.png`,mimeType:'image/png',base64:bytes.toString('base64')},kind,role});
    }
    c.equal(items(await c.invoke('listAssets',{projectId:p.id})).length,12,'each original domain quota is enforced independently');
  }},
  {id:'planning-domain-boundaries',title:'Planning count/template boundaries and removable draft storyboard items',jobTypes:['PLAN'],run:async c=>{
    const p=await c.invoke('createProject',projectInput(c,'Planning boundary isolated'));
    for(const targetImageCount of [0,13])await c.rejects('createPlanningJob',{projectId:p.id,planningMode:'AI',targetImageCount});
    await c.rejects('createPlanningJob',{projectId:p.id,planningMode:'MANUAL',requestedTypes:[]});
    const board=await plan(c,p,{targetImageCount:12});c.equal(board.items.length,12,'original 1..12 planning domain supports upper boundary');
    await c.invoke('deleteStoryboardItem',{itemId:board.items[11].id});c.equal((await c.invoke('getStoryboard',{projectId:p.id})).items.length,11);
    await c.rejects('updateStoryboardItem',{itemId:board.items[0].id,candidateCount:5});
    await c.invoke('listEcomDetailsImageTemplates');
  }},
  {id:'research-real-tool-audit',title:'Real Pi visual-search tool observes source order/fallback, disable switch and persisted audit',jobTypes:['PLAN'],run:async c=>{
    need(c.state.sources,'Search sources unavailable');
    const p=await c.invoke('createProject',projectInput(c,'Research tool isolated',{webResearchEnabled:true}));
    c.state.researchToolPending=true;c.mock.control.failNext('brave',{type:'http',status:503});
    const initial=c.mock.control.snapshot();
    try {
      const job=await c.invoke('createPlanningJob',{projectId:p.id,planningMode:'AI',targetImageCount:1,regenerationKey:'research-with-real-tool'});await c.waitJob(job.id);
      c.equal(c.mock.state.counts.brave-initial.counts.brave,1);c.equal(c.mock.state.counts.tavily-initial.counts.tavily,1);
      const audit=await c.inspect('research',{jobId:job.id});c.equal(audit.audit.invocation_count,1);c.equal(audit.attempts.map(attempt=>attempt.source_kind),['brave','tavily']);c.equal(audit.attempts.map(attempt=>attempt.status),['FAILED','SUCCEEDED']);c.check(audit.attempts[1].result_count>0);await c.evidence('research-audit',audit);
      await c.invoke('updateProject',{projectId:p.id,webResearchEnabled:false});const before=c.mock.state.counts.brave+c.mock.state.counts.tavily+c.mock.state.counts.searxng;
      await plan(c,p);c.equal(c.mock.state.counts.brave+c.mock.state.counts.tavily+c.mock.state.counts.searxng,before,'disabled research makes zero search calls');
    } finally {c.state.researchToolPending=false;c.mock.control.clearFaults();}
  }},
  {id:'catalog-crud-resource-handles',title:'Suite import/edit/delete and named downloads use bounded resource refs',run:async c=>{
    const document=suiteReply({id:'custom-suite-full-imported-crud',name:'Imported suite CRUD',shotCount:2});
    const imported=await c.invoke('createUserSuite',document);
    const suite=imported.suite??imported;
    const updated=await c.invoke('updateUserSuite',{suiteId:suite.id,...document,name:'Imported suite updated'});c.equal((updated.suite??updated).name,'Imported suite updated');
    await c.invoke('deleteUserSuite',{suiteId:suite.id});c.check(!(await allPages(c,'listSuites',{ids:suite.id})).some(item=>item.id===suite.id));
    const asset=need(c.state.asset,'Asset unavailable'),output=need(c.state.outputs?.[0],'Output unavailable');
    for(const [operation,input,kind,id]of [['downloadAsset',{assetId:asset.id},'ASSET',asset.id],['downloadOutput',{outputId:output.id},'OUTPUT',output.id]]) {
      const handle=await c.invoke(operation,input);c.equal(handle.ref,{kind,id});await c.imageRef(handle.ref);
    }
    const thumbnail=await c.invoke('downloadThumbnail',{hash:output.hash});await c.imageRef(thumbnail.ref);
  }},
  {id:'reference-promotion',title:'Temporary edit reference promotion creates an independently addressable project asset',run:async c=>{
    const s=need(c.state.editSession,'Edit session unavailable');
    const bytes=await c.sharp(c.mock.images.image).modulate({hue:220}).png().toBuffer();
    const ref=await c.invoke('uploadEditReferenceAsset',{sessionId:s.id,file:{name:'promotion-reference.png',mimeType:'image/png',base64:bytes.toString('base64')},purpose:'STYLE'});
    const promoted=await c.invoke('promoteEditReferenceAsset',{sessionId:s.id,referenceAssetId:ref.id});c.equal(promoted.source,'PROJECT');
    const assets=items(await c.invoke('listAssets',{projectId:s.projectId}));c.check(assets.some(asset=>asset.id===promoted.id));await c.imageRef({kind:'ASSET',id:promoted.id});
  }},
  {id:'deletion-and-reference-cleanup',title:'Disposable Provider/model/pattern deletion cleans references and preserves unrelated records',run:async c=>{
    const original=need(c.state.provider,'Provider unavailable');
    const provider=await c.invoke('createProvider',{name:'Disposable provider',baseUrl:c.mock.baseUrl,reasoningProtocol:'openai',apiKey:c.fakeKey,models:[modelCapability('mock-reasoner'),modelCapability('mock-image',{imageApiKind:'openai_images'})]});
    const project=await c.invoke('createProject',{...projectInput(c,'Provider reference cleanup'),reasoningProviderId:provider.id,imageProviderId:provider.id});
    await c.invoke('deleteProvider',{providerId:provider.id});c.check(!items(await c.invoke('listProviders')).some(row=>row.id===provider.id));
    const changed=await c.invoke('getProject',{projectId:project.id});c.check(changed.reasoningProviderId!==provider.id&&changed.imageProviderId!==provider.id,'deleted provider references are cleared');
    const model=await c.invoke('createModel',{name:'Disposable model',spec:modelSpec});await c.invoke('uploadModelReferenceFace',{modelId:model.id,file:await c.byteFile()});await c.invoke('deleteModelReferenceFace',{modelId:model.id});c.equal((await c.invoke('getModel',{modelId:model.id})).hasReferenceFace,false);await c.invoke('deleteModel',{modelId:model.id});c.check(!items(await c.invoke('listModels')).some(row=>row.id===model.id));
    const pattern=await c.invoke('uploadPattern',{file:await c.byteFile(),name:'Disposable pattern'});await c.invoke('deletePattern',{patternId:pattern.id});c.check(!items(await c.invoke('listPatterns')).some(row=>row.id===pattern.id));
    c.check(items(await c.invoke('listProviders')).some(row=>row.id===original.id),'main provider unaffected');
  }},
];
