import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDesktopDatabase, openDatabase } from './database.js';
import { EcomRepository } from './repository.js';

const connections: Database.Database[] = [], directories: string[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const track = (db: Database.Database) => { connections.push(db); return db; };
function source(version: 3 | 4 | 5 | 6 | 7 | 8, filename = ':memory:') {
  const db = track(openDatabase(filename)), repository = new EcomRepository(db);
  const provider = repository.saveProvider({ id: 'provider', name: '原服务', baseUrl: 'https://fake.invalid', encryptedApiKey: 'original-ciphertext', reasoningProtocol: 'openai', models: [] });
  db.prepare('INSERT INTO projects(id,name,platform_targets_json,default_mode,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('project', '原商品', '["TAOBAO"]', 'CREATIVE', 'original-time', 'original-time');
  repository.createAsset({ projectId: 'project', role: 'PRODUCT_TRUTH', storagePath: 'assets/original.png', hash: 'original-hash', originalName: '原图片', mimeType: 'image/png', width: 12, height: 12 });
  const job = repository.createJob({ id: 'job', projectId: 'project', storyboardItemId: null, type: 'GENERATE', status: 'UNKNOWN', retryable: false, input: { frozen: '原冻结输入' }, providerId: provider.id, requestFingerprint: 'original-fingerprint' });
  db.prepare('INSERT INTO desktop_job_runtime VALUES(?,?,?)').run(job.id, '{ "receipt": "original bytes" }', 'original-time');
  repository.saveStoryboard('project', '原视觉锁', 'DRAFT', [{ assetType: 'hero-image', displayName: '原分镜', shotRole: null, templateVariant: null, candidateCount: 1, referencedAssets: [], mode: 'CREATIVE', status: 'DRAFT', promptInstruction: '原手工提示词', compiledPrompt: '原编译提示词', factClaims: [], riskFlags: [], sortOrder: 0 }]);
  const item = repository.listStoryboardItems('project')[0]!;
  repository.createOutput({ projectId: 'project', storyboardItemId: item.id, jobId: job.id, candidateIndex: 1, generationSnapshot: null, storagePath: 'outputs/original.png', hash: 'original-output' });
  if (version >= 5) {
    db.prepare('INSERT INTO desktop_usage_records VALUES(?,?,?,?,?)').run('usage', job.id, 'request', '{ "original": "frozen usage" }', 'original-time');
    db.prepare('INSERT INTO desktop_application_settings VALUES(?,?,?)').run(1, '{ "original": "settings" }', 'original-time');
  } else db.exec('DROP TABLE desktop_application_settings; DROP TABLE desktop_model_pricing; DROP TABLE desktop_usage_records');
  if (version === 3) db.exec('DROP TABLE desktop_asset_provenance');
  if (version < 6) db.exec('DROP TABLE desktop_usage_recovery');
  else db.exec("INSERT INTO desktop_usage_recovery VALUES('history',9223372036854775807,9007199254740993),('pending',5,3)");
  if (version < 8) db.exec('DROP TABLE desktop_project_workbench');
  else {
    db.prepare('INSERT INTO desktop_project_workbench VALUES(?,?,?,?,?)').run('project', 1, '["original"]', '["original"]', 'original-time');
    db.exec(`DROP TRIGGER desktop_unknown_no_retry; DROP TRIGGER desktop_unknown_pipeline_no_retry; DROP TRIGGER desktop_unknown_slot_no_retry;
      CREATE TRIGGER desktop_unknown_no_retry BEFORE UPDATE ON jobs
      WHEN OLD.status='UNKNOWN' AND (NEW.status IN ('QUEUED','RUNNING','FAILED','CANCELLED') OR NEW.retryable<>0)
      BEGIN SELECT RAISE(ABORT,'Unknown external outcome requires reconciliation'); END;
      CREATE TRIGGER desktop_unknown_pipeline_no_retry BEFORE UPDATE ON pattern_pipeline_steps
      WHEN (OLD.status='UNKNOWN' OR EXISTS(SELECT 1 FROM jobs WHERE id=OLD.job_id AND status='UNKNOWN'))
      AND (NEW.status IN ('PENDING','QUEUED','RUNNING','FAILED','CANCELLED') OR NEW.job_id IS NOT OLD.job_id)
      BEGIN SELECT RAISE(ABORT,'Unknown pipeline outcome requires reconciliation'); END;
      CREATE TRIGGER desktop_unknown_slot_no_retry BEFORE UPDATE ON draft_slots
      WHEN (OLD.status='UNKNOWN' OR EXISTS(SELECT 1 FROM jobs WHERE id=OLD.job_id AND status='UNKNOWN'))
      AND (NEW.status IN ('QUEUED','RUNNING','FAILED','CANCELLED') OR NEW.job_id IS NOT OLD.job_id OR NEW.attempt<>OLD.attempt)
      BEGIN SELECT RAISE(ABORT,'Unknown draft outcome requires reconciliation'); END;`);
  }
  if (version < 7) db.exec('DROP TABLE desktop_project_image_planning; ALTER TABLE storyboard_items DROP COLUMN image_planning_json; ALTER TABLE storyboard_items DROP COLUMN planning_stale; ALTER TABLE storyboard_items DROP COLUMN planning_superseded');
  db.exec('DROP TABLE desktop_suite_planning_batches; DROP TABLE desktop_generation_prompts; ALTER TABLE storyboard_items DROP COLUMN planning_source_json');
  db.prepare('UPDATE desktop_schema SET version=?,identity=?').run(version, `ecomgen-desktop-domain-v${version}`); db.pragma(`user_version=${version}`);
  return db;
}
function snapshot(db: Database.Database) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'desktop_schema' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, name === 'desktop_usage_recovery'
    ? db.prepare('SELECT lane,CAST(runtime_rowid AS TEXT) runtime_rowid,CAST(request_offset AS TEXT) request_offset FROM desktop_usage_recovery ORDER BY lane').all()
    : db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

describe('additive v8 planning and workbench migration', () => {
  it('upgrades a real v8 schema in place and preserves all rows, ciphertext, receipts and 64-bit cursors across repeated migration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'desktop-v8-v9-')); directories.push(directory);
    const filename = join(directory, 'source.sqlite'), db = source(8, filename);
    const before = snapshot(db);
    before.desktop_suite_planning_batches = []; before.desktop_generation_prompts = [];
    before.storyboard_items = (before.storyboard_items as Record<string, unknown>[]).map(row => ({ ...row, planning_source_json: null }));
    before.desktop_application_settings = [{ singleton: 1, settings_json: JSON.stringify({ original: 'settings', ai: { requestTimeoutSeconds: 240, thinkingLevel: 'auto', maxOutputTokens: 16384, concurrency: 2 } }), updated_at: 'original-time' }];
    const workbenchSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='desktop_project_workbench'").get();
    db.close();
    const upgraded = track(openDatabase(filename));
    expect(upgraded.pragma('user_version', { simple: true })).toBe(12);
    expect(upgraded.prepare('SELECT * FROM desktop_schema').all()).toEqual([{ version:12,identity:'ecomgen-desktop-domain-v12' }]);
    expect(snapshot(upgraded)).toEqual(before);
    expect(upgraded.prepare("SELECT sql FROM sqlite_master WHERE name='desktop_project_workbench'").get()).toEqual(workbenchSql);
    const schema = upgraded.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
    migrateDesktopDatabase(upgraded);
    expect(snapshot(upgraded)).toEqual(before);
    expect(upgraded.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
  });
  it.each([3, 4, 5, 6, 7] as const)('validates the real v%s source shape, preserves every row and reopens without DDL changes', version => {
    const directory = mkdtempSync(join(tmpdir(), 'desktop-planning-v7-')); directories.push(directory);
    const filename = join(directory, 'isolated.sqlite'), db = source(version, filename), before = snapshot(db);
    if (version >= 5) before.desktop_application_settings = [{ singleton: 1, settings_json: JSON.stringify({ original: 'settings', ai: { requestTimeoutSeconds: 240, thinkingLevel: 'auto', maxOutputTokens: 16384, concurrency: 2 } }), updated_at: 'original-time' }];
    const sourceColumns = (db.prepare('PRAGMA table_info(storyboard_items)').all() as { name: string }[]).map(column => column.name);
    const recoverySchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='desktop_usage_recovery'").get(); db.close();
    const upgraded = track(openDatabase(filename)); expect(upgraded.pragma('user_version', { simple: true })).toBe(12);
    expect(upgraded.prepare('SELECT * FROM desktop_schema').all()).toEqual([{ version:12,identity:'ecomgen-desktop-domain-v12' }]);
    const after = snapshot(upgraded);
    for (const [table, rows] of Object.entries(before)) {
      if (table === 'storyboard_items') expect(upgraded.prepare(`SELECT ${sourceColumns.join(',')} FROM storyboard_items ORDER BY rowid`).all()).toEqual(rows);
      else expect(after[table], table).toEqual(rows);
    }
    expect(upgraded.prepare('SELECT image_planning_json,planning_stale,planning_superseded FROM storyboard_items').all()).toEqual([{ image_planning_json: null, planning_stale: 0, planning_superseded: 0 }]);
    expect(new EcomRepository(upgraded).getProjectImagePlanning('project')).toBeUndefined();
    expect(new EcomRepository(upgraded).getProjectWorkbench('project')).toEqual({ projectId: 'project', revision: 0, adoptions: [], detailOrder: [], updatedAt: null });
    if (version >= 6) expect(upgraded.prepare("SELECT sql FROM sqlite_master WHERE name='desktop_usage_recovery'").get()).toEqual(recoverySchema);
    expect(upgraded.pragma('foreign_key_check')).toEqual([]); expect(upgraded.pragma('integrity_check', { simple: true })).toBe('ok');
    const schema = upgraded.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(); upgraded.close();
    const reopened = track(openDatabase(filename)); expect(snapshot(reopened)).toEqual(after);
    expect(reopened.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
    expect(new EcomRepository(reopened).getJob('job')).toMatchObject({ status: 'UNKNOWN', retryable: false, requestFingerprint: 'original-fingerprint' });
  });
  it.each(['table', 'column'] as const)('rolls back the entire v7 upgrade on a conflicting %s', conflict => {
    const db = source(6);
    db.exec(conflict === 'table' ? 'CREATE TABLE desktop_project_image_planning(conflict TEXT)' : 'ALTER TABLE storyboard_items ADD COLUMN planning_stale TEXT');
    const rows = snapshot(db), schema = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
    expect(() => migrateDesktopDatabase(db)).toThrow(); expect(snapshot(db)).toEqual(rows);
    expect(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
    expect(db.pragma('user_version', { simple: true })).toBe(6);
    expect(db.prepare('SELECT * FROM desktop_schema').all()).toEqual([{ version: 6, identity: 'ecomgen-desktop-domain-v6' }]);
  });
  it('rejects malformed v6 recovery before adding any planning schema', () => {
    const db = source(6); db.exec('DROP TABLE desktop_usage_recovery; CREATE TABLE desktop_usage_recovery(lane TEXT PRIMARY KEY,runtime_rowid INTEGER NOT NULL,request_offset INTEGER NOT NULL)');
    const before = snapshot(db); expect(() => migrateDesktopDatabase(db)).toThrow('Malformed v6'); expect(snapshot(db)).toEqual(before);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='desktop_project_image_planning'").get()).toBeUndefined();
    expect(db.pragma('user_version', { simple: true })).toBe(6);
  });
  it.each(['desktop_project_image_planning', 'image_planning_json', 'planning_stale', 'planning_superseded'])('rejects missing v7 %s on reopen', missing => {
    const db = track(openDatabase(':memory:'));
    db.exec(missing === 'desktop_project_image_planning' ? `DROP TABLE ${missing}` : `ALTER TABLE storyboard_items DROP COLUMN ${missing}`);
    expect(() => migrateDesktopDatabase(db)).toThrow('Incomplete'); expect(db.pragma('user_version', { simple: true })).toBe(12);
  });
  it('rolls back a conflicting v7 workbench upgrade without changing existing rows', () => {
    const db = source(7);
    db.exec('CREATE TABLE desktop_project_workbench(conflict TEXT)');
    const before = snapshot(db), schema = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
    expect(() => migrateDesktopDatabase(db)).toThrow();
    expect(snapshot(db)).toEqual(before);
    expect(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
    expect(db.pragma('user_version', { simple: true })).toBe(7);
  });
  it('composes directory and storyboard writes under the repository transaction and rolls back both', () => {
    const db = track(openDatabase(':memory:')), repository = new EcomRepository(db), projectId = randomUUID();
    db.prepare('INSERT INTO projects(id,name,platform_targets_json,default_mode,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(projectId, '项目', '[]', 'CREATIVE', 'time', 'time');
    expect(() => repository.transaction(() => {
      repository.saveProjectImagePlanning({ projectId, revision: 1, updatedAt: '2026-11-07T12:00:00.000Z', config: { mainCount: 1, detailCount: 0, skuImagesPerGroup: 1, shareImages: false }, skus: [], imageGroups: [] });
      throw new Error('rollback');
    })).toThrow('rollback');
    expect(repository.getProjectImagePlanning(projectId)).toBeUndefined();
  });
});
