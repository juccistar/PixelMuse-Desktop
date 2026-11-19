import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectionSnapshot } from '@ecomgen/contracts';
const mocks = vi.hoisted(() => ({ windows: [] as any[], sessions: [] as any[] }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    options: any; webContents: any; destroyed = false; url = ''; title='商品页面'; extracted: any;
    constructor(options: any) {
      super(); this.options=options;
      this.webContents=Object.assign(new EventEmitter(), {
        getURL:()=>this.url, isLoadingMainFrame:()=>false,
        executeJavaScriptInIsolatedWorld:vi.fn(async()=>this.extracted ?? {url:this.url,title:this.title,images:[]}),
        setWindowOpenHandler:(handler:any)=>{this.webContents.popup=handler;},
        setWebRTCIPHandlingPolicy:vi.fn(),
        navigationHistory:{canGoBack:()=>false,canGoForward:()=>false},
      }); mocks.windows.push(this);
    }
    async loadURL(url:string) { this.webContents.emit('did-start-navigation',{},url,false,true); this.url=url; this.webContents.emit('did-navigate',{},url); }
    getTitle(){return this.title;}
    setMenu(menu:unknown){this.options.menu=menu;}
    isDestroyed(){return this.destroyed;}
    destroy(){if(this.destroyed)return;this.destroyed=true;this.emit('closed');}
    focus(){this.emit('focus');} isFocused(){return false;} reload(){}
  }
  return { BrowserWindow:Window, Menu:{buildFromTemplate:(template:any)=>template}, session:{fromPartition:(partition:string,options:any)=>{
    const value=Object.assign(new EventEmitter(),{partition,options,cookies:{get:vi.fn(async()=>[])},
      setPermissionRequestHandler:vi.fn(),setPermissionCheckHandler:vi.fn(),setDevicePermissionHandler:vi.fn(),setProxy:vi.fn(async()=>{}),
      clearStorageData:vi.fn(async()=>{}),clearCache:vi.fn(async()=>{}),clearAuthCache:vi.fn(async()=>{}),closeAllConnections:vi.fn(),
      webRequest:{onBeforeRequest:(handler:any)=>{value.beforeRequest=handler;}},beforeRequest:undefined as any,
    });mocks.sessions.push(value);return value;
  }}};
});
import { createFixtureCollectionService } from './testing.js';
import { createCollectionService } from './index.js';
import { createScopedCollectionService, type CollectionService } from './service.js';
let server:Server,origin:string,service:CollectionService,host:any;
beforeEach(async()=>{
  mocks.windows.length=0;mocks.sessions.length=0;
  server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'image/png'});res.end(Buffer.from([137,80,78,71,13,10,26,10]));});
  server.listen(0,'127.0.0.1');await once(server,'listening');origin=`http://127.0.0.1:${(server.address() as any).port}`;
  host=vi.fn(async(operation:string,_input:any)=>{
    if(operation==='host.collectionSources')return {items:[]};
    if(operation==='host.previewCollectionImage')return {dataUrl:'data:image/jpeg;base64,AAAA'};
    if(operation==='host.importCollectedAsset')return {assetId:'imported-asset',status:'IMPORTED'};
    if(operation==='host.cancelCollectionImport')return null;
    throw new Error('unexpected');
  });
  service=createFixtureCollectionService({parent:()=>undefined,hostRequest:host},origin);
});
afterEach(async()=>{await service?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
async function opened(){return service.invoke('open',{projectId:'project',url:`${origin}/item?id=123&token=EPHEMERAL#SECRET`}) as Promise<CollectionSnapshot>;}
async function candidates(){const state=await opened();const win=mocks.windows[0];win.extracted={url:win.url,title:'商品标题',images:[{url:`${origin}/image?signature=EPHEMERAL`,width:500,height:600,label:'页面已加载图片'}]};return service.invoke('refresh',{collectionId:state.collectionId}) as Promise<CollectionSnapshot>;}
describe('collection service lifecycle and IPC boundary',()=>{
  it('rejects unknown operations, additional fields, role injection and arbitrary file paths',async()=>{
    await expect(service.invoke('executeJavaScript',{script:'anything'})).rejects.toThrow('不支持');
    await expect(service.invoke('open',{projectId:'project',url:`${origin}/item`,preload:'C:/secret'})).rejects.toThrow('参数');
    await expect(service.invoke('import',{collectionId:'x',revision:1,candidateId:'y',role:'PRODUCT_TRUTH'})).rejects.toThrow('参数');
    await expect(service.invoke('addImage',{collectionId:'x',url:'file:///secret'})).rejects.toThrow();
  });
  it('creates a nonpersistent isolated sandbox with permissions/downloads denied and controlled popups',async()=>{
    const state=await opened();const browser=mocks.windows[0],isolated=mocks.sessions[0];
    expect(isolated.partition).toMatch(/^collection-/);expect(isolated.partition).not.toContain('persist:');
    expect(browser.options.webPreferences).toMatchObject({session:isolated,nodeIntegration:false,sandbox:true,contextIsolation:true,webviewTag:false});
    expect(browser.options.webPreferences.preload).toBeUndefined();
    expect(isolated.setProxy).toHaveBeenCalledWith({mode:'fixed_servers',proxyRules:expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),proxyBypassRules:'<-loopback>'});
    expect(browser.webContents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp');
    const callback=vi.fn();isolated.setPermissionRequestHandler.mock.calls[0][0]({},'camera',callback);expect(callback).toHaveBeenCalledWith(false);
    expect(isolated.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
    const preventDefault=vi.fn();isolated.emit('will-download',{preventDefault});expect(preventDefault).toHaveBeenCalled();
    expect(browser.webContents.popup({url:'file:///secret'})).toEqual({action:'deny'});
    const child=browser.webContents.popup({url:'https://accounts.example/login'});expect(child.action).toBe('allow');
    expect(child.overrideBrowserWindowOptions.webPreferences).toMatchObject({session:isolated,sandbox:true,nodeIntegration:false,contextIsolation:true});
    await service.invoke('clearSession',{collectionId:state.collectionId});
    expect(isolated.clearStorageData).toHaveBeenCalledTimes(1);expect(isolated.clearAuthCache).toHaveBeenCalledTimes(1);expect(isolated.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(await service.invoke('status',{collectionId:state.collectionId})).toMatchObject({state:'CLOSED',candidates:[]});
  });
  it('keeps candidate URLs ephemeral and invalidates selections on navigation and refresh',async()=>{
    const state=await candidates();expect(state.candidates).toHaveLength(1);
    expect(state.page?.url).toBe(`${origin}/item?id=123`);expect(JSON.stringify(state)).not.toMatch(/EPHEMERAL|SECRET|signature/);
    const selection={collectionId:state.collectionId,revision:state.revision,candidateId:state.candidates[0]!.candidateId};
    mocks.windows[0].webContents.emit('did-start-navigation',{},`${origin}/other`,false,true);
    await expect(service.invoke('preview',selection)).rejects.toThrow('过期');await expect(service.invoke('import',selection)).rejects.toThrow('过期');
    expect((await service.invoke('status',{collectionId:state.collectionId}) as CollectionSnapshot).candidates).toEqual([]);
  });
  it('downloads for Backend preview/import and cancels in-flight imports when navigating',async()=>{
    const state=await candidates();const selection={collectionId:state.collectionId,revision:state.revision,candidateId:state.candidates[0]!.candidateId};
    expect(await service.invoke('preview',selection)).toEqual({dataUrl:'data:image/jpeg;base64,AAAA'});
    let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let complete!:()=>void;
    host.mockImplementation(async(operation:string)=>{
      if(operation==='host.importCollectedAsset'){entered();await new Promise<void>(resolve=>{complete=resolve;});return {assetId:'committed-asset',status:'IMPORTED'};}
      if(operation==='host.cancelCollectionImport'){complete();return null;}
      return {items:[]};
    });
    const importing=service.invoke('import',selection);await started;
    mocks.windows[0].webContents.emit('did-start-navigation',{},`${origin}/next`,false,true);
    // A commit may win the cancellation race; a late success must stay queryable and truthful.
    expect(await importing).toEqual({assetId:'committed-asset',status:'IMPORTED'});
    const cancel=host.mock.calls.find((call:any[])=>call[0]==='host.cancelCollectionImport');expect(cancel).toBeDefined();
    const imported=host.mock.calls.find((call:any[])=>call[0]==='host.importCollectedAsset');expect(cancel[1].requestId).toBe(imported[1].requestId);
    expect(imported[1].source.pageUrl).toBe(`${origin}/item?id=123`);expect(imported[1].file.base64).toBeDefined();
    expect(imported[1]).not.toHaveProperty('url');
  });
  it('rejects a preview response after navigation and allows sources after close',async()=>{
    const state=await candidates();const selection={collectionId:state.collectionId,revision:state.revision,candidateId:state.candidates[0]!.candidateId};
    host.mockImplementation(async(operation:string)=>{if(operation==='host.previewCollectionImage'){mocks.windows[0].webContents.emit('did-start-navigation',{},`${origin}/new`,false,true);return {dataUrl:'data:image/jpeg;base64,AAAA'};}return {items:[]};});
    await expect(service.invoke('preview',selection)).rejects.toThrow('取消');
    await service.invoke('close',{collectionId:state.collectionId});expect(await service.invoke('sources',{projectId:'project'})).toEqual({items:[]});
  });
  it('extracts the popup menu window and binds imported source, focus changes and closing to its revision',async()=>{
    const mainState=await candidates();const main=mocks.windows[0];
    const child=new (main.constructor)({webPreferences:main.options.webPreferences});
    child.url=`${origin}/popup?token=EPHEMERAL`;child.title='弹窗商品';
    child.extracted={url:child.url,title:child.title,images:[{url:`${origin}/child.png`,width:700,height:800,label:'页面已加载图片'}]};
    main.webContents.emit('did-create-window',child);
    child.options.menu[0].submenu[0].click();
    await vi.waitFor(async()=>expect((await service.invoke('status',{collectionId:mainState.collectionId}) as CollectionSnapshot).candidates).toHaveLength(1));
    expect(child.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
    const popup=await service.invoke('status',{collectionId:mainState.collectionId}) as CollectionSnapshot;
    expect(popup.page).toMatchObject({url:`${origin}/popup`,title:'弹窗商品'});expect(popup.candidates).toHaveLength(1);
    const selection={collectionId:popup.collectionId,revision:popup.revision,candidateId:popup.candidates[0]!.candidateId};
    await service.invoke('import',selection);
    expect(host.mock.calls.find((call:any[])=>call[0]==='host.importCollectedAsset')[1].source).toMatchObject({pageUrl:`${origin}/popup`,title:'弹窗商品'});
    main.focus();await expect(service.invoke('preview',selection)).rejects.toThrow('过期');
    const again=await service.invoke('refresh',{collectionId:mainState.collectionId}) as CollectionSnapshot;expect(again.page?.title).toBe('商品标题');
    child.focus();
    const fromWorkbench=await service.invoke('refresh',{collectionId:mainState.collectionId}) as CollectionSnapshot;expect(fromWorkbench.page?.title).toBe('弹窗商品');
    child.destroy();
    const closed=await service.invoke('status',{collectionId:mainState.collectionId}) as CollectionSnapshot;
    expect(closed.page?.url).toBe(`${origin}/item?id=123`);expect(closed.candidates).toEqual([]);expect(closed.revision).toBeGreaterThan(fromWorkbench.revision);
  });
  it('sends same-site Strict/Lax CDN cookies and actual page referrer but filters unrelated-site cookies',async()=>{
    await service.close();
    const port=new URL(origin).port;
    const page=`http://shop.example.co.uk:${port}/product/detail?id=123`;
    const cdn=`http://cdn.example.co.uk:${port}/image.png`,external=`http://unrelated.co.uk:${port}/image.png`;
    const received:Array<{cookie:string;referer:string}>=[];
    server.removeAllListeners('request');server.on('request',(req,res)=>{received.push({cookie:req.headers.cookie??'',referer:req.headers.referer??''});res.writeHead(200,{'content-type':'image/png'});res.end(Buffer.from([137,80,78,71,13,10,26,10]));});
    service=createScopedCollectionService({parent:()=>undefined,hostRequest:host},{resolve:async()=>[{address:'127.0.0.1',family:4}],allow:(address,url)=>address==='127.0.0.1'&&['shop.example.co.uk','cdn.example.co.uk','unrelated.co.uk'].includes(url.hostname),allowPort:url=>url.port===port});
    const state=await service.invoke('open',{projectId:'project',url:page}) as CollectionSnapshot;
    const win=mocks.windows.at(-1),isolated=mocks.sessions.at(-1);
    isolated.cookies.get.mockResolvedValue([{name:'strict',value:'one',sameSite:'strict',path:'/'},{name:'lax',value:'two',sameSite:'lax',path:'/image.png'},{name:'default',value:'three',sameSite:'unspecified',path:'/'}]);
    win.extracted={url:page,title:'商品',images:[{url:cdn,width:400,height:400,label:'页面已加载图片'},{url:external,width:400,height:400,label:'页面已加载图片'}]};
    const snapshot=await service.invoke('refresh',{collectionId:state.collectionId}) as CollectionSnapshot;
    for(const candidate of snapshot.candidates)await service.invoke('preview',{collectionId:state.collectionId,revision:snapshot.revision,candidateId:candidate.candidateId});
    expect(received).toEqual([{cookie:'lax=two; strict=one; default=three',referer:new URL(page).origin+'/'},{cookie:'',referer:new URL(page).origin+'/'}]);
    expect(isolated.cookies.get.mock.calls.map((call:any[])=>call[0])).toEqual([{url:cdn},{url:external}]);
  });
  it('rejects extraction that finishes after focus switched to another window',async()=>{
    const state=await opened(),main=mocks.windows[0];
    let complete!:(result:any)=>void;
    main.webContents.executeJavaScriptInIsolatedWorld.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
    const reading=service.invoke('refresh',{collectionId:state.collectionId});
    await vi.waitFor(()=>expect(complete).toBeDefined());
    const child=new (main.constructor)({webPreferences:main.options.webPreferences});child.url=`${origin}/popup`;child.title='弹窗商品';
    main.webContents.emit('did-create-window',child);child.focus();
    complete({url:main.url,title:'过期首窗',images:[{url:`${origin}/wrong.png`,width:500,height:500,label:'页面已加载图片'}]});
    const result=await reading as CollectionSnapshot;expect(result.page?.title).toBe('弹窗商品');expect(result.candidates).toEqual([]);
  });
  it('bounds manual candidates, deduplicates URL and exposes no private-network production override',async()=>{
    const state=await opened();
    const added=await service.invoke('addImage',{collectionId:state.collectionId,url:`${origin}/manual.png`}) as CollectionSnapshot;
    expect(added.candidates).toHaveLength(1);expect(added.candidates[0]!.label).toBe('手动图片链接');
    expect((await service.invoke('addImage',{collectionId:state.collectionId,url:`${origin}/manual.png`}) as CollectionSnapshot).candidates).toHaveLength(1);
    const production=createCollectionService({parent:()=>undefined,hostRequest:host});
    await expect(production.invoke('open',{projectId:'project',url:`${origin}/item`})).rejects.toThrow('端口');await production.close();
    expect(()=>createFixtureCollectionService({parent:()=>undefined,hostRequest:host},'http://0.0.0.0:1234')).toThrow('exact loopback');
    await expect(new Promise((resolve)=>mocks.sessions[0].beforeRequest({url:'http://10.0.0.1/private'},resolve))).resolves.toEqual({cancel:true});
  });
});
