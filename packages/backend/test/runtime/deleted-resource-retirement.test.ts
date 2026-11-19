import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAssetStore, openDatabase } from '@ecomgen/core';
import type { BackendOptions, ResourceRef } from '@ecomgen/contracts';
import { createBackend, type Backend } from '../../src/index.js';
import { ResourceRegistry, resourceKey, type ResourcePayload } from '../../src/runtime/resources.js';
import { RuntimeStore } from '../../src/runtime/state.js';
import { publishedFixture } from '../integration/history-fixtures.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'ecomgen-deleted-resource-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function open(options: BackendOptions) {
  const backend = await createBackend(options);
  cleanups.push(() => backend.close());
  return backend;
}
function inspect<T>(root: string, read: (db: Database.Database) => T): T {
  const db = new Database(join(root, 'backend.sqlite'), { readonly: true });
  try { return read(db); } finally { db.close(); }
}
function record(db: Database.Database, ref: ResourceRef): ResourcePayload | undefined {
  const row = db.prepare('SELECT payload FROM desktop_resources WHERE id=?').get(resourceKey(ref)) as { payload: string } | undefined;
  return row && JSON.parse(row.payload) as ResourcePayload;
}
async function png() {
  return sharp({ create: { width: 8, height: 8, channels: 4, background: '#12abef' } }).png().toBuffer();
}
async function fixture() {
  const root = await directory();
  const options = { dataDir: root, masterKey: randomBytes(32).toString('base64'), version: 'deleted-resource-test' };
  const backend = await open(options);
  const provider = await backend.invoke('createProvider', { name: 'isolated offline', baseUrl: 'http://127.0.0.1:1/v1', reasoningProtocol: 'openai', apiKey: 'synthetic-test-key',
    models: [
      { id: 'reasoner', supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: true },
      { id: 'gpt-image-1', supportsVision: false, supportsThinking: false, supportsTools: false, supportsStructuredOutput: false, imageApiKind: 'openai_images' },
    ] });
  const projectInput = { name: 'disposable', defaultMode: 'CREATIVE' as const, reasoningProviderId: provider.id, reasoningModelId: 'reasoner', imageProviderId: provider.id, imageModelId: 'gpt-image-1' };
  const project = await backend.invoke('createProject', projectInput);
  const bytes = await png();
  const asset = await backend.invoke('uploadAsset', { projectId: project.id, role: 'PRODUCT_TRUTH', file: { name: 'synthetic.png', mimeType: 'image/png', base64: bytes.toString('base64') } });
  return { root, options, backend, project, projectInput, bytes, asset, ref: { kind: 'ASSET', id: asset.id } as const };
}
async function deleteProject(backend: Backend, projectId: string) {
  await backend.invoke('updateProject', { projectId, archived: true });
  await backend.invoke('deleteProject', { projectId });
}

async function registry(historical?: { prepare(ref: ResourceRef): Promise<void>; owners(ref: ResourceRef): string[] }) {
  const root = await directory();
  const db = openDatabase(join(root, 'backend.sqlite'));
  cleanups.push(async () => db.close());
  const storage = new LocalAssetStore(root); await storage.initialize();
  const store = new RuntimeStore(db);
  const resources = new ResourceRegistry(store, storage, historical);
  const ref = { kind: 'PATTERN', id: randomUUID() } as const;
  const stored = await storage.putPatternArtifact(ref.id, 'artwork', await png());
  const input = { ref, relativePath: stored.path, mimeType: 'image/png', hash: stored.hash, owners: [] as string[] };
  return { root, db, storage, store, resources, ref, stored, input };
}

describe('deleted resource access before durable physical cleanup', () => {
  it('revokes both default Backend entrypoints immediately when project deletion leaves no owner', async () => {
    const f = await fixture();
    const location = await f.backend.invokeHost('host.resolveResource', { ref: f.ref });
    expect(await f.backend.invoke('getResource', { ref: f.ref })).toEqual({ ref: f.ref, mimeType: 'image/png' });
    inspect(f.root, db => {
      expect(record(db, f.ref)?.owners).toEqual([`project:${f.project.id}`]);
      expect(db.prepare('SELECT id FROM desktop_cleanup_queue WHERE id=?').get(resourceKey(f.ref))).toBeUndefined();
    });
    await deleteProject(f.backend, f.project.id);
    await expect(f.backend.invoke('getProject', { projectId: f.project.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    inspect(f.root, db => {
      expect(record(db, f.ref)).toMatchObject({ owners: [], publication: 'PUBLISHED' });
      expect(db.prepare('SELECT id FROM desktop_cleanup_queue WHERE id=?').get(resourceKey(f.ref))).toEqual({ id: resourceKey(f.ref) });
    });
    expect(await readFile(location.path)).toEqual(f.bytes);
    const access = await Promise.allSettled([
      f.backend.invoke('getResource', { ref: f.ref }),
      f.backend.invokeHost('host.resolveResource', { ref: f.ref }),
    ]);
    expect(access).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ code: 'NOT_FOUND' }) },
      { status: 'rejected', reason: expect.objectContaining({ code: 'NOT_FOUND' }) },
    ]);
    await f.backend.close();
    await expect(readFile(location.path)).rejects.toMatchObject({ code: 'ENOENT' });
    for (let attempt = 0; attempt < 2; attempt++) {
      const reopened = await open(f.options);
      await expect(reopened.invoke('getResource', { ref: f.ref })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      inspect(f.root, db => {
        expect(record(db, f.ref)).toBeUndefined();
        expect(db.prepare('SELECT COUNT(*) n FROM desktop_cleanup_queue').get()).toEqual({ n: 0 });
      });
      await reopened.close();
    }
  });

  it('keeps the same content readable in another live project after deleting its source', async () => {
    const f = await fixture();
    const other = await f.backend.invoke('createProject', { ...f.projectInput, name: 'live project' });
    const copied = await f.backend.invoke('copyLibraryAssetToProject', { projectId: other.id, itemId: `asset:${f.asset.id}`, role: 'PRODUCT_TRUTH' });
    const ref = { kind: 'ASSET', id: copied.id } as const;
    const location = await f.backend.invokeHost('host.resolveResource', { ref });
    await deleteProject(f.backend, f.project.id);
    await expect(f.backend.invoke('getResource', { ref: f.ref })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await readFile((await f.backend.invokeHost('host.resolveResource', { ref })).path)).toEqual(f.bytes);
    expect((await f.backend.invoke('getProject', { projectId: other.id })).id).toBe(other.id);
    await f.backend.close();
    const reopened = await open(f.options);
    expect(await reopened.invoke('getResource', { ref })).toEqual({ ref, mimeType: 'image/png' });
    expect(await readFile(location.path)).toEqual(f.bytes);
  });

  it('revokes only the queued identity, allowing new same-path aliases before physical cleanup', async () => {
    const f = await registry();
    f.resources.register(f.input);
    // Ownerless registrations without cleanup intent remain a supported input.
    expect((await f.resources.resolve(f.ref)).hash).toBe(f.stored.hash);
    f.resources.scheduleCleanup(f.ref);
    await expect(f.resources.resolve(f.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const alias = { kind: 'ASSET', id: randomUUID() } as const;
    f.resources.register({ ...f.input, ref: alias, relativePath: f.stored.path.replaceAll('\\', '/'), owners: ['project:live'] });
    expect((await f.resources.resolve(alias)).hash).toBe(f.stored.hash);
    await f.resources.cleanup(); await f.resources.cleanup();
    expect(record(f.db, f.ref)).toBeUndefined();
    expect((await f.resources.resolve(alias)).hash).toBe(f.stored.hash);
    f.resources.release(alias, 'project:live'); f.resources.scheduleCleanup(alias);
    await f.resources.cleanup();
    await expect(readFile(f.storage.absolute(f.stored.path))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['retain', 'register'] as const)('safely restores an owner with %s before cleanup without weakening identity', async method => {
    const f = await registry(); f.resources.register(f.input); f.resources.scheduleCleanup(f.ref);
    for (const change of [{ hash: 'f'.repeat(64) }, { mimeType: 'image/jpeg' }, { relativePath: 'patterns/another.png' }]) {
      expect(() => f.resources.register({ ...f.input, ...change, owners: ['job:retained'] })).toThrowError(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
    }
    await expect(f.resources.resolve(f.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    if (method === 'retain') f.resources.retain(f.ref, 'job:retained');
    else f.resources.register({ ...f.input, owners: ['job:retained'] });
    expect((await f.resources.resolve(f.ref)).hash).toBe(f.stored.hash);
    expect(() => f.resources.scheduleCleanup(f.ref)).toThrowError(expect.objectContaining({ code: 'RESOURCE_IN_USE' }));
    await f.resources.cleanup(); await f.resources.cleanup();
    expect(record(f.db, f.ref)?.owners).toEqual(['job:retained']);
    expect(f.db.prepare('SELECT COUNT(*) n FROM desktop_cleanup_queue').get()).toEqual({ n: 0 });
    expect((await f.resources.resolve(f.ref)).hash).toBe(f.stored.hash);
  });

  it('rejects an in-flight resolve if its final owner is removed during hashing', async () => {
    const f = await registry(); f.resources.register({ ...f.input, owners: ['project:deleting'] });
    const pending = f.resources.resolve(f.ref);
    f.resources.release(f.ref, 'project:deleting'); f.resources.scheduleCleanup(f.ref);
    await expect(pending).rejects.toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    expect(await readFile(f.storage.absolute(f.stored.path))).toBeInstanceOf(Buffer);
  });

  it('drains durable cleanup on reopen and tolerates repeated cleanup after physical deletion', async () => {
    const f = await registry(); f.resources.register(f.input); f.resources.scheduleCleanup(f.ref);
    const path = f.storage.absolute(f.stored.path);
    expect(await readFile(path)).toBeInstanceOf(Buffer);
    // Close only the SQLite connection, simulating exit before the cleanup worker runs.
    f.db.close();
    const options = { dataDir: f.root, masterKey: randomBytes(32).toString('base64'), version: 'restart-cleanup' };
    for (let attempt = 0; attempt < 2; attempt++) {
      const backend = await open(options);
      await expect(backend.invokeHost('host.resolveResource', { ref: f.ref })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
      inspect(f.root, db => {
        expect(record(db, f.ref)).toBeUndefined();
        expect(db.prepare('SELECT COUNT(*) n FROM desktop_cleanup_queue').get()).toEqual({ n: 0 });
      });
      await backend.close();
    }
  });

  it('restores a newly discovered historical owner before applying the pending cleanup barrier', async () => {
    let owners: string[] = [];
    const f = await registry({ prepare: async () => undefined, owners: () => owners });
    f.resources.register(f.input); f.resources.scheduleCleanup(f.ref);
    owners = ['history:job:preserved'];
    expect((await f.resources.resolve(f.ref)).hash).toBe(f.stored.hash);
    expect(record(f.db, f.ref)?.owners).toEqual(owners);
    expect(f.db.prepare('SELECT COUNT(*) n FROM desktop_cleanup_queue').get()).toEqual({ n: 0 });
    await f.resources.cleanup();
    expect((await f.resources.resolve(f.ref)).hash).toBe(f.stored.hash);
  });

  it('keeps real preserved job/history inputs readable immediately after asset deletion and after reopen', async () => {
    const root = await directory(), source = await publishedFixture(root, 2);
    const backend = await open(source.options), ref = { kind: 'ASSET', id: source.ids.asset } as const;
    await backend.invoke('getJob', { jobId: source.ids.generated });
    await backend.invoke('deleteAsset', { assetId: source.ids.asset });
    inspect(root, db => {
      expect(record(db, ref)?.owners).toEqual(expect.arrayContaining([`job:${source.ids.generated}`, `history:project:${source.ids.project}`]));
      expect(db.prepare('SELECT id FROM desktop_cleanup_queue WHERE id=?').get(resourceKey(ref))).toBeUndefined();
    });
    expect(await backend.invoke('getResource', { ref })).toEqual({ ref, mimeType: 'image/png' });
    expect(await readFile((await backend.invokeHost('host.resolveResource', { ref })).path)).toEqual(source.image);
    await backend.close();
    const reopened = await open(source.options);
    expect((await reopened.invoke('getJob', { jobId: source.ids.generated })).history?.files[0]?.available).toBe(true);
    expect(await readFile((await reopened.invokeHost('host.resolveResource', { ref })).path)).toEqual(source.image);
  });
});
