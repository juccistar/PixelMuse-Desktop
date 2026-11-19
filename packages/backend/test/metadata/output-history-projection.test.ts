import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EcomRepository, LocalAssetStore, openDatabase } from '@ecomgen/core';
import { operations } from '@ecomgen/contracts';
import { Value } from '@sinclair/typebox/value';
import sharp from 'sharp';
import { createBackend } from '../../src/index.js';
import { projectPublic } from '../../src/commands/support.js';
import { publishedFixture } from '../integration/history-fixtures.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function directory() { const root = await mkdtemp(join(tmpdir(), 'ecomgen-metadata-')); cleanups.push(() => rm(root, { recursive: true, force: true })); return root; }
async function open(options: Parameters<typeof createBackend>[0]) { const backend = await createBackend(options); cleanups.push(() => backend.close()); return backend; }

describe('actual Backend public output and history seams', () => {
  it('keeps all 154 named operations and 131 offline source mappings, including every public Output shape', async () => {
    const catalog = JSON.parse(await readFile(new URL('../../../contracts/command-catalog.json', import.meta.url), 'utf8'));
    expect(Object.keys(operations)).toHaveLength(154);
    expect(catalog.operations.filter((entry: { source?: { operationId?: string } }) => entry.source?.operationId)).toHaveLength(131);
    for (const name of ['getProject', 'listOutputs', 'getOutput', 'getEditSession'] as const) {
      const entry = catalog.operations.find((entry: { operation: string }) => entry.operation === name);
      expect(entry.output).toEqual(JSON.parse(JSON.stringify(operations[name].output)));
    }
  });
  it('projects only persisted revision consistently through get/list/project and preserves the stored snapshot', async () => {
    const root = await directory();
    const options = { dataDir: root, masterKey: randomBytes(32).toString('base64'), version: 'metadata-test' };
    const initial = await open(options); await initial.close();
    const db = openDatabase(join(root, 'backend.sqlite'));
    const repository = new EcomRepository(db), storage = new LocalAssetStore(root); await storage.initialize();
    const png = await sharp({ create: { width: 8, height: 6, channels: 4, background: '#cc5522' } }).png().toBuffer();
    const project = repository.createProject({ name: '隔离结果', category: null, productDescription: null, verifiedFacts: [], prohibitedClaims: [], brandGuidelines: {}, platformTargets: [], targetMarket: null, copyLanguage: null, reasoningProviderId: null, reasoningModelId: null, imageProviderId: null, imageModelId: null, defaultMode: 'CREATIVE', imageResolution: '1K', imageAspectRatio: 'AUTO', candidatesPerType: 1 });
    repository.saveStoryboard(project.id, 'original', 'CONFIRMED', [{ assetType: 'hero-image', displayName: '首图', shotRole: 'HERO', templateVariant: null, candidateCount: 1, referencedAssets: [], mode: 'CREATIVE', status: 'GENERATED', promptInstruction: 'original', compiledPrompt: null, factClaims: [], riskFlags: [], sortOrder: 0 }]);
    const item = repository.listStoryboardItems(project.id)[0]!;
    const snapshots: Array<string | null> = [];
    const outputs = [];
    try {
      for (const revision of ['retry', '把背景改为米色', undefined]) {
        const job = repository.createJob({ id: randomUUID(), projectId: project.id, storyboardItemId: item.id, type: 'GENERATE', input: {}, status: 'SUCCEEDED' });
        const stored = await storage.putOutput(project.id, png, 'png', job.id);
        const output = repository.createOutput({ projectId: project.id, storyboardItemId: item.id, jobId: job.id, candidateIndex: 1, generationSnapshot: null, storagePath: stored.path, hash: stored.hash, width: 8, height: 6, generationKey: job.id });
        // 与执行器相同的持久字段，额外私有值证明不是直接序列化快照。
        const snapshot = revision === undefined ? null : JSON.stringify({ revision, providerId: randomUUID(), modelId: 'private-model', encryptedApiKey: 'private-credential', storagePath: 'C:/private/snapshot.png', bodyBase64: 'private-receipt' });
        db.prepare('UPDATE outputs SET generation_snapshot_json=? WHERE id=?').run(snapshot, output.id);
        snapshots.push(snapshot); outputs.push({ id: output.id, revision });
      }
      // getProject 的完整 ID 集合允许 UI 绕开 listJobs 的最近 500 条上限。
      for (let i = 0; i < 501; i++) repository.createJob({ id: randomUUID(), projectId: project.id, storyboardItemId: null, type: 'EXPORT', input: {}, status: 'SUCCEEDED' });
    } finally { db.close(); }
    const backend = await open(options);
    const listed = (await backend.invoke('listOutputs', { projectId: project.id })).items;
    const detail = await backend.invoke('getProject', { projectId: project.id });
    expect(detail.jobs).toHaveLength(504);
    const recent = await backend.invoke('listJobs', { projectId: project.id, limit: 500 });
    expect(recent.items).toHaveLength(500);
    const omitted = detail.jobs.find(job => !recent.items.some(row => row.id === job.id))!;
    expect((await backend.invoke('getJob', { jobId: omitted.id })).id).toBe(omitted.id);
    for (const output of outputs) {
      const direct = await backend.invoke('getOutput', { outputId: output.id });
      for (const value of [direct, listed.find(row => row.id === output.id)!, detail.outputs.find(row => row.id === output.id)!]) {
        expect(value.revision).toBe(output.revision);
        if (output.revision === undefined) expect(value).not.toHaveProperty('revision');
        expect(Value.Check(operations.getOutput.output, value)).toBe(true);
        const json = JSON.stringify(value);
        for (const secret of ['generationSnapshot', 'providerId', 'private-model', 'private-credential', 'storagePath', 'C:/private', 'private-receipt', root]) expect(json).not.toContain(secret);
      }
    }
    await backend.close();
    const verify = openDatabase(join(root, 'backend.sqlite'));
    try { expect(outputs.map(output => (verify.prepare('SELECT generation_snapshot_json value FROM outputs WHERE id=?').get(output.id) as { value: string | null }).value)).toEqual(snapshots); } finally { verify.close(); }
  });

  it('ignores a top-level forged revision and non-string snapshot revisions', () => {
    for (const generationSnapshot of [null, {}, { revision: 12 }]) expect(projectPublic(operations.getOutput.output, { revision: 'forged', generationSnapshot })).not.toHaveProperty('revision');
  });

  it.each([1, 2] as const)('reads real v%s resource identities and detects changed/missing historical bytes with no generated rows', async version => {
    const root = await directory(), source = await publishedFixture(root, version);
    let backend = await open(source.options);
    const project = await backend.invoke('getProject', { projectId: source.ids.project });
    const listing = await backend.invoke('listJobs', { projectId: source.ids.project, limit: 500 });
    expect(new Set(listing.items.map(job => job.id))).toEqual(new Set(project.jobs.map(job => job.id)));
    for (const job of listing.items) expect((await backend.invoke('getJob', { jobId: job.id })).history).toEqual(job.history);
    const exported = await backend.invoke('getJob', { jobId: source.ids.export });
    const ref = exported.history!.files[0]!.ref;
    expect(ref).toEqual({ kind: 'EXPORT', id: source.ids.export });
    const location = await backend.invokeHost('host.resolveResource', { ref });
    expect(await readFile(location.path)).toEqual(source.archive);
    if (version === 2) {
      const generated = await backend.invoke('getJob', { jobId: source.ids.generated });
      expect(generated.history!.files[0]).toMatchObject({ ref: { kind: 'ASSET', id: source.ids.asset }, available: true });
      const layer = await backend.invoke('getJob', { jobId: source.ids.layer });
      expect(layer.history!.files[1]).toMatchObject({ ref: { kind: 'LAYER_PSD', id: source.ids.layer }, available: true });
      const psdLocation = await backend.invokeHost('host.resolveResource', { ref: layer.history!.files[1]!.ref });
      expect(createHash('sha256').update(await readFile(psdLocation.path)).digest('hex')).toBe(createHash('sha256').update(source.psd).digest('hex'));
      const unknown = await backend.invoke('getJob', { jobId: source.ids.unknown });
      expect(unknown).toMatchObject({ status: 'UNKNOWN', retryable: false, history: { executable: false, requestState: 'IN_FLIGHT' } });
      await expect(backend.invoke('retryJob', { jobId: unknown.id })).rejects.toMatchObject({ code: 'RETRY_UNSAFE' });
    }
    expect((await backend.invoke('listOutputs', { projectId: source.ids.project })).items).toEqual([]);
    expect((await backend.invoke('listPatterns', {})).items).toEqual([]);
    await backend.close();
    await rm(join(root, 'exports', `${source.ids.export}.zip`));
    if (version === 2) await writeFile(join(root, 'exports', `${source.ids.layer}.psd`), Buffer.concat([source.psd, Buffer.from('changed')]));
    backend = await open(source.options);
    expect((await backend.invoke('getJob', { jobId: source.ids.export })).history!.files[0]!.available).toBe(false);
    if (version === 2) expect((await backend.invoke('getJob', { jobId: source.ids.layer })).history!.files[1]!.available).toBe(false);
  });
});
