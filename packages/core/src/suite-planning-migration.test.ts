import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { EcomRepository } from './repository.js';

describe('v12 suite planning persistence', () => {
  it('upgrades v11 without inventing sources and preserves batches, prompts and storyboard sources on reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'suite-planning-v12-'));
    const filename = join(directory, 'data.sqlite');
    let db = openDatabase(filename);
    try {
      let repo = new EcomRepository(db);
      db.prepare('INSERT INTO projects(id,name,platform_targets_json,default_mode,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('project', '商品', '[]', 'CREATIVE', 'time', 'time');
      repo.createJob({ id: 'job', projectId: 'project', storyboardItemId: null, type: 'GENERATE', input: {} });
      const item = { assetType: 'hero-image', displayName: '历史', shotRole: null, templateVariant: null, candidateCount: 1, referencedAssets: [], mode: 'CREATIVE' as const, status: 'DRAFT' as const, promptInstruction: '提示', compiledPrompt: null, factClaims: [], riskFlags: [], sortOrder: 0 };
      repo.saveStoryboard('project', '风格', 'DRAFT', [item]);
      db.prepare('INSERT INTO desktop_application_settings VALUES(?,?,?)').run(1, '{"ai":{"concurrency":4}}', 'time');
      db.exec("DROP TABLE desktop_suite_planning_batches; DROP TABLE desktop_generation_prompts; ALTER TABLE storyboard_items DROP COLUMN planning_source_json; UPDATE desktop_schema SET version=11,identity='ecomgen-desktop-domain-v11'; PRAGMA user_version=11");
      db.close(); db = openDatabase(filename); repo = new EcomRepository(db);
      expect(repo.listStoryboardItems('project')[0]?.planningSource).toBeUndefined();
      expect(db.prepare('SELECT settings_json FROM desktop_application_settings').get()).toEqual({ settings_json: '{"ai":{"concurrency":4}}' });
      const planningSource = { version: 1 as const, kind: 'MODEL_DIRECT' as const, intent: '构图', referenceIntent: '光线' };
      repo.saveStoryboard('project', '风格', 'DRAFT', [{ ...item, planningSource }]);
      const newItem = repo.listStoryboardItems('project').find(row => row.planningSource)!;
      repo.updateStoryboardItem(newItem.id, { displayName: '修改' });
      const payload = { suiteBlueprint: { version: 1 as const, suiteId: 'suite', suiteName: '套图', suiteVersion: 'v1', styleLock: '风格', shots: [] }, entries: [{ projectId: 'project', generationKey: 'key' }], phase: 'PLANNING' as const };
      repo.createSuitePlanningBatch({ id: 'batch', requestKey: 'request', payload });
      expect(() => repo.createSuitePlanningBatch({ id: 'other', requestKey: 'request', payload })).toThrow();
      repo.saveGenerationPrompt({ ownerJobId: 'job', prompt: '共享提示' });
      expect(repo.saveGenerationPrompt({ ownerJobId: 'job', prompt: '共享提示' }).prompt).toBe('共享提示');
      expect(() => repo.saveGenerationPrompt({ ownerJobId: 'job', prompt: '冲突' })).toThrow('conflicts');
      db.close(); db = openDatabase(filename); repo = new EcomRepository(db);
      expect(repo.getStoryboardItem(newItem.id)?.planningSource).toEqual(planningSource);
      expect(repo.listStoryboardVersions('project').some(version => JSON.stringify(version).includes('MODEL_DIRECT'))).toBe(true);
      expect(repo.findSuitePlanningBatchByRequestKey('request')?.payload).toEqual(payload);
      expect(repo.listSuitePlanningBatches()).toHaveLength(1);
      expect(repo.updateSuitePlanningBatch('batch', { ...payload, phase: 'GENERATION' })?.payload.phase).toBe('GENERATION');
      expect(repo.getGenerationPrompt('job')?.prompt).toBe('共享提示');
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
