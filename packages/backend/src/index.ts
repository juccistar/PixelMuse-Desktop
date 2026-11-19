import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { EcomRepository, DesktopHistoryRepository, SecretBox, SuiteCatalog, type SqliteDatabase } from '@ecomgen/core';
import { operations, hostOperations, applicationSettingsOperations, usageOperations, type BackendOptions, type ChangeEvent, type Operation, type Input, type Output, type HostOperation, type HostInput, type HostOutput } from '@ecomgen/contracts';
import { openDatabase } from './database.js';
import { createRuntimeCommands } from './business.js';
import { MediaWorkspace } from './workspace/index.js';
import { legacyReferences } from './workspace/files.js';
import { archiveGeneratedFile } from './workspace/archive.js';
import { WorkspaceAssetStore } from './workspace/store.js';
import { createCollectedAssetHandlers } from './commands/collected-assets.js';
import { createApplicationSettingsHandlers } from './commands/application-settings.js';
import { readApplicationSettings } from './settings-store.js';
import { createUsageHandlers } from './commands/usage.js';
import { registerDomainCommands } from './commands/index.js';
import { registerExecutors } from './execution/index.js';
import { DesktopHistoryResources } from './runtime/history.js';
export { registerDomainCommands } from './commands/index.js';
export { registerExecutors, createExecutionSnapshot } from './execution/index.js';
import { acquireOwner } from './storage.js';
import { assertPublicOutput, BackendError, check, safeError } from './validation.js';
import { RuntimeStore } from './runtime/state.js';
import { RequestLedger } from './runtime/request-ledger.js';
import { ResourceRegistry } from './runtime/resources.js';
import { PersistentScheduler } from './runtime/scheduler.js';
import { InvalidationEvents } from './runtime/events.js';
import type { CommandContext, CommandHandlers, ExecutorMap, RegisterCommands, RegisterExecutors } from './runtime/ports.js';
export { BackendError, decodeByteImport } from './validation.js';
export * from './runtime/ports.js';
export { FrozenJobSnapshotSchema, JobRuntimeSchema, RuntimeStore } from './runtime/state.js';
export { RequestLedger } from './runtime/request-ledger.js';
export { ResourceRegistry, ResourcePayloadSchema, CleanupPayloadSchema } from './runtime/resources.js';
export { PersistentScheduler } from './runtime/scheduler.js';
export type { HostInput, HostOutput } from '@ecomgen/contracts';
/** 默认使用完整领域命令与执行器；显式替换用于隔离运行时测试。 */
export interface BackendIntegrations {
 commands?:CommandHandlers|RegisterCommands;
 executors?:ExecutorMap|RegisterExecutors;
 fetch?:typeof fetch;
 concurrency?:number;
}
export interface Backend {
 invoke<K extends Operation>(operation:K,input:Input<K>):Promise<Output<K>>;
 invokeHost<K extends HostOperation>(operation:K,input:HostInput<K>):Promise<HostOutput<K>>;
 close():Promise<void>;
}
/** 主进程交付 safeStorage 解封的主密钥；所有任务和业务共享唯一 owner/连接。 */
export async function createBackend(options:BackendOptions,onChange:(event:ChangeEvent)=>void=()=>undefined,integrations:BackendIntegrations={}):Promise<Backend> {
 let key:Buffer|undefined,db:SqliteDatabase|undefined,release:(()=>Promise<void>)|undefined,scheduler:PersistentScheduler|undefined,workspace:MediaWorkspace|undefined;
 try{
  if(!options||typeof options.dataDir!=='string'||!options.dataDir||typeof options.version!=='string'||typeof options.masterKey!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(options.masterKey))throw new BackendError('INVALID_OPTIONS','后端启动配置无效。');
  key=Buffer.from(options.masterKey,'base64');if(key.length!==32)throw new BackendError('INVALID_OPTIONS','主密钥格式无效。');
  await mkdir(options.dataDir,{recursive:true});const root=await realpath(options.dataDir);release=await acquireOwner(root);
  const databasePath=join(root,'backend.sqlite');
  try{if((await lstat(databasePath)).isSymbolicLink())throw new BackendError('INVALID_STORAGE','数据库路径无效。');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  db=openDatabase(databasePath);
  workspace=new MediaWorkspace(root);await workspace.initialize();
  const media=workspace;
  const repository=new EcomRepository(db),storage=new WorkspaceAssetStore(media.directory,()=>media.assertStorageRoot()),secrets=new SecretBox(key);
  key.fill(0);if(media.usable)await storage.initialize();
  const catalog=new SuiteCatalog({dataDir:root,suitesDir:join(media.directory,'suites'),repository,logger:()=>undefined});if(media.usable)await catalog.refresh();
  const store=new RuntimeStore(db),events=new InvalidationEvents(store,onChange),requestLedger=new RequestLedger(store,secrets,integrations.fetch,()=>events.publish({topic:'usage'}));
  const shutdown=new AbortController();let context:CommandContext,historyResources:DesktopHistoryResources;
  const resources=new ResourceRegistry(store,storage,{
   prepare:ref=>historyResources.prepare(ref),owners:ref=>historyResources.owners(ref),
  });
  scheduler=new PersistentScheduler(store,repository,requestLedger,()=>context,integrations.concurrency??readApplicationSettings(db).ai.concurrency);
  context={repository,history:new DesktopHistoryRepository(db),storage,secrets,catalog,scheduler,events,requestLedger,resources,clock:store.clock,idFactory:randomUUID,signal:shutdown.signal,transaction:callback=>events.transaction(callback)};
  historyResources=new DesktopHistoryResources(context);
  const executors=integrations.executors??registerExecutors;
  scheduler.register(typeof executors==='function'?executors(context):executors);
  const runtimeCommands=createRuntimeCommands(context,store,options.version,()=>scheduler!.activeCount);
  const commands=integrations.commands??registerDomainCommands;
  const domainCommands=typeof commands==='function'?commands(context):commands;
  for(const name of Object.keys(domainCommands))if(!Object.hasOwn(operations,name))throw new BackendError('UNKNOWN_OPERATION','业务处理器包含未注册命令。');
  const handlers:CommandHandlers={...domainCommands,...runtimeCommands,...createApplicationSettingsHandlers(context,db),...createUsageHandlers(context,db)};
  let closing=false,maintenance=false,updateMaintenance=false,updatePreparing=false,workspaceSelecting=false,closePromise:Promise<void>|undefined;
  let updatePreparationFinished:Promise<void>|undefined;
  const accepted=new Set<Promise<unknown>>();
  // 应用设置与统计只访问 userData 下的 SQLite；媒体离线不应阻止恢复缩放或查看数据。
  const databaseOperations=new Set<Operation>([...Object.keys(applicationSettingsOperations),...Object.keys(usageOperations)] as Operation[]);
  const track=<T>(operation:()=>Promise<T>,requiresMedia=true):Promise<T>=>{
   if(closing)return Promise.reject(new BackendError('CLOSING','后台正在关闭。'));
   if(updateMaintenance)return Promise.reject(new BackendError('UPDATE_MAINTENANCE','正在准备安装更新，请稍后重试。'));
   if(requiresMedia){
    if(maintenance||media.committed)return Promise.reject(new BackendError('WORKSPACE_MAINTENANCE','工作空间正在迁移，请稍后重试。'));
    if(!media.usable)return Promise.reject(new BackendError('WORKSPACE_UNAVAILABLE','已选择的工作空间不可用，请先连接原设备。'));
    try{media.assertStorageRoot();}catch(error){return Promise.reject(safeError(error));}
   }
   const pending=operation();accepted.add(pending);void pending.finally(()=>accepted.delete(pending)).catch(()=>undefined);return pending;
  };
  const connection=db,releaseOwner=release,queue=scheduler;
  media.attach({
   enter:async()=>{
    if(closing||maintenance)throw new BackendError('WORKSPACE_BUSY','后台正在处理其他操作。');
    maintenance=true;queue.pauseForMaintenance();
    try{
     if(queue.hasPendingWork)throw new BackendError('WORKSPACE_BUSY','后台仍有排队或运行任务，请完成后再切换。');
     await Promise.allSettled([...accepted]);
     if(closing||queue.hasPendingWork)throw new BackendError('WORKSPACE_BUSY','后台仍有排队或运行任务，请完成后再切换。');
     await resources.cleanup();
    }catch(error){maintenance=false;if(media.usable)queue.resumeAfterMaintenance();throw error;}
   },
   leave:()=>{maintenance=false;if(!closing&&media.usable)queue.resumeAfterMaintenance();},
   references:()=>legacyReferences(connection),
   unavailable:()=>queue.pauseForMaintenance(),
  });
  const collectionHandlers=createCollectedAssetHandlers(context,db);
  if(media.usable){await resources.cleanup();scheduler.start();}
  return {
   invoke:<K extends Operation>(operation:K,input:Input<K>):Promise<Output<K>>=>track(async()=>{
    try{
     if(typeof operation!=='string'||!Object.hasOwn(operations,operation))throw new BackendError('UNKNOWN_OPERATION','命令未注册。');
     const contract=operations[operation];check(contract.input,input);
     const handler=handlers[operation] as ((context:CommandContext,input:Input<K>)=>unknown)|undefined;
     if(!handler)throw new BackendError('COMMAND_UNAVAILABLE','此业务命令尚未接入执行模块。');
     const result=await handler(context,structuredClone(input));check(contract.output,result,true);assertPublicOutput(result);return structuredClone(result) as Output<K>;
    }catch(error){throw safeError(error);}
   },!databaseOperations.has(operation)),
   invokeHost:async<K extends HostOperation>(operation:K,input:HostInput<K>):Promise<HostOutput<K>>=>{
    try{
     if(closing)throw new BackendError('CLOSING','后台正在关闭。');
     if(typeof operation!=='string'||!Object.hasOwn(hostOperations,operation))throw new BackendError('UNKNOWN_OPERATION','宿主能力未注册。');
     const contract=hostOperations[operation];check(contract.input,input);
     let result:unknown;
     // 控制面不进入业务屏障，否则迁移会等待自身；其余每一种宿主能力显式分派。
     if(operation==='host.prepareUpdateInstall'){
      if(updateMaintenance||maintenance||workspaceSelecting||media.committed||!media.usable||media.status().state!=='READY')throw new BackendError('UPDATE_BUSY','后台或工作空间正在处理其他操作，无法安装更新。');
      updateMaintenance=true;updatePreparing=true;queue.pauseForMaintenance();
      let finishPreparation!:()=>void;
      updatePreparationFinished=new Promise<void>(resolve=>{finishPreparation=resolve;});
      try{
       if(queue.hasPendingWork)throw new BackendError('UPDATE_BUSY','仍有排队或运行任务，请完成后再安装更新。');
       await Promise.allSettled([...accepted]);
       if(closing||maintenance||media.committed||queue.hasPendingWork)throw new BackendError('UPDATE_BUSY','仍有排队或运行任务，请完成后再安装更新。');
       result=null;
      }catch(error){updateMaintenance=false;if(!closing&&media.usable)queue.resumeAfterMaintenance();throw error;}finally{updatePreparing=false;finishPreparation();}
     }else if(operation==='host.cancelUpdateInstall'){
      if(updatePreparing)await updatePreparationFinished;
      if(updateMaintenance){updateMaintenance=false;if(!closing&&media.usable)queue.resumeAfterMaintenance();}
      result=null;
     }else if(updateMaintenance)throw new BackendError('UPDATE_MAINTENANCE','正在准备安装更新，请稍后重试。');
     else if(operation==='host.workspaceStatus')result=media.status();
     else if(operation==='host.workspaceCancel')result=await media.cancel();
     else if(operation==='host.workspaceChoose'){
      media.status();
      if(media.usable&&queue.hasPendingWork)throw new BackendError('WORKSPACE_BUSY','后台仍有排队或运行任务，请完成后再切换。');
      workspaceSelecting=true;
      try{result=await media.choose((input as HostInput<'host.workspaceChoose'>).directory);}finally{workspaceSelecting=false;}
     }else result=await track(async()=>{
      switch(operation){
       case 'host.resolveResource':return resources.resolve((input as HostInput<'host.resolveResource'>).ref);
       case 'host.archiveGeneratedFile':return archiveGeneratedFile(storage,input as HostInput<'host.archiveGeneratedFile'>,shutdown.signal);
       case 'host.previewCollectionImage':return collectionHandlers['host.previewCollectionImage'](input as HostInput<'host.previewCollectionImage'>);
       case 'host.importCollectedAsset':return collectionHandlers['host.importCollectedAsset'](input as HostInput<'host.importCollectedAsset'>);
       case 'host.cancelCollectionImport':return collectionHandlers['host.cancelCollectionImport'](input as HostInput<'host.cancelCollectionImport'>);
       case 'host.collectionSources':return collectionHandlers['host.collectionSources'](input as HostInput<'host.collectionSources'>);
       default:throw new BackendError('UNKNOWN_OPERATION','宿主能力未注册。');
      }
     });
     check(contract.output,result,true);return result as HostOutput<K>;
    }catch(error){throw safeError(error);}
   },
   close:()=>{
    if(closePromise)return closePromise;closing=true;shutdown.abort(new BackendError('CLOSING','后台正在关闭。'));
    closePromise=(async()=>{try{
     // 已接受的删除命令可能正在等执行器退出，须先发出队列取消再等待命令。
     const stopped=queue.close();
     await Promise.allSettled([...accepted]);await stopped;await media.cancel();
     if(media.usable&&!media.committed)await resources.cleanup();
    }finally{try{await media.close();}finally{try{connection.close();}finally{await releaseOwner();}}}})();return closePromise;
   },
  };
 }catch(error){
  try{await scheduler?.close();}catch{/* 保留最初的启动失败。 */}
  try{await workspace?.close();}catch{/* 保留最初的启动失败。 */}
  try{if(db?.open)db.close();}catch{/* 保留最初的启动失败。 */}
  key?.fill(0);try{await release?.();}catch{/* 受管路径错误不能跨 IPC 暴露。 */}throw safeError(error);
 }
}
