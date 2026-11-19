import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { EcomRepository, LocalAssetStore, openDatabase } from '@ecomgen/core';
import { operations, ResourceRefSchema, resourceUrlFor, resourceRefFromUrl, publicSchema, type ResourceRef } from '@ecomgen/contracts';
import { createBackend, decodeByteImport, type Backend, type CommandContext } from '../../src/index.js';
import { RuntimeStore } from '../../src/runtime/state.js';
import { ResourceRegistry } from '../../src/runtime/resources.js';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function root(){const directory=await mkdtemp(join(tmpdir(),'ecomgen-runtime-boundary-'));cleanups.push(()=>rm(directory,{recursive:true,force:true}));return directory;}
async function registry(){const directory=await root(),db=openDatabase(':memory:'),store=new RuntimeStore(db),storage=new LocalAssetStore(directory);await storage.initialize();cleanups.push(async()=>db.close());return {directory,db,store,storage,resources:new ResourceRegistry(store,storage)};}
async function png(){return sharp({create:{width:8,height:8,channels:4,background:'#12abef'}}).png().toBuffer();}
describe('资源登记/清理与命名 IPC 边界',()=>{
 it('资源只能按有界 kind/id/index 寻址，拒绝路径、越界下标和错误类型',()=>{
  for(const ref of [{kind:'ASSET',id:'../../other'},{kind:'LAYER_FILE',id:'valid',index:256},{kind:'ASSET',id:'valid',index:0},{kind:'EXPORT',id:'valid',path:'C:/private'}])expect(Value.Check(ResourceRefSchema,ref)).toBe(false);
  for(const ref of [{kind:'ASSET',id:randomUUID()},{kind:'LAYER_FILE',id:randomUUID(),index:255}] as ResourceRef[])expect(resourceRefFromUrl(resourceUrlFor(ref))).toEqual(ref);
  expect(()=>resourceRefFromUrl('ecomgen-resource://ASSET/id/1')).toThrow();expect(()=>resourceRefFromUrl('ecomgen-resource://LAYER_FILE/id/256')).toThrow();
 });
 it('登记 hash/身份不可改写，真实文件被篡改后拒绝预览和保存',async()=>{
  const f=await registry(),id=randomUUID(),bytes=await png(),stored=await f.storage.putPatternArtifact(id,'artwork',bytes),ref={kind:'PATTERN',id} as const;
  f.resources.register({ref,relativePath:stored.path,mimeType:'image/png',hash:stored.hash,owners:['pattern:'+id]});
  expect((await f.resources.resolve(ref)).hash).toBe(stored.hash);
  expect(()=>f.resources.register({ref,relativePath:stored.path,mimeType:'image/png',hash:'f'.repeat(64),owners:[]})).toThrow();
  await writeFile(f.storage.absolute(stored.path),'corrupted');await expect(f.resources.resolve(ref)).rejects.toMatchObject({code:'RESOURCE_CHANGED'});
 });
 it('执行/历史引用阻止回收，持久清理可重入且不删除共享字节',async()=>{
  const f=await registry(),id=randomUUID(),stored=await f.storage.putPatternArtifact(id,'artwork',await png()),a={kind:'PATTERN',id} as const,b={kind:'DRAFT_CANDIDATE',id:randomUUID()} as const;
  f.resources.register({ref:a,relativePath:stored.path,mimeType:'image/png',hash:stored.hash,owners:['job:history']});
  f.resources.register({ref:b,relativePath:stored.path.replaceAll('\\','/'),mimeType:'image/png',hash:stored.hash,owners:['draft:alive']});
  expect(()=>f.resources.scheduleCleanup(a)).toThrow();f.resources.release(a,'job:history');f.resources.scheduleCleanup(a);await f.resources.cleanup();await f.resources.cleanup();
  await expect(f.resources.resolve(a)).rejects.toThrow();expect((await f.resources.resolve(b)).hash).toBe(stored.hash);
  f.resources.release(b,'draft:alive');f.resources.scheduleCleanup(b);await f.resources.cleanup();await expect(readFile(f.storage.absolute(stored.path))).rejects.toThrow();
  expect(f.db.prepare('SELECT count(*) AS n FROM desktop_cleanup_queue').get()).toEqual({n:0});
 });
 it('文件删除 await 期间禁止同路径新增别名，避免删除新发布的资源',async()=>{
  const f=await registry(),id=randomUUID(),stored=await f.storage.putPatternArtifact(id,'artwork',await png()),ref={kind:'PATTERN',id} as const;
  f.resources.register({ref,relativePath:stored.path,mimeType:'image/png',hash:stored.hash,owners:[]});f.resources.scheduleCleanup(ref);
  const cleaning=f.resources.cleanup();
  expect(()=>f.resources.register({ref:{kind:'DRAFT_CANDIDATE',id:randomUUID()},relativePath:stored.path.replaceAll('\\','/'),mimeType:'image/png',hash:stored.hash,owners:['draft:new']})).toThrowError(expect.objectContaining({code:'RESOURCE_RETIRING'}));
  await cleaning;expect(f.db.prepare('SELECT count(*) AS n FROM desktop_resources').get()).toEqual({n:0});
 });
 it('清理失败保留重试意图，重启后能继续处理',async()=>{
  const f=await registry(),id=randomUUID(),stored=await f.storage.putPatternArtifact(id,'artwork',await png()),ref={kind:'PATTERN',id} as const;
  f.resources.register({ref,relativePath:stored.path,mimeType:'image/png',hash:stored.hash,owners:[]});f.resources.scheduleCleanup(ref);
  const broken=new ResourceRegistry(f.store,{absolute:()=>{throw new Error('locked');}});await broken.cleanup();
  const intent=f.db.prepare('SELECT payload FROM desktop_cleanup_queue').get() as {payload:string};expect(JSON.parse(intent.payload)).toMatchObject({attempts:1,lastError:'CLEANUP_FAILED'});
  await f.resources.cleanup();expect(f.db.prepare('SELECT count(*) AS n FROM desktop_cleanup_queue').get()).toEqual({n:0});
 });
 it('拒绝绝对路径、上级跳转和链接越界',async()=>{
  const f=await registry(),outside=await root(),ref={kind:'PATTERN',id:randomUUID()} as const;
  for(const path of ['../private','C:/private','/etc/passwd','patterns/../private'])expect(()=>f.resources.register({ref,relativePath:path,mimeType:'image/png',hash:'a'.repeat(64),owners:[]})).toThrow();
  await symlink(outside,join(f.directory,'patterns','escape'),'junction');
  expect(()=>f.resources.register({ref,relativePath:'patterns/escape/file.png',mimeType:'image/png',hash:'a'.repeat(64),owners:[]})).toThrow();
 });
 it('图片字节有界且校验真实签名与规范 Base64',async()=>{
  const bytes=await png();expect(decodeByteImport({name:'mask.png',mimeType:'image/png',base64:bytes.toString('base64')})).toEqual(bytes);
  expect(()=>decodeByteImport({name:'mask.png',mimeType:'image/jpeg',base64:bytes.toString('base64')})).toThrow();
  expect(()=>decodeByteImport({name:'../../mask.png',mimeType:'image/png',base64:bytes.toString('base64')})).toThrow();
  expect(()=>decodeByteImport({name:'mask.png',mimeType:'image/png',base64:'e30='})).toThrow();
 });
 it('多 MiB 字节导入不会耗尽正则栈，padding/实际长度仍按规范拒绝',()=>{
  const bytes=Buffer.alloc(6*1024*1024);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  const input={name:'large.png',mimeType:'image/png' as const,base64:bytes.toString('base64')};
  expect(decodeByteImport(input).equals(bytes)).toBe(true);
  expect(()=>decodeByteImport({...input,base64:input.base64+'='})).toThrow();
 });
 it('公开投影从同源 schema 去掉密文/路径/快照，嵌套额外字段不能通过',()=>{
  const schema=publicSchema(Type.Object({id:Type.String(),storagePath:Type.String(),generationSnapshot:Type.Object({secret:Type.String()}),nested:Type.Object({name:Type.String(),encryptedApiKey:Type.String()})}));
  expect(Value.Check(schema,{id:'one',nested:{name:'safe'}})).toBe(true);expect(Value.Check(schema,{id:'one',storagePath:'private',nested:{name:'safe'}})).toBe(false);
  expect(Value.Check(operations.updateProvider.input,{providerId:'one',models:[{id:'m',supportsVision:true,supportsThinking:false,supportsTools:false,supportsStructuredOutput:false,imageApiKind:null,arbitraryPath:'C:/private'}]})).toBe(false);
 });
 it('真实 Backend await 异步处理器后校验输出；唯一 owner、错误和公开 health 不泄漏路径',async()=>{
  const directory=await root(),options={dataDir:directory,masterKey:randomBytes(32).toString('base64'),version:'runtime-test'};
  let context!:CommandContext,called=false;
  const backend=await createBackend(options,()=>{throw new Error('observer');},{commands:ctx=>{context=ctx;return {listUserTemplates:async()=>{await new Promise(resolve=>setImmediate(resolve));called=true;return {items:ctx.repository.listUserTemplates(),nextCursor:null};}};}});cleanups.push(()=>backend.close());
  expect(await backend.invoke('listUserTemplates',{})).toEqual({items:[],nextCursor:null});expect(called).toBe(true);
  const health=await backend.invoke('getHealth',{});expect(health).toMatchObject({status:'ready',version:'runtime-test'});expect(health).not.toHaveProperty('dataDir');
  await expect(createBackend(options)).rejects.toThrow();await expect(backend.invoke('arbitrary' as never,{} as never)).rejects.toMatchObject({code:'UNKNOWN_OPERATION'});
  await expect(backend.invoke('getHealth',{path:'C:/private'} as never)).rejects.toMatchObject({code:'INVALID_INPUT'});
  const id=randomUUID(),stored=await context.storage.putPatternArtifact(id,'artwork',await png()),ref={kind:'PATTERN',id} as const;
  context.resources.register({ref,relativePath:stored.path,mimeType:'image/png',hash:stored.hash,owners:['test']});
  expect(await backend.invoke('getResource',{ref})).toEqual({ref,mimeType:'image/png'});
  const trusted=await backend.invokeHost('host.resolveResource',{ref});expect(trusted.path).toBe(context.storage.absolute(stored.path));
  await expect(backend.invoke('listPatterns',{})).rejects.toMatchObject({code:'COMMAND_UNAVAILABLE'});
 });
 it('关闭等待已接受的异步处理器，拒绝新的调用并可重新取得 owner',async()=>{
  const directory=await root(),options={dataDir:directory,masterKey:randomBytes(32).toString('base64'),version:'test'};let unblock!:()=>void;const gate=new Promise<void>(resolve=>unblock=resolve);
  const backend=await createBackend(options,undefined,{commands:{listUserTemplates:async()=>{await gate;return {items:[],nextCursor:null};}}});cleanups.push(()=>backend.close());
  const pending=backend.invoke('listUserTemplates',{});let closed=false;const closing=backend.close().then(()=>closed=true);await Promise.resolve();expect(closed).toBe(false);
  await expect(backend.invoke('getHealth',{})).rejects.toMatchObject({code:'CLOSING'});unblock();await pending;await closing;
  const reopened=await createBackend(options);cleanups.push(()=>reopened.close());expect((await reopened.invoke('getHealth',{})).status).toBe('ready');
 });
});
