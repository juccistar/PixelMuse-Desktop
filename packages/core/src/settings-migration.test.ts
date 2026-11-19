import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { USAGE_RECOVERY_SQL } from './schema.js';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDesktopDatabase, openDatabase } from './database.js';
import { EcomRepository } from './repository.js';

const connections: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const added = ['desktop_application_settings', 'desktop_model_pricing', 'desktop_usage_records', 'desktop_usage_recovery'];
function source(version: 3 | 4 | 5, filename = ':memory:') {
  const db = openDatabase(filename); connections.push(db);
  db.exec('DROP TABLE desktop_project_workbench; DROP TABLE desktop_project_image_planning; ALTER TABLE storyboard_items DROP COLUMN image_planning_json; ALTER TABLE storyboard_items DROP COLUMN planning_stale; ALTER TABLE storyboard_items DROP COLUMN planning_superseded');
  const r = new EcomRepository(db);
  const provider = r.saveProvider({ id: 'original-provider', name: '服务', baseUrl: 'https://fake.invalid/v1', encryptedApiKey: 'unchanged-ciphertext', reasoningProtocol: 'openai_responses', models: [{ id: 'original-model', supportsVision: true, supportsThinking: true, supportsTools: true, supportsStructuredOutput: true }] });
  db.prepare(`INSERT INTO projects(id,name,platform_targets_json,default_mode,reasoning_provider_id,reasoning_model_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run('original-project','原项目','["TAOBAO"]','PIXEL_PROTECTED',provider.id,'original-model','original-time','original-time');
  db.prepare('INSERT INTO assets(id,project_id,role,storage_path,hash,original_name,mime_type,created_at) VALUES(?,?,?,?,?,?,?,?)').run('original-asset','original-project','PRODUCT_TRUTH','assets/original.png','original-hash','原图.png','image/png','original-time');
  const job = r.createJob({ id: 'original-job', projectId: 'original-project', storyboardItemId: null, type: 'PLAN', status: 'UNKNOWN', input: { private: 'original input' }, requestFingerprint: 'original-fingerprint', providerId: provider.id, modelId: 'original-model', retryable: false });
  db.prepare('INSERT INTO desktop_job_runtime VALUES(?,?,?)').run(job.id,'{ "encryptedReceipt": "preserve-byte-for-byte" }','original-time');
  db.prepare('INSERT INTO desktop_resources VALUES(?,?,?)').run('original-resource','{ "resource": "original" }','original-time');
  db.prepare('INSERT INTO desktop_cleanup_queue VALUES(?,?,?)').run('original-cleanup','{ "resource": "original" }','original-time');
  db.prepare('INSERT INTO desktop_provider_history VALUES(?,?,?)').run(provider.id,2,'{ "original": "provider history" }');
  db.prepare('INSERT INTO desktop_project_history VALUES(?,?,?,?)').run('original-project',2,'{ "original": "project history" }','{ "original": "settings" }');
  db.prepare(`INSERT INTO desktop_job_history(job_id,source_version,kind,original_status,request_state,snapshot_json,original_job_json,migration_note) VALUES(?,?,?,?,?,?,?,?)`).run(job.id,2,'PLAN','UNKNOWN','UNKNOWN','{ "snapshot": "original" }','{ "original": "job" }','原始记录');
  if (version >= 4) db.prepare('INSERT INTO desktop_asset_provenance VALUES(?,?,?,?,?)').run('original-asset','网页','https://fake.invalid/item','原来源','original-time');
  else db.exec('DROP TABLE desktop_asset_provenance');
  for (const table of version < 5 ? added : ['desktop_usage_recovery']) db.exec(`DROP TABLE ${table}`);
  if (version === 5) {
    db.prepare('INSERT INTO desktop_application_settings VALUES(?,?,?)').run(1,'{ "defaults": "original", "zoom": 1.25 }','original-settings-time');
    db.prepare('INSERT INTO desktop_model_pricing VALUES(?,?,?)').run(provider.id,'original-model','{ "currency": "CNY", "inputPerMillion": 0.123 }');
    db.prepare('INSERT INTO desktop_usage_records VALUES(?,?,?,?,?)').run('original-usage',job.id,'original-request','{ "frozenPrice": 0.456, "receipt": "original" }','original-usage-time');
  }
  db.exec('DROP TABLE desktop_suite_planning_batches; DROP TABLE desktop_generation_prompts; ALTER TABLE storyboard_items DROP COLUMN planning_source_json');
  db.prepare('UPDATE desktop_schema SET version=?,identity=?').run(version,`ecomgen-desktop-domain-v${version}`);
  db.pragma(`user_version=${version}`);
  return db;
}
function snapshot(db: Database.Database) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'desktop_schema' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
describe('v6 settings, usage and recovery explicit migration', () => {
  it.each([3,4] as const)('retains every existing v%s row, encrypted key, immutable request and history byte', version => {
    const db = source(version); const before = snapshot(db);
    migrateDesktopDatabase(db);
    expect(db.pragma('user_version',{simple:true})).toBe(12);
    expect(db.prepare('SELECT * FROM desktop_schema').all()).toEqual([{version:12,identity:'ecomgen-desktop-domain-v12'}]);
    for (const [table, rows] of Object.entries(before)) expect(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),table).toEqual(rows);
    for (const table of added) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    expect(db.pragma('integrity_check',{simple:true})).toBe('ok'); expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(() => db.prepare("UPDATE jobs SET status='QUEUED',retryable=1 WHERE id='original-job'").run()).toThrow('Unknown');
    const migrated = snapshot(db); migrateDesktopDatabase(db); expect(snapshot(db)).toEqual(migrated);
  });
  it.each(added)('rolls back all DDL and v4 identity when %s already conflicts', table => {
    const db = source(4); db.exec(`CREATE TABLE ${table}(conflict TEXT)`);
    const before = snapshot(db); const schema = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
    expect(() => migrateDesktopDatabase(db)).toThrow();
    expect(snapshot(db)).toEqual(before); expect(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
    expect(db.pragma('user_version',{simple:true})).toBe(4);
    expect(db.prepare('SELECT * FROM desktop_schema').all()).toEqual([{version:4,identity:'ecomgen-desktop-domain-v4'}]);
  });
  it('enforces singleton settings and idempotent request identities without cascading usage or pricing deletion', () => {
    const db = source(4); migrateDesktopDatabase(db);
    expect(() => db.prepare('INSERT INTO desktop_application_settings VALUES(?,?,?)').run(2,'{}','time')).toThrow('CHECK');
    db.prepare('INSERT INTO desktop_application_settings VALUES(?,?,?)').run(1,'{ "real": "setting" }','time');
    db.prepare('INSERT INTO desktop_model_pricing VALUES(?,?,?)').run('original-provider','original-model','{ "price": "snapshot" }');
    db.prepare('INSERT INTO desktop_usage_records VALUES(?,?,?,?,?)').run('usage-1','original-job','request-1','{ "original": "usage" }','time');
    expect(() => db.prepare('INSERT INTO desktop_usage_records VALUES(?,?,?,?,?)').run('usage-2','original-job','request-1','{}','time')).toThrow('UNIQUE');
    db.prepare('DELETE FROM projects').run(); new EcomRepository(db).deleteProvider('original-provider');
    expect(db.prepare('SELECT settings_json FROM desktop_application_settings').get()).toEqual({settings_json:'{ "real": "setting" }'});
    expect(db.prepare('SELECT entry_json FROM desktop_usage_records').all()).toEqual([{entry_json:'{ "original": "usage" }'}]);
    expect(db.prepare('SELECT pricing_json FROM desktop_model_pricing').all()).toEqual([{pricing_json:'{ "price": "snapshot" }'}]);
  });
  it.each(added)('rejects an incomplete v6 %s on reopen', table => {
    const db = openDatabase(':memory:'); connections.push(db); db.exec(`DROP TABLE ${table}`);
    expect(() => migrateDesktopDatabase(db)).toThrow('Incomplete');
  });
  it.each(['bare', 'runtime', 'constrained'] as const)('upgrades a real v5 %s file, retains all settings, prices, usage and optional cursor rows across reopen', variant => {
    const directory = mkdtempSync(join(tmpdir(), 'desktop-v5-recovery-')); directories.push(directory);
    const filename = join(directory, 'isolated.sqlite');
    const db = source(5, filename);
    if (variant === 'runtime') db.exec('CREATE TABLE desktop_usage_recovery (lane TEXT PRIMARY KEY, runtime_rowid INTEGER NOT NULL, request_offset INTEGER NOT NULL)');
    if (variant === 'constrained') db.exec(`CREATE TABLE desktop_usage_recovery (
      lane TEXT PRIMARY KEY CHECK(lane IN ('pending','history')),
      runtime_rowid INTEGER NOT NULL CHECK(runtime_rowid>=0),
      request_offset INTEGER NOT NULL CHECK(request_offset>=0)
    )`);
    if (variant !== 'bare') db.exec("INSERT INTO desktop_usage_recovery VALUES('pending',31,7),('history',63,201)");
    const before = snapshot(db);
    before.desktop_application_settings = [{ singleton: 1, settings_json: JSON.stringify({ defaults: 'original', zoom: 1.25, ai: { requestTimeoutSeconds: 240, thinkingLevel: 'auto', maxOutputTokens: 16384, concurrency: 2 } }), updated_at: 'original-settings-time' }];
    db.close();
    const migrated = openDatabase(filename); connections.push(migrated);
    expect(migrated.pragma('user_version',{simple:true})).toBe(12);
    expect(migrated.prepare('SELECT * FROM desktop_schema').all()).toEqual([{version:12,identity:'ecomgen-desktop-domain-v12'}]);
    for (const [table, rows] of Object.entries(before)) expect(migrated.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),table).toEqual(rows);
    if (variant === 'bare') expect(migrated.prepare('SELECT * FROM desktop_usage_recovery').all()).toEqual([]);
    expect(migrated.prepare("SELECT sql FROM sqlite_master WHERE name='desktop_usage_recovery'").get()).toEqual({sql:USAGE_RECOVERY_SQL.trim().replace(/;$/, '')});
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE name LIKE '__desktop_v5_%'").all()).toEqual([]);
    expect(() => migrated.prepare("UPDATE jobs SET status='QUEUED',retryable=1 WHERE id='original-job'").run()).toThrow('Unknown');
    expect(migrated.pragma('integrity_check',{simple:true})).toBe('ok'); expect(migrated.pragma('foreign_key_check')).toEqual([]);
    const after = snapshot(migrated); const schema = migrated.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(); migrated.close();
    const reopened = openDatabase(filename); connections.push(reopened);
    expect(snapshot(reopened)).toEqual(after);
    expect(reopened.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
    for (const values of [['other',0,0],['pending',-1,0],['history',0,-1]]) {
      expect(() => reopened.prepare('INSERT OR REPLACE INTO desktop_usage_recovery VALUES(?,?,?)').run(...values)).toThrow('CHECK');
    }
  });
  it('copies full 64-bit historical cursors inside SQLite without JavaScript rounding', () => {
    const db = source(5);
    db.exec("CREATE TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY,runtime_rowid INTEGER NOT NULL,request_offset INTEGER NOT NULL); INSERT INTO desktop_usage_recovery VALUES('history',9223372036854775807,9007199254740993)");
    const query = 'SELECT lane,CAST(runtime_rowid AS TEXT) runtime_rowid,CAST(request_offset AS TEXT) request_offset FROM desktop_usage_recovery';
    const before = db.prepare(query).all(); migrateDesktopDatabase(db);
    expect(db.prepare(query).all()).toEqual(before);
  });
  it.each([
    ['missing column', 'CREATE TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY,runtime_rowid INTEGER NOT NULL)'],
    ['extra column', 'CREATE TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY,runtime_rowid INTEGER NOT NULL,request_offset INTEGER NOT NULL,extra TEXT)'],
    ['wrong column type', 'CREATE TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY,runtime_rowid TEXT NOT NULL,request_offset INTEGER NOT NULL)'],
    ['nullable cursor', 'CREATE TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY,runtime_rowid INTEGER,request_offset INTEGER NOT NULL)'],
    ['missing primary key', 'CREATE TABLE desktop_usage_recovery(lane TEXT,runtime_rowid INTEGER NOT NULL,request_offset INTEGER NOT NULL)'],
    ['reordered columns', 'CREATE TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY,request_offset INTEGER NOT NULL,runtime_rowid INTEGER NOT NULL)'],
    ['generated extra column', 'CREATE TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY,runtime_rowid INTEGER NOT NULL,request_offset INTEGER NOT NULL,extra INTEGER GENERATED ALWAYS AS (runtime_rowid))'],
    ['unexpected default', 'CREATE TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY,runtime_rowid INTEGER NOT NULL DEFAULT 0,request_offset INTEGER NOT NULL)'],
    ['unexpected check', "CREATE TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY CHECK(lane='history'),runtime_rowid INTEGER NOT NULL,request_offset INTEGER NOT NULL)"],
    ['altered check literal', "CREATE TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY CHECK(lane IN ('pend ing','history')),runtime_rowid INTEGER NOT NULL CHECK(runtime_rowid>=0),request_offset INTEGER NOT NULL CHECK(request_offset>=0))"],
    ['altered check case', "CREATE TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY CHECK(lane IN ('PENDING','history')),runtime_rowid INTEGER NOT NULL CHECK(runtime_rowid>=0),request_offset INTEGER NOT NULL CHECK(request_offset>=0))"],
    ['view conflict', "CREATE VIEW desktop_usage_recovery AS SELECT 'history' lane,0 runtime_rowid,0 request_offset"],
    ['temporary table conflict', 'CREATE TEMP TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY,runtime_rowid INTEGER NOT NULL,request_offset INTEGER NOT NULL)'],
  ])('rejects v5 %s without changing any row, schema object, identity or version', (_name, ddl) => {
    const db = source(5); db.exec(ddl);
    const before = snapshot(db); const schema = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
    expect(() => migrateDesktopDatabase(db)).toThrow('Malformed v5');
    expect(snapshot(db)).toEqual(before); expect(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
    expect(db.pragma('user_version',{simple:true})).toBe(5);
    expect(db.prepare('SELECT * FROM desktop_schema').all()).toEqual([{version:5,identity:'ecomgen-desktop-domain-v5'}]);
  });
  it.each([
    ['attached trigger', "CREATE TRIGGER recovery_trigger AFTER INSERT ON desktop_usage_recovery BEGIN SELECT 1; END"],
    ['referencing trigger', "CREATE TRIGGER recovery_trigger AFTER UPDATE ON projects BEGIN DELETE FROM desktop_usage_recovery; END"],
    ['temporary trigger', "CREATE TEMP TRIGGER recovery_trigger AFTER INSERT ON main.desktop_usage_recovery BEGIN SELECT 1; END"],
    ['referencing view', 'CREATE VIEW recovery_view AS SELECT * FROM desktop_usage_recovery'],
    ['custom index', 'CREATE INDEX recovery_index ON desktop_usage_recovery(runtime_rowid)'],
    ['incoming foreign key', 'CREATE TABLE recovery_child(lane TEXT REFERENCES desktop_usage_recovery(lane))'],
    ['invalid lane', "INSERT INTO desktop_usage_recovery VALUES('unknown',0,0)"],
    ['null lane', 'INSERT INTO desktop_usage_recovery VALUES(NULL,0,0)'],
    ['negative row cursor', "INSERT INTO desktop_usage_recovery VALUES('pending',-1,0)"],
    ['negative request cursor', "INSERT INTO desktop_usage_recovery VALUES('pending',0,-1)"],
    ['fractional row cursor', "INSERT INTO desktop_usage_recovery VALUES('pending',1.5,0)"],
    ['text request cursor', "INSERT INTO desktop_usage_recovery VALUES('pending',0,'bad')"],
  ])('rejects v5 maintenance %s atomically and retains even malformed records', (_name, ddl) => {
    const db = source(5);
    db.exec("CREATE TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY,runtime_rowid INTEGER NOT NULL,request_offset INTEGER NOT NULL); INSERT INTO desktop_usage_recovery VALUES('history',44,201)");
    db.exec(ddl);
    const before = snapshot(db); const schema = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
    const temporary = db.prepare('SELECT type,name,sql FROM sqlite_temp_master ORDER BY name').all();
    expect(() => migrateDesktopDatabase(db)).toThrow('Malformed v5');
    expect(snapshot(db)).toEqual(before); expect(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
    expect(db.prepare('SELECT type,name,sql FROM sqlite_temp_master ORDER BY name').all()).toEqual(temporary);
    expect(db.pragma('user_version',{simple:true})).toBe(5);
    expect(db.prepare('SELECT * FROM desktop_schema').all()).toEqual([{version:5,identity:'ecomgen-desktop-domain-v5'}]);
  });
  it('rolls back a completed recovery reconstruction when the final identity update fails', () => {
    const db = source(5);
    db.exec("CREATE TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY,runtime_rowid INTEGER NOT NULL,request_offset INTEGER NOT NULL); INSERT INTO desktop_usage_recovery VALUES('history',44,201); CREATE TRIGGER fail_identity BEFORE UPDATE ON desktop_schema BEGIN SELECT RAISE(ABORT,'injected identity failure'); END");
    const before = snapshot(db); const schema = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
    expect(() => migrateDesktopDatabase(db)).toThrow('schema identity triggers');
    expect(snapshot(db)).toEqual(before); expect(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
    expect(db.pragma('user_version',{simple:true})).toBe(5);
    expect(db.prepare('SELECT * FROM desktop_schema').all()).toEqual([{version:5,identity:'ecomgen-desktop-domain-v5'}]);
    db.exec('DROP TRIGGER fail_identity'); migrateDesktopDatabase(db);
    expect(db.pragma('user_version',{simple:true})).toBe(12);
    expect(db.prepare('SELECT * FROM desktop_usage_recovery').all()).toEqual([{lane:'history',runtime_rowid:44,request_offset:201}]);
  });
  it('rolls back reconstruction if a trigger silently ignores the identity update', () => {
    const db = source(5);
    db.exec("CREATE TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY,runtime_rowid INTEGER NOT NULL,request_offset INTEGER NOT NULL); INSERT INTO desktop_usage_recovery VALUES('pending',12,3); CREATE TRIGGER ignore_identity BEFORE UPDATE ON desktop_schema BEGIN SELECT RAISE(IGNORE); END");
    const before = snapshot(db); const schema = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
    expect(() => migrateDesktopDatabase(db)).toThrow('schema identity triggers');
    expect(snapshot(db)).toEqual(before); expect(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
    expect(db.pragma('user_version',{simple:true})).toBe(5);
    expect(db.prepare('SELECT * FROM desktop_schema').all()).toEqual([{version:5,identity:'ecomgen-desktop-domain-v5'}]);
  });
  it.each(['desktop_application_settings','desktop_model_pricing','desktop_usage_records'])('rejects an incomplete historical v5 %s without creating recovery', table => {
    const db = source(5); db.exec(`DROP TABLE ${table}`);
    expect(() => migrateDesktopDatabase(db)).toThrow('Incomplete');
    expect(db.pragma('user_version',{simple:true})).toBe(5);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='desktop_usage_recovery'").get()).toBeUndefined();
  });
  it('rejects AFTER UPDATE identity interference without changing the v5 database', () => {
    const db = source(5);
    db.exec("CREATE TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY,runtime_rowid INTEGER NOT NULL,request_offset INTEGER NOT NULL); INSERT INTO desktop_usage_recovery VALUES('history',44,201); CREATE TRIGGER corrupt_identity AFTER UPDATE ON desktop_schema BEGIN UPDATE desktop_schema SET identity='wrong' WHERE version=NEW.version; END");
    const before = snapshot(db); const schema = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
    expect(() => migrateDesktopDatabase(db)).toThrow('schema identity triggers');
    expect(snapshot(db)).toEqual(before); expect(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
    expect(db.pragma('user_version', { simple: true })).toBe(5);
    expect(db.prepare('SELECT * FROM desktop_schema').all()).toEqual([{ version: 5, identity: 'ecomgen-desktop-domain-v5' }]);
  });
  it('rejects replaced v6 recovery types and missing constraints on reopen', () => {
    const db = openDatabase(':memory:'); connections.push(db);
    db.exec("DROP TABLE desktop_usage_recovery; CREATE TABLE desktop_usage_recovery(lane TEXT,runtime_rowid TEXT,request_offset TEXT); INSERT INTO desktop_usage_recovery VALUES('history','broken','broken')");
    const before = snapshot(db);
    expect(() => migrateDesktopDatabase(db)).toThrow('Malformed v6');
    expect(snapshot(db)).toEqual(before);
    expect(db.pragma('user_version', { simple: true })).toBe(12);
  });
  it('rejects a forged v4 identity without creating settings tables', () => {
    const db = source(4); db.prepare('UPDATE desktop_schema SET identity=?').run('another-application');
    expect(() => migrateDesktopDatabase(db)).toThrow('Unrecognized');
    for (const table of added) expect(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table)).toBeUndefined();
  });
});
