import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAssetStore, openDatabase } from '@ecomgen/core';
import type { ResourceRef } from '@ecomgen/contracts';
import { ResourceRegistry, ResourcePayloadSchema, resourceKey, type ResourcePayload } from '../../src/runtime/resources.js';
import { RuntimeStore } from '../../src/runtime/state.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.mocked(rm).mockReset().mockImplementation(realFs.rm);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'ecomgen-cleanup-scale-cdx-'));
  cleanups.push(() => realFs.rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(historyOwners: (ref: ResourceRef) => string[] = () => []) {
  const root = await directory(), db = openDatabase(':memory:');
  cleanups.push(async () => db.close());
  const storage = new LocalAssetStore(root); await storage.initialize();
  const absolute = vi.fn((path: string) => storage.absolute(path));
  const store = new RuntimeStore(db, () => '2026-11-06T00:00:00.000Z');
  const resources = new ResourceRegistry(store, { absolute }, { prepare: async () => undefined, owners: historyOwners });
  async function add(id: string, owners: string[] = []) {
    const ref = { kind: 'PATTERN', id } as const;
    const stored = await storage.putPatternArtifact(id, 'artwork', Buffer.from(id), '.bin');
    const input = { ref, relativePath: stored.path, mimeType: 'application/octet-stream', hash: stored.hash, owners };
    resources.register(input);
    return input;
  }
  function record(ref: ResourceRef): ResourcePayload | undefined {
    const row = db.prepare('SELECT payload FROM desktop_resources WHERE id=?').get(resourceKey(ref)) as { payload: string } | undefined;
    return row && store.decode(ResourcePayloadSchema, row.payload);
  }
  return { root, db, store, storage, absolute, resources, add, record };
}
function pauseNextDeletion() {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.mocked(rm).mockImplementationOnce(async (path, options) => {
    entered(); await gate; await realFs.rm(path, options);
  });
  return { started, release };
}
function count(f: Awaited<ReturnType<typeof fixture>>, table: 'desktop_resources' | 'desktop_cleanup_queue') {
  return (f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
}

describe('cleanup comparison scale and fresh managed-path security (cdx 20261106)', () => {
  it('bounds absolute validation linearly for 299 resources and 41 durable intents, deleting all unshared files', async () => {
    const f = await fixture(), inputs: Array<{ ref: ResourceRef; relativePath: string }> = [];
    const bytes = Buffer.from('isolated cleanup scale fixture'), hash = createHash('sha256').update(bytes).digest('hex');
    const insert = f.db.prepare('INSERT INTO desktop_resources(id,payload,updated_at) VALUES (?,?,?)');
    // Seed canonical rows directly so setup work is excluded from the cleanup call bound.
    for (let index = 0; index < 299; index++) {
      const id = `scale-${String(index).padStart(3, '0')}`, ref = { kind: 'PATTERN', id } as const;
      const relativePath = `patterns/${id}.bin`;
      await realFs.writeFile(join(f.root, relativePath), bytes);
      const payload: ResourcePayload = { version: 1, ref, relativePath, hash, mimeType: 'application/octet-stream', owners: index < 41 ? [] : ['job:preserved'], publication: 'PUBLISHED' };
      f.store.validate(ResourcePayloadSchema, payload);
      insert.run(resourceKey(ref), JSON.stringify(payload), f.store.clock());
      inputs.push({ ref, relativePath });
      if (index < 41) f.resources.scheduleCleanup(ref);
    }
    f.absolute.mockClear(); vi.mocked(rm).mockClear();
    await f.resources.cleanup();
    expect(f.absolute.mock.calls.length).toBeLessThanOrEqual(299 + 41);
    // Every physical deletion must have its own fresh validation in addition to any comparison key.
    for (const input of inputs.slice(0, 41)) expect(f.absolute.mock.calls.filter(([path]) => path === input.relativePath).length).toBeGreaterThanOrEqual(2);
    expect(vi.mocked(rm)).toHaveBeenCalledTimes(41);
    expect(count(f, 'desktop_resources')).toBe(258);
    expect(count(f, 'desktop_cleanup_queue')).toBe(0);
    for (const [index, input] of inputs.entries()) {
      if (index < 41) await expect(realFs.stat(join(f.root, input.relativePath))).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await realFs.readFile(join(f.root, input.relativePath))).toEqual(bytes);
    }
    const calls = f.absolute.mock.calls.length;
    await f.resources.cleanup();
    expect(f.absolute.mock.calls.length).toBe(calls);
  });

  it('refreshes later aliases, owners, historical references and canceled intents after an awaited deletion', async () => {
    const history = new Map<string, string[]>(), f = await fixture(ref => history.get(ref.id) ?? []);
    const first = await f.add('a-gate'), shared = await f.add('b-shared'), historical = await f.add('c-history');
    const retained = await f.add('d-retained'), canceled = await f.add('e-canceled'), registered = await f.add('f-registered');
    for (const input of [first, shared, historical, retained, canceled, registered]) f.resources.scheduleCleanup(input.ref);
    const pause = pauseNextDeletion(), cleaning = f.resources.cleanup();
    expect(f.resources.cleanup()).toBe(cleaning);
    await pause.started;
    try {
      const variants = [first.relativePath.replaceAll('\\', '/')];
      if (process.platform === 'win32') variants.push(first.relativePath.toUpperCase().replaceAll('\\', '/'));
      for (const relativePath of variants) {
        expect(() => f.resources.register({ ...first, ref: { kind: 'ASSET', id: 'late-first-alias' }, relativePath, owners: ['project:new'] })).toThrowError(expect.objectContaining({ code: 'RESOURCE_RETIRING' }));
      }
      expect(() => f.resources.retain(first.ref, 'job:too-late')).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
      f.resources.register({ ...shared, ref: { kind: 'ASSET', id: 'new-shared-alias' }, relativePath: shared.relativePath.replaceAll('\\', '/'), owners: ['project:new'] });
      history.set(historical.ref.id, ['history:job:new']);
      f.resources.retain(retained.ref, 'job:new');
      f.resources.retain(canceled.ref, 'temporary'); f.resources.release(canceled.ref, 'temporary');
      f.resources.register({ ...registered, owners: ['job:registered'] });
    } finally { pause.release(); await cleaning; }
    expect(f.record(first.ref)).toBeUndefined(); expect(f.record(shared.ref)).toBeUndefined();
    expect(f.record(historical.ref)?.owners).toEqual(['history:job:new']);
    expect(f.record(retained.ref)?.owners).toEqual(['job:new']);
    expect(f.record(registered.ref)?.owners).toEqual(['job:registered']);
    expect(f.record(canceled.ref)).toMatchObject({ owners: [], publication: 'PUBLISHED' });
    for (const ref of [{ kind: 'ASSET', id: 'new-shared-alias' } as const, historical.ref, retained.ref, canceled.ref, registered.ref]) {
      expect((await f.resources.resolve(ref)).path).toBeTruthy();
    }
    expect(count(f, 'desktop_cleanup_queue')).toBe(0);
  });

  it('keeps slash/case aliases until the final alias retires and preserves pendingCleanup access revocation', async () => {
    const f = await fixture(), original = await f.add('shared-original');
    const slash = { ...original, ref: { kind: 'ASSET', id: 'shared-slash' } as const, relativePath: original.relativePath.replaceAll('\\', '/') };
    const other = { ...original, ref: { kind: 'OUTPUT', id: 'shared-case' } as const, relativePath: process.platform === 'win32' ? slash.relativePath.toUpperCase() : slash.relativePath.replaceAll('/', '\\'), owners: ['job:alive'] };
    f.resources.register(slash); f.resources.register(other);
    f.resources.scheduleCleanup(original.ref); f.resources.scheduleCleanup(slash.ref);
    await expect(f.resources.resolve(original.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    vi.mocked(rm).mockClear(); await f.resources.cleanup();
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
    expect((await f.resources.resolve(other.ref)).hash).toBe(original.hash);
    f.resources.release(other.ref, 'job:alive'); f.resources.scheduleCleanup(other.ref);
    await expect(f.resources.resolve(other.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await f.resources.cleanup();
    expect(vi.mocked(rm)).toHaveBeenCalledTimes(1);
    expect(count(f, 'desktop_resources')).toBe(0);
    await expect(realFs.stat(join(f.root, original.relativePath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['hardlink', 'junction'] as const)('rechecks a previously compared path replaced by a %s during await, persists failure and retries safely', async replacement => {
    const f = await fixture(), first = await f.add('a-gate'), target = await f.add('b-replaced');
    const targetAbsolute = f.storage.absolute(target.relativePath), outside = await directory();
    const outsideFile = join(outside, basename(targetAbsolute));
    await realFs.writeFile(outsideFile, 'outside sentinel');
    f.resources.scheduleCleanup(first.ref); f.resources.scheduleCleanup(target.ref);
    f.absolute.mockClear(); vi.mocked(rm).mockClear();
    const pause = pauseNextDeletion(), cleaning = f.resources.cleanup();
    await pause.started;
    try {
      expect(f.absolute.mock.calls.some(([path]) => path === target.relativePath)).toBe(true);
      if (replacement === 'hardlink') {
        await realFs.unlink(targetAbsolute); await realFs.link(outsideFile, targetAbsolute);
      } else {
        await realFs.rename(dirname(targetAbsolute), `${dirname(targetAbsolute)}-original`);
        await realFs.symlink(outside, dirname(targetAbsolute), 'junction');
      }
    } finally { pause.release(); await cleaning; }
    expect(f.record(target.ref)).toMatchObject({ publication: 'RETIRING', owners: [] });
    const row = f.db.prepare('SELECT payload FROM desktop_cleanup_queue WHERE id=?').get(resourceKey(target.ref)) as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({ attempts: 1, lastError: 'CLEANUP_FAILED' });
    expect(vi.mocked(rm).mock.calls.some(([path]) => path === targetAbsolute)).toBe(false);
    await expect(f.resources.resolve(target.ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await realFs.readFile(outsideFile, 'utf8')).toBe('outside sentinel');
    if (replacement === 'hardlink') {
      await realFs.unlink(targetAbsolute); await realFs.writeFile(targetAbsolute, target.ref.id);
    } else {
      await realFs.unlink(dirname(targetAbsolute));
      await realFs.rename(`${dirname(targetAbsolute)}-original`, dirname(targetAbsolute));
    }
    // A subsequent call owns a new comparison cache and freshly checks the restored path.
    await f.resources.cleanup();
    expect(count(f, 'desktop_cleanup_queue')).toBe(0); expect(f.record(target.ref)).toBeUndefined();
    expect(await realFs.readFile(outsideFile, 'utf8')).toBe('outside sentinel');
    await expect(realFs.stat(targetAbsolute)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
