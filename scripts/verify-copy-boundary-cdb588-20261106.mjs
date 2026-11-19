import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../packages/backend/src/index.ts';
import { startFullMockProvider } from './full-mock-provider.mjs';
const root = await mkdtemp(join(tmpdir(), 'ecomgen-copy-verify-cdb588-'));
let backend, mock;
const options = { dataDir: join(root, 'managed'), masterKey: randomBytes(32).toString('base64'), version: 'isolated-copy-cdb588' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, accepts, label) {
  const until = Date.now()+30000;
  while(Date.now()<until) { const current = await fn(); if(accepts(current)) return current; await pause(10); }
  throw new Error('Timeout '+label);
}
try {
  mock = await startFullMockProvider();
  backend = await createBackend(options);
  const provider = await backend.invoke('createProvider', {name:'cdb588 synthetic local provider',baseUrl:mock.baseUrl,reasoningProtocol:'openai',apiKey:'cdb588-synthetic-key',models:[{id:'mock-reasoner',supportsVision:true,supportsTools:false,supportsThinking:false,supportsStructuredOutput:true},{id:'mock-image',supportsVision:false,supportsTools:false,supportsThinking:false,supportsStructuredOutput:false,imageApiKind:'openai_images'}]});
  const project = await backend.invoke('createProject', {name:'cdb588 isolated copy project',productDescription:'Original synthetic description',reasoningProviderId:provider.id,reasoningModelId:'mock-reasoner',imageProviderId:provider.id,imageModelId:'mock-image',defaultMode:'CREATIVE'});
  await backend.invoke('uploadAsset',{projectId:project.id,kind:'PRODUCT',role:'PRODUCT_TRUTH',file:{name:'synthetic.png',mimeType:'image/png',base64:mock.images.image.toString('base64')}});
  mock.control.failNext('chat',{type:'delay',ms:400});
  const job = await backend.invoke('createCopywritingJob',{projectId:project.id,target:'PRODUCT_DESCRIPTION',regenerationKey:'cdb588-first-copy'});
  await poll(() => backend.invoke('getJob',{jobId:job.id}), value => value.status==='RUNNING', 'running copy task');
  const saved = await backend.invoke('updateProject',{projectId:project.id,productDescription:'User save before actual delayed provider completes'});
  assert.equal(saved.productDescription,'User save before actual delayed provider completes');
  const terminal = await poll(() => backend.invoke('getJob',{jobId:job.id}), value => ['SUCCEEDED','FAILED','UNKNOWN','CANCELLED'].includes(value.status), 'terminal copy');
  assert.equal(terminal.status,'SUCCEEDED',JSON.stringify(terminal));
  const result = await backend.invoke('getCopywritingResult',{jobId:job.id});
  assert.equal(result.jobId,job.id); assert.equal(result.projectId,project.id); assert.equal(result.target,'PRODUCT_DESCRIPTION'); assert.ok(result.content.length);
  assert.equal((await backend.invoke('getProject',{projectId:project.id})).productDescription,saved.productDescription);
  await assert.rejects(backend.invoke('updateProject',{projectId:project.id,path:'C:/private',productDescription:'invalid'}), {code:'INVALID_INPUT'});
  await assert.rejects(backend.invoke('host.resolveResource',{}), {code:'UNKNOWN_OPERATION'});
  const publicOutput = JSON.stringify({project:await backend.invoke('getProject',{projectId:project.id}),result,providers:await backend.invoke('listProviders',{})});
  assert.ok(!publicOutput.includes(options.dataDir)); assert.ok(!publicOutput.includes('cdb588-synthetic-key')); assert.ok(!publicOutput.includes('encryptedApiKey'));
  await backend.close(); backend = await createBackend(options);
  assert.equal((await backend.invoke('getProject',{projectId:project.id})).productDescription,saved.productDescription);
  assert.deepEqual(await backend.invoke('getCopywritingResult',{jobId:job.id}),result);
  console.log(JSON.stringify({currentBackendSource:'E:/EcomGen/desktop/packages/backend/src/index.ts',defaultIntegrations:true,terminal:terminal.status,descriptionRetained:true,generatedResultRetainedAfterReopen:true,strictPublicBoundary:true,localProviderRequests:mock.state.counts.chat}));
} finally { await backend?.close(); await mock?.close(); await rm(root,{recursive:true,force:true,maxRetries:3}); }
