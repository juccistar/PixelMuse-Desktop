import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { openDatabase, EcomRepository, SecretBox, type SqliteDatabase } from '@ecomgen/core';
import { RuntimeStore, type FrozenJobSnapshot } from '../../src/runtime/state.js';
import { RequestLedger } from '../../src/runtime/request-ledger.js';
const databases:SqliteDatabase[]=[],servers:Server[]=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}for(const db of databases.splice(0))db.close();});
const descriptor=(key:string)=>({requestKey:key,fingerprint:createHash('sha256').update(key).digest('hex'),purpose:'MODEL' as const});
function fixture(){
 const db=openDatabase(':memory:');databases.push(db);const repository=new EcomRepository(db),store=new RuntimeStore(db),secrets=new SecretBox(randomBytes(32)),ledger=new RequestLedger(store,secrets);
 const add=()=>{const job=repository.createJob({id:randomUUID(),projectId:null,storyboardItemId:null,type:'COPYWRITE',input:{target:'LISTING'}});
  const snapshot:FrozenJobSnapshot={version:1,jobId:job.id,type:job.type,input:job.input as FrozenJobSnapshot['input'],effective:{prompt:'frozen'},createdAt:new Date().toISOString(),resources:[]};
  store.transaction(()=>store.create(job.id,snapshot));return job;
 };return {db,store,ledger,secrets,repository,add};
}
async function serve(handler:Parameters<typeof createServer>[0]){
 const server=createServer(handler);servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('No fake endpoint');return `http://127.0.0.1:${address.port}`;
}
describe('逐请求持久账本：真实本地 HTTP/SSE',()=>{
 it('先保存完整原始回执，JSON 解码失败后重放不会再次 POST，敏感证据是密文',async()=>{
  const f=fixture(),job=f.add();let calls=0;
  const url=await serve((_request,response)=>{calls++;response.writeHead(200,{'content-type':'application/json','x-signed-secret':'private-token'});response.end('{"url":"https://cdn.invalid/image?signature=secret",broken');});
  const scope=f.ledger.forJob(job.id,new AbortController().signal),request=descriptor('round:0');
  const response=await scope.fetch(request,url,{method:'POST',body:'frozen'});
  await expect(response.json()).rejects.toThrow();
  expect(f.ledger.summaries(job.id)).toEqual([{requestKey:'round:0',state:'COMPLETED',localState:'PENDING'}]);
  const persisted=(f.db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get(job.id) as {payload:string}).payload;
  expect(persisted).not.toContain('private-token');expect(persisted).not.toContain('cdn.invalid');
  const replay=await scope.fetch(request,url,{method:'POST'});expect(await replay.text()).toContain('broken');expect(calls).toBe(1);
  f.store.transaction(()=>scope.committed(request.requestKey));expect(f.ledger.summaries(job.id)[0]?.localState).toBe('COMMITTED');
 });
 it('并发 SSE 两个任务上下文不混合响应；每轮有稳定独立请求键',async()=>{
  const f=fixture(),a=f.add(),b=f.add();const seen:string[]=[];
  const url=await serve((request,response)=>{
   const tag=request.url!.slice(1);seen.push(tag);response.writeHead(200,{'content-type':'text/event-stream'});response.write(`data: {"task":"${tag}","part":1}\n\n`);
   setImmediate(()=>response.end(`data: {"task":"${tag}","part":2}\n\ndata: [DONE]\n\n`));
  });
  const sa=f.ledger.forJob(a.id,new AbortController().signal),sb=f.ledger.forJob(b.id,new AbortController().signal);
  const [ra,rb]=await Promise.all([sa.fetch(descriptor('agent:round:0'),url+'/alpha',{method:'POST'}),sb.fetch(descriptor('agent:round:0'),url+'/beta',{method:'POST'})]);
  expect(await ra.text()).toContain('alpha');expect(await rb.text()).toContain('beta');
  expect(Buffer.from(sa.receipt('agent:round:0')!.bodyBase64,'base64').toString()).not.toContain('beta');
  expect(Buffer.from(sb.receipt('agent:round:0')!.bodyBase64,'base64').toString()).not.toContain('alpha');
  await sa.fetch(descriptor('agent:round:1'),url+'/alpha-round-1',{method:'POST'});
  expect(seen.sort()).toEqual(['alpha','alpha-round-1','beta']);expect(f.ledger.summaries(a.id)).toHaveLength(2);
 });
 it('取消已发送的请求保留 UNKNOWN，不能经同键或新键自动重发',async()=>{
  const f=fixture(),job=f.add();let calls=0;let received!:()=>void;const arrived=new Promise<void>(resolve=>received=resolve);
  const url=await serve((_request,response)=>{calls++;response.writeHead(200,{'content-type':'text/event-stream'});response.write('data: partial\n\n');received();});
  const controller=new AbortController(),scope=f.ledger.forJob(job.id,controller.signal);
  const pending=scope.fetch(descriptor('candidate:1'),url,{method:'POST'});await arrived;controller.abort();await expect(pending).rejects.toThrow();
  expect(f.ledger.hasUnknown(job.id)).toBe(true);
  const fresh=f.ledger.forJob(job.id,new AbortController().signal);
  await expect(fresh.fetch(descriptor('candidate:1'),url,{method:'POST'})).rejects.toMatchObject({code:'EXTERNAL_UNKNOWN'});
  await expect(fresh.fetch(descriptor('candidate:2'),url,{method:'POST'})).rejects.toMatchObject({code:'EXTERNAL_UNKNOWN'});expect(calls).toBe(1);
 });
 it('崩溃恢复将 IN_FLIGHT 保留为 UNKNOWN；后续成功不能洗掉先前未知窗口',()=>{
  const f=fixture(),job=f.add(),scope=f.ledger.forJob(job.id,new AbortController().signal);
  scope.begin(descriptor('slot:1'));scope.begin(descriptor('slot:2'));
  scope.complete('slot:2',{status:200,headers:[],bodyBase64:Buffer.from('done').toString('base64')});
  expect(f.ledger.recover(job.id)).toBe(true);expect(f.ledger.summaries(job.id).map(item=>item.state)).toEqual(['UNKNOWN','COMPLETED']);
  expect(()=>scope.begin(descriptor('slot:1'))).toThrow();expect(()=>scope.committed('slot:1')).toThrow();
  expect(f.repository.getJob(job.id)?.providerTaskId).toBe('__EXTERNAL_REQUEST_STARTED__');
 });
 it('完整回执后下载失败只续本地尾阶段，不重发模型请求',async()=>{
  const f=fixture(),job=f.add();let modelCalls=0,downloadCalls=0;
  const url=await serve((request,response)=>{if(request.url==='/model'){modelCalls++;response.end(JSON.stringify({image:'retained'}));}else{downloadCalls++;response.writeHead(503);response.end('unavailable');}});
  const scope=f.ledger.forJob(job.id,new AbortController().signal),request=descriptor('image:1');
  await (await scope.fetch(request,url+'/model',{method:'POST'})).json();expect((await fetch(url+'/download')).status).toBe(503);
  const recovered=f.ledger.forJob(job.id,new AbortController().signal);
  expect(await (await recovered.fetch(request,url+'/model',{method:'POST'})).json()).toEqual({image:'retained'});
  expect(modelCalls).toBe(1);expect(downloadCalls).toBe(1);expect(f.ledger.hasUnknown(job.id)).toBe(false);
 });
 it('不同指纹不能覆盖同一请求键，回执篡改不能解密重放',()=>{
  const f=fixture(),job=f.add(),scope=f.ledger.forJob(job.id,new AbortController().signal);
  scope.begin(descriptor('one'));scope.complete('one',{status:200,headers:[],bodyBase64:'e30='});
  expect(()=>scope.begin({...descriptor('one'),fingerprint:'f'.repeat(64)})).toThrow();
  f.store.mutate(job.id,record=>{record.requests[0]!.encryptedReceipt=f.secrets.encrypt('changed');});
  expect(()=>scope.receipt('one')).toThrow();
 });
 it('外层业务事务未提交时拒绝发送，即使内层账本可使用 SAVEPOINT',async()=>{
  const f=fixture(),job=f.add();let calls=0,pending!:Promise<Response>;
  const ledger=new RequestLedger(f.store,f.secrets,async()=>{calls++;return new Response('{}');});
  const scope=ledger.forJob(job.id,new AbortController().signal);
  f.store.transaction(()=>{pending=scope.fetch(descriptor('uncommitted'),'http://fake.invalid',{method:'POST'});});
  await expect(pending).rejects.toMatchObject({code:'EXTERNAL_TRANSACTION'});expect(calls).toBe(0);expect(ledger.summaries(job.id)).toEqual([]);
 });
 it('注入传输忽略取消时仍中止未完成的 SSE 捕获，保留 UNKNOWN',async()=>{
  const f=fixture(),job=f.add(),controller=new AbortController();let cancelled=false,received!:()=>void;
  const arrived=new Promise<void>(resolve=>received=resolve);
  const ledger=new RequestLedger(f.store,f.secrets,async()=>new Response(new ReadableStream<Uint8Array>({
   start(stream){stream.enqueue(Buffer.from('data: partial\\n\\n'));received();},
   cancel(){cancelled=true;},
  }),{headers:{'content-type':'text/event-stream'}}));
  const scope=ledger.forJob(job.id,controller.signal),pending=scope.fetch(descriptor('ignored-abort'),'http://fake.invalid',{method:'POST'});
  await arrived;await new Promise(resolve=>setImmediate(resolve));controller.abort();
  await expect(pending).rejects.toThrow();expect(cancelled).toBe(true);expect(ledger.summaries(job.id)).toEqual([{requestKey:'ignored-abort',state:'UNKNOWN',localState:'PENDING'}]);
 });
 it('每次网络之前先提交 IN_FLIGHT，失败持久化不能发出网络请求',async()=>{
  const f=fixture(),job=f.add();let calls=0;
  const injected:typeof fetch=async()=>{calls++;expect(f.ledger.summaries(job.id)[0]?.state).toBe('IN_FLIGHT');return new Response('{}');};
  const ledger=new RequestLedger(f.store,f.secrets,injected),scope=ledger.forJob(job.id,new AbortController().signal);
  await scope.fetch(descriptor('first'),'http://fake.invalid',{method:'POST'});expect(calls).toBe(1);
  f.db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
  await expect(scope.fetch(descriptor('second'),'http://fake.invalid',{method:'POST'})).rejects.toMatchObject({code:'RUNTIME_REQUIRED'});expect(calls).toBe(1);
 });
});
