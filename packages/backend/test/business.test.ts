import { describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { readPsd } from 'ag-psd';
import { EcomRepository, openDatabase, SecretBox } from '@ecomgen/core';
import { storyboardReply } from '../../../scripts/full-mock-provider.mjs';
import { RequestLedger, RuntimeStore } from '../src/index.js';
import { generationKeyFor } from '../src/execution/index.js';
import { FAKE_KEY, file, generate, poll, regressionFixtures, waitJob } from './desktop-regression-helpers.js';

const { fixture, open, directory } = regressionFixtures();
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function assertSelectedPixels(source: Buffer, layer: Buffer) {
  let foreground = 0, transparent = 0;
  for (let offset = 0; offset < layer.length; offset += 4) {
    if (layer[offset + 3]! > 0) {
      expect(layer.subarray(offset, offset + 3)).toEqual(source.subarray(offset, offset + 3));
      expect(layer[offset + 3]).toBeLessThanOrEqual(source[offset + 3]!);
      foreground++;
    } else transparent++;
  }
  expect(foreground).toBeGreaterThan(0); expect(transparent).toBeGreaterThan(0);
}

describe('canonical desktop business integration regressions', { timeout: 120000 }, () => {
  it('uses real Pi planning, truth/template gates and version confirmation, and reuses a completed stable generation', async () => {
    const f = await fixture({ mode: 'PIXEL_PROTECTED', mock: { replies: { storyboard: storyboardReply({ assetTypes: ['hero-image'], mode: 'PIXEL_PROTECTED', referencedAssets: ['P1'], candidateCount: 1 }) } } });
    const request = { projectId: f.project.id, requestedTypes: ['hero-image'], targetImageCount: 1 };
    await expect(f.backend.invoke('createPlanningJob', request)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const asset = await f.backend.invoke('uploadAsset', { projectId: f.project.id, file: file(f.bytes), kind: 'PRODUCT' });
    await expect(f.backend.invoke('createPlanningJob', { ...request, requestedTypes: ['unknown-template'] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const plan = await f.backend.invoke('createPlanningJob', request);
    expect((await f.backend.invoke('createPlanningJob', request)).id).toBe(plan.id);
    await waitJob(f.backend, plan.id);
    expect(f.server.state.counts.chat).toBe(1);
    const board = await f.backend.invoke('getStoryboard', { projectId: f.project.id });
    expect(board.storyboard).toMatchObject({ status: 'DRAFT', version: 1 });
    expect(board.items[0]!.referencedAssets).toEqual([asset.id]);
    const generation = { projectId: f.project.id, storyboardItemIds: [board.items[0]!.id] };
    await expect(f.backend.invoke('createGenerationJobs', generation)).rejects.toMatchObject({ code: 'CONFLICT' });
    const version = Number(board.storyboard!.version); expect(Number.isSafeInteger(version)).toBe(true);
    await expect(f.backend.invoke('confirmStoryboard', { projectId: f.project.id, version: version + 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await f.backend.invoke('confirmStoryboard', { projectId: f.project.id, version });
    const generated = await f.backend.invoke('createGenerationJobs', generation);
    expect((await f.backend.invoke('createGenerationJobs', generation)).jobs.map(value => value.id)).toEqual(generated.jobs.map(value => value.id));
    await waitJob(f.backend, generated.jobs[0]!.id);
    expect(f.server.state.counts['image-edit']).toBe(1);
    expect(f.server.state.idempotencyCounts).toEqual({ [sha(generationKeyFor(generated.jobs[0]!.id, 1))]: 1 });
    const outputs = await f.backend.invoke('listOutputs', { projectId: f.project.id });
    expect(outputs.items).toHaveLength(1);
    const generatedPath = await f.backend.invokeHost('host.resolveResource', { ref: { kind: 'OUTPUT', id: outputs.items[0]!.id } });
    expect(await sharp(await readFile(generatedPath.path)).metadata()).toMatchObject({ width: 32, height: 24, format: 'png' });
    const requests = await f.backend.invoke('getJobRequests', { jobId: generated.jobs[0]!.id });
    expect(requests.items).toEqual([expect.objectContaining({ state: 'COMPLETED', localState: 'COMMITTED' })]);
    expect(JSON.stringify({ requests, outputs, board })).not.toMatch(/encryptedReceipt|bodyBase64|storagePath|encryptedApiKey/);
    expect(JSON.stringify({ requests, outputs, board })).not.toContain(FAKE_KEY);
    const duplicate = await f.backend.invoke('createGenerationJobs', generation);
    // 若回归已发生，先取消新意图，避免断言失败后的夹具清理前继续请求。
    for (const job of duplicate.jobs) if (!generated.jobs.some(original => original.id === job.id)) await f.backend.invoke('cancelJob', { jobId: job.id });
    expect(duplicate.jobs.map(value => value.id)).toEqual(generated.jobs.map(value => value.id));
    const retryMarker = await f.backend.invoke('createGenerationJobs', { ...generation, revision: 'retry' });
    expect(retryMarker.jobs.map(value => value.id)).toEqual(generated.jobs.map(value => value.id));
    expect(f.server.state.counts['image-edit']).toBe(1);
  });

  it('keeps a dropped paid request UNKNOWN across reopen and blocks both generic retry and duplicate domain submission', async () => {
    const f = await fixture(); const generated = await generate(f.backend, f.project.id);
    f.server.control.failNext('image-generation', { type: 'drop' });
    const request = { projectId: f.project.id, storyboardItemIds: [generated.board.items[0]!.id], revision: 'retry', generationConfig: { candidateCount: 2 } };
    const uncertain = await f.backend.invoke('createGenerationJobs', request);
    expect(uncertain.jobs).toHaveLength(2); expect(uncertain.jobs[0]!.id).toBe(generated.job.id);
    const newJob = uncertain.jobs.find(job => job.id !== generated.job.id)!;
    expect(newJob).toBeDefined();
    const snapshot = f.context.repository.getJob(newJob.id)!.input;
    await waitJob(f.backend, newJob.id, 'UNKNOWN');
    await expect(f.backend.invoke('retryJob', { jobId: newJob.id })).rejects.toMatchObject({ code: 'RETRY_UNSAFE' });
    expect(f.server.state.counts['image-generation']).toBe(2);
    await f.backend.close(); const reopened = await open(f.options);
    expect((await reopened.backend.invoke('getStoryboard', { projectId: f.project.id })).storyboard!.status).toBe('CONFIRMED');
    expect((await reopened.backend.invoke('getJob', { jobId: newJob.id })).status).toBe('UNKNOWN');
    expect((await reopened.backend.invoke('getJobRequests', { jobId: newJob.id })).items).toEqual([expect.objectContaining({ state: 'UNKNOWN' })]);
    expect(f.server.state.counts['image-generation']).toBe(2);
    expect((await reopened.backend.invoke('listOutputs', { projectId: f.project.id })).items).toEqual([generated.output]);
    const duplicate = await reopened.backend.invoke('createGenerationJobs', request);
    for (const job of duplicate.jobs) if (!uncertain.jobs.some(original => original.id === job.id)) await reopened.backend.invoke('cancelJob', { jobId: job.id });
    expect(duplicate.jobs.map(job => job.id)).toEqual(uncertain.jobs.map(job => job.id));
    expect(reopened.context.repository.getJob(newJob.id)!.input).toEqual(snapshot);
    expect(f.server.state.counts['image-generation']).toBe(2);
  });

  it('allows original CREATIVE planning without truth and executes real local recolor/seam checks without network requests', async () => {
    const f = await fixture();
    const { output } = await generate(f.backend, f.project.id);
    expect((await f.backend.invoke('listAssets', { projectId: f.project.id })).items).toEqual([]);
    const location = await f.backend.invokeHost('host.resolveResource', { ref: { kind: 'OUTPUT', id: output.id } });
    expect(await sharp(await readFile(location.path)).metadata()).toMatchObject({ width: 32, height: 24 });
    const counts = f.server.control.snapshot().counts;
    const pattern = await f.backend.invoke('uploadPattern', { name: '纯色花型', file: file(f.bytes) });
    const recolor = await f.backend.invoke('createPatternDeriveJob', { patternId: pattern.id, hueShift: 120 });
    await waitJob(f.backend, recolor.id);
    const patterns = await f.backend.invoke('listPatterns', {});
    const derived = patterns.items.find(value => value.sourceJobId === recolor.id)!;
    expect(derived).toMatchObject({ parentPatternId: pattern.id, width: 32, height: 24 });
    const bytes = await readFile((await f.backend.invokeHost('host.resolveResource', { ref: { kind: 'PATTERN', id: derived.id } })).path);
    const source = await sharp(f.bytes).ensureAlpha().raw().toBuffer(), changed = await sharp(bytes).ensureAlpha().raw().toBuffer();
    expect(changed.subarray(0, 3)).not.toEqual(source.subarray(0, 3));
    for (let index = 3; index < changed.length; index += 4) expect(changed[index]).toBe(source[index]);
    const check = await f.backend.invoke('createPatternTileCheckJob', { patternId: pattern.id });
    await waitJob(f.backend, check.id);
    expect(await f.backend.invoke('getPattern', { patternId: pattern.id })).toMatchObject({ tileable: 'VERIFIED', tileableScore: expect.any(Number) });
    expect(f.server.state.counts).toEqual(counts);
  });

  it('runs grounded SAM for manual/prompt layers, keeps source RGB/alpha and writes a readable PSD', async () => {
    const f = await fixture(); const { output } = await generate(f.backend, f.project.id);
    const before = f.server.control.snapshot().counts;
    const result = await f.backend.invoke('createLayerExport', { outputId: output.id, includeBackground: true, elements: [
      { id: 'manual-cup', name: '框选杯身', source: 'manual', bbox: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } },
      { id: 'prompt-cup', name: 'ceramic cup', source: 'prompt' },
    ] });
    await waitJob(f.backend, result.job.id);
    expect(f.server.state.counts['grounded-sam'] - before['grounded-sam']).toBe(2);
    expect(f.server.state.counts['image-generation']).toBe(before['image-generation']);
    expect(f.server.state.counts.chat).toBe(before.chat);
    const layers = await f.backend.invoke('getLayerExport', { outputId: output.id });
    expect(layers.status).toBe('SUCCEEDED'); expect(layers.layerFiles).toHaveLength(4);
    const originalPath = await f.backend.invokeHost('host.resolveResource', { ref: { kind: 'OUTPUT', id: output.id } });
    const source = await sharp(await readFile(originalPath.path)).ensureAlpha().raw().toBuffer();
    for (const index of [1, 2]) {
      const handle = await f.backend.invoke('downloadLayerExportLayer', { layerExportId: result.layerExport.id, layerIndex: index });
      const rgba = await sharp(await readFile((await f.backend.invokeHost('host.resolveResource', { ref: handle.ref })).path)).ensureAlpha().raw().toBuffer();
      assertSelectedPixels(source, rgba);
    }
    const handle = await f.backend.invoke('downloadLayerExport', { layerExportId: result.layerExport.id });
    const psd = readPsd(await readFile((await f.backend.invokeHost('host.resolveResource', { ref: handle.ref })).path), { skipCompositeImageData: true, skipLayerImageData: true });
    expect(psd).toMatchObject({ width: 32, height: 24 });
    expect(psd.children?.map(value => value.name)).toEqual(['背景', '01 框选杯身', '02 ceramic cup']);
    const requests = await f.backend.invoke('getJobRequests', { jobId: result.job.id });
    expect(requests.items).toHaveLength(2);
    expect(new Set(requests.items.map(value => value.requestKey)).size).toBe(2);
    expect(requests.items.every(value => value.state === 'COMPLETED' && value.localState === 'COMMITTED')).toBe(true);
  });

  it('recovers an interrupted v3 external request as UNKNOWN without dispatch, retry or changed original snapshot', async () => {
    const f = await fixture(); const generated = await generate(f.backend, f.project.id);
    const request = { projectId: f.project.id, storyboardItemIds: [generated.board.items[0]!.id], revision: 'retry', generationConfig: { candidateCount: 2 } };
    const created = await f.backend.invoke('createGenerationJobs', request);
    expect(created.jobs).toHaveLength(2); expect(created.jobs[0]!.id).toBe(generated.job.id);
    const newJob = created.jobs.find(job => job.id !== generated.job.id)!;
    expect(newJob).toBeDefined();
    expect((await f.backend.invoke('getJobRequests', { jobId: newJob.id })).items).toEqual([]);
    await f.backend.close(); const before = f.server.control.snapshot().counts;
    const db = openDatabase(join(f.options.dataDir, 'backend.sqlite'));
    let original: unknown;
    try {
      const repository = new EcomRepository(db), store = new RuntimeStore(db);
      original = store.get(newJob.id)!.snapshot;
      repository.updateJob(newJob.id, { status: 'RUNNING' });
      store.mutate(newJob.id, runtime => { runtime.phase = 'EXECUTING'; runtime.runToken = 'dead-process'; runtime.attempt = 1; });
      const ledger = new RequestLedger(store, new SecretBox(Buffer.from(f.options.masterKey, 'base64')));
      ledger.forJob(newJob.id, new AbortController().signal).begin({ requestKey: 'interrupted-candidate:1', fingerprint: 'b'.repeat(64), purpose: 'IMAGE' });
    } finally { db.close(); }
    const reopened = await open(f.options);
    await waitJob(reopened.backend, newJob.id, 'UNKNOWN');
    await expect(reopened.backend.invoke('retryJob', { jobId: newJob.id })).rejects.toMatchObject({ code: 'RETRY_UNSAFE' });
    expect((await reopened.backend.invoke('getJobRequests', { jobId: newJob.id })).items).toEqual([expect.objectContaining({ state: 'UNKNOWN' })]);
    const connection = (reopened.context.repository as unknown as { db: Database.Database }).db;
    expect(new RuntimeStore(connection).get(newJob.id)!.snapshot).toEqual(original);
    const duplicate = await reopened.backend.invoke('createGenerationJobs', request);
    expect(duplicate.jobs.map(job => job.id)).toEqual(created.jobs.map(job => job.id));
    expect((await reopened.backend.invoke('listOutputs', { projectId: f.project.id })).items).toEqual([generated.output]);
    expect(f.server.state.counts).toEqual(before);
    expect(before['image-generation']).toBe(1);
  });

  it('cooperatively closes an active real executor and reopens its durable cancellation without output', async () => {
    let closeId: string | undefined, closing: Promise<void> | undefined;
    let subject: Awaited<ReturnType<typeof fixture>> | undefined;
    const f = await fixture({ onChange: event => {
      if (subject && event.aggregateId === closeId && subject.context.repository.getJob(closeId!)?.status === 'RUNNING') {
        closeId = undefined; closing = subject.backend.close();
      }
    } });
    subject = f; const { output } = await generate(f.backend, f.project.id);
    const job = await f.backend.invoke('createExportJob', { projectId: f.project.id, outputIds: [output.id] }); closeId = job.job.id;
    await poll(async () => closing ? true : undefined, 'cooperative close'); await closing;
    await expect(f.backend.invoke('getHealth', {})).rejects.toMatchObject({ code: 'CLOSING' });
    const reopened = await open(f.options);
    expect((await reopened.backend.invoke('getJob', { jobId: job.job.id })).status).toBe('CANCELLED');
    expect((await reopened.backend.invoke('getExport', { exportId: job.export!.id })).status).toBe('CANCELLED');
    await expect(reopened.backend.invoke('downloadExport', { exportId: job.export!.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each([1, 2] as const)('opens published v%s history through canonical Backend, preserves ciphertext/IDs/files and never executes historical payloads', async version => {
    const root = await directory(), key = randomBytes(32), projectId = randomUUID(), providerId = randomUUID(), assetId = randomUUID(), completedId = randomUUID(), pendingId = randomUUID();
    const ciphertext = new SecretBox(key).encrypt(FAKE_KEY), time = '2026-11-01T12:00:00.000Z';
    const originalSnapshot = '{ "oldPayload": true, "mustNeverExecute": true }';
    const image = await sharp({ create: { width: 8, height: 6, channels: 4, background: '#dd5533' } }).png().toBuffer();
    await mkdir(join(root, 'assets')); await mkdir(join(root, 'exports'));
    await writeFile(join(root, 'assets', `${assetId}.png`), image);
    const archive = Buffer.from('preserved historical archive bytes'); await writeFile(join(root, 'exports', `${completedId}.zip`), archive);
    const db = new Database(join(root, 'backend.sqlite'));
    try {
      db.exec(`
        CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
        CREATE TABLE assets(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,mimeType TEXT NOT NULL,size INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,createdAt TEXT NOT NULL,file TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL);
        CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,protocol TEXT NOT NULL,baseUrl TEXT NOT NULL,model TEXT NOT NULL,encryptedKey TEXT NOT NULL,updatedAt TEXT NOT NULL);
        CREATE TABLE jobs(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL CHECK(kind ${version === 1 ? "='EXPORT'" : "IN ('EXPORT','PLAN','GENERATE','SEGMENT','LAYER','PATTERN','SUITE','PI_AGENT')"}),status TEXT NOT NULL,progress REAL NOT NULL DEFAULT 0,cancelRequested INTEGER NOT NULL DEFAULT 0,error TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,resultName TEXT,fingerprint TEXT NOT NULL,snapshot TEXT NOT NULL${version === 2 ? ",requestState TEXT NOT NULL DEFAULT 'NOT_SENT'" : ''});
        CREATE UNIQUE INDEX jobs_dedupe ON jobs(fingerprint) WHERE status IN ('QUEUED','RUNNING','SUCCEEDED'${version === 2 ? ",'UNKNOWN'" : ''});
        PRAGMA user_version=${version};
      `);
      if (version === 2) db.exec(`
        ALTER TABLE assets ADD COLUMN role TEXT NOT NULL DEFAULT 'STYLE_REFERENCE';
        ALTER TABLE providers ADD COLUMN reasoningProtocol TEXT NOT NULL DEFAULT 'openai';
        ALTER TABLE providers ADD COLUMN supportsVision INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE providers ADD COLUMN supportsThinking INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE providers ADD COLUMN supportsStructuredOutput INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE project_business(projectId TEXT PRIMARY KEY REFERENCES projects(id),settings TEXT NOT NULL);
        CREATE TABLE storyboards(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),jobId TEXT NOT NULL UNIQUE REFERENCES jobs(id),version INTEGER NOT NULL,confirmed INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,UNIQUE(projectId,version));
        CREATE TABLE job_results(jobId TEXT PRIMARY KEY REFERENCES jobs(id),data TEXT NOT NULL);
      `);
      db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(projectId, '已有商品', '已有描述', time, time);
      db.prepare('INSERT INTO providers(id,name,protocol,baseUrl,model,encryptedKey,updatedAt) VALUES(?,?,?,?,?,?,?)').run(providerId, '已有服务', 'OPENAI', 'http://127.0.0.1:1/v1', 'existing', ciphertext, time);
      db.prepare('INSERT INTO assets(id,projectId,name,mimeType,size,width,height,createdAt,file,sha256) VALUES(?,?,?,?,?,?,?,?,?,?)').run(assetId, projectId, 'old.png', 'image/png', image.length, 8, 6, time, `assets/${assetId}.png`, sha(image));
      const add = db.prepare('INSERT INTO jobs(id,projectId,kind,status,progress,createdAt,updatedAt,resultName,fingerprint,snapshot) VALUES(?,?,?,?,?,?,?,?,?,?)');
      add.run(completedId, projectId, 'EXPORT', 'SUCCEEDED', 100, time, time, '已有导出.zip', 'original-completed-fingerprint', originalSnapshot);
      add.run(pendingId, projectId, version === 2 ? 'GENERATE' : 'EXPORT', version === 2 ? 'RUNNING' : 'QUEUED', 25, time, time, null, 'original-pending-fingerprint', originalSnapshot);
      if (version === 2) db.prepare("UPDATE jobs SET requestState='IN_FLIGHT' WHERE id=?").run(pendingId);
    } finally { db.close(); }
    const options = { dataDir: root, masterKey: key.toString('base64'), version: 'migration-regression' };
    const opened = await open(options);
    expect((await opened.backend.invoke('listProjects', {})).items[0]).toMatchObject({ id: projectId, name: '已有商品' });
    expect((await opened.backend.invoke('listProviders', {})).items[0]).toMatchObject({ id: providerId, hasApiKey: true });
    expect(opened.context.repository.getProvider(providerId)!.encryptedApiKey).toBe(ciphertext);
    expect(opened.context.repository.getPreservedJobHistory(completedId)).toMatchObject({ snapshotJson: originalSnapshot, resultName: '已有导出.zip', artifactPath: `exports/${completedId}.zip` });
    expect(opened.context.repository.getJob(pendingId)).toMatchObject({ preservedHistory: true, retryable: false, status: version === 2 ? 'UNKNOWN' : 'CANCELLED', requestFingerprint: 'original-pending-fingerprint', input: JSON.parse(originalSnapshot) });
    await expect(opened.backend.invoke('retryJob', { jobId: pendingId })).rejects.toMatchObject({ code: 'RETRY_UNSAFE' });
    const handle = await opened.backend.invoke('downloadAsset', { assetId });
    expect(await readFile((await opened.backend.invokeHost('host.resolveResource', { ref: handle.ref })).path)).toEqual(image);
    expect(await readFile(join(root, 'exports', `${completedId}.zip`))).toEqual(archive);
    expect((await opened.backend.invoke('getJobRequests', { jobId: pendingId })).items).toEqual([]);
    await opened.backend.close();
    const inspect = new Database(join(root, 'backend.sqlite'), { readonly: true });
    try { expect(inspect.pragma('user_version', { simple: true })).toBe(11); expect(inspect.pragma('integrity_check', { simple: true })).toBe('ok'); expect(inspect.pragma('foreign_key_check')).toEqual([]); expect(inspect.prepare('SELECT COUNT(*) n FROM desktop_job_runtime').get()).toEqual({ n: 0 }); } finally { inspect.close(); }
    const reopened = await open(options);
    expect((await reopened.backend.invoke('getJob', { jobId: completedId })).status).toBe('SUCCEEDED');
    expect(reopened.context.repository.getPreservedJobHistory(completedId)!.snapshotJson).toBe(originalSnapshot);
  });
});
