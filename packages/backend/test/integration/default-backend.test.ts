import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { readPsd } from 'ag-psd';
import { operations } from '@ecomgen/contracts';
import { createBackend, registerDomainCommands, registerExecutors, createExecutionSnapshot, EXECUTOR_TYPES, type Backend } from '../../src/index.js';
import { integrationFixtures, waitJob, generate, poll, unzip } from './fixtures.js';
const { fixture, open, directory } = integrationFixtures();
// 真实 Pi 规划在根 worker 池中可超过 20 秒；仅这些包含规划的完整流程采用已验证的本地集成上限。
const planningWorkflowTimeout = 60_000;

describe('production default Backend', () => {
  it('exposes actual factories and executes planning, stable generation, PSD and ZIP with no injected handlers', { timeout: planningWorkflowTimeout }, async () => {
    expect(Object.keys(operations)).toHaveLength(154); expect(EXECUTOR_TYPES).toHaveLength(20);
    expect([registerDomainCommands, registerExecutors, createExecutionSnapshot].every(value => typeof value === 'function')).toBe(true);
    const f = await fixture();
    const generated = await generate(f.backend, f.project.id);
    expect(f.server.state.counts.chat).toBe(1); expect(f.server.state.counts['image-generation']).toBe(1);
    const repeated = await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [generated.board.items[0]!.id] });
    expect(repeated.jobs[0]!.id).toBe(generated.job.id);
    const layer = await f.backend.invoke('createLayerExport', { outputId: generated.output.id, includeBackground: true,
      elements: [{ id: 'body', name: '杯身', source: 'manual', bbox: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }] });
    await waitJob(f.backend, layer.job.id);
    const psdHandle = await f.backend.invoke('downloadLayerExport', { layerExportId: layer.layerExport.id });
    const psdBytes = await readFile((await f.backend.invokeHost('host.resolveResource', { ref: psdHandle.ref })).path);
    expect(readPsd(psdBytes, { skipCompositeImageData: true, skipLayerImageData: true })).toMatchObject({ width: 32, height: 24 });
    const exported = await f.backend.invoke('createExportJob', { projectId: f.project.id, outputIds: [generated.output.id] });
    await waitJob(f.backend, exported.job.id);
    const handle = await f.backend.invoke('downloadExport', { exportId: exported.export!.id });
    const bytes = await readFile((await f.backend.invokeHost('host.resolveResource', { ref: handle.ref })).path);
    const files = unzip(bytes); expect([...files.keys()].some(name => name.endsWith('.png'))).toBe(true);
    const publicState = { jobs: await f.backend.invoke('listJobs', {}), outputs: await f.backend.invoke('listOutputs', { projectId: f.project.id }),
      requests: await f.backend.invoke('getJobRequests', { jobId: generated.job.id }), handle };
    expect(publicState.requests.items).toEqual([expect.objectContaining({ state: 'COMPLETED', localState: 'COMMITTED' })]);
    expect(JSON.stringify(publicState)).not.toMatch(/storagePath|encryptedApiKey|encryptedReceipt|bodyBase64|privateSnapshot/);
    expect(JSON.stringify(publicState)).not.toContain(f.root);
    await f.backend.close();
    const db = new Database(join(f.root, 'backend.sqlite'), { readonly: true });
    try {
      const runtime = JSON.parse((db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get(generated.job.id) as { payload: string }).payload);
      expect(runtime.snapshot.effective.execution).toBeDefined(); expect(runtime.phase).toBe('SETTLED');
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });

  it('retries the real download tail from a complete receipt without a second paid request, including after reopen', { timeout: planningWorkflowTimeout }, async () => {
    const f = await fixture();
    f.server.control.failNext('image-generation', { type: 'download-once' });
    const plan = await f.backend.invoke('createPlanningJob', { projectId: f.project.id, planningMode: 'MANUAL', requestedTypes: ['hero-image'] });
    await waitJob(f.backend, plan.id);
    const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    await f.backend.invoke('confirmStoryboard', { projectId: f.project.id, version: Number(board.storyboard!.version) });
    const queued = await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [board.items[0]!.id] });
    const id = queued.jobs[0]!.id; await waitJob(f.backend, id, 'FAILED');
    expect((await f.backend.invoke('getJobRequests', { jobId: id })).items).toEqual([expect.objectContaining({ state: 'COMPLETED', localState: 'PENDING' })]);
    expect(f.server.state.counts['image-generation']).toBe(1);
    await f.backend.close(); const backend = await open(f.options);
    await backend.invoke('retryJob', { jobId: id }); await waitJob(backend, id);
    expect(f.server.state.counts['image-generation']).toBe(1); expect(f.server.state.counts.download).toBe(2);
    expect((await backend.invoke('listOutputs', { projectId: f.project.id })).items).toHaveLength(1);
  });

  it('keeps actual dropped requests UNKNOWN across owners and prevents default retry or duplicate dispatch', { timeout: planningWorkflowTimeout }, async () => {
    const f = await fixture(); const generated = await generate(f.backend, f.project.id);
    f.server.control.failNext('image-generation', { type: 'drop' });
    const input = { projectId: f.project.id, storyboardItemIds: [generated.board.items[0]!.id], revision: 'retry', generationConfig: { candidateCount: 2 } };
    const pending = await f.backend.invoke('createGenerationJobs', input);
    expect(pending.jobs).toHaveLength(2); expect(pending.jobs[0]!.id).toBe(generated.job.id);
    const newJob = pending.jobs.find(job => job.id !== generated.job.id)!;
    expect(newJob).toBeDefined(); const id = newJob.id;
    await waitJob(f.backend, id, 'UNKNOWN'); await f.backend.close();
    const backend = await open(f.options);
    expect((await backend.invoke('getJob', { jobId: id })).status).toBe('UNKNOWN');
    await expect(backend.invoke('retryJob', { jobId: id })).rejects.toMatchObject({ code: 'RETRY_UNSAFE' });
    const duplicate = await backend.invoke('createGenerationJobs', input);
    expect(duplicate.jobs.map(job => job.id)).toEqual(pending.jobs.map(job => job.id));
    expect((await backend.invoke('getJobRequests', { jobId: id })).items).toEqual([expect.objectContaining({ state: 'UNKNOWN' })]);
    expect(f.server.state.counts['image-generation']).toBe(2);
    expect((await backend.invoke('listOutputs', { projectId: f.project.id })).items).toEqual([generated.output]);
  });

  it('settles Listing through the default COPYWRITE executor and publishes local pattern artifacts', async () => {
    const f = await fixture();
    const pattern = await f.backend.invoke('uploadPattern', { name: '测试花型', file: { name: 'pattern.png', mimeType: 'image/png', base64: f.bytes.toString('base64') } });
    const derive = await f.backend.invoke('createPatternDeriveJob', { patternId: pattern.id, hueShift: 100 });
    await waitJob(f.backend, derive.id);
    const listing = await f.backend.invoke('createPatternListingJob', { patternId: pattern.id, providerId: f.provider.id, modelId: 'mock-reasoner', platform: 'ETSY' });
    await waitJob(f.backend, listing.id);
    expect((await f.backend.invoke('getJob', { jobId: listing.id }))).toMatchObject({ type: 'COPYWRITE', projectId: null });
    expect((await f.backend.invoke('getPatternListingResult', { patternId: pattern.id, jobId: listing.id })).jobId).toBe(listing.id);
    expect(f.server.state.counts.chat).toBe(1); expect(f.server.state.counts['image-generation']).toBe(0);
  });

  it('aborts active default execution before releasing ownership and rejects all calls after close starts', { timeout: planningWorkflowTimeout }, async () => {
    const f = await fixture(); const generated = await generate(f.backend, f.project.id);
    f.server.control.failNext('image-generation', { type: 'hang' });
    const input = { projectId: f.project.id, storyboardItemIds: [generated.board.items[0]!.id], revision: 'retry', generationConfig: { candidateCount: 2 } };
    const queued = await f.backend.invoke('createGenerationJobs', input);
    expect(queued.jobs).toHaveLength(2); expect(queued.jobs[0]!.id).toBe(generated.job.id);
    const newJob = queued.jobs.find(job => job.id !== generated.job.id)!;
    expect(newJob).toBeDefined();
    await poll(async () => f.server.state.hanging > 0 ? true : undefined, 'paid request to start');
    await expect(createBackend(f.options)).rejects.toMatchObject({ code: 'BACKEND_IN_USE' });
    const closed = f.backend.close(); expect(f.backend.close()).toBe(closed);
    await expect(f.backend.invoke('getHealth', {})).rejects.toMatchObject({ code: 'CLOSING' });
    await expect(f.backend.invokeHost('host.resolveResource', { ref: { kind: 'OUTPUT', id: generated.output.id } })).rejects.toMatchObject({ code: 'CLOSING' });
    await closed;
    const backend = await open(f.options); const job = await backend.invoke('getJob', { jobId: newJob.id });
    expect(job.status).toBe('UNKNOWN'); expect(job.retryable).toBe(false);
    expect((await backend.invoke('createGenerationJobs', input)).jobs.map(value => value.id)).toEqual(queued.jobs.map(value => value.id));
    expect((await backend.invoke('listOutputs', { projectId: f.project.id })).items).toEqual([generated.output]);
    expect(f.server.state.counts['image-generation']).toBe(2);
  });

  it('keeps explicit runtime-test overrides usable without populating missing commands from production', async () => {
    const root = await directory();
    const backend: Backend = await createBackend({ dataDir: root, masterKey: Buffer.alloc(32, 4).toString('base64'), version: 'override' }, undefined,
      { commands: {}, executors: registerExecutors });
    try {
      expect((await backend.invoke('getHealth', {})).version).toBe('override');
      await expect(backend.invoke('listProjects', {})).rejects.toMatchObject({ code: 'COMMAND_UNAVAILABLE' });
    } finally { await backend.close(); }
  });
});
