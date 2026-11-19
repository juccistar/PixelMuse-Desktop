import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { DESKTOP_SCHEMA_VERSION, migrateDesktopDatabase, openDatabase } from './database.js';
const connections: Database.Database[] = [];
afterEach(() => { for (const db of connections.splice(0)) db.close(); });
function v3() {
  const db = openDatabase(':memory:'); connections.push(db);
  db.exec('DROP TABLE desktop_project_workbench; DROP TABLE desktop_project_image_planning; ALTER TABLE storyboard_items DROP COLUMN image_planning_json; ALTER TABLE storyboard_items DROP COLUMN planning_stale; ALTER TABLE storyboard_items DROP COLUMN planning_superseded');
  db.exec('DROP TABLE desktop_suite_planning_batches; DROP TABLE desktop_generation_prompts; ALTER TABLE storyboard_items DROP COLUMN planning_source_json');
  db.exec("DROP TABLE desktop_asset_provenance; DROP TABLE desktop_application_settings; DROP TABLE desktop_model_pricing; DROP TABLE desktop_usage_records; DROP TABLE desktop_usage_recovery; UPDATE desktop_schema SET version=3,identity='ecomgen-desktop-domain-v3'; PRAGMA user_version=3;");
  db.prepare('INSERT INTO projects(id,name,platform_targets_json,default_mode,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('project','原商品','["AMAZON"]','PIXEL_PROTECTED','original-time','original-time');
  db.prepare('INSERT INTO assets(id,project_id,role,storage_path,hash,original_name,mime_type,created_at) VALUES(?,?,?,?,?,?,?,?)').run('asset','project','PRODUCT_TRUTH','assets/original.png','original-hash','原图.png','image/png','original-time');
  return db;
}
describe('explicit v3 to v6 collection provenance, settings and recovery migration', () => {
  it('adds only provenance and schema identity, retaining all existing domain rows', () => {
    const db = v3();
    const project = db.prepare('SELECT * FROM projects').all(); const asset = db.prepare('SELECT * FROM assets').all();
    migrateDesktopDatabase(db);
    expect(DESKTOP_SCHEMA_VERSION).toBe(12); expect(db.pragma('user_version',{simple:true})).toBe(12);
    expect(db.prepare('SELECT * FROM desktop_schema').all()).toEqual([{version:12,identity:'ecomgen-desktop-domain-v12'}]);
    for (const table of ['desktop_application_settings', 'desktop_model_pricing', 'desktop_usage_records', 'desktop_usage_recovery']) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    expect(db.prepare('SELECT * FROM projects').all()).toEqual(project); expect(db.prepare('SELECT * FROM assets').all()).toEqual(asset);
    expect(db.prepare('SELECT * FROM desktop_asset_provenance').all()).toEqual([]);
    const schema = db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(); migrateDesktopDatabase(db);
    expect(db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
  it('enforces provenance ownership and cascade deletion', () => {
    const db = v3(); migrateDesktopDatabase(db);
    const insert = db.prepare('INSERT INTO desktop_asset_provenance VALUES(?,?,?,?,?)');
    expect(() => insert.run('missing','网页','https://shop.example/item','商品','2026-11-06T00:00:00.000Z')).toThrow();
    insert.run('asset','网页','https://shop.example/item','商品','2026-11-06T00:00:00.000Z');
    db.prepare('DELETE FROM projects WHERE id=?').run('project');
    expect(db.prepare('SELECT * FROM desktop_asset_provenance').all()).toEqual([]);
  });
  it('rolls back identity and DDL if a conflicting source table exists', () => {
    const db = v3(); db.exec('CREATE TABLE desktop_asset_provenance(unrecognized TEXT)');
    expect(() => migrateDesktopDatabase(db)).toThrow();
    expect(db.pragma('user_version',{simple:true})).toBe(3);
    expect(db.prepare('SELECT identity FROM desktop_schema').get()).toEqual({identity:'ecomgen-desktop-domain-v3'});
    expect(db.prepare('PRAGMA table_info(desktop_asset_provenance)').all()).toHaveLength(1);
  });
  it('rejects incomplete v3 before any upgrade and rejects incomplete v6 on reopen', () => {
    const db = v3(); db.exec('ALTER TABLE assets RENAME COLUMN hash TO corrupt_hash');
    expect(() => migrateDesktopDatabase(db)).toThrow('Incomplete'); expect(db.pragma('user_version',{simple:true})).toBe(3);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='desktop_asset_provenance'").get()).toBeUndefined();
    const current = openDatabase(':memory:'); connections.push(current); current.exec('DROP TABLE desktop_asset_provenance');
    expect(() => migrateDesktopDatabase(current)).toThrow('Incomplete');
  });
});
