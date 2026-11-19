import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,readdir,rename,stat,writeFile} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {makeContext,executeScenario,poll,items,appPackage,desktop,root,requireApp} from './e2e-full-harness.mjs';
import {launchGuardedElectron} from './e2e-full-startup-guard-launch.mjs';
import {modelCapability,projectInput,plan,generate} from './e2e-full-business.mjs';
import {startPixelMuseProductFixture,createPixelMuseProductImages} from './pixelmuse-product-fixture.mjs';
import {captureRuntimeIdentity,hashPhysicalFile} from './pixelmuse-runtime-identity.mjs';

// New capabilities run through the actual sandboxed renderer/preload/main/Backend.
// Synthetic fixtures and test-controlled native dialogs never touch real profiles.
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const expectedVersion=JSON.parse(await readFile(appPackage,'utf8')).version;
const artifacts=resolve(process.env.ECOMGEN_E2E_ARTIFACTS||join(root,'.cache/e2e-full',`pixelmuse-${new Date().toISOString().replace(/[:.]/g,'-')}`));
await mkdir(artifacts,{recursive:true});assert.equal((await readdir(artifacts)).length,0,'Use a new/empty ECOMGEN_E2E_ARTIFACTS directory');process.env.ECOMGEN_E2E_ARTIFACTS=artifacts;
const runId=randomUUID(),runtimeMode=process.env.ECOMGEN_E2E_EXECUTABLE?'exe':'source';
const c=await makeContext();c.result.runId=runId;
let site;
const extra=[];
const native=(api,operation,input={})=>c.page.evaluate(async ({api,operation,input})=>window.ecomgen[api](operation,input),{api,operation,input});
async function openWorkspaceSettings(){
  await c.page.getByRole('button',{name:'设置',exact:true}).click();
  await c.page.getByRole('navigation',{name:'设置分类'}).getByRole('link',{name:'工作空间与数据',exact:true}).click();
  await c.page.getByRole('heading',{name:'工作空间与数据',exact:true}).waitFor();
  const panel=c.page.getByRole('region',{name:'设置内容',exact:true});
  await panel.getByLabel('当前工作空间目录').waitFor();
  return panel;
}
async function filesUnder(directory){
  const result=[];
  async function visit(current){for(const item of await readdir(current,{withFileTypes:true})){const filename=join(current,item.name);assert.equal(item.isSymbolicLink(),false,'fixture media tree must not contain links');if(item.isDirectory())await visit(filename);else if(item.isFile()){const bytes=await readFile(filename);result.push({path:relative(directory,filename).replaceAll('\\','/'),size:bytes.length,hash:hash(bytes)});}}}
  try{await visit(directory)}catch(error){if(error.code!=='ENOENT')throw error}
  return result;
}
async function launch(executable=process.env.ECOMGEN_E2E_EXECUTABLE,{baseline=false}={}){
  assert.equal(c.app,null,'Stop the current owned Electron before relaunching');
  const token=randomUUID();
  const env={...process.env,ECOMGEN_DESKTOP_DATA_DIR:c.userData,ECOMGEN_E2E_GUARD_ORIGINS:JSON.stringify([c.mock.origin,...extra]),ECOMGEN_E2E_GUARD_AUDIT:join(c.fixture,'network-audit.jsonl'),ECOMGEN_E2E_APP_PACKAGE:appPackage,ECOMGEN_E2E_GUARD_TOKEN:token,HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'127.0.0.1',http_proxy:'',https_proxy:'',all_proxy:'',no_proxy:'127.0.0.1'};
  delete env.NODE_OPTIONS;delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  c.activeData=c.userData;
  try{
    c.app=await launchGuardedElectron({executable:executable||requireApp('electron'),args:executable?[]:[desktop],env,timeout:45000});
    const identity=await c.app.evaluate(()=>({pid:process.pid,guard:globalThis.__ecomgenFullGuard}));assert.equal(identity.guard.token,token);
    c.startupGuard={token,browserPid:identity.pid,backendPid:null};c.page=await c.app.firstWindow();c.page.setDefaultTimeout(12000);
    c.page.on('pageerror',error=>c.state.events.push({type:'pageerror',message:c.redact(error.message)}));
    await poll(async()=>{try{return await c.invoke('getHealth')}catch{return null}},value=>value?.status==='ready',{label:'PixelMuse renderer and Backend ready'});
    if(baseline){const previous=await c.app.evaluate(({app})=>({version:app.getVersion(),packaged:app.isPackaged,archive:app.getAppPath(),executable:process.execPath}));assert.equal(previous.version,'0.3.0');assert.equal(previous.packaged,true);c.result.baselineIdentity={version:previous.version,packaged:true,archive:{path:previous.archive,sha256:await hashPhysicalFile(previous.archive)},executable:{path:previous.executable,sha256:await hashPhysicalFile(previous.executable)}};}
    else{const runtimeIdentity=await captureRuntimeIdentity(c.app,{mode:runtimeMode,runId});assert.equal(runtimeIdentity.version,expectedVersion);if(c.result.runtimeIdentity)assert.deepEqual(runtimeIdentity,c.result.runtimeIdentity,'compiled runtime unchanged across restart');else c.result.runtimeIdentity=runtimeIdentity;}
  }catch(error){try{await c.stop()}catch{c.result.launchCleanupFailed=true}throw error}
}
const legacySeed={id:'pixelmuse-0.3-seed',title:'Released 0.3.0 writes a synthetic project, image and encrypted Provider before brand upgrade',run:async c=>{
  const released=resolve(process.env.PIXELMUSE_BASELINE_EXECUTABLE||join(root,'release/0.3.0/win-unpacked/EcomGen.exe'));assert.ok((await stat(released)).isFile(),'released 0.3.0 EXE is required; set PIXELMUSE_BASELINE_EXECUTABLE to its path');
  try{await launch(released,{baseline:true});
  c.equal(await c.app.evaluate(({app})=>app.getVersion()),'0.3.0');c.equal((await c.inspect()).version,3);
  c.state.provider=await c.invoke('createProvider',{name:'PixelMuse isolated provider',baseUrl:c.mock.baseUrl,apiKey:c.fakeKey,reasoningProtocol:'openai',models:[modelCapability('mock-reasoner'),modelCapability('mock-image',{imageApiKind:'openai_images'})]});
  c.state.project=await c.invoke('createProject',projectInput(c,'LUMA · 春季创作验收',{productDescription:'Synthetic LUMA hand wash bottle for offline desktop acceptance.',verifiedFacts:['synthetic 300 mL bottle']}));
  c.state.asset=await c.invoke('uploadAsset',{projectId:c.state.project.id,role:'PRODUCT_TRUTH',file:await c.byteFile(c.image)});
  c.state.keyHash=hash(await readFile(join(c.userData,'master-key.enc')));c.state.assetHash=hash(await c.save({kind:'ASSET',id:c.state.asset.id}));
  }finally{await c.stop();}
}};
async function installFixtureCollection(){
  // Inject one exact loopback exception into the shipped policy object. The
  // shipped service, IPC trusted check, extraction and import code remain intact.
  await c.app.evaluate(async ({app,ipcMain},origin)=>{
    const fixture=new URL(origin);if(fixture.protocol!=='http:'||fixture.hostname!=='127.0.0.1'||!fixture.port||fixture.origin!==origin)throw Error('Invalid isolated fixture origin');
    const {join}=require('node:path');
    const main=require(join(app.getAppPath(),'out/main/index.js'));
    const policy=main.collectionTransportPolicy;if(!policy)throw Error('Shipped collection transport policy unavailable');
    const allow=policy.allow.bind(policy),allowPort=policy.allowPort.bind(policy);
    policy.allow=(address,url)=>url.origin===origin?address==='127.0.0.1':allow(address,url);
    policy.allowPort=url=>url.origin===origin||allowPort(url);
    const original=ipcMain._invokeHandlers.get('ecomgen:collection');if(!original)throw Error('Production collection IPC handler unavailable');
    globalThis.__pixelmuseFixtureCollection={snapshot:null};
    ipcMain.removeHandler('ecomgen:collection');
    ipcMain.handle('ecomgen:collection',async(...args)=>{const response=await original(...args);const result=response?.ok?response.data:null;if(result&&typeof result.collectionId==='string'&&Array.isArray(result.candidates))globalThis.__pixelmuseFixtureCollection.snapshot=result;return response});
  },site.origin);
}
const scenarios=[
  {id:'pixelmuse-brand-seed',needs:['pixelmuse-0.3-seed'],title:'Actual PixelMuse UI opens 0.3.0 project, image and encrypted Provider without resetting key',run:async c=>{
    await c.page.getByRole('link',{name:'PixelMuse',exact:true}).waitFor();
    const title=await c.page.title();c.check(title.includes('PixelMuse'));
    const body=await c.page.evaluate(()=>getComputedStyle(document.body).backgroundColor);c.equal(body,'rgb(8, 8, 8)');
    c.equal((await c.inspect()).version,6,'0.3.0 canonical v3 upgraded to v6');
    c.equal((await c.invoke('getProject',{projectId:c.state.project.id})).name,c.state.project.name,'old project remains available');
    c.check(items(await c.invoke('listProviders')).some(provider=>provider.id===c.state.provider.id&&provider.hasApiKey),'old encrypted Provider remains configured');
    c.equal(hash(await readFile(join(c.userData,'master-key.enc'))),c.state.keyHash,'rebrand keeps the existing safeStorage key bytes');
    c.equal(hash(await c.save({kind:'ASSET',id:c.state.asset.id})),c.state.assetHash,'old product image remains accessible');
    const probe=await c.invoke('testProviderConnection',{providerId:c.state.provider.id,modelId:'mock-reasoner',kind:'reasoning'});c.equal(probe.ok,true,'old encrypted key decrypts successfully');
    await poll(()=>c.page.getByRole('button',{name:'新建项目',exact:true}).isEnabled(),Boolean,{label:'home primary action ready'});await c.screenshot('brand');
  }},
  {id:'pixelmuse-responsive-ui',needs:['pixelmuse-brand-seed'],title:'Actual minimum-size desktop window keeps navigation and project configuration reachable',run:async c=>{
    try{
      await c.app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('file:'))?.setSize(1000,740)});
      const bounds=await c.page.evaluate(()=>({width:innerWidth,root:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));c.check(bounds.width<=1000);c.check(bounds.root<=bounds.client+1,'minimum window has no document horizontal overflow');
      await c.page.getByRole('navigation',{name:'全局导航'}).waitFor();await c.screenshot('minimum-home');
      await c.page.getByRole('region',{name:'项目画廊'}).getByText(c.state.project.name,{exact:true}).click();
      await c.page.getByRole('navigation',{name:'工作阶段'}).getByRole('button',{name:'1 配置',exact:true}).click();
      const input=c.page.getByLabel('项目名称',{exact:true});await input.scrollIntoViewIfNeeded();const box=await input.boundingBox();c.check(Boolean(box)&&box.x>=0&&box.x+box.width<=bounds.width+1,'project name remains inside minimum viewport');
      await c.page.getByRole('button',{name:'采集参考图',exact:true}).scrollIntoViewIfNeeded();await c.screenshot('minimum-workbench');
      await c.page.getByRole('link',{name:'PixelMuse',exact:true}).click();await c.page.getByRole('region',{name:'项目画廊'}).waitFor();
    }finally{await c.app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('file:'))?.setSize(1440,960)})}
  }},
  {id:'pixelmuse-workspace-cancel',needs:['pixelmuse-brand-seed'],title:'Native directory cancellation leaves current workspace unchanged',run:async c=>{
    const before=await native('workspace','status');c.equal(before.state,'READY');
    await c.app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]})});
    const panel=await openWorkspaceSettings();
    c.equal(await panel.getByLabel('当前工作空间目录').textContent(),before.directory);
    await panel.getByRole('button',{name:'选择工作空间目录',exact:true}).click();await c.page.getByText('已取消选择目录',{exact:true}).waitFor();
    c.equal((await native('workspace','status')).directory,before.directory);await c.page.getByRole('button',{name:'返回创作页面',exact:true}).click();
    c.state.originalDirectory=before.directory;
  }},
  {id:'pixelmuse-workspace-busy',needs:['pixelmuse-brand-seed'],title:'Workspace migration refuses an active paid task without cancelling it',jobTypes:['PLAN'],run:async c=>{
    const selected=join(c.fixture,'busy-workspace');await mkdir(selected);
    const before=await native('workspace','status');
    c.mock.control.failNext('chat',{type:'delay',ms:5000});
    const job=await c.invoke('createPlanningJob',{projectId:c.state.project.id,planningMode:'AI',targetImageCount:1,regenerationKey:randomUUID()});
    await poll(()=>c.invoke('getJob',{jobId:job.id}),value=>value.status==='RUNNING',{label:'active task before workspace request'});
    await c.app.evaluate(({dialog},selected)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]})},selected);
    const result=await c.page.evaluate(async()=>{try{return {ok:true,data:await window.ecomgen.workspace('choose',{})}}catch(error){return {ok:false,message:error.message}}});
    c.equal(result.ok,false,'busy workspace change rejects');c.check(/正在|任务|忙碌|完成后|稍后/.test(result.message),'busy refusal has a specific actionable message');
    const after=await native('workspace','status');c.equal(after.directory,before.directory);c.equal(after.state,'READY');
    await c.waitJob(job.id,'SUCCEEDED');
  }},
  {id:'pixelmuse-workspace-output',needs:['pixelmuse-brand-seed'],title:'Real local Provider generation yields a managed output before relocation',jobTypes:['PLAN','GENERATE'],run:async c=>{
    const board=await plan(c,c.state.project);const generated=await generate(c,c.state.project,board);
    c.state.output=generated.outputs[0];c.state.outputHash=hash(await c.save({kind:'OUTPUT',id:c.state.output.id}));c.check(c.state.outputHash.length===64);
  }},
  {id:'pixelmuse-workspace-relocate',needs:['pixelmuse-workspace-cancel','pixelmuse-workspace-output'],title:'Verified media copy changes workspace, preserves source and leaves database/key in userData',run:async c=>{
    const selected=join(c.fixture,'selected-workspace');await mkdir(selected);
    await c.app.evaluate(({dialog},selected)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]})},selected);
    const previous=await filesUnder(c.state.originalDirectory);
    const workspacePanel=await openWorkspaceSettings();
    await workspacePanel.getByRole('button',{name:'选择工作空间目录',exact:true}).click();
    const status=await poll(()=>native('workspace','migration'),value=>value.state==='FAILED'||(value.state==='READY'&&value.configured&&value.directory!==c.state.originalDirectory),{timeout:120000,label:'workspace migration terminal state'});
    c.equal(status.state,'READY',status.error||'workspace migration succeeded');c.equal(status.configured,true);
    const within=relative(resolve(selected),resolve(status.directory));c.check(within!==''&&!isAbsolute(within)&&within!=='..'&&!within.startsWith('..'+sep),'media root is inside user-selected folder');
    c.state.workspaceDirectory=status.directory;
    await poll(async()=>{try{return await c.invoke('getHealth')}catch{return null}},value=>value?.status==='ready',{label:'Backend ready after workspace change'});
    c.equal(hash(await readFile(join(c.userData,'master-key.enc'))),c.state.keyHash,'system-protected master-key bytes unchanged');
    c.check((await stat(join(c.userData,'data/backend.sqlite'))).isFile(),'business SQLite remains in original userData');
    const copied=await filesUnder(status.directory);
    c.check(!copied.some(file=>/backend\.sqlite|master-key\.enc|main\.log/i.test(file.path)),'media workspace excludes business database/key/log');
    const managed=previous.filter(file=>/^(assets|outputs|exports|edits|layers|thumbs|tmp|suite-forge|models|patterns|print-packs|drafts|suites)\//.test(file.path));
    c.check(managed.length>0,'migration has actual existing media to copy');c.check(managed.some(file=>file.hash===c.state.assetHash),'seeded upload is included in copy proof');c.check(managed.some(file=>file.hash===c.state.outputHash),'generated output is included in copy proof');
    for(const file of managed){c.check(copied.some(other=>other.path===file.path&&other.hash===file.hash),'each existing managed media file retains bytes');c.equal(hash(await readFile(join(c.state.originalDirectory,file.path))),file.hash,'source media preserved');}
    c.equal(hash(await c.save({kind:'ASSET',id:c.state.asset.id})),c.state.assetHash);c.equal(hash(await c.save({kind:'OUTPUT',id:c.state.output.id})),c.state.outputHash);
    await c.evidence('workspace',{state:status.state,copiedManagedFiles:managed.length,totalFiles:copied.length,databaseStayedInUserData:true,keyUnchanged:true});
    await poll(()=>workspacePanel.getByLabel('当前工作空间目录').textContent(),value=>value===status.directory,{label:'workspace settings reflects actual migrated root'});
    await workspacePanel.getByText('可以创作',{exact:true}).waitFor();
    await c.screenshot('workspace');await c.page.getByRole('button',{name:'返回创作页面',exact:true}).click();
    const disconnected=status.directory+'.offline-'+randomUUID();await rename(status.directory,disconnected);
    try{
      const missing=await poll(()=>native('workspace','status'),value=>value.state==='FAILED',{label:'disconnected media root is unavailable'});c.equal(missing.directory,status.directory,'no silent fallback to old source');
      let absent=false;try{await stat(status.directory)}catch(error){if(error.code==='ENOENT')absent=true;else throw error}c.equal(absent,true,'missing workspace is not recreated as an empty substitute');
      await c.rejects('getResource',{ref:{kind:'ASSET',id:c.state.asset.id}},/工作空间不可用|连接原设备/);
      const offlineSettings=await c.invoke('getApplicationSettings');
      c.equal((await c.invoke('updateApplicationSettings',{startupPage:offlineSettings.startupPage})).startupPage,offlineSettings.startupPage,'database-only settings remain writable while media is unavailable');
      c.check(Array.isArray((await c.invoke('listModelPricing',{})).items),'model pricing remains readable without media');
      c.check(Array.isArray((await c.invoke('listUsage',{limit:1})).items),'usage history remains readable without media');
      c.check(Number.isSafeInteger((await c.invoke('getUsageSummary',{})).requestCount),'usage summary remains readable without media');
      c.equal((await native('application','info')).name,'PixelMuse','native application information remains available without media');
      await c.page.getByRole('button',{name:'设置',exact:true}).click();
      await c.page.getByRole('navigation',{name:'设置分类'}).getByRole('link',{name:'常规设置',exact:true}).click();
      await c.page.getByRole('heading',{name:'常规设置',exact:true}).waitFor();c.check(true,'actual settings navigation stays available while media is disconnected');
      await c.page.getByRole('button',{name:'返回创作页面',exact:true}).click();
    }finally{await rename(disconnected,status.directory)}
    await c.app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]})},status.directory);
    const reconnect=await openWorkspaceSettings();await reconnect.getByRole('button',{name:'选择工作空间目录',exact:true}).click();
    await poll(()=>native('workspace','status'),value=>value.state==='READY',{label:'original workspace identity reconnects'});await poll(async()=>{try{return await c.invoke('getHealth')}catch{return null}},value=>value?.status==='ready',{label:'Backend resumes after reconnect'});
    c.equal(hash(await c.save({kind:'ASSET',id:c.state.asset.id})),c.state.assetHash);await reconnect.getByText('可以创作',{exact:true}).waitFor();await c.screenshot('reconnected-workspace');await c.page.getByRole('button',{name:'返回创作页面',exact:true}).click();
  }},
  {id:'pixelmuse-canvas-archive',needs:['pixelmuse-workspace-relocate'],title:'Canvas-generated PNG is archived in workspace even when external save is canceled',run:async c=>{
    const before=await filesUnder(c.state.workspaceDirectory);
    await c.app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true})});
    const image=await c.sharp(c.mock.images.image).modulate({hue:233}).png().toBuffer();
    const saved=await c.page.evaluate(file=>window.ecomgen.saveGeneratedFile(file),{name:'PixelMuse-canvas.png',mimeType:'image/png',base64:image.toString('base64')});
    c.equal(saved,false,'native external save was canceled');
    const after=await filesUnder(c.state.workspaceDirectory);
    c.check(after.some(file=>file.path.startsWith('exports/')&&file.hash===hash(image)&&!before.some(old=>old.path===file.path)),'canvas bytes actually archived under workspace exports');
  }},
  {id:'pixelmuse-workspace-restart',needs:['pixelmuse-canvas-archive'],title:'App restart preserves selected media root, resources, projects and encrypted Provider',run:async c=>{
    await c.stop();await launch();
    const status=await native('workspace','status');c.equal(status.state,'READY');c.equal(status.directory,c.state.workspaceDirectory);
    const project=await c.invoke('getProject',{projectId:c.state.project.id});c.equal(project.name,c.state.project.name);
    c.check(items(await c.invoke('listProviders')).some(provider=>provider.id===c.state.provider.id&&provider.hasApiKey));
    c.equal(hash(await readFile(join(c.userData,'master-key.enc'))),c.state.keyHash);
    const probe=await c.invoke('testProviderConnection',{providerId:c.state.provider.id,modelId:'mock-reasoner',kind:'reasoning'});c.equal(probe.ok,true,'old encrypted Key remains usable');
    c.equal(hash(await c.save({kind:'ASSET',id:c.state.asset.id})),c.state.assetHash);
    await c.screenshot('restart');
  }},
  {id:'pixelmuse-collection-import',needs:['pixelmuse-workspace-restart'],title:'Collection UI opens a normal browser, previews and imports a selected reference with persistent clean provenance',run:async c=>{
    await installFixtureCollection();
    await c.page.getByRole('link',{name:'PixelMuse',exact:true}).click();
    await c.page.getByRole('region',{name:'项目画廊'}).getByText(c.state.project.name,{exact:true}).click();
    await c.page.getByRole('navigation',{name:'工作阶段'}).getByRole('button',{name:'1 配置',exact:true}).click();
    await c.page.getByRole('button',{name:'采集参考图',exact:true}).click();
    const drawer=c.page.getByRole('dialog',{name:'电商灵感采集'});await drawer.waitFor();
    await drawer.getByLabel('商品链接',{exact:true}).fill(site.origin+'/product?id=123&utm_source=fixture&token=synthetic-auth-query');
    const before=await c.invoke('getProject',{projectId:c.state.project.id});const beforeIds=new Set(before.assets.map(asset=>asset.id));const paidBefore=c.mock.state.total;
    await drawer.getByRole('button',{name:'打开浏览窗口',exact:true}).click();
    await poll(()=>c.app.evaluate(({BrowserWindow},origin)=>BrowserWindow.getAllWindows().some(window=>!window.isDestroyed()&&window.webContents.getURL().startsWith(origin+'/product')&&!window.webContents.isLoadingMainFrame()),site.origin),Boolean,{label:'synthetic product page loaded in isolated browser'});
    await c.app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('file:'))?.focus()});
    await drawer.getByRole('button',{name:'读取当前页图片',exact:true}).click();
    const snapshot=await poll(()=>c.app.evaluate(()=>globalThis.__pixelmuseFixtureCollection.snapshot),value=>value?.candidates.length>=2,{label:'real DOM collection candidates'});
    c.check(!/[?&](token|utm_source)=/i.test(snapshot.page.url),'authentication/tracking query omitted from source');c.check(snapshot.page.title.includes('PixelMuse'));
    await drawer.getByRole('img',{name:'采集图片 2',exact:true}).waitFor();
    await drawer.getByRole('checkbox',{name:'选择图片 2',exact:true}).check();await c.screenshot('collection-selected');
    await drawer.getByRole('button',{name:'导入当前项目',exact:true}).click();
    await drawer.getByRole('region',{name:'采集导入结果'}).getByText('已导入',{exact:true}).waitFor();
    const after=await poll(()=>c.invoke('getProject',{projectId:c.state.project.id}),value=>value.assets.some(asset=>!beforeIds.has(asset.id)),{label:'collected asset committed through actual Backend'});
    const asset=after.assets.find(asset=>!beforeIds.has(asset.id));c.equal(asset.role,'STYLE_REFERENCE');c.equal(after.verifiedFacts,before.verifiedFacts);c.equal(after.productDescription,before.productDescription);
    c.equal(after.assets.find(asset=>asset.id===c.state.asset.id).role,'PRODUCT_TRUTH','existing product truth remains unchanged');
    const selection={collectionId:snapshot.collectionId,revision:snapshot.revision,candidateId:snapshot.candidates[1].candidateId};
    const duplicate=await native('collection','import',selection);c.equal(duplicate.status,'ALREADY_PRESENT');c.equal(duplicate.assetId,asset.id);
    const sources=await native('collection','sources',{projectId:c.state.project.id});const source=sources.items.find(item=>item.assetId===asset.id);c.check(Boolean(source));c.equal(source.pageUrl,snapshot.page.url);c.check(source.collectedAt.length>0);
    const bytes=await c.save({kind:'ASSET',id:asset.id},'webp');const meta=await c.sharp(bytes).metadata();c.equal([meta.width,meta.height],[640,640]);
    c.check((await filesUnder(c.state.workspaceDirectory)).some(file=>file.path.startsWith('assets/')&&file.hash===hash(bytes)),'collected original resides in selected workspace');
    c.equal(c.mock.state.total,paidBefore,'collecting a reference does not call the paid Provider');
    c.state.collectedAsset=asset;c.state.collectedSource=source;c.state.collectedHash=hash(bytes);c.state.collection=snapshot;
    await c.screenshot('collection-import');
  }},
  {id:'pixelmuse-collection-isolation',needs:['pixelmuse-collection-import'],title:'Remote collection page has no Node/preload/app IPC and navigation invalidates old candidate identity',run:async c=>{
    const info=await c.app.evaluate(async ({BrowserWindow,session,ipcMain},{origin,projectId})=>{
      const remote=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith(origin));if(!remote)throw Error('Collection browser missing');
      const preferences=remote.webContents.getLastWebPreferences();const bridge=await remote.webContents.executeJavaScript('window.fixtureIsolation');
      const reply=await ipcMain._invokeHandlers.get('ecomgen:collection')({sender:remote.webContents,senderFrame:remote.webContents.mainFrame},'sources',{projectId});
      const appCookies=await session.defaultSession.cookies.get({url:origin});
      globalThis.__pixelmuseFixtureCollection.session=remote.webContents.session;
      return {bridge,nodeIntegration:preferences.nodeIntegration,contextIsolation:preferences.contextIsolation,sandbox:preferences.sandbox,preload:Boolean(preferences.preload),isolated:remote.webContents.session!==session.defaultSession,appCookieCount:appCookies.length,remoteIpc:reply};
    },{origin:site.origin,projectId:c.state.project.id});
    c.equal(info.bridge,{node:'undefined',bridge:'undefined'});c.equal(info.nodeIntegration,false);c.equal(info.contextIsolation,true);c.equal(info.sandbox,true);c.equal(info.preload,false);c.equal(info.isolated,true);c.equal(info.appCookieCount,0);c.equal(info.remoteIpc.ok,false);c.equal(info.remoteIpc.error.code,'FORBIDDEN');
    await c.app.evaluate(async ({BrowserWindow},origin)=>{const root=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith(origin+'/product'));await root.webContents.executeJavaScript('document.querySelector(\'a[href="/popup-product"]\').click()')},site.origin);
    await poll(()=>c.app.evaluate(({BrowserWindow},origin)=>BrowserWindow.getAllWindows().some(window=>window.webContents.getURL()===origin+'/popup-product'&&!window.webContents.isLoadingMainFrame()),site.origin),Boolean,{label:'allowed product popup loaded'});
    await c.app.evaluate(({BrowserWindow},origin)=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===origin+'/popup-product').focus(),site.origin);
    const popup=await native('collection','refresh',{collectionId:c.state.collection.collectionId});c.check(popup.page.title.includes('Popup product'));c.check(popup.page.url.endsWith('/popup-product'));c.equal(popup.candidates.length,1,'refresh reads the focused product popup');
    await c.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('file:')).focus());
    const popupDrawer=c.page.getByRole('dialog',{name:'电商灵感采集'});await popupDrawer.getByText(popup.page.title,{exact:true}).waitFor();await popupDrawer.getByRole('img',{name:'采集图片 1',exact:true}).waitFor();
    const popupImport=await native('collection','import',{collectionId:popup.collectionId,revision:popup.revision,candidateId:popup.candidates[0].candidateId});c.equal(popupImport.status,'IMPORTED');
    const popupSource=(await native('collection','sources',{projectId:c.state.project.id})).items.find(item=>item.assetId===popupImport.assetId);c.equal(popupSource.pageUrl,popup.page.url);c.equal(popupSource.title,popup.page.title);c.state.popupSource=popupSource;
    await c.app.evaluate(({BrowserWindow},origin)=>{BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===origin+'/popup-product').close();BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith(origin+'/product')).focus()},site.origin);
    c.state.collection=await native('collection','refresh',{collectionId:popup.collectionId});c.check(c.state.collection.page.url.includes('/product?'),'closing a popup restores the original product window');
    const before=items(await c.invoke('listAssets',{projectId:c.state.project.id})).length;
    await c.app.evaluate(async ({BrowserWindow},origin)=>{const remote=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith(origin));await remote.webContents.executeJavaScript('document.querySelector(\'a[href="/other-product"]\').click()')},site.origin);
    await poll(()=>c.app.evaluate(({BrowserWindow},origin)=>BrowserWindow.getAllWindows().some(window=>window.webContents.getURL()===origin+'/other-product'&&!window.webContents.isLoadingMainFrame()),site.origin),Boolean,{label:'collection browser navigated normally'});
    const stale=await c.page.evaluate(async input=>{try{await window.ecomgen.collection('import',input);return {ok:true}}catch(error){return {ok:false,message:error.message,code:error.code}}},{collectionId:c.state.collection.collectionId,revision:c.state.collection.revision,candidateId:c.state.collection.candidates[0].candidateId});
    c.equal(stale.ok,false,'stale page candidates reject');c.check(/(?:页面|图片|候选|选择).*(?:变化|失效)|重新读取/.test(stale.message),'stale rejection explains invalidated page selection');c.check(!/TypeError|LOCAL_OPERATION_FAILED|本地操作未完成|后台/.test(stale.message),'unexpected bridge or runtime error is not a stale-selection pass');c.equal(items(await c.invoke('listAssets',{projectId:c.state.project.id})).length,before);
    await c.evidence('collection-isolation',info);
  }},
  {id:'pixelmuse-collection-manual',needs:['pixelmuse-collection-isolation'],title:'An empty product page accepts a manual image URL and session clear closes the browser and clears cookies',run:async c=>{
    await c.app.evaluate(async ({BrowserWindow},origin)=>{const remote=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith(origin));await remote.webContents.executeJavaScript('document.querySelector(\'a[href="/empty"]\').click()')},site.origin);
    await poll(()=>c.app.evaluate(({BrowserWindow},origin)=>BrowserWindow.getAllWindows().some(window=>window.webContents.getURL()===origin+'/empty'&&!window.webContents.isLoadingMainFrame()),site.origin),Boolean,{label:'empty fixture page loaded'});
    await c.app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('file:'))?.focus()});
    const drawer=c.page.getByRole('dialog',{name:'电商灵感采集'});await drawer.getByRole('button',{name:'读取当前页图片',exact:true}).click();
    await poll(()=>c.app.evaluate(()=>globalThis.__pixelmuseFixtureCollection.snapshot),value=>value?.page?.url.endsWith('/empty')&&value.candidates.length===0,{label:'empty product has no invented candidates'});
    await drawer.getByLabel('图片链接',{exact:true}).fill(site.origin+'/media/lazy.png');await drawer.getByRole('button',{name:'添加候选',exact:true}).click();
    await drawer.getByRole('img',{name:'采集图片 1',exact:true}).waitFor();await drawer.getByRole('checkbox',{name:'选择图片 1',exact:true}).check();
    const before=items(await c.invoke('listAssets',{projectId:c.state.project.id})).length;
    await drawer.getByRole('button',{name:'导入当前项目',exact:true}).click();
    const assets=await poll(()=>c.invoke('listAssets',{projectId:c.state.project.id}),value=>items(value).length===before+1,{label:'manual image URL imported'});c.check(items(assets).filter(asset=>asset.role==='STYLE_REFERENCE').length>=2);
    await drawer.getByRole('button',{name:'清除本次登录',exact:true}).click();
    await poll(()=>native('collection','status',{collectionId:c.state.collection.collectionId}),value=>value.state==='CLOSED',{label:'session cleared and browser closed'});
    c.equal(await c.app.evaluate(async (_electron,origin)=>(await globalThis.__pixelmuseFixtureCollection.session.cookies.get({url:origin})).length,site.origin),0,'ephemeral browser cookies cleared');
    await c.screenshot('manual-collection');
  }},
  {id:'pixelmuse-collection-sources-restart',needs:['pixelmuse-collection-manual'],title:'A normal application restart reads collected provenance and original media from selected workspace',run:async c=>{
    await c.stop();await launch();
    const sources=await native('collection','sources',{projectId:c.state.project.id});c.equal(sources.items.find(item=>item.assetId===c.state.collectedAsset.id),c.state.collectedSource);c.equal(sources.items.find(item=>item.assetId===c.state.popupSource.assetId),c.state.popupSource,'popup page provenance survives restart');
    c.equal(hash(await c.save({kind:'ASSET',id:c.state.collectedAsset.id},'webp')),c.state.collectedHash);
    c.equal((await native('workspace','status')).directory,c.state.workspaceDirectory);
    await c.page.getByRole('link',{name:'PixelMuse',exact:true}).click();await c.page.getByRole('region',{name:'项目画廊'}).getByText(c.state.project.name,{exact:true}).click();
    await c.page.getByRole('navigation',{name:'工作阶段'}).getByRole('button',{name:'1 配置',exact:true}).click();
    await c.page.getByRole('region',{name:'采集来源'}).getByText(c.state.collectedSource.title,{exact:true}).waitFor();
    await c.screenshot('persistent-collected-sources');
  }},
  {id:'pixelmuse-main-close',needs:['pixelmuse-collection-sources-restart'],title:'Closing the main window also closes an open collection browser and releases Backend ownership',run:async c=>{
    await installFixtureCollection();await native('collection','open',{projectId:c.state.project.id,url:site.origin+'/product'});
    await poll(()=>c.app.evaluate(({BrowserWindow},origin)=>BrowserWindow.getAllWindows().some(window=>window.webContents.getURL().startsWith(origin)),site.origin),Boolean,{label:'collection browser open before main close'});
    c.check(await c.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length>=2),'both main and collection windows exist');
    const observer=join(c.fixture,'pixelmuse-close-observer.jsonl');
    await c.app.evaluate(({app,BrowserWindow},{origin,observer})=>{
      const fs=require('node:fs');fs.writeFileSync(observer,'');const write=value=>fs.appendFileSync(observer,JSON.stringify(value)+'\n');
      const main=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('file:'));const remote=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith(origin));
      main.once('closed',()=>write({event:'main-closed'}));remote.once('closed',()=>write({event:'collection-closed'}));app.once('window-all-closed',()=>write({event:'all-windows-closed',remaining:BrowserWindow.getAllWindows().length}));main.close();
    },{origin:site.origin,observer}).catch(()=>{});
    // Node waits for its inspector to detach after app.quit. Prove production
    // shutdown (ack, released owner and zero windows) before detaching that debugger.
    const closed=await poll(async()=>{let lock=false;try{await stat(join(c.userData,'data/backend.lock'));lock=true}catch(error){if(error.code!=='ENOENT')throw error}const audit=await c.guardAudit();return {lock,ack:audit.some(row=>row.event==='utility-closed'&&row.pid===c.startupGuard.browserPid&&row.childPid===c.startupGuard.backendPid)}},value=>!value.lock&&value.ack,{timeout:20000,label:'main close receives Backend closed acknowledgement and releases owner'});
    c.equal(closed.lock,false);c.equal(closed.ack,true);
    const observed=await poll(async()=>{try{return (await readFile(observer,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))}catch(error){if(error.code==='ENOENT')return [];throw error}},rows=>['main-closed','collection-closed','all-windows-closed'].every(event=>rows.some(row=>row.event===event)),{label:'actual main and auxiliary window closed events'});
    c.equal(observed.find(row=>row.event==='all-windows-closed').remaining,0);await c.evidence('window-close',observed);
    const ownedChild=c.app.process();await c.stop();c.equal(ownedChild.exitCode,0,'owned inspector detaches after complete orderly shutdown');await launch();c.equal((await native('workspace','status')).state,'READY');c.equal((await c.invoke('getProject',{projectId:c.state.project.id})).id,c.state.project.id);
  }},
];
let cleanup=[];
try{
  const images=await createPixelMuseProductImages(c.sharp);c.mock.images.image=images.mainImage;await writeFile(c.image,images.mainImage);await writeFile(c.reference,images.lazyImage);
  site=await startPixelMuseProductFixture(images);extra.push(site.origin);
  const seeded=await executeScenario(c,legacySeed);assert.equal(seeded.status,'passed','Legacy seed must succeed before current application acceptance');
  await launch();
  for(const scenario of scenarios)await executeScenario(c,scenario);
  c.result.integration=c.result.scenarios.every(row=>row.status==='passed')?'passed':'failed';
}catch(error){c.result.integration='failed';c.result.error=c.redact(error.message);await c.screenshot('fatal').catch(()=>{});
}finally{
  cleanup=await c.cleanup();if(c.result.launchCleanupFailed)cleanup.push('An earlier owned launch cleanup was not confirmed');await site?.close().catch(error=>cleanup.push(error.message));
  let temporaryUserDataRemoved=false;try{await stat(c.fixture)}catch(error){if(error.code==='ENOENT')temporaryUserDataRemoved=true;else cleanup.push('Cannot verify isolated fixture cleanup')}
  if(!temporaryUserDataRemoved)cleanup.push('Isolated fixture was not removed');
  c.result.cleanup={status:cleanup.length?'failed':'passed',temporaryUserDataRemoved,errors:cleanup};c.result.globalChecks={rendererErrors:c.state.events.filter(event=>event.type==='pageerror').length};
  if(cleanup.length||c.result.globalChecks.rendererErrors)c.result.integration='failed';
  await writeFile(join(c.artifacts,'pixelmuse-result.json'),JSON.stringify(c.result,null,2));
  console.log(JSON.stringify({integration:c.result.integration,passed:c.result.scenarios.filter(row=>row.status==='passed').length,failed:c.result.scenarios.filter(row=>row.status==='failed').length,blocked:c.result.scenarios.filter(row=>row.status==='blocked').length,cleanup:c.result.cleanup,artifacts:c.artifacts},null,2));
  process.exitCode=c.result.integration==='passed'?0:1;
}
