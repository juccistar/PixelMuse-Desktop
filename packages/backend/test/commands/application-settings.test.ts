import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APPLICATION_SETTINGS, type ApplicationSettings, type ChangeEvent } from '@ecomgen/contracts';
import { openDatabase } from '@ecomgen/core';
import { createBackend, createExecutionSnapshot, registerDomainCommands, type Backend, type CommandContext } from '../../src/index.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pixelmuse-app-settings-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const options = { dataDir: join(root, 'managed'), masterKey: Buffer.alloc(32, 31).toString('base64'), version: 'settings-test' };
  const events: ChangeEvent[] = []; let context!: CommandContext; let calls = 0;
  const open = async () => {
    const backend = await createBackend(options, event => events.push(event), {
      commands: current => { context = current; return registerDomainCommands(current); },
      fetch: async () => { calls++; throw Error('No Provider request may be sent while saving settings'); },
    });
    cleanups.push(() => backend.close()); return backend;
  };
  const backend = await open();
  return { backend, root: options.dataDir, open, events, context: () => context, calls: () => calls };
}
const models = [
  { id: 'reason', supportsVision: true, supportsThinking: true, supportsTools: true, supportsStructuredOutput: true },
  { id: 'image', supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, imageApiKind: 'openai_images' as const },
  { id: 'segment', supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, segmentationProtocol: 'fal' as const },
];
const provider = (backend: Backend) => backend.invoke('createProvider', { name: '原服务', baseUrl: 'https://fake.invalid/v1', apiKey: 'isolated-private-key', reasoningProtocol: 'openai', models });
function configured(id: string): ApplicationSettings['defaults'] {
  return { ...structuredClone(DEFAULT_APPLICATION_SETTINGS.defaults), reasoningModel: { providerId: id, modelId: 'reason' }, imageModel: { providerId: id, modelId: 'image' }, segmentationModel: { providerId: id, modelId: 'segment', protocol: 'fal' }, promptLanguage: 'ENGLISH', copyLanguage: '中文', imageAspectRatio: '3:4', imageResolution: '2K', candidatesPerType: 3, webResearchEnabled: true };
}
async function frozenGeneration(f: Awaited<ReturnType<typeof fixture>>, reasoningProviderId: string, imageProviderId: string, revision?: unknown) {
  const project = await f.backend.invoke('createProject', { name: '冻结生图依赖', reasoningProviderId, reasoningModelId: 'reason', imageProviderId, imageModelId: 'image', defaultMode: 'CREATIVE' });
  const r = f.context().repository;
  r.saveStoryboard(project.id, 'style', 'CONFIRMED', [{ assetType: 'test-template', displayName: '商品图', shotRole: null, templateVariant: null, candidateCount: 1, referencedAssets: [], mode: 'CREATIVE', status: 'CONFIRMED', promptInstruction: 'clean product shot', compiledPrompt: null, factClaims: [], riskFlags: [], sortOrder: 0 }]);
  const item = r.listStoryboardItems(project.id)[0]!;
  const job = f.context().transaction(() => {
    const job = r.createJob({ id: randomUUID(), projectId: project.id, storyboardItemId: item.id, type: 'GENERATE', input: revision === undefined ? {} : { revision }, providerId: imageProviderId, modelId: 'image' });
    // freeze 不 enqueue，真实执行快照用于统计而不发送模型请求。
    f.context().scheduler.freeze(job.id, createExecutionSnapshot(f.context(), job));
    return job;
  });
  const db = (r as unknown as {db: ReturnType<typeof openDatabase>}).db;
  return { project, job, db };
}
describe('application settings through the actual Backend boundary', () => {
  it('returns complete defaults and persists actual SQLite settings across a new owner with no Provider request', async () => {
    const f = await fixture(); const p = await provider(f.backend);
    expect(await f.backend.invoke('getApplicationSettings', {})).toEqual(DEFAULT_APPLICATION_SETTINGS);
    const settings = { startupPage: 'last' as const, interfaceScale: 1.2, taskNotifications: true, lastWorkspaceRoute: '/patterns/example-id', defaults: configured(p.id), ai: { requestTimeoutSeconds: 321, thinkingLevel: 'high' as const, maxOutputTokens: 4096, concurrency: 3 } };
    expect(await f.backend.invoke('updateApplicationSettings', settings)).toEqual(settings);
    const key = f.context().repository.getProvider(p.id)!.encryptedApiKey;
    await f.backend.close(); const reopened = await f.open();
    expect(await reopened.invoke('getApplicationSettings', {})).toEqual(settings);
    expect(f.context().repository.getProvider(p.id)!.encryptedApiKey).toBe(key);
    expect(f.events.some(event => event.topic === 'settings')).toBe(true); expect(f.calls()).toBe(0);
    const publicState = JSON.stringify(await reopened.invoke('getApplicationSettings', {}));
    expect(publicState).not.toMatch(/isolated-private-key|encryptedApiKey|https:/);
    await reopened.close(); const db = openDatabase(join(f.root, 'backend.sqlite'));
    try { expect(JSON.parse((db.prepare('SELECT settings_json FROM desktop_application_settings WHERE singleton=1').get() as {settings_json:string}).settings_json)).toEqual(settings); } finally { db.close(); }
  });
  it('freezes model options at submission while later settings change', async () => {
    const f = await fixture(); const p = await provider(f.backend);
    const first = { requestTimeoutSeconds: 333, thinkingLevel: 'high' as const, maxOutputTokens: 2048, concurrency: 3 };
    await f.backend.invoke('updateApplicationSettings', { ai: first });
    const frozen = await frozenGeneration(f, p.id, p.id);
    const before = JSON.parse((frozen.db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get(frozen.job.id) as {payload:string}).payload);
    expect(before.snapshot.effective.execution.ai).toEqual(first);
    await f.backend.invoke('updateApplicationSettings', { ai: { ...first, requestTimeoutSeconds: 444, concurrency: 1 } });
    const after = JSON.parse((frozen.db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get(frozen.job.id) as {payload:string}).payload);
    expect(after.snapshot.effective.execution.ai).toEqual(first);
    expect(f.calls()).toBe(0);
  });
  it.each(['https://evil.invalid', '//evil.invalid', '/settings', '/projects/../settings', '/patterns/a?next=https://evil.invalid', '/projects/a#section', 'C:/private', '/library/extra'])('rejects unsafe or unsupported restore route %s before writing', async route => {
    const f = await fixture();
    await expect(f.backend.invoke('updateApplicationSettings', { lastWorkspaceRoute: route })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await f.backend.invoke('getApplicationSettings', {})).toEqual(DEFAULT_APPLICATION_SETTINGS);
  });
  it('keeps settings and usage available when the selected media drive is disconnected', async () => {
    const f = await fixture();
    await f.backend.invoke('updateApplicationSettings', { interfaceScale: 1.2, taskNotifications: true });
    const target = await mkdtemp(join(tmpdir(), 'pixelmuse-settings-offline-')); cleanups.push(() => rm(target, { recursive: true, force: true }));
    await f.backend.invokeHost('host.workspaceChoose', { directory: target });
    const deadline = Date.now() + 5000;
    while ((await f.backend.invokeHost('host.workspaceStatus', {})).state !== 'RESTARTING') {
      if (Date.now() > deadline) throw Error('workspace migration did not finish');
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect((await f.backend.invoke('getApplicationSettings', {})).interfaceScale).toBe(1.2);
    await f.backend.close(); await rename(join(target, 'PixelMuse'), join(target, 'disconnected'));
    const offline = await f.open();
    expect((await offline.invokeHost('host.workspaceStatus', {})).state).toBe('FAILED');
    await expect(offline.invoke('listProjects', {})).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' });
    expect(await offline.invoke('getApplicationSettings', {})).toMatchObject({ interfaceScale: 1.2, taskNotifications: true });
    expect(await offline.invoke('updateApplicationSettings', { interfaceScale: 1.1 })).toMatchObject({ interfaceScale: 1.1 });
    expect(await offline.invoke('listUsage', {})).toEqual({items:[], total:0});
    expect(await offline.invoke('getUsageSummary', {})).toMatchObject({requestCount:0});
    expect(await offline.invoke('listModelPricing', {})).toEqual({items:[]});
    expect(await offline.invoke('exportUsage', {})).toMatchObject({mimeType:'text/csv'});
    expect(f.calls()).toBe(0);
  });
  it('rejects incompatible, missing and mismatched protocol defaults without partial setting writes', async () => {
    const f = await fixture(); const p = await provider(f.backend); const defaults = configured(p.id);
    for (const patch of [
      { reasoningModel: { providerId: p.id, modelId: 'image' } },
      { imageModel: { providerId: p.id, modelId: 'reason' } },
      { segmentationModel: { providerId: p.id, modelId: 'segment', protocol: 'grounded_sam' } },
      { reasoningModel: { providerId: 'missing', modelId: 'reason' } },
      { imageModel: { providerId: p.id, modelId: 'missing' } },
    ]) await expect(f.backend.invoke('updateApplicationSettings', { interfaceScale: 1.3, defaults: { ...defaults, ...patch } as ApplicationSettings['defaults'] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(f.backend.invoke('updateApplicationSettings', { defaults: { reasoningModel: null } } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.backend.invoke('updateApplicationSettings', { interfaceScale: 1.31 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await f.backend.invoke('getApplicationSettings', {})).toEqual(DEFAULT_APPLICATION_SETTINGS); expect(f.calls()).toBe(0);
  });
  it('preserves project choices and frozen tasks and returns model-specific safe impact counts', async () => {
    const f = await fixture(); const p = await provider(f.backend);
    const project = await f.backend.invoke('createProject', { name: '保持原项目', reasoningProviderId: p.id, reasoningModelId: 'reason', imageProviderId: p.id, imageModelId: 'image', defaultMode: 'CREATIVE' });
    const other = await f.backend.invoke('createProject', { name: '归档仍引用', reasoningProviderId: p.id, reasoningModelId: 'reason', imageProviderId: p.id, imageModelId: 'image', defaultMode: 'CREATIVE' });
    await f.backend.invoke('updateProject', { projectId: other.id, archived: true });
    const r = f.context().repository;
    const frozenId = randomUUID();
    f.context().transaction(() => {
      const frozen = r.createJob({ id: frozenId, projectId: project.id, storyboardItemId: null, type: 'PLAN', input: { immutable: 'frozen original' }, providerId: p.id, modelId: 'reason' });
      f.context().scheduler.freeze(frozen.id, createExecutionSnapshot(f.context(), frozen));
      r.updateJob(frozen.id, { status: 'SUCCEEDED' });
    });
    const db = (r as unknown as {db: ReturnType<typeof openDatabase>}).db;
    const beforeFrozen = db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get(frozenId);
    const job = r.createJob({ id: randomUUID(), projectId: project.id, storyboardItemId: null, type: 'PLAN', input: { immutable: 'original' }, providerId: p.id, modelId: 'reason' });
    // 另留一个未提交执行的排队意图用于影响计数，不能因保存设置而开始付费请求。
    const beforeJob = r.getJob(job.id), beforeProject = r.getProject(project.id);
    const defaults = configured(p.id);
    await f.backend.invoke('updateApplicationSettings', { defaults });
    expect(r.getProject(project.id)).toEqual(beforeProject); expect(r.getJob(job.id)).toEqual(beforeJob);
    expect(db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get(frozenId)).toEqual(beforeFrozen);
    expect(await f.backend.invoke('getModelConfigurationImpact', { providerId: p.id })).toEqual({ projectCount: 2, activeJobCount: 1, defaultRoles: ['reasoningModel','imageModel','segmentationModel'] });
    expect(await f.backend.invoke('getModelConfigurationImpact', { providerId: p.id, modelId: 'image' })).toEqual({ projectCount: 2, activeJobCount: 0, defaultRoles: ['imageModel'] });
    expect(await f.backend.invoke('getModelConfigurationImpact', { providerId: p.id, modelId: 'reason' })).toEqual({ projectCount: 2, activeJobCount: 1, defaultRoles: ['reasoningModel'] });
    expect(await f.backend.invoke('getModelConfigurationImpact', { providerId: p.id, modelId: 'missing' })).toEqual({ projectCount: 0, activeJobCount: 0, defaultRoles: [] });
    expect(f.calls()).toBe(0);
  });
  it('counts frozen revision reasoning and image dependencies without counting cached catalogs or changing settings and references', async () => {
    const f = await fixture(); const reasoning = await provider(f.backend), image = await provider(f.backend), unrelated = await provider(f.backend);
    const { project, job, db } = await frozenGeneration(f, reasoning.id, image.id, '  make lighting softer\n');
    await f.backend.invoke('updateApplicationSettings', { defaults: configured(reasoning.id) });
    const r = f.context().repository;
    // 项目和任务行后来变化，执行仍使用冻结身份；新选择不能冒充本任务的依赖。
    await f.backend.invoke('updateProject', { projectId: project.id, reasoningModel: { providerId: unrelated.id, modelId: 'reason' } });
    db.prepare('UPDATE jobs SET provider_id=?, model_id=?, input_json=? WHERE id=?').run(unrelated.id, 'image', JSON.stringify({ revision: 'retry' }), job.id);
    const before = { settings: await f.backend.invoke('getApplicationSettings', {}), project: r.getProject(project.id), job: r.getJob(job.id), payload: db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get(job.id) };
    expect(await f.backend.invoke('getModelConfigurationImpact', { providerId: reasoning.id, modelId: 'reason' })).toEqual({ projectCount: 0, activeJobCount: 1, defaultRoles: ['reasoningModel'] });
    expect(await f.backend.invoke('getModelConfigurationImpact', { providerId: image.id, modelId: 'image' })).toEqual({ projectCount: 1, activeJobCount: 1, defaultRoles: [] });
    expect(await f.backend.invoke('getModelConfigurationImpact', { providerId: unrelated.id })).toEqual({ projectCount: 1, activeJobCount: 0, defaultRoles: [] });
    expect(await f.backend.invoke('getModelConfigurationImpact', { providerId: image.id, modelId: 'reason' })).toEqual({ projectCount: 0, activeJobCount: 0, defaultRoles: [] });
    expect(await f.backend.invoke('getModelConfigurationImpact', { providerId: reasoning.id, modelId: 'image' })).toEqual({ projectCount: 0, activeJobCount: 0, defaultRoles: ['imageModel'] });
    expect(await f.backend.invoke('getModelConfigurationImpact', { providerId: reasoning.id, modelId: 'segment' })).toEqual({ projectCount: 0, activeJobCount: 0, defaultRoles: ['segmentationModel'] });
    expect({ settings: await f.backend.invoke('getApplicationSettings', {}), project: r.getProject(project.id), job: r.getJob(job.id), payload: db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get(job.id) }).toEqual(before);
    r.updateJob(job.id, { status: 'RUNNING' });
    expect((await f.backend.invoke('getModelConfigurationImpact', { providerId: reasoning.id, modelId: 'reason' })).activeJobCount).toBe(1);
    r.updateJob(job.id, { status: 'SUCCEEDED' });
    expect((await f.backend.invoke('getModelConfigurationImpact', { providerId: reasoning.id })).activeJobCount).toBe(0);
    expect((await f.backend.invoke('getModelConfigurationImpact', { providerId: image.id })).activeJobCount).toBe(0);
    expect(f.calls()).toBe(0);
  });
  it('counts a revision task only once when its image and reasoning models share a provider', async () => {
    const f = await fixture(); const p = await provider(f.backend);
    await frozenGeneration(f, p.id, p.id, 'change lighting');
    expect(await f.backend.invoke('getModelConfigurationImpact', { providerId: p.id })).toEqual({ projectCount: 1, activeJobCount: 1, defaultRoles: [] });
    for (const modelId of ['reason', 'image']) expect((await f.backend.invoke('getModelConfigurationImpact', { providerId: p.id, modelId })).activeJobCount).toBe(1);
    expect((await f.backend.invoke('getModelConfigurationImpact', { providerId: p.id, modelId: 'segment' })).activeJobCount).toBe(0);
    expect(f.calls()).toBe(0);
  });
  it.each([undefined, null, 42, '', ' \t\r\n', 'retry', ' \tretry\r\n'])('does not add a secondary reasoning dependency for generation revision %j', async revision => {
    const f = await fixture(); const reasoning = await provider(f.backend), image = await provider(f.backend);
    await frozenGeneration(f, reasoning.id, image.id, revision);
    expect(await f.backend.invoke('getModelConfigurationImpact', { providerId: reasoning.id })).toEqual({ projectCount: 1, activeJobCount: 0, defaultRoles: [] });
    expect(await f.backend.invoke('getModelConfigurationImpact', { providerId: image.id, modelId: 'image' })).toEqual({ projectCount: 1, activeJobCount: 1, defaultRoles: [] });
    expect(f.calls()).toBe(0);
  });
  it('clears only removed or capability-invalid defaults and preserves the key when editing an existing connection', async () => {
    const f = await fixture(); const p = await provider(f.backend); const key = f.context().repository.getProvider(p.id)!.encryptedApiKey;
    await f.backend.invoke('updateApplicationSettings', { defaults: configured(p.id) });
    await f.backend.invoke('updateProvider', { providerId: p.id, name: '新名称', models: models.filter(model => model.id !== 'image') });
    expect((await f.backend.invoke('getApplicationSettings', {})).defaults).toEqual({ ...configured(p.id), imageModel: null });
    expect(f.context().repository.getProvider(p.id)!.encryptedApiKey).toBe(key);
    await f.backend.invoke('updateProvider', { providerId: p.id, models: [{ ...models[0]!, imageApiKind: 'openai_images' }, models[2]!] });
    expect((await f.backend.invoke('getApplicationSettings', {})).defaults.reasoningModel).toBeNull();
    await f.backend.invoke('deleteProvider', { providerId: p.id });
    const settings = await f.backend.invoke('getApplicationSettings', {});
    expect(settings.defaults).toEqual({ ...configured(p.id), reasoningModel: null, imageModel: null, segmentationModel: null });
    expect(f.calls()).toBe(0);
  });
  it('rolls back provider deletion and default cleanup together when the enclosing transaction fails', async () => {
    const f = await fixture(); const p = await provider(f.backend); await f.backend.invoke('updateApplicationSettings', { defaults: configured(p.id) });
    const db = (f.context().repository as unknown as {db: ReturnType<typeof openDatabase>}).db;
    db.exec("CREATE TRIGGER fail_settings_update BEFORE UPDATE ON desktop_application_settings BEGIN SELECT RAISE(ABORT,'injected settings failure'); END");
    await expect(f.backend.invoke('deleteProvider', { providerId: p.id })).rejects.toBeDefined();
    expect(f.context().repository.getProvider(p.id)).toBeDefined();
    expect((await f.backend.invoke('getApplicationSettings', {})).defaults).toEqual(configured(p.id));
  });
});
