import { afterEach, describe, expect, it } from 'vitest';
import type { SqliteDatabase } from './database.js';
import { openDatabase } from './database.js';
import { EcomRepository, EXTERNAL_REQUEST_STARTED } from './repository.js';
import { resetPipelineStepsFrom, startPipelineStep } from './pattern-pipeline.js';

let db: SqliteDatabase;
afterEach(() => db?.close());
function setup() { db=openDatabase(':memory:'); return new EcomRepository(db); }
function pipeline(repository: EcomRepository) {
  return repository.createPatternPipeline({ patternId:null,specId:'spec',specVersion:'1',layout:'TILE',repeatLayout:'STRAIGHT',listingPlatform:'ETSY',listingProviderId:'provider',listingModelId:'reasoner',listingHints:{ sellingPoints:null,bannedWords:null },requestFingerprint:'pipeline-fp',steps:[{ step:'TILE_CHECK',position:0 },{ step:'LISTING',position:1 }] });
}

describe('UNKNOWN intent protection', () => {
  it.each([['RETRY','FAILED','INTERRUPTED_RETRY'],['END','CANCELLED','INTERRUPTED_ENDED']])('主动 %s 必须覆盖全部未知请求且保留历史', (action,status,code) => {
    const repository=setup();
    const job=repository.createJob({id:'interrupted',projectId:null,storyboardItemId:null,type:'SUITE_FORGE',input:{frozen:true},status:'UNKNOWN',retryable:false});
    const requests=[{requestKey:'one',startedAt:'t1',usageKey:'usage'},{requestKey:'two',startedAt:'t2'}];
    const history=[...requests.map(({requestKey,startedAt,...rest})=>({descriptor:{requestKey},startedAt,...rest,state:'UNKNOWN'})),{descriptor:{requestKey:'legacy'},startedAt:'old',state:'VERIFIED_FAILED'}];
    const payload={version:1,attempt:2,requests:[{state:'COMPLETED',encryptedReceipt:'saved'}],requestHistory:history,reviews:[{requestKey:'legacy',requestStartedAt:'old',outcome:'FAILED',encryptedEvidence:'cipher',recordedAt:'old'}],interruptions:[{action,recordedAt:'now',attempt:2,requests}]};
    const write=(value:unknown)=>db.prepare('INSERT OR REPLACE INTO desktop_job_runtime VALUES(?,?,?)').run(job.id,JSON.stringify(value),'now');
    const finish=()=>db.prepare('UPDATE jobs SET status=?,error_json=?,retryable=0 WHERE id=?').run(status,JSON.stringify({code}),job.id);
    for(const invalid of [
      {...payload,interruptions:[]},
      {...payload,interruptions:[{...payload.interruptions[0],requests:requests.slice(0,1)}]},
      {...payload,interruptions:[{...payload.interruptions[0],requests:[{...requests[0],usageKey:'wrong'},requests[1]]}]},
      {...payload,interruptions:[{...payload.interruptions[0],attempt:1}]},
      {...payload,requests:[{state:'UNKNOWN'}]},
    ]) { write(invalid); expect(finish).toThrow('Unknown external outcome'); }
    write(payload);
    expect(()=>db.prepare('UPDATE jobs SET status=?,error_json=?,input_json=? WHERE id=?').run(status,JSON.stringify({code}),'{}',job.id)).toThrow('Unknown external outcome');
    expect(()=>db.prepare("UPDATE jobs SET status='SUCCEEDED' WHERE id=?").run(job.id)).toThrow('Unknown external outcome');
    finish();
    expect(JSON.parse((db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get(job.id) as {payload:string}).payload)).toEqual(payload);
  });
  it('主动结束仅允许同一任务和原槽位身份终结', () => {
    const repository=setup();
    const draft=repository.createPatternDraft({name:'draft',composeType:'PLACEMENT',conditions:{}});
    const {batch}=repository.createDraftBatch({draftId:draft.id,operation:'GENERATE',parentCandidateId:null,providerId:null,imageModelId:null,candidateCount:1,instruction:null,snapshot:{},clientKey:'end'});
    const job=repository.createJob({id:'end-job',projectId:null,storyboardItemId:null,type:'PATTERN_DRAFT_GENERATE',input:{},status:'UNKNOWN',retryable:false});
    repository.assignDraftSlotsToJob(batch.id,[1],job.id,false);
    db.prepare("UPDATE draft_slots SET status='UNKNOWN' WHERE batch_id=?").run(batch.id);
    const flow=pipeline(repository);
    repository.updatePatternPipelineStep(flow.steps[0]!.id,{status:'UNKNOWN',jobId:job.id});
    const request={requestKey:'key',startedAt:'time'};
    db.prepare('INSERT INTO desktop_job_runtime VALUES(?,?,?)').run(job.id,JSON.stringify({version:1,attempt:1,requests:[],requestHistory:[{descriptor:{requestKey:'key'},startedAt:'time',state:'UNKNOWN'}],interruptions:[{action:'END',recordedAt:'now',attempt:1,requests:[request]}]}),'now');
    const error=JSON.stringify({code:'INTERRUPTED_ENDED'});
    db.prepare("UPDATE jobs SET status='CANCELLED',error_json=? WHERE id=?").run(error,job.id);
    expect(()=>db.prepare("UPDATE draft_slots SET status='CANCELLED',attempt=attempt+1,error_json=? WHERE batch_id=?").run(error,batch.id)).toThrow('Unknown draft outcome');
    expect(()=>db.prepare("UPDATE pattern_pipeline_steps SET status='CANCELLED',job_id='other',error_json=? WHERE id=?").run(error,flow.steps[0]!.id)).toThrow('Unknown pipeline outcome');
    db.prepare("UPDATE draft_slots SET status='CANCELLED',error_json=? WHERE batch_id=?").run(error,batch.id);
    db.prepare("UPDATE pattern_pipeline_steps SET status='CANCELLED',error_json=? WHERE id=?").run(error,flow.steps[0]!.id);
  });

  it('仅允许逐条审计的已核实失败终结，并保持关联槽位和流水线的原任务及尝试次数', () => {
    const repository=setup();
    const draft=repository.createPatternDraft({ name:'draft',composeType:'PLACEMENT',conditions:{} });
    const { batch }=repository.createDraftBatch({ draftId:draft.id,operation:'GENERATE',parentCandidateId:null,providerId:null,imageModelId:null,candidateCount:1,instruction:null,snapshot:{},clientKey:'review' });
    const job=repository.createJob({ id:'review-job',projectId:null,storyboardItemId:null,type:'PATTERN_DRAFT_GENERATE',input:{},status:'UNKNOWN',retryable:false });
    repository.assignDraftSlotsToJob(batch.id,[1],job.id,false);
    db.prepare("UPDATE draft_slots SET status='UNKNOWN' WHERE batch_id=?").run(batch.id);
    const flow=pipeline(repository);
    repository.updatePatternPipelineStep(flow.steps[0]!.id,{ status:'UNKNOWN',jobId:job.id });
    const history={ descriptor:{ requestKey:'key' },state:'VERIFIED_FAILED',startedAt:'start',encryptedReceipt:'unchanged',extra:'preserved' };
    const review={ requestKey:'key',requestStartedAt:'start',outcome:'FAILED',encryptedEvidence:'ciphertext',recordedAt:'review-time' };
    const payload={ version:1,requests:[{ state:'COMPLETED',encryptedReceipt:'receipt',responseHash:'hash' }],requestHistory:[history],reviews:[review] };
    const write=(value: unknown) => db.prepare('INSERT OR REPLACE INTO desktop_job_runtime VALUES(?,?,?)').run(job.id,JSON.stringify(value),'time');
    const finish=() => db.prepare("UPDATE jobs SET status='FAILED',error_json=?,retryable=0 WHERE id=?").run(JSON.stringify({ code:'VERIFIED_EXTERNAL_FAILURE' }),job.id);
    const invalid = [
      { ...payload, reviews:[] },
      { ...payload, reviews:[{ ...review, encryptedEvidence:'' }] },
      { ...payload, reviews:[{ ...review, requestStartedAt:'other' }] },
      { ...payload, reviews:[{ ...review, outcome:'UNRESOLVED' }] },
      { ...payload, requestHistory:[] },
      { ...payload, requests:[{ state:'UNKNOWN' }] },
      { ...payload, requests:[{ state:'IN_FLIGHT' }] },
      { ...payload, requestHistory:[history,{ ...history, descriptor:{ requestKey:'second' } }] },
    ];
    for (const value of invalid) { write(value); expect(finish).toThrow('Unknown external outcome'); }
    write(payload);
    for (const status of ['QUEUED','RUNNING','CANCELLED','SUCCEEDED'])
      expect(() => db.prepare('UPDATE jobs SET status=? WHERE id=?').run(status,job.id)).toThrow('Unknown external outcome');
    expect(() => db.prepare("UPDATE jobs SET status='FAILED',error_json='{}' WHERE id=?").run(job.id)).toThrow('Unknown external outcome');
    expect(() => db.prepare("UPDATE draft_slots SET status='FAILED' WHERE batch_id=?").run(batch.id)).toThrow('Unknown draft outcome');
    expect(() => db.prepare("UPDATE pattern_pipeline_steps SET status='FAILED' WHERE id=?").run(flow.steps[0]!.id)).toThrow('Unknown pipeline outcome');
    finish();
    const error=JSON.stringify({ code:'VERIFIED_EXTERNAL_FAILURE' });
    expect(() => db.prepare("UPDATE draft_slots SET status='FAILED',attempt=attempt+1,error_json=? WHERE batch_id=?").run(error,batch.id)).toThrow('Unknown draft outcome');
    expect(() => db.prepare("UPDATE draft_slots SET status='FAILED',job_id='other',error_json=? WHERE batch_id=?").run(error,batch.id)).toThrow('Unknown draft outcome');
    expect(() => db.prepare("UPDATE draft_slots SET status='QUEUED' WHERE batch_id=?").run(batch.id)).toThrow('Unknown draft outcome');
    expect(() => db.prepare("UPDATE draft_slots SET status='FAILED' WHERE batch_id=?").run(batch.id)).toThrow('Unknown draft outcome');
    expect(() => db.prepare("UPDATE pattern_pipeline_steps SET status='FAILED',job_id='other',error_json=? WHERE id=?").run(error,flow.steps[0]!.id)).toThrow('Unknown pipeline outcome');
    expect(() => db.prepare("UPDATE pattern_pipeline_steps SET status='PENDING' WHERE id=?").run(flow.steps[0]!.id)).toThrow('Unknown pipeline outcome');
    expect(() => db.prepare("UPDATE pattern_pipeline_steps SET status='FAILED' WHERE id=?").run(flow.steps[0]!.id)).toThrow('Unknown pipeline outcome');
    db.prepare("UPDATE draft_slots SET status='FAILED',error_json=? WHERE batch_id=?").run(error,batch.id);
    db.prepare("UPDATE pattern_pipeline_steps SET status='FAILED',error_json=? WHERE id=?").run(error,flow.steps[0]!.id);
    expect(JSON.parse((db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get(job.id) as {payload:string}).payload)).toEqual(payload);
  });

  it('保留历史任务即使有完整审计也不能通过该门禁', () => {
    const repository=setup();
    repository.createJob({ id:'history',projectId:null,storyboardItemId:null,type:'SUITE_FORGE',input:{},status:'UNKNOWN',retryable:false });
    db.prepare("UPDATE jobs SET preserved_history=1 WHERE id='history'").run();
    db.prepare('INSERT INTO desktop_job_runtime VALUES(?,?,?)').run('history',JSON.stringify({ version:1,requests:[],requestHistory:[{ descriptor:{ requestKey:'key' },state:'VERIFIED_FAILED',startedAt:'start' }],reviews:[{ requestKey:'key',requestStartedAt:'start',outcome:'NOT_EXECUTED',encryptedEvidence:'cipher',recordedAt:'time' }] }),'time');
    expect(() => db.prepare("UPDATE jobs SET status='FAILED',preserved_history=0,error_json=? WHERE id='history'").run(JSON.stringify({ code:'VERIFIED_EXTERNAL_FAILURE' }))).toThrow();
  });
  it('崩溃恢复把任务、草稿槽和流水线变为不可自动补偿的未知状态', () => {
    const repository=setup();
    const draft=repository.createPatternDraft({ name:'draft',composeType:'PLACEMENT',conditions:{} });
    const { batch }=repository.createDraftBatch({ draftId:draft.id,operation:'GENERATE',parentCandidateId:null,providerId:null,imageModelId:null,candidateCount:2,instruction:null,snapshot:{ original:'immutable' },clientKey:'intent' });
    const job=repository.createJob({ id:'external',projectId:null,storyboardItemId:null,type:'PATTERN_DRAFT_GENERATE',input:{ batchId:batch.id },status:'RUNNING',providerTaskId:EXTERNAL_REQUEST_STARTED,requestFingerprint:'unknown-fp' });
    repository.assignDraftSlotsToJob(batch.id,[1,2],job.id,false);
    repository.updateDraftSlot(batch.id,1,{ status:'RUNNING' });
    const flow=pipeline(repository);
    repository.updatePatternPipelineStep(flow.steps[0]!.id,{ status:'RUNNING',jobId:job.id });
    expect(repository.recoverInterruptedJobs()).toEqual([]);
    expect(repository.getJob(job.id)).toMatchObject({ status:'UNKNOWN',retryable:false,input:{ batchId:batch.id } });
    expect(repository.listDraftSlots(batch.id).map(slot=>slot.status)).toEqual(['UNKNOWN','UNKNOWN']);
    expect(repository.getPatternPipeline(flow.id)).toMatchObject({ status:'AWAITING_INPUT',blockReason:'EXTERNAL_RESULT_UNKNOWN',steps:[{ status:'UNKNOWN',jobId:job.id },{ status:'PENDING' }] });
    expect(repository.findJobByFingerprint(null,'unknown-fp')?.id).toBe(job.id);
    expect(() => repository.updateJob(job.id,{ status:'FAILED',retryable:true })).toThrow('Unknown external outcome');
    expect(() => repository.assignDraftSlotsToJob(batch.id,[1],'retry-job')).toThrow('Unknown external outcome');
    expect(() => repository.updateDraftSlot(batch.id,1,{ status:'FAILED' })).toThrow('Unknown draft outcome');
    expect(() => resetPipelineStepsFrom(repository,flow.id,flow.steps[0]!.id)).toThrow('Unknown external outcome');
    expect(() => repository.updatePatternPipelineStep(flow.steps[0]!.id,{ status:'PENDING',jobId:null })).toThrow('Unknown pipeline outcome');
    expect(repository.recoverInterruptedJobs()).toEqual([]);
    expect(repository.getDraftBatch(batch.id)?.snapshot).toEqual({ original:'immutable' });
  });

  it('恢复保留取消意图；外部未知优先于取消，安全重排清理旧进度明细', () => {
    const repository=setup();
    for(const id of ['safe','cancelled','unknown']) repository.createJob({ id,projectId:null,storyboardItemId:null,type:'SUITE_FORGE',input:{},status:'RUNNING',progressDetail:{ stale:'detail' },cancelRequested:id!=='safe',providerTaskId:id==='unknown'?EXTERNAL_REQUEST_STARTED:null });
    expect(repository.getJob('safe')?.progressDetail).toEqual({ stale:'detail' });
    expect(repository.recoverInterruptedJobs()).toMatchObject([{ id:'safe',status:'QUEUED',progressDetail:null }]);
    expect(repository.getJob('safe')?.progressDetail).toBeNull();
    expect(repository.getJob('cancelled')).toMatchObject({ status:'CANCELLED',retryable:false,cancelRequested:true });
    expect(repository.getJob('unknown')).toMatchObject({ status:'UNKNOWN',retryable:false,cancelRequested:true });
  });

  it('删除 Provider 保留已发出的未知请求，同时取消尚未执行的任务并清除模型引用', () => {
    const repository=setup();
    const provider=repository.saveProvider({ name:'fake',baseUrl:'https://fake.invalid',encryptedApiKey:'cipher',reasoningProtocol:'openai',models:[] });
    for(const id of ['queued','running']) repository.createJob({ id,projectId:null,storyboardItemId:null,type:'SUITE_FORGE',input:{ providerSnapshot:'frozen' },providerId:provider.id,...(id==='running'?{ status:'RUNNING',providerTaskId:EXTERNAL_REQUEST_STARTED }:{}) });
    expect(repository.deleteProvider(provider.id)).toBe('deleted');
    expect(repository.getJob('running')).toMatchObject({ status:'UNKNOWN',retryable:false,cancelRequested:true,input:{ providerSnapshot:'frozen' } });
    expect(repository.getJob('queued')).toMatchObject({ status:'CANCELLED',retryable:false });
    expect(() => repository.updateJob('running',{ status:'QUEUED' })).toThrow('Unknown external outcome');
  });

  it('流水线步骤创建在一个事务内；伴随记录失败时不留下可执行孤儿任务', () => {
    const repository=setup(), flow=pipeline(repository);
    // 真实 SQLite 故障注入：任务已插入，写步骤关联时触发失败。
    db.exec("CREATE TRIGGER reject_step BEFORE UPDATE ON pattern_pipeline_steps BEGIN SELECT RAISE(ABORT,'injected step failure'); END");
    expect(() => startPipelineStep(repository,flow,flow.steps[0]!,'pattern')).toThrow('injected step failure');
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n:0 });
    expect(repository.getPatternPipeline(flow.id)?.steps[0]).toMatchObject({ status:'PENDING',jobId:null });
    db.exec('DROP TRIGGER reject_step');
    const created=startPipelineStep(repository,flow,flow.steps[0]!,'pattern');
    expect(repository.getPatternPipeline(flow.id)?.steps[0]).toMatchObject({ status:'QUEUED',jobId:created.job.id });
    expect(() => startPipelineStep(repository,flow,flow.steps[0]!,'pattern')).toThrow('explicitly reset');
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n:1 });
  });

  it('失败槽位补偿不会覆盖成功槽位或静默忽略错误索引，部分写入事务回滚', () => {
    const repository=setup();
    const draft=repository.createPatternDraft({ name:'draft',composeType:'PLACEMENT',conditions:{} });
    const { batch }=repository.createDraftBatch({ draftId:draft.id,operation:'GENERATE',parentCandidateId:null,providerId:null,imageModelId:null,candidateCount:2,instruction:null,snapshot:{},clientKey:'batch' });
    repository.updateDraftSlot(batch.id,1,{ status:'FAILED' });
    repository.updateDraftSlot(batch.id,2,{ status:'SUCCEEDED' });
    expect(() => repository.assignDraftSlotsToJob(batch.id,[1,2],'retry')).toThrow('Only failed draft slots');
    expect(repository.listDraftSlots(batch.id).map(slot=>[slot.status,slot.attempt])).toEqual([['FAILED',1],['SUCCEEDED',1]]);
    expect(() => repository.assignDraftSlotsToJob(batch.id,[1,3],'retry')).toThrow('Draft slot not found');
    expect(() => repository.assignDraftSlotsToJob(batch.id,[1,1],'retry')).toThrow('Duplicate');
    repository.assignDraftSlotsToJob(batch.id,[1],'retry');
    expect(repository.listDraftSlots(batch.id).map(slot=>[slot.status,slot.attempt])).toEqual([['QUEUED',2],['SUCCEEDED',1]]);
  });
});
