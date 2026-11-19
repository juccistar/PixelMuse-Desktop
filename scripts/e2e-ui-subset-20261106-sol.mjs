import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeContext, executeScenario, items } from './e2e-full-harness.mjs';
import { modelCapability, projectInput } from './e2e-full-business.mjs';
import { uiScenarios } from './e2e-full-ui.mjs';
const c=await makeContext();
try {
  await c.launch();
  const diagnostics=[];
  c.page.on('console',message=>diagnostics.push({type:'console',level:message.type(),text:c.redact(message.text())}));
  c.page.on('request',request=>{if(request.url().startsWith('ecomgen-resource:'))request.allHeaders().then(headers=>diagnostics.push({type:'resource-request',url:request.url(),origin:headers.origin??null,mode:headers['sec-fetch-mode']??null}));});
  c.page.on('requestfailed',request=>diagnostics.push({type:'requestfailed',url:request.url(),error:request.failure()}));
  c.page.on('response',response=>{if(response.url().startsWith('ecomgen-resource:'))diagnostics.push({type:'resource-response',url:response.url(),status:response.status(),headers:response.headers()});});
  await c.page.evaluate(()=>{window.__uiSubsetNotices=[];new MutationObserver(()=>{for(const el of document.querySelectorAll('.ant-notification-notice,.ant-message-notice'))if(!window.__uiSubsetNotices.includes(el.innerText))window.__uiSubsetNotices.push(el.innerText);}).observe(document.body,{subtree:true,childList:true});});
  await executeScenario(c,{id:'ui-subset-prerequisites',title:'Named IPC creates synthetic provider and library source only',run:async c=>{
    c.state.provider=await c.invoke('createProvider',{name:'Full offline provider retained key',baseUrl:c.mock.baseUrl,reasoningProtocol:'openai',apiKey:c.fakeKey,models:[modelCapability('mock-reasoner',{supportsTools:true}),modelCapability('mock-image',{imageApiKind:'openai_images'}),modelCapability('sam-3',{segmentationProtocol:'fal'})]});
    const p=await c.invoke('createProject',projectInput(c,'Full acceptance cup'));
    await c.invoke('uploadAsset',{projectId:p.id,file:await c.byteFile(),role:'PRODUCT_TRUTH',kind:'PRODUCT'});
    c.check(items(await c.invoke('listAssets',{projectId:p.id})).length===1);
  }});
  const ids=new Set(process.argv.slice(2));
  if(ids.size&&!ids.has('ui-project-workbench')&&['ui-upload-drop-paste','ui-copy-adoption-late-write','ui-edit-canvas','ui-auto-layers-export-compose'].some(id=>ids.has(id))) {
    await executeScenario(c,{id:'ui-subset-project-prerequisites',title:'Minimal real project and optional generation prerequisites',run:async c=>{
      const project=await c.invoke('createProject',projectInput(c,'UI acceptance project'));c.state.uiProject=project;
      if(ids.has('ui-copy-adoption-late-write'))await c.invoke('uploadAsset',{projectId:project.id,file:await c.byteFile(),role:'PRODUCT_TRUTH',kind:'PRODUCT'});
      if(ids.has('ui-edit-canvas')||ids.has('ui-auto-layers-export-compose')) {
        const job=await c.invoke('createPlanningJob',{projectId:project.id,planningMode:'AI',targetImageCount:1});await c.waitJob(job.id);
        const board=await c.invoke('getStoryboard',{projectId:project.id});await c.invoke('confirmStoryboard',{projectId:project.id,version:board.storyboard.version});
        const generation=await c.invoke('createGenerationJobs',{projectId:project.id,storyboardItemIds:board.items.map(item=>item.id)});for(const job of generation.jobs)await c.waitJob(job.id);
      }
      c.check((await c.invoke('getProject',{projectId:project.id})).id===project.id);
    }});
  }
  for(const scenario of uiScenarios.filter(s=>ids.size===0||ids.has(s.id))) {
    await executeScenario(c,scenario);
    if(c.result.scenarios.at(-1).status!=='passed')await c.evidence(`${scenario.id}-dom`,{body:await c.page.locator('body').innerText(),events:c.state.events,diagnostics,notices:await c.page.evaluate(()=>window.__uiSubsetNotices)});
  }
  c.result.integration=c.result.scenarios.every(s=>s.status==='passed')?'passed':'failed';
} finally {
  c.result.cleanup=await c.cleanup();
  await writeFile(join(c.artifacts,'result.json'),c.redact(JSON.stringify(c.result,null,2)));
}
process.exitCode=c.result.integration==='passed'?0:1;
