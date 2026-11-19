import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Input } from '@ecomgen/contracts';
import { suiteReply, type MockRequestContext } from '../../../../scripts/full-mock-provider.mjs';
import { integrationFixtures, file, waitJob } from './fixtures.js';

const { fixture } = integrationFixtures();

function storedHints(root: string, jobId: string) {
  const db = new Database(join(root, 'backend.sqlite'), { readonly: true });
  try {
    const row = db.prepare('SELECT input_json FROM jobs WHERE id=?').get(jobId) as { input_json: string };
    return JSON.parse(row.input_json).hints;
  } finally { db.close(); }
}

function userText(request: MockRequestContext): string {
  return (request.json?.messages ?? []).filter((message: { role: string }) => message.role === 'user')
    .map((message: { content: string | Array<{ type: string; text?: string }> }) => typeof message.content === 'string'
      ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')).join('\n');
}

describe('SuiteForge automatic target through the default Backend', () => {
  it.each(['omitted', 'explicitly undefined'] as const)('executes an %s target, preserves automatic hints and reuses the equivalent intent', { timeout: 60_000 }, async target => {
    const prompts: string[] = [];
    const f = await fixture({ replies: { 'suite-forge': request => {
      prompts.push(userText(request));
      return suiteReply({ shotCount: 7 });
    } } });
    const input: Input<'createSuiteForgeJob'> = {
      providerId: f.provider.id, modelId: 'mock-reasoner', files: [file(f.bytes)],
      ...(target === 'explicitly undefined' ? {
        targetShotCount: undefined, name: undefined, l1: undefined, l2: undefined,
        leaf: undefined, productFamily: undefined, userInstruction: undefined, idempotencyKey: undefined,
      } : {}),
    };
    const job = await f.backend.invoke('createSuiteForgeJob', input);
    await waitJob(f.backend, job.id);
    expect(storedHints(f.root, job.id)).toEqual({});
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('Produce about');
    expect(prompts[0]).not.toContain('undefined');
    const draft = await f.backend.invoke('getSuiteForgeResult', { jobId: job.id });
    expect(draft.status).toBe('DRAFT');
    expect(draft.suite.shots).toHaveLength(7);
    expect((await f.backend.invoke('getJobRequests', { jobId: job.id })).items).toEqual([
      expect.objectContaining({ state: 'COMPLETED', localState: 'COMMITTED' }),
    ]);
    const equivalent = { providerId: input.providerId, modelId: input.modelId, files: input.files,
      ...(target === 'omitted' ? { targetShotCount: undefined } : {}) };
    const duplicate = await f.backend.invoke('createSuiteForgeJob', equivalent);
    expect(duplicate.id).toBe(job.id);
    expect(duplicate.reused).toBe(true);
    expect(f.server.state.counts.chat).toBe(1);
    expect(f.server.state.counts['image-generation']).toBe(0);
  });

  it.each([5, 12])('preserves explicit target %i and all supplied hints', { timeout: 60_000 }, async targetShotCount => {
    const prompts: string[] = [];
    const f = await fixture({ replies: { 'suite-forge': request => {
      prompts.push(userText(request));
      return suiteReply({ shotCount: targetShotCount });
    } } });
    const hints = { name: 'undefined', l1: '生活日用', l2: '家居用品', leaf: '日用商品', productFamily: 'general',
      userInstruction: 'Keep the original lighting', targetShotCount };
    const job = await f.backend.invoke('createSuiteForgeJob', { providerId: f.provider.id, modelId: 'mock-reasoner', files: [file(f.bytes)], ...hints });
    await waitJob(f.backend, job.id);
    expect(storedHints(f.root, job.id)).toEqual(hints);
    expect(prompts).toHaveLength(1);
    for (const instruction of [`Produce about ${targetShotCount} shots.`, 'Use this suite name: undefined',
      'Use category L1 exactly: 生活日用', 'Use category L2 exactly: 家居用品', 'Use this leaf product name: 日用商品',
      'Use productFamily: general', 'Additional requirement: Keep the original lighting']) expect(prompts[0]).toContain(instruction);
    expect((await f.backend.invoke('getSuiteForgeResult', { jobId: job.id })).suite.shots).toHaveLength(targetShotCount);
    expect(f.server.state.counts.chat).toBe(1);
  });

  it('rejects supplied invalid targets before creating jobs or sending requests', async () => {
    const f = await fixture();
    const input = { providerId: f.provider.id, modelId: 'mock-reasoner', files: [file(f.bytes)] };
    for (const targetShotCount of [4, 13, 5.5, 0, -1, 'undefined', '5', null, NaN, Infinity]) {
      await expect(f.backend.invoke('createSuiteForgeJob', { ...input, targetShotCount } as Input<'createSuiteForgeJob'>))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect((await f.backend.invoke('listSuiteForgeJobResults', {})).items).toEqual([]);
    expect(f.server.state.total).toBe(0);
  });
});
