import { join } from 'node:path';
import { need, items, poll, sha256 } from './e2e-full-harness.mjs';
import { projectInput, plan } from './e2e-full-business.mjs';
import { prepareIsolatedV2Profile } from './e2e-full-persistence.mjs';

async function newGeneration(c, label) {
  const project=await c.invoke('createProject',projectInput(c,label));
  const board=await plan(c,project);
  await c.invoke('confirmStoryboard',{projectId:project.id,version:board.storyboard.version});
  return {project,request:{projectId:project.id,storyboardItemIds:board.items.map(item=>item.id),revision:label}};
}
const paidCount=c=>c.mock.state.counts['image-generation']+c.mock.state.counts['image-edit'];
async function waitNewInFlight(c, jobId, hangingBefore) {
  // hanging counts all injected hangs, including sockets already aborted by an earlier scenario.
  const observed=await poll(async()=>({hanging:c.mock.state.hanging,requests:items(await c.invoke('getJobRequests',{jobId}))}),
    value=>value.hanging>hangingBefore&&value.requests.some(row=>row.state==='IN_FLIGHT'),{label:'new hanging provider socket and current job IN_FLIGHT'});
  c.check(observed.hanging>hangingBefore,'this scenario reached a new hanging provider request');
  c.check(observed.requests.some(row=>row.state==='IN_FLIGHT'),'current job persisted IN_FLIGHT before interruption');
  await c.evidence('before-interruption',{jobId,hangingBefore,...observed});
}
export const recoveryScenarios=[
  {id:'ipc-path-secret-boundaries',title:'Restricted IPC, traversal/path/secret rejection and renderer isolation',run:async c=>{
    const isolation=await c.page.evaluate(()=>({require:typeof window.require,process:typeof window.process,ipc:typeof window.ipcRenderer,bridge:typeof window.ecomgen}));
    c.equal(isolation,{require:'undefined',process:'undefined',ipc:'undefined',bridge:'object'});
    for(const operation of ['notAnOperation','host.resolveResource','host.assetPath'])await c.rejects(operation,{ref:{kind:'ASSET',id:c.state.asset?.id??'unknown'}});
    await c.rejects('listAssets',{projectId:need(c.state.project,'Project unavailable').id,path:'C:/Windows/win.ini'});
    for(const ref of [{kind:'ASSET',id:'../outside'},{kind:'ASSET',id:'C:/Windows/win.ini'},{kind:'ASSET',id:'valid',path:'../outside'},{kind:'PRINT_PACK_FILE',id:'valid',index:-1}])await c.rejects('getResource',{ref});
    const providers=await c.invoke('listProviders');c.check(!JSON.stringify(providers).includes('encryptedApiKey')&&!JSON.stringify(providers).includes('e2e-full-fake-key'));
    const invalid=await c.page.evaluate(async()=>{try{await window.ecomgen.saveArtifact({kind:'ASSET',id:'../outside'});return 'accepted';}catch{return 'rejected';}});c.equal(invalid,'rejected');
    const blockedByBrowser=rows=>rows.filter(row=>row.event==='blocked'&&row.type==='browser'&&row.pid===c.startupGuard.browserPid&&row.token===c.startupGuard.token).length;
    const blockedBefore=blockedByBrowser(await c.guardAudit());
    // Port 9 is rejected by fetch's bad-port validation before the socket guard can run.
    const probe=await c.app.evaluate(async()=>{try{await fetch('http://192.0.2.1:8088/');return false;}catch(error){return String(error).includes('E2E_NETWORK_BLOCKED')||String(error.cause).includes('E2E_NETWORK_BLOCKED');}});c.equal(probe,true,'Node network guard blocks non-fixture address without transmitting');
    const audit=await c.guardAudit();c.check(blockedByBrowser(audit)>blockedBefore,'current browser guard audited this denied socket attempt');
    await c.evidence('network-guard',audit);
  }},
  {id:'draft-partial-retry',title:'Partial draft keeps successful slots/pixels and retries only failed slots',jobTypes:['PATTERN_DRAFT_GENERATE'],run:async c=>{
    const provider=need(c.state.provider,'Provider unavailable');
    const draft=await c.invoke('createPatternDraft',{name:'Partial isolated batch'});
    const before=c.mock.state.counts['image-generation'];
    c.mock.control.addFault({kind:'image-generation',at:before+2,fault:{type:'http',status:400}});
    try {
      const request={draftId:draft.id,clientKey:'partial-batch',operation:'GENERATE',candidateCount:2,providerId:provider.id,imageModelId:'mock-image',theme:'Partial batch two candidates',aspectRatio:'1:1',background:'WHITE'};
      const queued=await c.invoke('createDraftBatch',request);await c.waitJob(queued.job.id,'FAILED');
      const first=items(await c.invoke('listDraftBatches',{draftId:draft.id})).find(item=>item.id===queued.batch.id);c.equal(first.slots.filter(slot=>slot.status==='SUCCEEDED').length,1);c.equal(first.slots.filter(slot=>slot.status==='FAILED').length,1);
      const survivor=items(await c.invoke('listDraftCandidates',{draftId:draft.id}))[0];need(survivor,'Partial success was lost');const bytes=await c.save({kind:'DRAFT_CANDIDATE',id:survivor.id});
      const retry=await c.invoke('retryFailedDraftBatch',{draftId:draft.id,batchId:first.id});await c.waitJob(retry.job.id);
      const after=items(await c.invoke('listDraftCandidates',{draftId:draft.id}));c.equal(after.length,2);c.check(after.some(candidate=>candidate.id===survivor.id));
      c.equal(sha256(await c.save({kind:'DRAFT_CANDIDATE',id:survivor.id})),sha256(bytes),'successful file never overwritten');
      c.equal(c.mock.state.counts['image-generation']-before,3,'two original attempts plus one failed-slot replacement');
      await c.evidence('partial-slots',{before:first,after:await c.invoke('listDraftBatches',{draftId:draft.id})});
    } finally {c.mock.control.clearFaults();}
  }},
  {id:'receipt-replay-download-failure',title:'Complete paid receipt survives failed GET and restart; retry performs no second paid POST',jobTypes:['GENERATE'],run:async c=>{
    const {project,request}=await newGeneration(c,'Receipt replay download once');
    const before=paidCount(c);c.mock.control.failNext('image-generation',{type:'download-once'});
    try {
      const submitted=await c.invoke('createGenerationJobs',request);const jobId=submitted.jobs[0].id;
      await c.waitJob(jobId,'FAILED');
      const requests=items(await c.invoke('getJobRequests',{jobId}));c.check(requests.some(row=>row.state==='COMPLETED'&&row.localState==='PENDING'),'complete receipt persisted before image GET');c.check(!requests.some(row=>row.state==='UNKNOWN'));
      c.equal(paidCount(c)-before,1,'one paid request before failed download');
      await c.stop();await c.launch();
      const retried=await c.invoke('retryJob',{jobId});await c.waitJob(retried.id);
      const outputs=items(await c.invoke('listOutputs',{projectId:project.id}));c.equal(outputs.length,1);await c.imageRef({kind:'OUTPUT',id:outputs[0].id});
      c.equal(paidCount(c)-before,1,'restart and retry replay receipt; NO second paid POST');c.check(c.mock.state.downloadFailures>0,'fault really affected image GET');
      c.check(items(await c.invoke('getJobRequests',{jobId:retried.id})).every(row=>row.state==='COMPLETED'&&row.localState==='COMMITTED'));
    } finally {c.mock.control.clearFaults();}
  }},
  {id:'unknown-no-retry',title:'Dropped paid request becomes UNKNOWN and remains non-retryable across restart and duplicate submit',jobTypes:['PLAN'],run:async c=>{
    const project=await c.invoke('createProject',projectInput(c,'Unknown isolated planning'));
    c.mock.control.failNext('chat',{type:'drop'});const before=c.mock.state.counts.chat;
    const request={projectId:project.id,planningMode:'AI',targetImageCount:1,regenerationKey:'unknown-exact-intent'};
    try {
      const job=await c.invoke('createPlanningJob',request);await c.waitJob(job.id,'UNKNOWN');await c.rejects('retryJob',{jobId:job.id});
      await c.stop();await c.launch();c.equal((await c.invoke('getJob',{jobId:job.id})).status,'UNKNOWN');
      let duplicate;
      try{duplicate=await c.invoke('createPlanningJob',request);}catch(error){if(/UNKNOWN|未知|未决/.test(error.message))duplicate=null;else throw error;}
      if(duplicate)c.equal(duplicate.id,job.id,'duplicate must preserve unknown identity');
      c.equal(c.mock.state.counts.chat-before,1,'UNKNOWN has no automatic or duplicate paid resend');
    } finally {c.mock.control.clearFaults();}
  }},
  {id:'abort-inflight',title:'Cancel aborts hanging transport and unknown paid intent cannot create late output',jobTypes:['GENERATE'],run:async c=>{
    const {project,request}=await newGeneration(c,'Abort hanging image');const before=paidCount(c),aborted=c.mock.state.aborted,hangingBefore=c.mock.state.hanging;
    c.mock.control.failNext('image-generation',{type:'hang'});
    try {
      const submitted=await c.invoke('createGenerationJobs',request);const jobId=submitted.jobs[0].id;
      await waitNewInFlight(c,jobId,hangingBefore);
      await c.invoke('cancelJob',{jobId});const final=await c.waitJob(jobId,'UNKNOWN');c.check(final.cancelRequested,'cancel intent persists even when UNKNOWN wins');
      await poll(async()=>c.mock.state.aborted,value=>value>aborted,{label:'provider observed transport abort'});
      c.equal(items(await c.invoke('listOutputs',{projectId:project.id})).length,0);c.equal(paidCount(c)-before,1);await c.rejects('retryJob',{jobId});
    } finally {c.mock.control.clearFaults();}
  }},
  {id:'backend-crash-status',title:'Test-owned Backend crash reports disconnection and recovers paid IN_FLIGHT as UNKNOWN',jobTypes:['PLAN'],run:async c=>{
    const project=await c.invoke('createProject',projectInput(c,'Crash unknown planning'));const before=c.mock.state.counts.chat,hangingBefore=c.mock.state.hanging;
    c.mock.control.failNext('chat',{type:'hang'});
    try {
      const job=await c.invoke('createPlanningJob',{projectId:project.id,planningMode:'AI',targetImageCount:1,regenerationKey:'crash-unknown'});
      await waitNewInFlight(c,job.id,hangingBefore);
      await c.restartBackend();await c.waitJob(job.id,'UNKNOWN');await c.rejects('retryJob',{jobId:job.id});
      c.equal(c.mock.state.counts.chat-before,1,'restart did not repeat paid planning POST');
      c.equal((await c.invoke('getProject',{projectId:need(c.state.project,'Primary project unavailable').id})).id,c.state.project.id);
      await c.evidence('statuses',await c.page.evaluate(()=>window.__e2eBackendStatuses));
    } finally {c.mock.control.clearFaults();}
  }},
  {id:'persisted-records-restart',title:'Actual SQLite integrity/counts and stable record/file IDs after app restart',run:async c=>{
    const project=need(c.state.project,'Project unavailable');const before=await c.invoke('getProject',{projectId:project.id});
    const summary=await c.inspect();c.equal(summary.version,6);c.equal(summary.integrity,'ok');c.equal(summary.foreignKeys,[]);c.check(summary.counts.desktop_job_runtime>0&&summary.counts.desktop_resources>0);
    await c.evidence('sqlite-summary',summary);
    await c.stop();await c.launch();const after=await c.invoke('getProject',{projectId:project.id});
    c.equal(after.assets.map(row=>row.id),before.assets.map(row=>row.id));c.equal(after.outputs.map(row=>row.id),before.outputs.map(row=>row.id));
    c.equal(after.verifiedFacts,before.verifiedFacts);
    for(const output of after.outputs)await c.imageRef({kind:'OUTPUT',id:output.id},{expectedHash:output.hash});
  }},
  {id:'isolated-v2-upgrade',title:'Baseline schema-v2 upgrade preserves IDs, ciphertext bytes/history/resources and never executes old paid task',run:async c=>{
    const userData=join(c.fixture,'migration-user-data');
    await c.assertGuardCurrent();
    const requestsBefore=c.mock.state.total;
    const seeded=await c.app.evaluate((_electron,{config,token})=>{
      if(typeof globalThis.__ecomgenFullSeedV2!=='function')throw Error('Guarded v2 fixture seeder is unavailable');
      return globalThis.__ecomgenFullSeedV2(config,token);
    },{config:{fixture:c.fixture,userData,image:c.image,width:c.mock.images.width,height:c.mock.images.height,baseUrl:c.mock.baseUrl},token:c.startupGuard.token});
    // Only after the separate closed fixture is seeded do we release this run's
    // current app and launch production against v2 for its genuine migration.
    const sourceUserData=c.activeData;
    await c.stop();
    try {
      await prepareIsolatedV2Profile({fixture:c.fixture,sourceUserData,userData});
      await c.launch(userData);
      const detail=await c.invoke('getProject',{projectId:seeded.ids.project});c.equal(detail.id,seeded.ids.project);c.check(detail.assets.some(asset=>asset.id===seeded.ids.asset));
      const historical=await c.invoke('getJob',{jobId:seeded.ids.unknown});c.equal(historical.id,seeded.ids.unknown);c.equal(historical.status,'UNKNOWN');c.equal(historical.retryable,false);await c.rejects('retryJob',{jobId:historical.id});
      // The settings center records the first visible business route after the
      // renderer loads. Settle that real startup write before the full DB baseline.
      await c.page.waitForLoadState('load');
      await c.page.getByRole('navigation',{name:'全局导航'}).waitFor({state:'visible'});
      await poll(()=>c.invoke('getApplicationSettings'),settings=>settings.lastWorkspaceRoute==='/',{label:'initial migrated renderer route preference persisted'});
      const rows=await c.inspect('migration',seeded.ids);c.equal(rows.version,6);c.equal(rows.integrity,'ok');c.equal(rows.foreignKeys,[]);c.equal(rows.ciphertextHash,seeded.ciphertextHash,'encrypted bytes preserved exactly');
      c.equal(rows.providerId,seeded.ids.provider);c.equal(rows.asset.id,seeded.ids.asset);c.equal(rows.asset.hash,seeded.imageHash);
      c.equal(rows.jobs.map(job=>job.id).sort(),['plan','complete','unknown','queued','running'].map(name=>seeded.ids[name]).sort());
      c.check(rows.decryptable,'same safeStorage master key decrypts preserved AES-GCM bytes');
      c.check(rows.jobs.every(job=>job.input_json===seeded.snapshot&&job.preserved_history===1&&job.retryable===0));
      for(const name of ['plan','complete','unknown','queued','running'])c.equal(rows.jobs.find(job=>job.id===seeded.ids[name]).request_fingerprint,`e2e-v2-${name}-original-fingerprint`);
      for(const name of ['unknown','running'])c.equal(rows.jobs.find(job=>job.id===seeded.ids[name]).status,'UNKNOWN');
      c.equal(rows.jobs.find(job=>job.id===seeded.ids.queued).status,'CANCELLED');
      c.equal(rows.histories.length,5);c.check(rows.histories.every(history=>history.snapshot_json===seeded.snapshot));c.check(rows.storyboards.some(board=>board.id===seeded.ids.board&&board.data_json===seeded.boardJson));
      c.check(rows.storyboardItems.some(item=>item.id===seeded.ids.item),'storyboard item ID retained');
      const unknownHistory=rows.histories.find(history=>history.job_id===seeded.ids.unknown);c.equal(unknownHistory.original_status,'UNKNOWN');c.equal(unknownHistory.request_state,'UNKNOWN');
      c.equal(JSON.parse(unknownHistory.original_job_json).snapshot,seeded.snapshot,'opaque original history is retained');
      const completedHistory=rows.histories.find(history=>history.job_id===seeded.ids.complete);c.equal(JSON.parse(completedHistory.result_json).assetIds,[seeded.ids.asset]);
      const file=await c.save({kind:'ASSET',id:seeded.ids.asset});c.equal(sha256(file),seeded.imageHash,'migrated flat file resource is readable');
      await c.stop();await c.launch(userData);
      // Health IPC is ready before createWindow finishes loading. Let the real
      // renderer settle so quit cannot cancel loadFile and open its error dialog.
      await c.page.waitForLoadState('load');
      await c.page.getByRole('navigation',{name:'全局导航'}).waitFor({state:'visible'});
      c.equal(await c.inspect('migration',seeded.ids),rows,'upgrade is idempotent after reopening');
      c.equal(c.mock.state.total,requestsBefore,'no fixture request from preserved unknown history or upgrade');
      await c.evidence('upgrade',{ids:seeded.ids,baselineSourceHash:seeded.baselineSourceHash,ciphertextHash:rows.ciphertextHash,version:rows.version,historyCount:rows.histories.length,assetHash:rows.asset.hash});
    } finally {await c.stop();await c.launch();}
  }},
];
