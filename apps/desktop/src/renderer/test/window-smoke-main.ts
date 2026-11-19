/** 真实 Electron 的 UI 隔离夹具：使用生产 preload/renderer，领域命令为假 IPC。 */
import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { DEFAULT_APPLICATION_SETTINGS, operations, applicationOperations, type ApplicationOperation, type Operation } from '@ecomgen/contracts';
import { PROJECT_FIXTURE, TEMPLATE_FIXTURES, USER_TEMPLATE_FIXTURE, projectDetailPayload } from './fixtures';
protocol.registerSchemesAsPrivileged([{ scheme:'ecomgen-resource', privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true} }]);
app.setPath('userData', join(import.meta.dirname,'gui-state'));
const timestamp = '2026-11-05T00:00:00.000Z';
const pattern = {id:'aaaaaaaa-1111-4222-8333-444444444444',name:'隔离花型',source:'UPLOADED',sourceJobId:null,parentPatternId:null,imageUrl:'ecomgen-resource://PATTERN/aaaaaaaa-1111-4222-8333-444444444444',hash:'a'.repeat(64),width:1,height:1,tags:[],tileable:'NONE',tileableScore:null,createdAt:timestamp,updatedAt:timestamp};
const draft = {id:'bbbbbbbb-1111-4222-8333-444444444444',name:'隔离草稿',composeType:'PLACEMENT',conditions:{theme:'',aspectRatio:'1:1',background:'WHITE',candidateCount:1},revision:1,selectedCandidateId:null,compareCandidateId:null,archivedAt:null,candidateCount:0,previewUrl:null,createdAt:timestamp,updatedAt:timestamp};
let created = false;
let applicationSettings = structuredClone(DEFAULT_APPLICATION_SETTINGS);
const values: Record<string,unknown> = {
  getApplicationSettings: applicationSettings,
  listUsage: { items: [], total: 0 }, listModelPricing: { items: [] },
  getUsageSummary: { requestCount: 0, completedCount: 0, failedResponseCount: 0, unknownCount: 0, inFlightCount: 0, withUsageCount: 0, inputTokens: null, outputTokens: null, cachedInputTokens: null, amounts: [], taskCount: 0, outputCount: 0, historyNote: 'UI 隔离夹具，无实际请求或模型质量证据。' },
  getModelConfigurationImpact: { projectCount: 0, activeJobCount: 0, defaultRoles: [] },
  getHealth:{status:'ready',version:'ui-isolation',webResearchAvailable:false,activeJobs:0},
  listProviders:{items:[{id:PROJECT_FIXTURE.reasoningProviderId,name:'隔离 Provider',baseUrl:'https://provider.invalid/v1',reasoningProtocol:'openai',hasApiKey:true,models:[{id:'gpt-4o',supportsVision:true,supportsThinking:false,supportsTools:true,supportsStructuredOutput:true,imageApiKind:null},{id:'gpt-image-1',supportsVision:false,supportsThinking:false,supportsTools:false,supportsStructuredOutput:false,imageApiKind:'openai_images'}],createdAt:timestamp,updatedAt:timestamp}],nextCursor:null},
  listSearchSources:{items:[],nextCursor:null},listEcomDetailsImageTemplates:TEMPLATE_FIXTURES,listUserTemplates:{items:[USER_TEMPLATE_FIXTURE]},
  getProject:projectDetailPayload({assets:[]}),listPlanningConfigSnapshots:[],getStoryboard:{storyboard:null,items:[]},
  listLibraryAssets:{items:[],nextCursor:null,total:0},listModels:{items:[],nextCursor:null},listPatterns:{items:[pattern]},listPodPrintSpecs:{items:[]},
  listPatternDrafts:{items:[draft]},getPatternDraft:draft,listDraftMedia:{items:[]},listDraftBatches:{items:[]},listDraftCandidates:{items:[]},
  listPatternPipelines:{items:[]},listPatternPrintPacks:{items:[]},listSuiteForgeJobResults:{items:[]},listSuites:{items:[],nextCursor:null,total:0,l1Counts:{},originCounts:{builtin:0,user:0}},listSuiteCategories:{l1:[],l2:{}},
};
void app.whenReady().then(async () => {
  const window = new BrowserWindow({width:1440,height:1000,show:true,webPreferences:{preload:join(import.meta.dirname,'window-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  protocol.handle('ecomgen-resource', () => new Response(Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/z8AAAAASUVORK5CYII=','base64')), {headers:{'Content-Type':'image/png','Access-Control-Allow-Origin':'*'}}));
  ipcMain.handle('ecomgen:invoke', (event,name:Operation,input:unknown) => {
    try {
      if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||!Object.hasOwn(operations,name))throw Error('Untrusted operation');
      if(!Value.Check(operations[name].input,input))throw Error(`Invalid input ${name}`);
      let result:unknown;
      if(name==='updateApplicationSettings'){applicationSettings={...applicationSettings,...input as Partial<typeof applicationSettings>};values.getApplicationSettings=applicationSettings;result=applicationSettings;}
      else if(name==='createProject'){created=true;result=PROJECT_FIXTURE;}
      else if(name==='listProjects')result={items:created?[PROJECT_FIXTURE]:[],nextCursor:null};
      else if(name==='updatePatternDraft'){Object.assign(draft,input,{revision:draft.revision+1});result=draft;}
      else {if(!Object.hasOwn(values,name))throw Error(`Unconfigured operation ${name}`);result=values[name];}
      result=Value.Clean(operations[name].output,structuredClone(result));
      if(!Value.Check(operations[name].output,result))throw Error(`Invalid output ${name}: ${[...Value.Errors(operations[name].output,result)].map(e=>e.path+' '+e.message).join(', ')}`);
      return{id:'',ok:true,data:result};
    }catch(error){return{id:'',ok:false,error:{code:'ISOLATED_FIXTURE_ERROR',message:(error as Error).message}};}
  });
  ipcMain.handle('ecomgen:application', (event, name: ApplicationOperation, input: unknown) => {
    try {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !Object.hasOwn(applicationOperations, name) || !Value.Check(applicationOperations[name].input, input)) throw Error('Untrusted application operation');
      const result = name === 'info' ? { name: 'PixelMuse', version: 'ui-isolation', platform: 'win32', arch: 'x64', electronVersion: process.versions.electron, chromeVersion: process.versions.chrome, nodeVersion: process.versions.node, packaged: false, notificationsSupported: false } : name === 'openDirectory' ? null : { saved: false };
      return { id: '', ok: true, data: result };
    } catch { return { id: '', ok: false, error: { code: 'ISOLATED_FIXTURE_ERROR', message: '隔离夹具操作未完成' } }; }
  });
  ipcMain.handle('ecomgen:pick-files',()=>({id:'',ok:true,data:[]}));
  ipcMain.handle('ecomgen:save-artifact',()=>({id:'',ok:true,data:false}));
  ipcMain.handle('ecomgen:save-generated',()=>({id:'',ok:true,data:false}));
  ipcMain.handle('ecomgen:clipboard-read',()=>({id:'',ok:true,data:''}));
  ipcMain.handle('ecomgen:clipboard-write',()=>({id:'',ok:true,data:undefined}));
  await window.loadFile(join(import.meta.dirname,'bundle-output','index.html'));
});
app.on('window-all-closed',()=>app.quit());
