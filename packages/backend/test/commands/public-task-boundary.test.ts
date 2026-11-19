import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { operations } from '@ecomgen/contracts';
import { expect, it } from 'vitest';
import { createBackend, type CommandContext } from '../../src/index.js';
import { registerDomainCommands } from '../../src/commands/index.js';
import { projectPublic } from '../../src/commands/support.js';
import { publicTaskError } from '../../src/public-task-error.js';

it('retains target identity through real Backend job and project queries without private input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ecomgen-public-job-'));
  let context!: CommandContext;
  const backend = await createBackend({ dataDir: root, masterKey: Buffer.alloc(32, 7).toString('base64'), version: 'test' }, () => undefined, {
    commands: current => { context = current; return registerDomainCommands(current); },
    fetch: async () => { throw new Error('network forbidden'); },
  });
  try {
    const project = context.repository.createProject({ name: '测试', category: null, productDescription: null, verifiedFacts: [], prohibitedClaims: [], brandGuidelines: {}, platformTargets: [], targetMarket: null, copyLanguage: null, reasoningProviderId: null, reasoningModelId: null, imageProviderId: null, imageModelId: null, defaultMode: 'CREATIVE', imageResolution: '1K', imageAspectRatio: 'AUTO', candidatesPerType: 1 });
    context.repository.saveStoryboard(project.id, 'test', 'CONFIRMED', [{ assetType: 'hero-image', displayName: '首图', shotRole: null, templateVariant: null, candidateCount: 1, referencedAssets: [], mode: 'CREATIVE', status: 'DRAFT', promptInstruction: 'test', compiledPrompt: null, factClaims: [], riskFlags: [], sortOrder: 0 }]);
    const item = context.repository.listStoryboardItems(project.id)[0]!;
    const job = context.repository.createJob({ id: randomUUID(), projectId: project.id, storyboardItemId: item.id, type: 'GENERATE', status: 'FAILED', input: { secret: 'private-input' } });
    context.repository.updateJob(job.id, { error: { code: 'EDIT_TARGET_REQUIRED', message: 'C:/private/secret' } });
    const direct = await backend.invoke('getJob', { jobId: job.id });
    const list = await backend.invoke('listJobs', { projectId: project.id });
    const detail = await backend.invoke('getProject', { projectId: project.id });
    for (const row of [direct, list.items.find(value => value.id === job.id)!, detail.jobs.find(value => value.id === job.id)!]) {
      expect(row.storyboardItemId).toBe(item.id);
      expect(row.error).toEqual({ code: 'EDIT_TARGET_REQUIRED', message: '请说明或标记需要修改的区域。' });
      expect(JSON.stringify(row)).not.toMatch(/private-input|C:\/private|"input"/);
    }
    expect(Value.Check(operations.getJob.output, direct)).toBe(true);
    expect(Value.Check(operations.listJobs.output, list)).toBe(true);
    expect(Value.Check(operations.getProject.output, detail)).toBe(true);
    const copy = context.repository.createJob({ id: randomUUID(), projectId: project.id, storyboardItemId: null, type: 'COPYWRITE', status: 'QUEUED', input: { target: 'PRODUCT_DESCRIPTION', secret: 'private-copy-input' } });
    const invalid = context.repository.createJob({ id: randomUUID(), projectId: project.id, storyboardItemId: null, type: 'COPYWRITE', status: 'FAILED', input: { target: 'private-unknown-target' } });
    const copyDirect = await backend.invoke('getJob', { jobId: copy.id });
    const copyList = await backend.invoke('listJobs', { projectId: project.id });
    const copyDetail = await backend.invoke('getProject', { projectId: project.id });
    for (const row of [copyDirect, copyList.items.find(value => value.id === copy.id)!, copyDetail.jobs.find(value => value.id === copy.id)!]) {
      expect(row.copywritingTarget).toBe('PRODUCT_DESCRIPTION');
      expect(JSON.stringify(row)).not.toMatch(/private-copy-input|"input"/);
    }
    expect(copyList.items.find(value => value.id === invalid.id)).not.toHaveProperty('copywritingTarget');
    expect(copyDetail.jobs.find(value => value.id === invalid.id)).not.toHaveProperty('copywritingTarget');
    expect(Value.Check(operations.getJob.output, copyDirect)).toBe(true);
    expect(Value.Check(operations.listJobs.output, copyList)).toBe(true);
    expect(Value.Check(operations.getProject.output, copyDetail)).toBe(true);
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }); }
});

it('projects only controlled error codes while leaving public clarification in the plan', () => {
  for (const code of ['REFERENCE_ASSET_REQUIRED', 'EDIT_TARGET_REQUIRED', 'OUTPAINT_CANVAS_REQUIRED', 'EDIT_VISION_REQUIRED', 'CAPABILITY_UNSUPPORTED', 'QUEUE_UNAVAILABLE', 'EDIT_PLAN_INVALID', 'EDIT_PLAN_EMPTY', 'EDIT_PLAN_MASK_REQUIRED']) {
    expect(publicTaskError({ message: `${code}: C:/private key=secret` })?.code).toBe(code);
    expect(JSON.stringify(publicTaskError({ code, message: 'secret' }))).not.toContain('secret');
  }
  expect(publicTaskError({ message: 'C:/private key=secret' })).toEqual({ code: 'TASK_ERROR', message: '任务未完成，请查看任务状态。' });
  expect(publicTaskError({ code: 'EDIT_TARGET_REQUIRED' }, 'UNKNOWN')?.code).toBe('EXTERNAL_UNKNOWN');
  const schema = Type.Object({ status: Type.String(), error: Type.Record(Type.String(), Type.Unknown()), plan: Type.Object({ clarification: Type.String() }) });
  const turn = projectPublic(schema, { status: 'NEED_INPUT', error: { message: 'private text' }, plan: { clarification: '请说明修改范围。' } });
  expect(turn.plan.clarification).toBe('请说明修改范围。');
  expect(JSON.stringify(turn.error)).not.toContain('private text');
});
