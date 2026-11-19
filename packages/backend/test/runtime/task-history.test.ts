import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EcomRepository, openDatabase } from '@ecomgen/core';
import { MODEL_SPEC_DEFAULTS } from '@ecomgen/contracts';
import { Value } from '@sinclair/typebox/value';
import { taskHistoryOperations } from '../../../contracts/src/task-history.js';
import { createTaskHistoryCommands } from '../../src/runtime/task-history.js';
import { RuntimeStore } from '../../src/runtime/state.js';
import type { CommandContext } from '../../src/runtime/ports.js';

describe('独立任务历史', () => {
  it('按实体及 Listing 类型分页，公开结果不包含任意输入', async () => {
    const db = openDatabase(':memory:');
    try {
      const repository = new EcomRepository(db);
      const context = { repository } as CommandContext;
      const commands = createTaskHistoryCommands(context, new RuntimeStore(db));
      const pattern = repository.createPattern({ name: '花型', sourceType: 'UPLOADED', sourceJobId: null, sourceAssetHash: null, parentPatternId: null, storagePath: null, fileHash: null, width: null, height: null, tags: [] });
      const model = repository.createModel({ name: '人物', spec: MODEL_SPEC_DEFAULTS, notes: '' });
      const add = (type: 'COPYWRITE' | 'MODEL_CAST', input: Record<string, unknown>) => repository.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type, input });
      add('COPYWRITE', { target: 'LISTING', patternId: pattern.id, platform: 'ETSY', sellingPoints: '卖点', secret: 'private-sentinel' });
      add('COPYWRITE', { target: 'LISTING', patternId: pattern.id, platform: 'AMAZON', prompt: 'private-sentinel' });
      add('COPYWRITE', { target: 'OTHER', patternId: pattern.id });
      add('COPYWRITE', { target: 'LISTING', patternId: 'other' });
      const cast = add('MODEL_CAST', { modelId: model.id, prompt: 'private-sentinel', path: '/private/path' });
      repository.updateJob(cast.id, { status: 'UNKNOWN', retryable: false });
      add('MODEL_CAST', { modelId: 'other' });
      const first = await commands.listPatternListingHistory!(context, { patternId: pattern.id, limit: 1, offset: 0 });
      const second = await commands.listPatternListingHistory!(context, { patternId: pattern.id, limit: 1, offset: 1 });
      expect(first.total).toBe(2);
      expect(second.total).toBe(2);
      expect(first.items[0]!.job.id).not.toBe(second.items[0]!.job.id);
      expect(Value.Check(taskHistoryOperations.listPatternListingHistory.output, first)).toBe(true);
      const casts = await commands.listModelCastHistory!(context, { modelId: model.id });
      expect(casts.total).toBe(1);
      expect(casts.items[0]).toMatchObject({ id: cast.id, status: 'UNKNOWN', retryable: false });
      expect(Value.Check(taskHistoryOperations.listModelCastHistory.output, casts)).toBe(true);
      expect(JSON.stringify([first, second, casts])).not.toMatch(/private-sentinel|\/private\/path|"input"/);
      expect(() => commands.listPatternListingHistory!(context, { patternId: 'missing' })).toThrow();
      expect(() => commands.listModelCastHistory!(context, { modelId: 'missing' })).toThrow();
    } finally { db.close(); }
  });
});
