import { createCipheriv } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DESKTOP_SCHEMA_VERSION, migrateDesktopDatabase, openDatabase } from './database.js';
import { EcomRepository } from './repository.js';
import { VERIFIED_FAILURE_TRIGGERS_SQL } from './schema.js';
import { SecretBox } from './secrets.js';
import { LocalAssetStore } from './files.js';

describe('v10 设置升级', () => {
  it('只扩展应用设置，保留任务快照、回执和密钥并可重复迁移', () => {
    const db = track(openDatabase(':memory:'));
    const repo = new EcomRepository(db);
    const provider = repo.saveProvider({ id: 'v10-provider', name: '服务', baseUrl: 'https://fake.invalid', encryptedApiKey: 'ciphertext', reasoningProtocol: 'openai', models: [] });
    repo.createJob({ id: 'v10-job', projectId: null, storyboardItemId: null, type: 'PLAN', input: {}, status: 'UNKNOWN', retryable: false });
    const payload = '{ "snapshot": "old", "receipt": "cipher" }';
    db.prepare('INSERT INTO desktop_job_runtime VALUES(?,?,?)').run('v10-job', payload, 'time');
    db.prepare('INSERT INTO desktop_application_settings VALUES(?,?,?)').run(1, '{"startupPage":"last"}', 'time');
    db.exec("DROP TABLE desktop_suite_planning_batches; DROP TABLE desktop_generation_prompts; ALTER TABLE storyboard_items DROP COLUMN planning_source_json; UPDATE desktop_schema SET version=10,identity='ecomgen-desktop-domain-v10'; PRAGMA user_version=10");
    migrateDesktopDatabase(db); migrateDesktopDatabase(db);
    expect(JSON.parse((db.prepare('SELECT settings_json FROM desktop_application_settings').get() as {settings_json:string}).settings_json)).toEqual({ startupPage: 'last', ai: {requestTimeoutSeconds:240,thinkingLevel:'auto',maxOutputTokens:16384,concurrency:2} });
    expect(db.prepare('SELECT payload FROM desktop_job_runtime').get()).toEqual({payload});
    expect(repo.getProvider(provider.id)?.encryptedApiKey).toBe('ciphertext');
    expect(db.pragma('user_version',{simple:true})).toBe(12);
  });
});

describe('v9 中断门禁升级', () => {
  it('保留真实 v9 触发器下的数据并可重复迁移', () => {
    const db = track(openDatabase(':memory:'));
    const repository = new EcomRepository(db);
    repository.createJob({ id:'v9-unknown',projectId:null,storyboardItemId:null,type:'SUITE_FORGE',input:{ frozen:'snapshot' },status:'UNKNOWN',retryable:false });
    const payload = JSON.stringify({version:1,requests:[],requestHistory:[{descriptor:{requestKey:'old'},state:'VERIFIED_FAILED',startedAt:'t'}],reviews:[{requestKey:'old',requestStartedAt:'t',outcome:'FAILED',encryptedEvidence:'cipher',recordedAt:'t'}]});
    db.prepare('INSERT INTO desktop_job_runtime VALUES(?,?,?)').run('v9-unknown',payload,'t');
    db.exec("DROP TRIGGER desktop_unknown_no_retry; DROP TRIGGER desktop_unknown_pipeline_no_retry; DROP TRIGGER desktop_unknown_slot_no_retry;");
    db.exec(VERIFIED_FAILURE_TRIGGERS_SQL);
    db.exec("DROP TABLE desktop_suite_planning_batches; DROP TABLE desktop_generation_prompts; ALTER TABLE storyboard_items DROP COLUMN planning_source_json; UPDATE desktop_schema SET version=9,identity='ecomgen-desktop-domain-v9'; PRAGMA user_version=9;");
    const before = db.prepare('SELECT * FROM jobs WHERE id=?').get('v9-unknown');
    migrateDesktopDatabase(db);
    migrateDesktopDatabase(db);
    expect(db.pragma('user_version',{simple:true})).toBe(12);
    expect(db.prepare('SELECT * FROM jobs WHERE id=?').get('v9-unknown')).toEqual(before);
    expect(db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get('v9-unknown')).toEqual({payload});
  });
});

const connections: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const track = (db: Database.Database) => { connections.push(db); return db; };
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'desktop-core-migration-')); directories.push(path); return path; };
const time = '2026-11-01T12:00:00.000Z';
const master = Buffer.alloc(32, 7);
// 按桌面 v2 的真实 IV + tag + ciphertext 格式构造，不依赖 SecretBox 自身生成。
const cipher = createCipheriv('aes-256-gcm', master, Buffer.alloc(12, 3));
const ciphertext = Buffer.concat([cipher.update('isolated-test-key'), cipher.final()]);
const encrypted = Buffer.concat([Buffer.alloc(12, 3), cipher.getAuthTag(), ciphertext]).toString('base64');
const settingsJson = '{ "category":"杯子", "verifiedFacts":["不锈钢"], "prohibitedClaims":["医疗"], "platformTargets":["TAOBAO"], "promptLanguage":"ENGLISH", "reasoningProviderId":"provider", "imageProviderId":"provider", "defaultMode":"PIXEL_PROTECTED", "imageResolution":"2K", "imageAspectRatio":"3:4", "requestedTypes":["hero-image"], "userInstruction":"原配置留痕" }';
const snapshotJson = '{ "version": 1, "unsafeOldExecutablePayload": true, "assets": [{"file":"assets/flat.png"}] }';

/** 仅声明桌面实际发布过的结构；不执行 legacy 迁移链。 */
function source(version: 1 | 2, filename = ':memory:'): Database.Database {
  const db = track(new Database(filename));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
    CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,protocol TEXT NOT NULL,baseUrl TEXT NOT NULL,model TEXT NOT NULL,encryptedKey TEXT NOT NULL,updatedAt TEXT NOT NULL);
    CREATE TABLE assets(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,mimeType TEXT NOT NULL,size INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,createdAt TEXT NOT NULL,file TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL);
    CREATE INDEX assets_project ON assets(projectId,id);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL CHECK(kind = 'EXPORT'),status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),progress REAL NOT NULL DEFAULT 0,cancelRequested INTEGER NOT NULL DEFAULT 0,error TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,resultName TEXT,fingerprint TEXT NOT NULL,snapshot TEXT NOT NULL);
    CREATE INDEX jobs_queue ON jobs(status,createdAt,id);
    CREATE INDEX jobs_project ON jobs(projectId,createdAt);
    CREATE UNIQUE INDEX jobs_dedupe ON jobs(fingerprint) WHERE status IN ('QUEUED','RUNNING','SUCCEEDED');
  `);
  if (version === 2) db.exec(`
    ALTER TABLE assets ADD COLUMN role TEXT NOT NULL DEFAULT 'STYLE_REFERENCE';
    ALTER TABLE providers ADD COLUMN reasoningProtocol TEXT NOT NULL DEFAULT 'openai';
    ALTER TABLE providers ADD COLUMN supportsVision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE providers ADD COLUMN supportsThinking INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE providers ADD COLUMN supportsStructuredOutput INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE jobs_v2(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL CHECK(kind IN ('EXPORT','PLAN','GENERATE','SEGMENT','LAYER','PATTERN','SUITE','PI_AGENT')),status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','UNKNOWN')),progress REAL NOT NULL DEFAULT 0,cancelRequested INTEGER NOT NULL DEFAULT 0,error TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,resultName TEXT,fingerprint TEXT NOT NULL,snapshot TEXT NOT NULL,requestState TEXT NOT NULL DEFAULT 'NOT_SENT' CHECK(requestState IN ('NOT_SENT','IN_FLIGHT','COMPLETED','UNKNOWN')));
    INSERT INTO jobs_v2(id,projectId,kind,status,progress,cancelRequested,error,createdAt,updatedAt,resultName,fingerprint,snapshot)
      SELECT id,projectId,kind,status,progress,cancelRequested,error,createdAt,updatedAt,resultName,fingerprint,snapshot FROM jobs;
    DROP TABLE jobs;
    ALTER TABLE jobs_v2 RENAME TO jobs;
    CREATE INDEX jobs_queue ON jobs(status,createdAt,id);
    CREATE INDEX jobs_project ON jobs(projectId,createdAt);
    CREATE UNIQUE INDEX jobs_dedupe ON jobs(fingerprint) WHERE status IN ('QUEUED','RUNNING','SUCCEEDED','UNKNOWN');
    CREATE TABLE project_business(projectId TEXT PRIMARY KEY REFERENCES projects(id),settings TEXT NOT NULL);
    CREATE TABLE storyboards(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),jobId TEXT NOT NULL UNIQUE REFERENCES jobs(id),version INTEGER NOT NULL,confirmed INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,UNIQUE(projectId,version));
    CREATE TABLE job_results(jobId TEXT PRIMARY KEY REFERENCES jobs(id),data TEXT NOT NULL);
  `);
  db.pragma(`user_version = ${version}`);
  db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run('project', '杯子', '原始商品描述', time, time);
  db.prepare('INSERT INTO providers(id,name,protocol,baseUrl,model,encryptedKey,updatedAt) VALUES(?,?,?,?,?,?,?)').run('provider', '测试', 'GEMINI', 'https://fake.invalid', 'original-model', encrypted, time);
  db.prepare('INSERT INTO assets(id,projectId,name,mimeType,size,width,height,createdAt,file,sha256) VALUES(?,?,?,?,?,?,?,?,?,?)').run('asset', 'project', 'flat.png', 'image/png', 13, 3, 4, time, 'assets/flat.png', 'original-hash');
  addJob(db, 'export', 'EXPORT', 'SUCCEEDED', 'NOT_SENT', '导出.zip');
  if (version === 2) {
    db.prepare('UPDATE providers SET reasoningProtocol=?,supportsVision=1,supportsThinking=1,supportsStructuredOutput=1').run('openai_responses');
    db.prepare("UPDATE assets SET role='PRODUCT_TRUTH'").run();
    db.prepare('INSERT INTO project_business VALUES(?,?)').run('project', settingsJson);
    for (const [id, kind, status, request] of [
      ['plan1','PLAN','SUCCEEDED','COMPLETED'], ['plan2','PI_AGENT','SUCCEEDED','COMPLETED'],
      ['unknown','GENERATE','UNKNOWN','UNKNOWN'], ['inflight','SEGMENT','RUNNING','IN_FLIGHT'],
      ['queued','SUITE','QUEUED','NOT_SENT'], ['local','PATTERN','RUNNING','NOT_SENT'], ['layer','LAYER','SUCCEEDED','NOT_SENT'],
    ]) addJob(db, id!, kind!, status!, request!, id === 'layer' ? '图层.psd' : null);
    for (const version of [1,2]) {
      const plan = { id: `board${version}`, projectId: 'project', jobId: `plan${version}`, version, confirmed: version === 2, campaignStyleLock: `style-${version}`, items: [{ id: `item${version}`, assetType: 'hero-image', displayName: '首图', shotRole: 'HERO', candidateCount: 2, referencedAssets: ['asset'], mode: 'PIXEL_PROTECTED', promptInstruction: 'original prompt', factClaims: ['不锈钢'], riskFlags: [], sortOrder: 0 }] };
      db.prepare('INSERT INTO storyboards VALUES(?,?,?,?,?,?)').run(plan.id, plan.projectId, plan.jobId, version, plan.confirmed ? 1 : 0, JSON.stringify(plan));
    }
    db.prepare('INSERT INTO job_results VALUES(?,?)').run('layer', '{ "assetIds":["asset"], "artifactName":"图层.psd" }');
  }
  return db;
}
function addJob(db: Database.Database, id: string, kind: string, status: string, requestState: string, resultName: string | null = null): void {
  db.prepare('INSERT INTO jobs(id,projectId,kind,status,progress,createdAt,updatedAt,resultName,fingerprint,snapshot) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, 'project', kind, status, 37, time, time, resultName, `fp-${id}`, snapshotJson);
  if (Number(db.pragma('user_version', { simple: true })) === 2) db.prepare('UPDATE jobs SET requestState=? WHERE id=?').run(requestState, id);
}
function assertHealthy(db: Database.Database): void {
  expect(db.pragma('user_version', { simple: true })).toBe(DESKTOP_SCHEMA_VERSION);
  expect(db.prepare('SELECT * FROM desktop_schema').all()).toEqual([{ version:12,identity:'ecomgen-desktop-domain-v12' }]);
  for (const table of ['desktop_application_settings', 'desktop_model_pricing', 'desktop_usage_records', 'desktop_usage_recovery']) expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).toEqual({ name: table });
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
}

describe('desktop canonical schema migration', () => {
  it('空库同事务创建全部领域表和三个冻结运行表，重复迁移无变化', () => {
    const db = track(openDatabase(':memory:'));
    assertHealthy(db);
    const schema = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
    for (const table of ['desktop_job_runtime','desktop_resources','desktop_cleanup_queue']) expect(db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?').get(table)).toEqual({ name: table });
    migrateDesktopDatabase(db);
    expect(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()).toEqual(schema);
  });

  it('v1 保留所有 ID、密文字节、原始输入/指纹与平铺文件引用，旧队列不可执行', () => {
    const db = source(1);
    addJob(db, 'pending', 'EXPORT', 'QUEUED', 'NOT_SENT');
    migrateDesktopDatabase(db);
    const repository = new EcomRepository(db);
    assertHealthy(db);
    expect(repository.getProject('project')).toMatchObject({ id: 'project', productDescription: '原始商品描述', createdAt: time });
    expect(repository.getProvider('provider')).toMatchObject({ encryptedApiKey: encrypted, models: [{ id: 'original-model', imageApiKind: 'gemini' }] });
    expect(new SecretBox(master).decrypt(repository.getProvider('provider')!.encryptedApiKey)).toBe('isolated-test-key');
    expect(repository.getAsset('asset')).toMatchObject({ storagePath: 'assets/flat.png', role: 'STYLE_REFERENCE' });
    expect(db.prepare("SELECT byte_size FROM assets WHERE id='asset'").get()).toEqual({ byte_size: 13 });
    expect(repository.getJob('pending')).toMatchObject({ status: 'CANCELLED', preservedHistory: true, retryable: false, requestFingerprint: 'fp-pending' });
    expect(repository.getPreservedJobHistory('export')).toMatchObject({ snapshotJson, artifactPath: 'exports/export.zip', resultName: '导出.zip', originalStatus: 'SUCCEEDED' });
    expect(() => repository.updateJob('pending', { status: 'QUEUED' })).toThrow('Preserved desktop history');
    expect(() => db.prepare("UPDATE jobs SET preserved_history=0 WHERE id='pending'").run()).toThrow('Preserved desktop history');
    expect(() => db.prepare("UPDATE jobs SET input_json='{}' WHERE id='export'").run()).toThrow('Preserved desktop history');
    expect(repository.recoverInterruptedJobs()).toEqual([]);
  });

  it('v2 完整保留配置/能力/角色、两个分镜版本、结果及 UNKNOWN，重开不改原数据', async () => {
    const root = directory();
    mkdirSync(join(root,'assets')); mkdirSync(join(root,'exports'));
    writeFileSync(join(root,'assets','flat.png'), 'flat-original');
    writeFileSync(join(root,'exports','layer.psd'), 'original-psd');
    const filename = join(root,'data.sqlite');
    const db = source(2, filename);
    const boards = db.prepare('SELECT data FROM storyboards ORDER BY version DESC').all();
    migrateDesktopDatabase(db);
    assertHealthy(db);
    const repository = new EcomRepository(db);
    expect(repository.getPreservedProjectHistory('project')).toMatchObject({ settingsJson });
    expect(repository.getProject('project')).toMatchObject({ category: '杯子', verifiedFacts: ['不锈钢'], prohibitedClaims: ['医疗'], platformTargets: ['TAOBAO'], promptLanguage: 'ENGLISH', imageModelId: 'original-model', defaultMode: 'PIXEL_PROTECTED' });
    expect(repository.getProvider('provider')).toMatchObject({ encryptedApiKey: encrypted, reasoningProtocol: 'openai_responses', models: [{ id: 'original-model', supportsVision: true, supportsThinking: true, supportsStructuredOutput: true }] });
    expect(repository.getAsset('asset')).toMatchObject({ id: 'asset', role: 'PRODUCT_TRUTH', storagePath: 'assets/flat.png' });
    expect(repository.listStoryboardVersions('project').map(row => ({ data: row.dataJson }))).toEqual(boards);
    expect(repository.getStoryboard('project')).toMatchObject({ version: 2, status: 'CONFIRMED' });
    expect(repository.listStoryboardItems('project').map(item => item.id)).toEqual(['item1','item2']);
    expect(repository.getPreservedJobHistory('layer')).toMatchObject({ snapshotJson, resultJson: '{ "assetIds":["asset"], "artifactName":"图层.psd" }', artifactPath: 'exports/layer.psd' });
    for (const id of ['unknown','inflight']) {
      expect(repository.getJob(id)).toMatchObject({ status: 'UNKNOWN', retryable: false, preservedHistory: true });
      expect(repository.findJobByFingerprint('project', `fp-${id}`)?.id).toBe(id);
      expect(() => repository.updateJob(id, { status: 'QUEUED', retryable: true })).toThrow();
    }
    expect(repository.getJob('queued')?.status).toBe('CANCELLED');
    const store = new LocalAssetStore(root);
    await store.initialize();
    expect((await store.read(repository.getAsset('asset')!.storagePath)).toString()).toBe('flat-original');
    expect((await store.read(repository.getPreservedJobHistory('layer')!.artifactPath!)).toString()).toBe('original-psd');
    const before = db.prepare('SELECT * FROM desktop_job_history ORDER BY job_id').all();
    db.close();
    const reopened = track(openDatabase(filename));
    expect(reopened.prepare('SELECT * FROM desktop_job_history ORDER BY job_id').all()).toEqual(before);
    expect(readFileSync(join(root,'assets','flat.png'),'utf8')).toBe('flat-original');
    assertHealthy(reopened);
  });

  it.each([
    { missing: ['reasoningProviderId'] },
    { missing: ['imageProviderId'] },
    { missing: ['reasoningProviderId', 'imageProviderId'] },
  ])('v2 删除 Provider 后清空失效选择并完整保留原配置：$missing', ({ missing }) => {
    const db = source(2);
    db.prepare('INSERT INTO providers SELECT ?,name,protocol,baseUrl,model,encryptedKey,updatedAt,reasoningProtocol,supportsVision,supportsThinking,supportsStructuredOutput FROM providers WHERE id=?').run('survivor', 'provider');
    let raw = settingsJson;
    for (const field of ['reasoningProviderId', 'imageProviderId']) {
      if (!missing.includes(field)) raw = raw.replace(`"${field}":"provider"`, `"${field}":"survivor"`);
    }
    db.prepare('UPDATE project_business SET settings=?').run(raw);
    // 发布版 providers.delete 只删除这一行，既不改 settings 也不改分镜。
    db.prepare('DELETE FROM providers WHERE id=?').run('provider');
    const boards = db.prepare('SELECT data FROM storyboards ORDER BY version DESC').all();
    const jobs = db.prepare('SELECT * FROM jobs ORDER BY id').all();
    migrateDesktopDatabase(db);
    const repository = new EcomRepository(db);
    assertHealthy(db);
    expect(repository.getProject('project')).toMatchObject({
      reasoningProviderId: missing.includes('reasoningProviderId') ? null : 'survivor',
      reasoningModelId: missing.includes('reasoningProviderId') ? null : 'original-model',
      imageProviderId: missing.includes('imageProviderId') ? null : 'survivor',
      imageModelId: missing.includes('imageProviderId') ? null : 'original-model',
    });
    expect(repository.getPreservedProjectHistory('project')?.settingsJson).toBe(raw);
    expect(repository.listProviders().map(provider => provider.id)).toEqual(['survivor']);
    expect(repository.getProvider('survivor')).toMatchObject({ encryptedApiKey: encrypted, models: [{ id: 'original-model' }] });
    expect(repository.listStoryboardVersions('project').map(row => ({ data: row.dataJson }))).toEqual(boards);
    for (const item of repository.listStoryboardItems('project')) expect(item).toMatchObject({
      imageProviderId: missing.includes('imageProviderId') ? null : 'survivor',
      imageModelId: missing.includes('imageProviderId') ? null : 'original-model',
    });
    expect(db.prepare('SELECT original_job_json FROM desktop_job_history ORDER BY job_id').all()).toEqual(jobs.map(job => ({ original_job_json: JSON.stringify(job) })));
    const before = db.prepare('SELECT * FROM desktop_project_history').all();
    migrateDesktopDatabase(db);
    expect(db.prepare('SELECT * FROM desktop_project_history').all()).toEqual(before);
  });

  it.each(['PLAN', 'PI_AGENT', 'GENERATE', 'SEGMENT', 'SUITE'])('v2 外部 %s 的 RUNNING/NOT_SENT 可确认未发送，未知窗口仍受保护且保留原请求状态', kind => {
    const db = source(2);
    const cases = [
      { id: 'not-sent', status: 'RUNNING', requestState: 'NOT_SENT', expected: 'CANCELLED' },
      { id: 'sent', status: 'RUNNING', requestState: 'IN_FLIGHT', expected: 'UNKNOWN' },
      { id: 'request-unknown', status: 'RUNNING', requestState: 'UNKNOWN', expected: 'UNKNOWN' },
      { id: 'ambiguous', status: 'RUNNING', requestState: 'COMPLETED', expected: 'UNKNOWN' },
      { id: 'status-unknown', status: 'UNKNOWN', requestState: 'NOT_SENT', expected: 'UNKNOWN' },
    ];
    for (const row of cases) addJob(db, row.id, kind, row.status, row.requestState);
    db.prepare('UPDATE jobs SET cancelRequested=1,error=? WHERE id IN (?,?,?,?,?)').run('原始错误', ...cases.map(row => row.id));
    const originals = new Map(cases.map(row => [row.id, db.prepare('SELECT * FROM jobs WHERE id=?').get(row.id)]));
    migrateDesktopDatabase(db);
    assertHealthy(db);
    const repository = new EcomRepository(db);
    for (const row of cases) {
      expect(repository.getJob(row.id)).toMatchObject({ status: row.expected, preservedHistory: true, retryable: false, input: JSON.parse(snapshotJson), requestFingerprint: `fp-${row.id}`, cancelRequested: true });
      expect(db.prepare('SELECT provider_task_id FROM jobs WHERE id=?').get(row.id)).toEqual({ provider_task_id: row.expected === 'UNKNOWN' ? '__EXTERNAL_REQUEST_STARTED__' : null });
      expect(db.prepare('SELECT request_state,original_status,snapshot_json,original_error,original_job_json FROM desktop_job_history WHERE job_id=?').get(row.id)).toEqual({
        request_state: row.requestState, original_status: row.status, snapshot_json: snapshotJson, original_error: '原始错误', original_job_json: JSON.stringify(originals.get(row.id)),
      });
      expect(() => repository.updateJob(row.id, { status: 'QUEUED', retryable: true })).toThrow();
      expect(() => db.prepare('UPDATE jobs SET preserved_history=0 WHERE id=?').run(row.id)).toThrow();
    }
    expect(repository.recoverInterruptedJobs()).toEqual([]);
  });

  it.each(['../outside.png','assets/../../outside.png','C:/private/key','assets/key:stream','assets\\escape.png'])('不安全旧引用 %s 在已写入项目/Provider 后触发整体回滚', unsafe => {
    const db = source(2);
    db.prepare('UPDATE assets SET file=?').run(unsafe);
    const schemaBefore = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
    const jobsBefore = db.prepare('SELECT * FROM jobs ORDER BY id').all();
    expect(() => migrateDesktopDatabase(db)).toThrow('Unsafe managed file reference');
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()).toEqual(schemaBefore);
    expect(db.prepare('SELECT * FROM jobs ORDER BY id').all()).toEqual(jobsBefore);
    expect(db.prepare('SELECT encryptedKey FROM providers').get()).toEqual({ encryptedKey: encrypted });
  });

  it('迁移后的新规划追加版本且确认只更新 v3 快照，旧分镜原文保持不变', () => {
    const db=source(2); migrateDesktopDatabase(db);
    const repository=new EcomRepository(db);
    const history=repository.listStoryboardVersions('project');
    const item=repository.listStoryboardItems('project')[1]!;
    const current=repository.saveStoryboard('project','new-style','DRAFT',[{ ...item,status:'DRAFT' }]);
    expect(current.version).toBe(3);
    expect(repository.listStoryboardVersions('project').slice(1)).toEqual(history);
    repository.confirmStoryboard('project');
    const versions=repository.listStoryboardVersions('project');
    expect(versions[0]).toMatchObject({ version:3,sourceVersion:3,confirmed:true });
    expect(JSON.parse(versions[0]!.dataJson).items[0]).toMatchObject({ status:'CONFIRMED',promptInstruction:item.promptInstruction });
    expect(versions.slice(1)).toEqual(history);
    assertHealthy(db);
  });

  it('分镜复制中途 ID 冲突回滚 DDL、原始历史与版本，修复源数据后可再次升级', () => {
    const db = source(2);
    db.prepare('DELETE FROM providers WHERE id=?').run('provider');
    addJob(db, 'preparation', 'GENERATE', 'RUNNING', 'NOT_SENT');
    const row = db.prepare("SELECT data FROM storyboards WHERE id='board2'").get() as { data: string };
    const invalid = JSON.parse(row.data); invalid.items[0].id='item1';
    db.prepare("UPDATE storyboards SET data=? WHERE id='board2'").run(JSON.stringify(invalid));
    const schemaBefore = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
    const jobsBefore = db.prepare('SELECT * FROM jobs ORDER BY id').all();
    expect(() => migrateDesktopDatabase(db)).toThrow('UNIQUE');
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()).toEqual(schemaBefore);
    expect(db.prepare('SELECT * FROM jobs ORDER BY id').all()).toEqual(jobsBefore);
    expect(db.prepare('SELECT settings FROM project_business').get()).toEqual({ settings: settingsJson });
    expect(db.prepare('SELECT COUNT(*) AS n FROM storyboards').get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '__desktop_source_%'").all()).toEqual([]);
    db.prepare("UPDATE storyboards SET data=? WHERE id='board2'").run(row.data);
    migrateDesktopDatabase(db); assertHealthy(db);
    expect(new EcomRepository(db).getJob('preparation')).toMatchObject({ status: 'CANCELLED', retryable: false, preservedHistory: true });
    expect(new EcomRepository(db).getPreservedProjectHistory('project')?.settingsJson).toBe(settingsJson);
  });

  it('拒绝未知版本、无标识非空库、伪装 v2 结构与带可执行触发器的源库', () => {
    const future = track(new Database(':memory:')); future.pragma('user_version=42');
    expect(() => migrateDesktopDatabase(future)).toThrow('Unsupported desktop database version');
    const web = track(new Database(':memory:')); web.exec('CREATE TABLE projects(id TEXT)');
    expect(() => migrateDesktopDatabase(web)).toThrow('Unversioned');
    const unexpected = source(2); unexpected.exec('ALTER TABLE jobs ADD COLUMN execution TEXT');
    expect(() => migrateDesktopDatabase(unexpected)).toThrow('Not a supported desktop');
    const trigger = source(1); trigger.exec("CREATE TRIGGER unexpected AFTER UPDATE ON projects BEGIN SELECT RAISE(ABORT,'not desktop'); END");
    expect(() => migrateDesktopDatabase(trigger)).toThrow('Unsupported executable');
  });

  it('v3 跨聚合结果与三个运行表可在同一事务提交或回滚，重开保留 payload 原字节', () => {
    const filename=join(directory(),'current.sqlite');
    const db=track(openDatabase(filename)); const repository=new EcomRepository(db);
    const job = { id: 'new-job', projectId: null, storyboardItemId: null, type: 'SUITE_FORGE' as const, input: { immutable: 'snapshot' } };
    const payload='{ "snapshot":{"original":"immutable"}, "requests":[] }';
    expect(() => repository.transaction(() => {
      repository.createJob(job);
      db.prepare('INSERT INTO desktop_job_runtime VALUES(?,?,?)').run(job.id,payload,time);
      db.prepare('INSERT INTO desktop_resources VALUES(?,?,?)').run('resource','{}',time);
      db.prepare('INSERT INTO desktop_cleanup_queue VALUES(?,?,?)').run('cleanup','{}',time);
      throw Error('injected settlement failure');
    })).toThrow('injected settlement failure');
    expect(repository.getJob(job.id)).toBeUndefined();
    for(const table of ['desktop_job_runtime','desktop_resources','desktop_cleanup_queue']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    repository.transaction(() => {
      repository.createJob(job);
      db.prepare('INSERT INTO desktop_job_runtime VALUES(?,?,?)').run(job.id,payload,time);
      db.prepare('INSERT INTO desktop_resources VALUES(?,?,?)').run('resource','{}',time);
      db.prepare('INSERT INTO desktop_cleanup_queue VALUES(?,?,?)').run('cleanup','{}',time);
    });
    db.close(); const reopened=track(openDatabase(filename));
    expect(reopened.prepare('SELECT payload FROM desktop_job_runtime').get()).toEqual({ payload });
    expect(new EcomRepository(reopened).getJob(job.id)).toMatchObject({ input: job.input, preservedHistory: false });
    assertHealthy(reopened);
  });
});
