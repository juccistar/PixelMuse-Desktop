import { need, items, poll } from './e2e-full-harness.mjs';
import { projectInput, allPages } from './e2e-full-business.mjs';
import { exportUiComposition, verifyUiLayers } from './e2e-ui-artifacts-20261106-sol.mjs';

async function dismiss(c) {
  if(!c.page)return;
  const stack=c.page.getByRole('dialog',{name:'图层编排',exact:true});
  if(await stack.count()){await stack.getByRole('button',{name:'关闭',exact:true}).click();await stack.waitFor({state:'hidden'});}
  // Close only renderer dialogs in the test-owned window, never other desktop windows.
  while(true) {
    const close=c.page.locator('.ant-modal:visible .ant-modal-close, .ant-drawer:visible .ant-drawer-close');
    const count=await close.count();if(!count)break;
    await close.last().click();
    await poll(()=>close.count(),value=>value<count,{label:'renderer dialog dismissed'});
  }
}
async function home(c) {
  await dismiss(c);
  const nav=c.page.getByRole('navigation',{name:'全局导航'});
  if(!await nav.count())await c.page.getByRole('button',{name:'花型工坊',exact:true}).click();
  await nav.waitFor();
  if(await nav.getByRole('button',{name:'项目',exact:true}).count())await c.click('项目',nav);
  await c.page.getByRole('region',{name:'项目画廊',exact:true}).waitFor();
}
async function openProject(c,project) {
  await home(c);
  // Card text is stable business data; let the real memory-router link handle navigation.
  await c.page.getByRole('region',{name:'项目画廊',exact:true}).getByText(project.name,{exact:true}).click();
  await c.page.getByLabel('项目名称',{exact:true}).waitFor();
  await c.page.getByRole('navigation',{name:'工作阶段'}).getByRole('button',{name:'1 商品配置',exact:true}).click();
}
async function navigate(c,name,heading) {
  await c.page.getByRole('navigation',{name:'全局导航'}).getByRole('button',{name,exact:true}).press('Enter');
  await c.page.getByRole('heading',{name:heading,exact:typeof heading==='string'}).waitFor();
}
async function choose(c,locator,name) {
  await locator.click();
  // AntD's ARIA option is an offscreen accessibility mirror; click the rendered row.
  await c.page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({hasText:name}).click();
}
async function waitNewJob(c,projectId,type,previousIds) {
  const job=await poll(async()=>items(await c.invoke('listJobs',{projectId,type})),jobs=>jobs.some(job=>!previousIds.has(job.id)),{label:`UI-created ${type} intent`});
  const created=job.find(job=>!previousIds.has(job.id));await c.waitJob(created.id);return created;
}
async function openEditor(c) {
  await c.page.getByRole('navigation',{name:'工作阶段'}).getByRole('button',{name:'3 成图',exact:true}).click();
  const lightbox=c.page.getByRole('button',{name:'灯箱',exact:true}).first();
  await lightbox.locator('xpath=ancestor::article').hover();await lightbox.click();
  await c.click('编辑图片');await c.page.getByRole('dialog',{name:'编辑图片',exact:true}).waitFor();
}
async function canvasCORS(c,ref) {
  const result=await c.page.evaluate(async ref=>{
    const image=new Image();image.crossOrigin='anonymous';image.src=window.ecomgen.resourceUrl(ref);
    await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    const context=canvas.getContext('2d');context.drawImage(image,0,0);const sample=[...context.getImageData(0,0,1,1).data];
    const data=canvas.toDataURL('image/png');
    // Write user-visible drawing into a scratch canvas too; this is a real browser canvas round trip.
    context.fillStyle='#ff7755';context.fillRect(0,0,1,1);const after=[...context.getImageData(0,0,1,1).data];
    return {sample,after,width:canvas.width,height:canvas.height,clean:data.startsWith('data:image/png;base64,')};
  },ref);
  c.check(result.clean&&result.width>0&&result.height>0,'restricted protocol supports drawImage/getImageData/toDataURL without taint');c.equal(result.after,[255,119,85,255]);await c.evidence('canvas-cors',result);
}
export const uiScenarios=[
  {id:'ui-provider-setup',title:'Real Provider form, connection-text paste, discovery and key-preserving save',run:async c=>{
    const provider=need(c.state.provider,'Provider unavailable');await home(c);await c.click('设置');
    await c.page.getByRole('navigation',{name:'设置分类'}).getByRole('link',{name:'模型配置',exact:true}).click();
    await c.page.getByRole('tab',{name:'服务连接',exact:true}).click();
    const providerName=provider.name==='Full offline provider'?'Full offline provider retained key':provider.name;
    await c.page.getByRole('row').filter({has:c.page.getByText(providerName,{exact:true})}).getByRole('button',{name:'编辑',exact:true}).click();
    await c.page.getByRole('dialog',{name:'编辑模型与服务连接',exact:true}).waitFor();
    const name=c.page.getByLabel('名称',{exact:true});await name.waitFor();
    c.equal(await c.page.getByLabel(/^API Key/).inputValue(),'','saved key not exposed in form');
    const base=c.page.getByLabel('Base URL',{exact:true});
    await base.evaluate((element,text)=>{const data=new DataTransfer();data.setData('text/plain',text);element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));},JSON.stringify({_type:'newapi_channel_conn',url:c.mock.origin,key:c.fakeKey}));
    await poll(()=>base.inputValue(),value=>value===c.mock.baseUrl,{label:'UI connection text parsed'});
    c.equal(await c.page.getByLabel(/^API Key/).inputValue(),c.fakeKey,'synthetic connection key parsed into password control');
    await c.page.getByLabel(/^API Key/).fill('');
    await name.fill('UI verified offline provider');await c.click('获取模型列表');
    await c.page.getByRole('dialog',{name:'选择要添加的模型',exact:true}).waitFor();
    await c.page.keyboard.press('Escape');
    await c.click('保存');
    const updated=await poll(async()=>items(await c.invoke('listProviders')).find(item=>item.id===provider.id),value=>value?.name==='UI verified offline provider',{label:'provider UI save'});
    c.check(updated.hasApiKey);c.state.provider=updated;c.state.ui.add('provider');
    await c.page.getByRole('dialog',{name:'编辑模型与服务连接',exact:true}).waitFor({state:'hidden'});
    await c.screenshot();
  }},
  {id:'ui-project-workbench',title:'Home creates project, workbench edits facts, plans, confirms and generates through UI',jobTypes:['PLAN','GENERATE'],run:async c=>{
    await home(c);const before=new Set((await allPages(c,'listProjects')).map(project=>project.id));
    await c.click('新建项目');await c.page.getByLabel('项目名称',{exact:true}).waitFor();
    const project=await poll(async()=>allPages(c,'listProjects'),projects=>projects.some(project=>!before.has(project.id)),{label:'UI project create'});
    c.state.uiProject=project.find(item=>!before.has(item.id));
    const projectId=c.state.uiProject.id;
    for(const [label,field,value]of [['项目名称','name','UI acceptance project'],['商品描述','productDescription','Synthetic UI product setup'],['已核验事实','verifiedFacts',['synthetic ceramic']],['禁止宣称','prohibitedClaims',['no medical claims']]]) {
      const control=c.page.getByLabel(label,{exact:true});const text=Array.isArray(value)?value.join('\n'):value;
      await control.fill(text);await control.press('Tab');
      await poll(()=>c.invoke('getProject',{projectId}),project=>JSON.stringify(project[field])===JSON.stringify(value),{label:`${label} autosave persisted`});
      await poll(()=>control.inputValue(),saved=>saved===text,{label:`${label} renderer query settled`});
    }
    const persisted=await poll(()=>c.invoke('getProject',{projectId}),value=>value.name==='UI acceptance project'&&value.productDescription==='Synthetic UI product setup'&&value.verifiedFacts.includes('synthetic ceramic')&&value.prohibitedClaims.includes('no medical claims'),{label:'UI project facts autosave'});c.state.uiProject=persisted;
    const previous=new Set(items(await c.invoke('listJobs',{projectId,type:'PLAN'})).map(job=>job.id));
    await c.click('生成分镜');await waitNewJob(c,projectId,'PLAN',previous);
    const board=await c.invoke('getStoryboard',{projectId});c.check(board.items.length>0);
    await c.page.getByRole('navigation',{name:'工作阶段'}).getByRole('button',{name:'2 图片规划',exact:true}).click();
    await c.page.getByRole('button',{name:`${board.items[0].displayName} 分镜`,exact:true}).click();
    await c.page.getByRole('button',{name:board.items[0].displayName,exact:true}).click();
    await c.page.getByLabel('分镜显示名称',{exact:true}).fill('UI renamed storyboard');await c.page.getByLabel('分镜显示名称',{exact:true}).press('Tab');
    await poll(()=>c.invoke('getStoryboard',{projectId}),value=>value.items.some(item=>item.displayName==='UI renamed storyboard'),{label:'storyboard UI autosave'});
    await dismiss(c);
    const generations=new Set(items(await c.invoke('listJobs',{projectId,type:'GENERATE'})).map(job=>job.id));
    await c.click('全选');await c.click('确认并生成');await waitNewJob(c,projectId,'GENERATE',generations);
    await poll(async()=>items(await c.invoke('listJobs',{projectId,type:'GENERATE'})),jobs=>jobs.filter(job=>!generations.has(job.id)).every(job=>job.status==='SUCCEEDED'),{label:'all UI-selected generations settled'});
    const confirmed=await c.invoke('getStoryboard',{projectId});c.check(confirmed.storyboard.status==='CONFIRMED'||confirmed.storyboard.confirmed===true,'UI confirmation persisted before generation');
    const outputs=items(await c.invoke('listOutputs',{projectId}));c.check(outputs.length>0);c.state.uiOutputs=outputs;
    await canvasCORS(c,{kind:'OUTPUT',id:outputs[0].id});
    c.state.ui.add('project');c.state.ui.add('workbench');c.state.ui.add('storyboard');c.state.ui.add('review');await c.screenshot();
  }},
  {id:'ui-upload-drop-paste',title:'File input selection, drop and paste reach actual project asset imports',run:async c=>{
    const project=need(c.state.uiProject,'UI project unavailable');await openProject(c,project);
    const initial=items(await c.invoke('listAssets',{projectId:project.id}));
    const upload=c.page.getByLabel('上传素材',{exact:true});await upload.setInputFiles(c.image);
    await poll(()=>c.invoke('listAssets',{projectId:project.id}),value=>items(value).length>initial.length,{label:'native file chooser import'});
    // Synthetic DOM events carry actual File bytes; renderer import code is untouched.
    const file=await c.byteFile(c.reference);
    const zone=c.page.locator('label').filter({has:upload});await zone.waitFor();
    await zone.evaluate((element,file)=>{const bytes=Uint8Array.from(atob(file.base64),char=>char.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],file.name,{type:file.mimeType}));element.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));},file);
    const afterDrop=await poll(()=>c.invoke('listAssets',{projectId:project.id}),value=>items(value).length>=initial.length+2,{label:'drop import real backend effect'});c.check(items(afterDrop).length>=2);
    const pasteBytes=await c.sharp(c.mock.images.image).modulate({hue:180}).png().toBuffer();
    await c.page.evaluate(base64=>{const bytes=Uint8Array.from(atob(base64),char=>char.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'paste.png',{type:'image/png'}));document.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));},pasteBytes.toString('base64'));
    const afterPaste=await poll(()=>c.invoke('listAssets',{projectId:project.id}),value=>items(value).length>=initial.length+3,{label:'paste import real backend effect'});c.check(items(afterPaste).length>=3);c.state.ui.add('upload');await c.screenshot();
  }},
  {id:'ui-copy-adoption-late-write',title:'AI copy actually adopts its target field and a later result cannot overwrite user changes',jobTypes:['COPYWRITE'],run:async c=>{
    const project=need(c.state.uiProject,'UI project unavailable');await openProject(c,project);
    const existing=items(await c.invoke('listAssets',{projectId:project.id}));need(existing.some(asset=>asset.role==='PRODUCT_TRUTH'),'UI copy needs a product truth asset');
    const before=await c.invoke('getProject',{projectId:project.id});const jobs=new Set(items(await c.invoke('listJobs',{projectId:project.id,type:'COPYWRITE'})).map(job=>job.id));
    await c.page.getByRole('button',{name:'AI 帮写商品描述',exact:true}).click();const job=await waitNewJob(c,project.id,'COPYWRITE',jobs);
    const result=await c.invoke('getCopywritingResult',{jobId:job.id});
    const adopted=await poll(()=>c.invoke('getProject',{projectId:project.id}),value=>value.productDescription===result.content,{label:'AI copy actual field adoption'});c.check(adopted.productDescription!==before.productDescription);
    c.mock.control.failNext('chat',{type:'delay',ms:1200});
    try {
      const prior=new Set(items(await c.invoke('listJobs',{projectId:project.id,type:'COPYWRITE'})).map(job=>job.id));await c.click('AI 帮写商品描述');
      const field=c.page.getByLabel('商品描述',{exact:true});await field.fill('User wrote this while AI was pending');await field.press('Tab');
      await poll(()=>c.invoke('getProject',{projectId:project.id}),value=>value.productDescription==='User wrote this while AI was pending',{label:'user edit persisted before delayed copy result'});
      const lateJob=await waitNewJob(c,project.id,'COPYWRITE',prior);
      await poll(()=>c.page.getByRole('button',{name:'AI 帮写商品描述',exact:true}).isEnabled(),enabled=>enabled,{label:'renderer observes delayed copy terminal state'});
      const settleUntil=Date.now()+2000;
      try {
        await poll(async()=>({field:await field.inputValue(),project:await c.invoke('getProject',{projectId:project.id})}),value=>{
          c.equal(value.field,'User wrote this while AI was pending','late copy cannot replace the visible user edit');
          c.equal(value.project.productDescription,'User wrote this while AI was pending','late copy cannot overwrite dirty user field');
          return Date.now()>=settleUntil;
        },{label:'user edit remains through terminal query and autosave settlement'});
      } finally {await c.evidence('late-copy-state',{jobId:lateJob.id,field:await field.inputValue(),project:await c.invoke('getProject',{projectId:project.id})});}
    } finally {c.mock.control.clearFaults();}
    c.state.ui.add('copywriting');await c.screenshot();
  }},
  {id:'ui-edit-canvas',title:'Real edit canvas brush/protect strokes, memory and mask submission persist',jobTypes:['EDIT_PLAN','EDIT_GENERATE'],run:async c=>{
    const project=need(c.state.uiProject,'UI project unavailable');await openProject(c,project);
    await openEditor(c);
    const dialog=c.page.getByRole('dialog',{name:'编辑图片',exact:true});await dialog.waitFor();
    await c.page.getByRole('img',{name:'待编辑图片',exact:true}).evaluate(image=>image.decode());
    const canvas=dialog.locator('canvas[data-tool]').first();
    await poll(()=>canvas.evaluate(canvas=>({width:canvas.width,height:canvas.height})),size=>size.width>0&&size.height>0,{label:'editor canvas initialized'});
    const stroke=async(x,y)=>{await canvas.scrollIntoViewIfNeeded();const box=need(await canvas.boundingBox(),'Edit canvas has no actual bounding box');await c.page.mouse.move(box.x+box.width*x,box.y+box.height*y);await c.page.mouse.down();await c.page.mouse.move(box.x+box.width*(x+0.15),box.y+box.height*(y+0.1),{steps:8});await c.page.mouse.up();};
    await c.click('涂抹可编辑区域',dialog);await stroke(0.45,0.45);await c.click('保护区域',dialog);await stroke(0.15,0.15);
    const read=await poll(()=>canvas.evaluate(canvas=>({width:canvas.width,height:canvas.height,sample:canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some(value=>value!==0),url:canvas.toDataURL().startsWith('data:image/png')})),value=>value.sample&&value.url,{label:'pointer strokes rendered on editor canvas'});c.check(read.sample&&read.url,'canvas reads and writes are real');await c.evidence('canvas-strokes',read);
    await dialog.getByPlaceholder('例如：保持晨光方向和木质台面').fill('UI branch memory');await c.click('保存记忆',dialog);
    await dialog.getByPlaceholder('例如：把选中的菠萝颜色调得更金黄，保留叶片和背景光线').fill('Recolor selected pixels, preserve protected area.');
    const oldIds=new Set(items(await c.invoke('listJobs',{projectId:project.id,type:'EDIT_PLAN'})).map(job=>job.id));
    c.state.editVariant='no-confirmation';
    try{await c.click('生成计划',dialog);await waitNewJob(c,project.id,'EDIT_PLAN',oldIds);const detail=await poll(()=>c.invoke('getProject',{projectId:project.id}),value=>value.outputs.some(output=>output.editTurnId),{label:'canvas edit generated output'});const edited=detail.outputs.find(output=>output.editTurnId);const turn=await c.invoke('getEditTurn',{turnId:edited.editTurnId});c.check(turn.annotations&&turn.id);await c.imageRef({kind:'EDIT_MASK',id:turn.id});await c.imageRef({kind:'PROTECT_MASK',id:turn.id});c.state.uiEditOutput=edited;}
    finally{c.state.editVariant='confirmation';}
    c.state.ui.add('edit');await c.screenshot();await dismiss(c);
  }},
  {id:'ui-auto-layers-export-compose',title:'Automatic layers UI creates plan/PNG/PSD and layer composition canvas remains clean',jobTypes:['LAYER_PLAN','LAYER_EXPORT'],run:async c=>{
    const project=need(c.state.uiProject,'UI project unavailable');
    await c.invoke('updateProject',{projectId:project.id,segmentationModel:{providerId:c.state.provider.id,modelId:'sam-3',protocol:'fal'}});
    await openProject(c,project);await openEditor(c);
    await c.click('AI 分层导出');await c.page.getByRole('heading',{name:'AI 分层导出',exact:true}).waitFor();
    const before=new Set(items(await c.invoke('listJobs',{projectId:project.id,type:'LAYER_PLAN'})).map(job=>job.id));await c.click(/智能识别|重新识别/);await waitNewJob(c,project.id,'LAYER_PLAN',before);
    const image=await c.page.getByRole('img',{name:'待编辑图片'}).getAttribute('src');
    const projectOutputs=(await c.invoke('getProject',{projectId:project.id})).outputs;
    const resources=await c.page.evaluate(ids=>ids.map(id=>({id,url:window.ecomgen.resourceUrl({kind:'OUTPUT',id})})),projectOutputs.map(output=>output.id));
    const output=need(projectOutputs.find(output=>resources.some(ref=>ref.id===output.id&&ref.url===image)),'Visible editor source does not match persisted output');
    await c.click('生成图层文件');
    const layer=await poll(()=>c.invoke('getLayerExport',{outputId:output.id}),value=>['SUCCEEDED','FAILED','UNKNOWN'].includes(value.status),{label:'UI layers export'});await verifyUiLayers(c,layer,output);
    await c.click('图层编排');const stack=c.page.getByRole('dialog',{name:'图层编排',exact:true});await stack.waitFor();
    const hide=stack.getByRole('button',{name:/隐藏图层/}).first();await hide.click();await stack.getByRole('button',{name:/显示图层/}).first().waitFor();
    c.equal(await stack.locator('img[data-hidden="true"]').count(),1,'hide action updates actual composition image state');
    await exportUiComposition(c,stack);
    c.state.ui.add('layers');await c.screenshot();await c.click('关闭',stack);await dismiss(c);
  }},
  {id:'ui-suite-forge',title:'Suite forge page submits automatic and explicit five-shot targets, edits and commits',jobTypes:['SUITE_FORGE'],run:async c=>{
    for(const target of ['automatic','five']) {
      await home(c);await navigate(c,'套图工坊','把爆款套图，变成可复用模板');
      await c.page.locator('input[type=file]').setInputFiles([c.image,c.reference]);
      await c.page.getByPlaceholder('例：氨基酸洁面泡沫套图').fill(`UI suite forge ${target}`);
      if(target==='automatic')await c.page.getByText('目标分镜自动',{exact:true}).waitFor();
      else await choose(c,c.page.locator('label').filter({has:c.page.getByText('目标分镜数',{exact:true})}).getByRole('combobox'),'5 张');
      await choose(c,c.page.getByRole('combobox').filter({hasNot:c.page.locator('[disabled]')}).last(),/mock-reasoner/);
      const before=new Set(items(await c.invoke('listSuiteForgeJobResults')).map(row=>row.jobId));await c.click('开始反推');
      const row=await poll(async()=>items(await c.invoke('listSuiteForgeJobResults')),rows=>rows.some(row=>!before.has(row.jobId)),{label:`suite UI creates ${target} forge job`});const jobId=row.find(row=>!before.has(row.jobId)).jobId;await c.waitJob(jobId);
      const draft=await c.invoke('getSuiteForgeResult',{jobId});c.equal(draft.status,'DRAFT','forge result requires confirmation before entering library');
      if(target==='five')c.equal(draft.suite.shots.length,5,'explicit five-shot result');
      else c.check(draft.suite.shots.length>=5&&draft.suite.shots.length<=12,'automatic result retains domain shot bounds');
      const review=c.page.getByRole('region',{name:'反推结果',exact:true});const editedName=`UI suite ${target} edited before commit`;
      await review.getByRole('textbox',{name:'套图名称',exact:true}).fill(editedName);await c.click('确认入库',review);
      const committed=await poll(()=>c.invoke('getSuiteForgeResult',{jobId}),result=>result.status==='COMMITTED',{label:`UI suite ${target} committed`});c.equal(committed.suite.name,editedName);
      if(target==='automatic')await c.click('再反推一套');
    }
    c.state.ui.add('suite-forge');await c.screenshot();
  }},
  {id:'ui-model-designer',title:'Model designer preset produces a real model; reference face and cast/select interact visibly',jobTypes:['MODEL_CAST'],run:async c=>{
    await home(c);await navigate(c,'模特库','模特库');await c.click('新建模特');await c.page.getByPlaceholder('例如：小满').fill('UI designed model');
    const designer=c.page.getByRole('dialog',{name:'新建模特'});
    await designer.getByRole('combobox').click();await c.page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();await c.click('创建模特');
    const model=await poll(async()=>items(await c.invoke('listModels')),rows=>rows.some(row=>row.name==='UI designed model'),{label:'designer persisted model'});const created=model.find(row=>row.name==='UI designed model');
    await c.page.getByRole('list',{name:'模特列表'}).getByRole('button').filter({hasText:'UI designed model'}).click();
    await c.page.getByRole('heading',{name:'UI designed model',exact:true}).waitFor();
    await c.page.locator('input[type=file]').setInputFiles(c.reference);await poll(()=>c.invoke('getModel',{modelId:created.id}),value=>value.hasReferenceFace,{label:'UI reference face'});
    await choose(c,c.page.getByRole('combobox').first(),/mock-image/);await c.click(/生成定妆照|开始选角|生成候选/);
    const portraits=await poll(()=>c.invoke('listModelPortraits',{modelId:created.id}),value=>items(value).length>0,{label:'UI cast portraits'});c.check(items(portraits).length>0);
    await c.page.getByRole('button',{name:'设为选定',exact:true}).first().click();
    const selected=await poll(()=>c.invoke('getModel',{modelId:created.id}),value=>Boolean(value.selectedPortrait),{label:'UI selected portrait'});c.check(selected.selectedPortrait.id);c.state.ui.add('models');await c.screenshot();
  }},
  {id:'ui-draft-and-pattern-routes',title:'Draft list/workspace create, autosave, generate/finalize then formal pattern detail',jobTypes:['PATTERN_DRAFT_GENERATE'],run:async c=>{
    await home(c);await navigate(c,'花型工坊','花型工坊');
    await c.page.getByRole('button',{name:'AI 起稿',exact:true}).first().click();await c.page.getByPlaceholder('草稿名称（可选，进入后可重命名）').fill('UI draft');await c.click('进入工作台');
    const name=c.page.getByLabel('草稿名称',{exact:true});await name.waitFor();await name.fill('UI draft saved');await name.press('Tab');
    const drafts=await poll(()=>c.invoke('listPatternDrafts'),value=>items(value).some(draft=>draft.name==='UI draft saved'),{label:'UI draft rename'});const draft=items(drafts).find(draft=>draft.name==='UI draft saved');
    await c.click('画一张草图');const sketch=c.page.getByRole('dialog',{name:'画一张草图',exact:true});await sketch.waitFor();
    const surface=sketch.locator('canvas').last();await surface.hover();const bounds=need(await surface.boundingBox(),'Sketch canvas unavailable');
    await surface.hover({position:{x:bounds.width*0.2,y:bounds.height*0.3}});await c.page.mouse.down();
    await surface.hover({position:{x:bounds.width*0.6,y:bounds.height*0.65}});await c.page.mouse.up();
    const marks=await poll(()=>sketch.locator('canvas').first().evaluate(canvas=>{const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let count=0;for(let i=0;i<data.length;i+=4)if(data[i+3]>0&&(data[i]<240||data[i+1]<240||data[i+2]<240))count++;return count;}),count=>count>0,{label:'sketch committed nonwhite pointer stroke'});c.check(marks>0,'draft sketch pointer stroke reached real canvas');
    await c.click('作为参考图加入',sketch);
    const media=await poll(()=>c.invoke('listDraftMedia',{draftId:draft.id}),value=>items(value).some(item=>item.role==='REFERENCE'),{label:'drawn sketch persists as numbered reference'});const savedSketch=items(media).find(item=>item.role==='REFERENCE');c.check(savedSketch.ordinal>0);await c.imageRef((await c.invoke('downloadDraftMediaFile',{draftId:draft.id,mediaId:savedSketch.id})).ref);c.state.ui.add('draft-sketch');
    await c.page.getByPlaceholder('描述图案主题与画面，例：水彩野花束、奶油色底').fill(`UI coral flower #ff7755 use @图${savedSketch.ordinal}`);
    await choose(c,c.page.getByRole('combobox',{name:'生图模型',exact:true}),/mock-image/);await c.click('生成 / 再来一组');
    const candidates=await poll(()=>c.invoke('listDraftCandidates',{draftId:draft.id}),value=>items(value).length>0,{label:'UI draft generation'});c.check(items(candidates).length>0);
    await c.click('定稿入库');await c.click('入库为正式花型');
    const patterns=await poll(()=>c.invoke('listPatterns'),value=>items(value).some(pattern=>pattern.name.includes('UI draft saved')),{label:'UI explicit finalization'});const pattern=items(patterns).find(pattern=>pattern.name.includes('UI draft saved'));
    await c.page.getByRole('heading',{name:pattern.name,exact:true}).waitFor();await c.imageRef({kind:'PATTERN',id:pattern.id});
    c.state.ui.add('patterns');c.state.ui.add('pattern-detail');c.state.ui.add('draft-workspace');await c.screenshot();
    await c.click('花型墙');await c.page.getByRole('heading',{name:'花型工坊',exact:true}).waitFor();await c.click(/^草稿 · /);await c.page.getByRole('heading',{name:'草稿',exact:true}).waitFor();
    await c.page.getByRole('list',{name:'草稿列表'}).getByText('UI draft saved',{exact:true}).waitFor();c.state.ui.add('drafts');await c.screenshot('draft-list');
  }},
  {id:'ui-library-copy',title:'Library search/selection/target picker copies real independent asset into project',run:async c=>{
    const target=await c.invoke('createProject',projectInput(c,'UI library copy target'));
    await home(c);await navigate(c,'资产库','资产库');await c.page.getByLabel('搜索资产库',{exact:true}).fill('Full acceptance cup');
    await c.page.getByText('关键词：Full acceptance cup',{exact:true}).waitFor();
    const select=c.page.getByRole('button',{name:/^选择 /}).first();await select.waitFor();await select.click();
    const targetPicker=c.page.locator('.ant-select').filter({has:c.page.getByText('选择目标项目',{exact:true})}).getByRole('combobox');
    await choose(c,targetPicker,target.name);await c.click('添加到项目');
    const assets=await poll(()=>c.invoke('listAssets',{projectId:target.id}),value=>items(value).length>0,{label:'UI library copy'});await c.imageRef({kind:'ASSET',id:items(assets)[0].id});c.state.ui.add('library');await c.screenshot();
  }},
  {id:'ui-routes-theme',title:'All nine original route families render their current heading before screenshots',run:async c=>{
    // The preceding UI scenarios cover parameter routes by actual cards and router transitions.
    const required=['project','workbench','storyboard','review','provider','upload','copywriting','edit','layers','suite-forge','models','patterns','pattern-detail','drafts','draft-workspace','draft-sketch','library'];
    for(const family of required)c.check(c.state.ui.has(family),`observable backend-effect UI family ${family}`);
    await home(c);
    const theme=await c.page.evaluate(()=>{
      const body=getComputedStyle(document.body);
      const primary=[...document.querySelectorAll('button')].find(button=>button.textContent?.trim()==='新建项目');
      const button=primary?getComputedStyle(primary):null;
      return {body:body.backgroundColor,font:body.fontFamily,accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),primary:button?{background:button.backgroundColor,color:button.color}:null};
    });
    c.equal(theme.body,'rgb(8, 8, 8)','PixelMuse monochrome base is actually applied');
    c.check(theme.font.length>0,'PixelMuse system typography loaded');
    c.check(Boolean(theme.primary),'home new-project action exists for the visual contrast check');
    if(theme.primary){
      const luminance=css=>{const values=css.match(/[\d.]+/g)?.slice(0,3).map(value=>Number(value)/255);if(!values||values.length!==3)throw Error('Expected computed RGB color');return values.map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);};
      const background=luminance(theme.primary.background),ink=luminance(theme.primary.color);
      c.check(background>0.8&&ink<0.1,'monochrome primary action has a light background and dark text');
      c.check((background+0.05)/(ink+0.05)>=4.5,'primary action text contrast meets 4.5:1');
    }
    for(const [button,heading]of [['套图工坊','把爆款套图，变成可复用模板'],['模特库','模特库'],['资产库','资产库'],['花型工坊','花型工坊']]){await navigate(c,button,heading);await c.screenshot(`route-${button}`);}
    await c.evidence('route-families',{routes:['/','/projects/:projectId','/library','/suite-forge','/models','/patterns','/patterns/:patternId','/pattern-drafts','/pattern-drafts/:draftId'],verifiedUiFamilies:[...c.state.ui],theme});
  }},
];
