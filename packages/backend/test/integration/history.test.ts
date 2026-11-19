import { describe, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { readPsd } from 'ag-psd';
import { LocalAssetStore, openDatabase } from '@ecomgen/core';
import { ResourceRegistry, RuntimeStore } from '../../src/index.js';
import { startFullMockProvider } from '../../../../scripts/full-mock-provider.mjs';
import { integrationFixtures, unzip } from './fixtures.js';
import { publishedFixture, sha } from './history-fixtures.js';
const { directory, open } = integrationFixtures();
function inspect<T>(root: string, work: (db: Database.Database) => T): T {
  const db = new Database(join(root, 'backend.sqlite'), { readonly: true });
  try { return work(db); } finally { db.close(); }
}

describe('published desktop history through production Backend', () => {
  it.each([1, 2] as const)('lazily exposes v%s originals, real files and non-executable results without manufacturing Outputs or Patterns', async version => {
    const root = await directory(); const source = await publishedFixture(root, version);
    const { ids, options } = source;
    let backend = await open(options); await backend.close();
    const originalHistory = inspect(root, db => {
      expect(db.prepare('SELECT COUNT(*) n FROM desktop_resources').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) n FROM desktop_job_runtime').get()).toEqual({ n: 0 });
      return db.prepare('SELECT * FROM desktop_job_history ORDER BY job_id').all();
    });
    backend = await open(options);
    // 首次宿主访问不依赖先调用listAssets/downloadAsset。
    const assetLocation = await backend.invokeHost('host.resolveResource', { ref: { kind: 'ASSET', id: ids.asset } });
    expect(await readFile(assetLocation.path)).toEqual(source.image);
    const completed = await backend.invoke('getJob', { jobId: ids.export });
    expect(completed.history).toMatchObject({ sourceVersion: version, kind: 'EXPORT', executable: false, originalStatus: 'SUCCEEDED',
      resultStatus: 'NONE', files: [{ ref: { kind: 'EXPORT', id: ids.export }, available: true, name: '已有导出.zip' }] });
    const handle = await backend.invoke('getResource', { ref: { kind: 'EXPORT', id: ids.export } });
    const location = await backend.invokeHost('host.resolveResource', { ref: handle.ref });
    expect(unzip(await readFile(location.path)).get('已有图片.png')).toEqual(source.image);
    const pending = await backend.invoke('getJob', { jobId: ids.unknown });
    expect(pending).toMatchObject({ status: version === 2 ? 'UNKNOWN' : 'CANCELLED', retryable: false,
      history: { executable: false, requestState: version === 2 ? 'IN_FLIGHT' : 'NOT_SENT' } });
    await expect(backend.invoke('retryJob', { jobId: ids.unknown })).rejects.toMatchObject({ code: 'RETRY_UNSAFE' });
    expect((await backend.invoke('getJobRequests', { jobId: ids.unknown })).items).toEqual([]);
    expect((await backend.invoke('listOutputs', { projectId: ids.project })).items).toEqual([]);
    expect((await backend.invoke('listPatterns', {})).items).toEqual([]);
    if (version === 2) {
      const generated = await backend.invoke('getJob', { jobId: ids.generated });
      expect(generated.history).toMatchObject({ resultStatus: 'AVAILABLE', result: { assetIds: [ids.asset] }, files: [{ ref: { kind: 'ASSET', id: ids.asset }, available: true }] });
      expect(generated.history!.result).not.toHaveProperty('receipt'); expect(generated.history!.result).not.toHaveProperty('privateSnapshot');
      const layer = await backend.invoke('getJob', { jobId: ids.layer });
      expect(layer.history!.files[1]).toMatchObject({ ref: { kind: 'LAYER_PSD', id: ids.layer }, available: true });
      const psdLocation = await backend.invokeHost('host.resolveResource', { ref: layer.history!.files[1]!.ref });
      expect(readPsd(await readFile(psdLocation.path), { skipCompositeImageData: true, skipLayerImageData: true })).toMatchObject({ width: 8, height: 6 });
      expect((await backend.invoke('getJob', { jobId: ids.plan })).history!.result).toEqual({ assetIds: [], storyboardId: ids.board });
      expect((await backend.invoke('getJob', { jobId: ids.suite })).history!.result).toEqual({ assetIds: [], text: source.suiteText });
    }
    const jobs = await backend.invoke('listJobs', { projectId: ids.project });
    expect(jobs.items.every(job => job.history?.executable === false)).toBe(true);
    const publicJson = JSON.stringify(jobs);
    for (const privateValue of [source.snapshot, source.ciphertext, root, 'bodyBase64', 'privateSnapshot', 'C:/private', 'storagePath']) expect(publicJson).not.toContain(privateValue);
    await backend.close();
    inspect(root, db => {
      expect(db.prepare('SELECT * FROM desktop_job_history ORDER BY job_id').all()).toEqual(originalHistory);
      expect(db.prepare('SELECT input_json,request_fingerprint FROM jobs WHERE id=?').get(ids.unknown)).toEqual({ input_json: source.snapshot, request_fingerprint: `original-${ids.unknown}` });
      expect(db.prepare('SELECT encrypted_api_key FROM providers WHERE id=?').get(ids.provider)).toEqual({ encrypted_api_key: source.ciphertext });
      expect(db.prepare('SELECT COUNT(*) n FROM outputs').get()).toEqual({ n: 0 }); expect(db.prepare('SELECT COUNT(*) n FROM patterns').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) n FROM desktop_job_runtime').get()).toEqual({ n: 0 });
      const records = (db.prepare('SELECT payload FROM desktop_resources').all() as { payload: string }[]).map(row => JSON.parse(row.payload));
      expect(records.find(row => row.ref.id === ids.asset).owners).toContain(`history:project:${ids.project}`);
      expect(records.find(row => row.ref.id === ids.export).owners).toEqual(expect.arrayContaining([`job:${ids.export}`, `history:job:${ids.export}`]));
      expect(db.pragma('foreign_key_check')).toEqual([]); expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    });
    backend = await open(options);
    expect((await backend.invoke('getJob', { jobId: ids.export })).history!.files[0]!.available).toBe(true);
  });

  it('keeps missing/tampered images, ZIP and PSD unavailable across reopen without altering original history', async () => {
    const root = await directory(); const source = await publishedFixture(root, 2);
    const { ids, options } = source; let backend = await open(options);
    await backend.invoke('getJob', { jobId: ids.layer }); await backend.invoke('getJob', { jobId: ids.export });
    await backend.close();
    const before = inspect(root, db => db.prepare('SELECT * FROM desktop_job_history ORDER BY job_id').all());
    await writeFile(join(root, 'assets', `${ids.asset}.png`), await sharp(source.image).negate().png().toBuffer());
    await writeFile(join(root, 'exports', `${ids.layer}.psd`), Buffer.concat([source.psd, Buffer.from('tampered')]));
    await rm(join(root, 'exports', `${ids.export}.zip`));
    for (let reopen = 0; reopen < 2; reopen++) {
      backend = await open(options);
      const layer = await backend.invoke('getJob', { jobId: ids.layer });
      expect(layer.history).toMatchObject({ resultStatus: 'AVAILABLE', result: { assetIds: [ids.asset] } });
      expect(layer.history!.files.every(file => !file.available)).toBe(true);
      expect((await backend.invoke('getJob', { jobId: ids.export })).history!.files[0]!.available).toBe(false);
      for (const ref of [{ kind: 'ASSET', id: ids.asset }, { kind: 'LAYER_PSD', id: ids.layer }] as const) await expect(backend.invoke('getResource', { ref })).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' });
      await expect(backend.invokeHost('host.resolveResource', { ref: { kind: 'EXPORT', id: ids.export } })).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
      await backend.close();
    }
    inspect(root, db => expect(db.prepare('SELECT * FROM desktop_job_history ORDER BY job_id').all()).toEqual(before));
  });

  it('does not bless truncated ZIP/PSD bytes when historical archives are first registered lazily', async () => {
    const root = await directory(); const source = await publishedFixture(root, 2);
    await writeFile(join(root, 'exports', `${source.ids.export}.zip`), source.archive.subarray(0, source.archive.length - 1));
    await writeFile(join(root, 'exports', `${source.ids.layer}.psd`), source.psd.subarray(0, source.psd.length - 1));
    const backend = await open(source.options);
    expect((await backend.invoke('getJob', { jobId: source.ids.export })).history!.files[0]!.available).toBe(false);
    expect((await backend.invoke('getJob', { jobId: source.ids.layer })).history!.files[1]!.available).toBe(false);
    await expect(backend.invoke('getResource', { ref: { kind: 'EXPORT', id: source.ids.export } })).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    await expect(backend.invoke('getResource', { ref: { kind: 'LAYER_PSD', id: source.ids.layer } })).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
  });

  it('returns a safe unavailable result for corrupt history JSON while preserving its exact bytes and task identity', async () => {
    const root = await directory(); const source = await publishedFixture(root, 2);
    const malformed = '{"assetIds":[],"text":"C:/private/path","privateSnapshot":{"encryptedApiKey":"private"}}';
    const db = new Database(join(root, 'backend.sqlite'));
    try { db.prepare('UPDATE job_results SET data=? WHERE jobId=?').run(malformed, source.ids.suite); } finally { db.close(); }
    const backend = await open(source.options);
    expect((await backend.invoke('getJob', { jobId: source.ids.suite })).history).toMatchObject({ executable: false, resultStatus: 'UNAVAILABLE', result: null });
    await backend.close();
    inspect(root, connection => expect(connection.prepare('SELECT result_json FROM desktop_job_history WHERE job_id=?').get(source.ids.suite)).toEqual({ result_json: malformed }));
  });

  it('keeps original result IDs and retained bytes readable after an actual asset deletion and shutdown cleanup', async () => {
    const root = await directory(); const source = await publishedFixture(root, 2);
    let backend = await open(source.options);
    await backend.invoke('getJob', { jobId: source.ids.generated });
    await backend.invoke('deleteAsset', { assetId: source.ids.asset });
    expect((await backend.invoke('listAssets', { projectId: source.ids.project })).items).toEqual([]);
    await backend.close(); backend = await open(source.options);
    const job = await backend.invoke('getJob', { jobId: source.ids.generated });
    expect(job.history).toMatchObject({ resultStatus: 'AVAILABLE', result: { assetIds: [source.ids.asset] },
      files: [{ ref: { kind: 'ASSET', id: source.ids.asset }, mimeType: 'image/png', available: true }] });
    const location = await backend.invokeHost('host.resolveResource', { ref: { kind: 'ASSET', id: source.ids.asset } });
    expect(await readFile(location.path)).toEqual(source.image);
  });

  it('protects existing historical registrations from a dormant cleanup intent before accepting commands', async () => {
    const root = await directory(); const source = await publishedFixture(root, 2);
    const first = await open(source.options); await first.close();
    const db = openDatabase(join(root, 'backend.sqlite'));
    try {
      const storage = new LocalAssetStore(root); await storage.initialize();
      const resources = new ResourceRegistry(new RuntimeStore(db), storage), ref = { kind: 'ASSET', id: source.ids.asset } as const;
      resources.register({ ref, relativePath: `assets/${source.ids.asset}.png`, mimeType: 'image/png', hash: sha(source.image), owners: [] });
      resources.scheduleCleanup(ref);
    } finally { db.close(); }
    const backend = await open(source.options);
    const location = await backend.invokeHost('host.resolveResource', { ref: { kind: 'ASSET', id: source.ids.asset } });
    expect(await readFile(location.path)).toEqual(source.image);
    await backend.close();
    inspect(root, connection => {
      expect(connection.prepare('SELECT COUNT(*) n FROM desktop_cleanup_queue').get()).toEqual({ n: 0 });
      const row = connection.prepare('SELECT payload FROM desktop_resources WHERE id=?').get(`ASSET:${source.ids.asset}`) as { payload: string };
      expect(JSON.parse(row.payload).owners).toContain(`history:project:${source.ids.project}`);
    });
  });

  it('never dispatches or retries historical UNKNOWN against even an available local provider', async () => {
    const root = await directory(); const server = await startFullMockProvider();
    try {
      const source = await publishedFixture(root, 2, server.baseUrl);
      let backend = await open(source.options);
      expect((await backend.invoke('listJobs', {})).items.find(job => job.id === source.ids.unknown)).toMatchObject({ status: 'UNKNOWN', retryable: false });
      await expect(backend.invoke('retryJob', { jobId: source.ids.unknown })).rejects.toMatchObject({ code: 'RETRY_UNSAFE' });
      await backend.invoke('cancelJob', { jobId: source.ids.unknown });
      await backend.close(); backend = await open(source.options);
      expect((await backend.invoke('getJob', { jobId: source.ids.unknown })).status).toBe('UNKNOWN');
      expect(server.state.total).toBe(0);
      await backend.close();
    } finally { await server.close(); }
  });
});
