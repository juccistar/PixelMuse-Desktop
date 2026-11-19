import { describe, expect, it } from 'vitest';
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { EcomRepository, LocalAssetStore, openDatabase } from '@ecomgen/core';
import { BackendError, createBackend, ResourceRegistry, RuntimeStore, type Backend, type CommandContext } from '../src/index.js';
import { FAKE_KEY, file, generate, managedFiles, poll, regressionFixtures, unzip, waitJob } from './desktop-regression-helpers.js';

const { fixture, open } = regressionFixtures();

describe('canonical desktop backend regressions', { timeout: 120000 }, () => {
  it('persists projects and resources across owners and enforces public/trusted-host boundaries', async () => {
    const f = await fixture();
    const updated = await f.backend.invoke('updateProject', { projectId: f.project.id, name: '更新项目', productDescription: '已更新' });
    const asset = await f.backend.invoke('uploadAsset', { projectId: f.project.id, file: file(f.bytes), kind: 'PRODUCT' });
    const handle = await f.backend.invoke('downloadAsset', { assetId: asset.id });
    expect(handle).toEqual({ ref: { kind: 'ASSET', id: asset.id }, mimeType: 'image/png' });
    expect(await f.backend.invoke('getResource', { ref: handle.ref })).toEqual(handle);
    const trusted = await f.backend.invokeHost('host.resolveResource', { ref: handle.ref });
    expect(await readFile(trusted.path)).toEqual(f.bytes);
    expect(JSON.stringify({ updated, asset, handle })).not.toMatch(/storagePath|encryptedApiKey|masterKey/);
    expect(JSON.stringify({ updated, asset, handle })).not.toContain(f.options.dataDir);
    await expect(f.backend.invoke('listAssets', { projectId: f.project.id, paths: ['C:/private'] } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.backend.invoke('uploadAsset', { projectId: f.project.id, path: trusted.path } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.backend.invoke('host.resolveResource' as never, { ref: handle.ref } as never)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' });
    await expect(f.backend.invoke('__proto__' as never, {} as never)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' });
    await expect(f.backend.invokeHost('host.resolveResource', { ref: { kind: 'ASSET', id: '../../outside' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.backend.invoke('updateProject', { projectId: f.project.id, name: '' })).rejects.toBeInstanceOf(BackendError);
    await expect(createBackend(f.options)).rejects.toMatchObject({ code: 'BACKEND_IN_USE' });
    await f.backend.close();
    const reopened = await open(f.options);
    expect((await reopened.backend.invoke('listProjects', {})).items).toContainEqual(expect.objectContaining({ id: updated.id, name: updated.name, productDescription: '已更新' }));
    expect(await reopened.backend.invokeHost('host.resolveResource', { ref: handle.ref })).toEqual(trusted);
    await expect(f.backend.invoke('getHealth', {})).rejects.toMatchObject({ code: 'CLOSING' });
  });

  it('decodes PNG/JPEG/WebP, owns copied bytes, and rejects SVG, malformed, unsupported and oversized imports atomically', async () => {
    const f = await fixture();
    const source = join(f.root, 'source.png'); await writeFile(source, f.bytes);
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const bytes = await sharp(f.bytes).toFormat(format).toBuffer();
      const asset = await f.backend.invoke('uploadAsset', { projectId: f.project.id, file: file(bytes, `source.${format}`, `image/${format}`), kind: 'REFERENCE' });
      expect(asset).toMatchObject({ width: 32, height: 24, mimeType: `image/${format}` });
      expect(asset).not.toHaveProperty('storagePath');
      const target = await f.backend.invokeHost('host.resolveResource', { ref: { kind: 'ASSET', id: asset.id } });
      expect(target.path).not.toBe(source); expect(await readFile(target.path)).toEqual(bytes);
    }
    await rm(source);
    const before = await managedFiles(f.options.dataDir);
    const assets = await f.backend.invoke('listAssets', { projectId: f.project.id });
    for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), Buffer.from('not an image'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])]) {
      await expect(f.backend.invoke('uploadAsset', { projectId: f.project.id, file: file(bytes) })).rejects.toBeInstanceOf(BackendError);
    }
    await expect(f.backend.invoke('uploadAsset', { projectId: f.project.id, file: { name: 'x.gif', mimeType: 'image/gif', base64: Buffer.from('GIF89a').toString('base64') } } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const oversized = Buffer.alloc(50 * 1024 * 1024 + 1); f.bytes.copy(oversized);
    await expect(f.backend.invoke('uploadAsset', { projectId: f.project.id, file: file(oversized) })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // 新版上传是逐文件命令；实际多文件入口是套图反推，所有图片验证后才能写入或创建意图。
    await expect(f.backend.invoke('createSuiteForgeJob', { providerId: f.provider.id, modelId: 'mock-reasoner', files: [file(f.bytes), file(Buffer.from('broken'))] })).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    expect(await f.backend.invoke('listAssets', { projectId: f.project.id })).toEqual(assets);
    expect(await f.backend.invoke('listJobs', {})).toEqual({ items: [] });
    expect(await managedFiles(f.options.dataDir)).toEqual(before);
    const original = assets.items[0]!;
    expect(await readFile((await f.backend.invokeHost('host.resolveResource', { ref: { kind: 'ASSET', id: original.id } })).path)).toEqual(f.bytes);
  });

  it.each(['avif', 'tiff'] as const)('preserves published %s file-import support with real decoded bytes', async format => {
    const f = await fixture();
    const bytes = await sharp(f.bytes).toFormat(format).toBuffer();
    // AVIF/TIFF 是已发布桌面入口支持的格式；故意经公开边界验证当前 schema 是否错误收窄。
    const asset = await f.backend.invoke('uploadAsset', { projectId: f.project.id, file: { name: `source.${format}`, mimeType: `image/${format}`, base64: bytes.toString('base64') } } as never);
    expect(asset).toMatchObject({ width: 32, height: 24, mimeType: `image/${format}` });
    expect(await readFile((await f.backend.invokeHost('host.resolveResource', { ref: { kind: 'ASSET', id: asset.id } })).path)).toEqual(bytes);
  });

  it('persists actual AES-GCM ciphertext and preserves an omitted provider key across reopen', async () => {
    const f = await fixture();
    const original = f.context.repository.getProvider(f.provider.id)!.encryptedApiKey;
    await f.backend.invoke('updateProvider', { providerId: f.provider.id, name: '已更新服务' });
    expect(f.context.repository.getProvider(f.provider.id)!.encryptedApiKey).toBe(original);
    await expect(f.backend.invoke('updateProvider', { providerId: f.provider.id, apiKey: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const bytes = Buffer.from(original, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(f.options.masterKey, 'base64'), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    expect(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()).toBe(FAKE_KEY);
    await f.backend.close();
    expect((await readFile(join(f.options.dataDir, 'backend.sqlite'))).includes(Buffer.from(FAKE_KEY))).toBe(false);
    const reopened = await open(f.options);
    expect(reopened.context.repository.getProvider(f.provider.id)!.encryptedApiKey).toBe(original);
    const providers = await reopened.backend.invoke('listProviders', {});
    expect(providers.items).toContainEqual(expect.objectContaining({ id: f.provider.id, name: '已更新服务', hasApiKey: true }));
    expect(JSON.stringify(providers)).not.toMatch(new RegExp(`${FAKE_KEY}|encryptedApiKey`));
    await reopened.backend.invoke('deleteProvider', { providerId: f.provider.id });
    expect((await reopened.backend.invoke('listProviders', {})).items).toEqual([]);
  });

  it('deduplicates selected generated-output exports and writes actual ZIP bytes plus a safe frozen manifest', async () => {
    const f = await fixture();
    await f.backend.invoke('uploadAsset', { projectId: f.project.id, file: file(f.bytes), kind: 'PRODUCT' });
    await expect(f.backend.invoke('createExportJob', { projectId: f.project.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    const generated = await generate(f.backend, f.project.id);
    const request = { projectId: f.project.id, outputIds: [generated.output.id] };
    const exports = await Promise.all(Array.from({ length: 8 }, () => f.backend.invoke('createExportJob', request)));
    expect(new Set(exports.map(value => value.job.id)).size).toBe(1);
    expect(exports.filter(value => !value.reused)).toHaveLength(1);
    const submitted = exports[0]!; expect(submitted.export).not.toBeNull();
    const snapshot = f.context.repository.getJob(submitted.job.id)!.input;
    await f.backend.invoke('updateProject', { projectId: f.project.id, name: '排队后修改的名称', verifiedFacts: ['后续事实'] });
    expect((await waitJob(f.backend, submitted.job.id)).progress).toBe(100);
    const handle = await f.backend.invoke('downloadExport', { exportId: submitted.export!.id });
    expect(handle.ref).toEqual({ kind: 'EXPORT', id: submitted.export!.id });
    const files = unzip(await readFile((await f.backend.invokeHost('host.resolveResource', { ref: handle.ref })).path));
    expect(files.size).toBe(2);
    const images = [...files].filter(([name]) => name !== 'manifest.json'); expect(images).toHaveLength(1);
    const outputBytes = await readFile((await f.backend.invokeHost('host.resolveResource', { ref: { kind: 'OUTPUT', id: generated.output.id } })).path);
    expect(images[0]![1]).toEqual(outputBytes);
    const manifestText = files.get('manifest.json')!.toString();
    const manifest = JSON.parse(manifestText);
    expect(manifest.project).toMatchObject({ id: f.project.id, name: '陶瓷杯' });
    expect(manifest.facts.verified).toEqual(['陶瓷杯']);
    expect(manifest.storyboard).toEqual([expect.objectContaining({ outputId: generated.output.id, jobId: generated.job.id, sha256: generated.output.hash })]);
    expect(manifestText).not.toContain(f.options.dataDir); expect(manifestText).not.toContain(FAKE_KEY);
    expect(manifestText).not.toMatch(/storagePath|encryptedApiKey|encryptedReceipt|bodyBase64/);
    expect(f.context.repository.getJob(submitted.job.id)!.input).toEqual(snapshot);
    expect((await f.backend.invoke('createExportJob', request)).job.id).toBe(submitted.job.id);
    const more = await f.backend.invoke('createGenerationJobs', { projectId: f.project.id, storyboardItemIds: [generated.output.storyboardItemId], revision: 'retry', generationConfig: { candidateCount: 2 } });
    expect(more.jobs).toHaveLength(2);
    expect(more.jobs[0]!.id).toBe(generated.job.id);
    const newJob = more.jobs.find(job => job.id !== generated.job.id)!;
    expect(newJob).toBeDefined();
    await waitJob(f.backend, newJob.id);
    const outputs = (await f.backend.invoke('listOutputs', { projectId: f.project.id })).items;
    expect(outputs).toHaveLength(2); expect(outputs).toContainEqual(generated.output);
    expect(f.server.state.counts['image-generation']).toBe(2);
    const next = outputs.find(value => value.jobId === newJob.id)!;
    expect(next.id).not.toBe(generated.output.id);
    expect((await f.backend.invoke('createExportJob', { projectId: f.project.id, outputIds: [next.id] })).job.id).not.toBe(submitted.job.id);
  });

  it('cancels queued/active real exports, leaves no output and retries only an explicit safe local intent', async () => {
    let subject: Backend | undefined, context: CommandContext | undefined, cancelId: string | undefined, cancelling: Promise<unknown> | undefined;
    const f = await fixture({ onChange: event => {
      if (subject && context && event.aggregateId === cancelId && context.repository.getJob(cancelId!)?.status === 'RUNNING') {
        const id = cancelId!; cancelId = undefined; cancelling = subject.invoke('cancelJob', { jobId: id });
      }
    } });
    subject = f.backend; context = f.context;
    const { output } = await generate(f.backend, f.project.id);
    const queued = await f.backend.invoke('createExportJob', { projectId: f.project.id, outputIds: [output.id] });
    expect((await f.backend.invoke('cancelJob', { jobId: queued.job.id })).status).toBe('CANCELLED');
    await expect(f.backend.invoke('downloadExport', { exportId: queued.export!.id })).rejects.toBeInstanceOf(BackendError);
    cancelId = queued.job.id;
    await f.backend.invoke('retryJob', { jobId: queued.job.id });
    await poll(async () => cancelling ? true : undefined, 'active export cancellation'); await cancelling;
    await waitJob(f.backend, queued.job.id, 'CANCELLED'); await f.context.scheduler.waitForIdle([queued.job.id]);
    expect(await managedFiles(join(f.options.dataDir, 'exports'))).toEqual([]);
    expect((await f.backend.invoke('getExport', { exportId: queued.export!.id })).status).toBe('CANCELLED');
    await f.backend.invoke('retryJob', { jobId: queued.job.id });
    await waitJob(f.backend, queued.job.id);
    expect((await f.backend.invoke('getExport', { exportId: queued.export!.id })).status).toBe('SUCCEEDED');
  });

  it.each([false, true])('recovers a real v3 frozen local export with persisted cancel=%s and preserves immutable input', async cancelled => {
    const f = await fixture(); const { output } = await generate(f.backend, f.project.id);
    const submitted = await f.backend.invoke('createExportJob', { projectId: f.project.id, outputIds: [output.id] });
    await f.backend.close();
    // 模拟崩溃只改 v3 运行状态；快照来自真正提交，不制造旧版可执行 payload。
    const db = openDatabase(join(f.options.dataDir, 'backend.sqlite'));
    let snapshot: unknown;
    const interruptedPaths = [join('tmp', randomUUID()), join('exports', f.project.id, `${randomUUID()}.zip`)];
    try {
      const repository = new EcomRepository(db), store = new RuntimeStore(db), storage = new LocalAssetStore(f.options.dataDir);
      const resources = new ResourceRegistry(store, storage);
      await mkdir(join(f.options.dataDir, 'exports', f.project.id), { recursive: true });
      // v3 不再按旧固定 job.zip.partial 名称猜文件；崩溃遗留物必须有持久受管回收意图。
      for (const relativePath of interruptedPaths) {
        const bytes = Buffer.from('interrupted, unpublished output');
        await writeFile(storage.absolute(relativePath), bytes);
        const ref = { kind: 'SUITE_SOURCE', id: `interrupted-${randomUUID()}` } as const;
        resources.register({ ref, relativePath, hash: createHash('sha256').update(bytes).digest('hex'), mimeType: 'application/octet-stream', owners: [] });
        resources.scheduleCleanup(ref);
      }
      snapshot = store.get(submitted.job.id)!.snapshot;
      repository.updateJob(submitted.job.id, { status: 'RUNNING', progress: 50, cancelRequested: cancelled });
      store.mutate(submitted.job.id, runtime => { runtime.phase = 'EXECUTING'; runtime.runToken = 'interrupted-local-attempt'; runtime.attempt = 1; });
    } finally { db.close(); }
    const reopened = await open(f.options);
    for (const relativePath of interruptedPaths) await expect(readFile(join(f.options.dataDir, relativePath))).rejects.toMatchObject({ code: 'ENOENT' });
    await waitJob(reopened.backend, submitted.job.id, cancelled ? 'CANCELLED' : 'SUCCEEDED');
    expect(reopened.context.repository.getJob(submitted.job.id)!.cancelRequested).toBe(cancelled);
    expect((await reopened.backend.invoke('listJobs', { projectId: f.project.id, type: 'EXPORT' })).items).toHaveLength(1);
    expect((new RuntimeStore((reopened.context.repository as unknown as { db: Database.Database }).db)).get(submitted.job.id)!.snapshot).toEqual(snapshot);
    if (cancelled) {
      expect(await managedFiles(join(f.options.dataDir, 'exports'))).toEqual([]);
      await reopened.backend.invoke('retryJob', { jobId: submitted.job.id }); await waitJob(reopened.backend, submitted.job.id);
    }
    const handle = await reopened.backend.invoke('downloadExport', { exportId: submitted.export!.id });
    expect(unzip(await readFile((await reopened.backend.invokeHost('host.resolveResource', { ref: handle.ref })).path)).has('manifest.json')).toBe(true);
  });

  it('rejects a corrupted persisted resource path after restart without reading outside managed storage', async () => {
    const f = await fixture();
    const asset = await f.backend.invoke('uploadAsset', { projectId: f.project.id, file: file(f.bytes), kind: 'REFERENCE' });
    const outside = join(f.root, 'outside.png'); await writeFile(outside, f.bytes);
    await f.backend.close();
    const db = new Database(join(f.options.dataDir, 'backend.sqlite'));
    try {
      const key = `ASSET:${asset.id}`;
      const row = db.prepare('SELECT payload FROM desktop_resources WHERE id=?').get(key) as { payload: string };
      const payload = JSON.parse(row.payload); payload.relativePath = '../outside.png';
      db.prepare('UPDATE desktop_resources SET payload=? WHERE id=?').run(JSON.stringify(payload), key);
    } finally { db.close(); }
    const reopened = await open(f.options), ref = { kind: 'ASSET', id: asset.id } as const;
    for (const read of [() => reopened.backend.invoke('getResource', { ref }), () => reopened.backend.invokeHost('host.resolveResource', { ref })]) {
      let failure: unknown;
      try { await read(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(BackendError);
      expect(JSON.stringify(failure)).not.toContain(outside);
      expect(JSON.stringify(failure)).not.toContain(f.options.dataDir);
    }
    expect(await readFile(outside)).toEqual(f.bytes);
  });

  it('rejects changed resource bytes on both public and trusted-host reads and fails frozen exports', async () => {
    const f = await fixture(); const { output } = await generate(f.backend, f.project.id);
    const ref = { kind: 'OUTPUT', id: output.id } as const;
    const trusted = await f.backend.invokeHost('host.resolveResource', { ref });
    await writeFile(trusted.path, 'changed bytes');
    await expect(f.backend.invoke('getResource', { ref })).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' });
    await expect(f.backend.invokeHost('host.resolveResource', { ref })).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' });
    const submitted = await f.backend.invoke('createExportJob', { projectId: f.project.id, outputIds: [output.id] });
    await waitJob(f.backend, submitted.job.id, 'FAILED');
    expect(await managedFiles(join(f.options.dataDir, 'exports'))).toEqual([]);
  });
});
