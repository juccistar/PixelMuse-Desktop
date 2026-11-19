import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { link, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MediaWorkspace, acquireMediaOwner } from '../../src/workspace/index.js';
import { namespaces } from '../../src/workspace/paths.js';
import { WorkspaceAssetStore } from '../../src/workspace/store.js';
import { file, poll, regressionFixtures } from '../desktop-regression-helpers.js';
import { registerDomainCommands } from '../../src/commands/index.js';
import { createBackend } from '../../src/index.js';

const { directory, fixture, open } = regressionFixtures();
const settle = (backend: Awaited<ReturnType<typeof fixture>>['backend']) => poll(async () => {
  const status = await backend.invokeHost('host.workspaceStatus', {});
  return status.state === 'RESTARTING' || status.state === 'FAILED' || status.state === 'READY' ? status : undefined;
}, 'workspace terminal state');

describe('media workspace safety and lifecycle', () => {
  it('migrates all namespaces, user suites, legacy flat files and archived canvas without moving SQLite or keys', async () => {
    const f = await fixture(), targetParent = await directory();
    const keyPath = join(f.root, 'master-key.enc'); await writeFile(keyPath, 'synthetic-safeStorage-envelope');
    const databasePath = join(f.options.dataDir, 'backend.sqlite'), beforeDb = await stat(databasePath);
    const cipher = f.context.repository.getProvider(f.provider.id)!.encryptedApiKey;
    const asset = await f.backend.invoke('uploadAsset', { projectId: f.project.id, kind: 'PRODUCT', file: file(f.bytes) });
    const original = await f.backend.invokeHost('host.resolveResource', { ref: { kind: 'ASSET', id: asset.id } });
    for (const name of namespaces) { await mkdir(join(f.options.dataDir, name), { recursive: true }); await writeFile(join(f.options.dataDir, name, 'migration-fixture.bin'), name); }
    await writeFile(join(f.options.dataDir, 'legacy-flat.png'), f.bytes);
    f.context.repository.createAsset({ projectId: f.project.id, role: 'STYLE_REFERENCE', storagePath: 'legacy-flat.png', hash: 'a'.repeat(64), originalName: 'legacy.png', mimeType: 'image/png', byteSize: f.bytes.length, width: 32, height: 24 });
    const generated = { name: '画布导出.json', mimeType: 'application/json' as const, base64: Buffer.from('{"canvas":true}').toString('base64') };
    expect(await f.backend.invokeHost('host.archiveGeneratedFile', generated)).toBeNull();
    expect((await readdir(join(f.options.dataDir, 'exports', 'canvas'), { recursive: true })).some(name => name.endsWith(generated.name))).toBe(true);
    const first = await f.backend.invokeHost('host.workspaceChoose', { directory: targetParent });
    expect(['COPYING', 'VERIFYING']).toContain(first.state);
    const status = await settle(f.backend); expect(status.state, status.error).toBe('RESTARTING');
    await expect(f.backend.invoke('listProjects', {})).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' });
    const target = join(targetParent, 'PixelMuse');
    for (const name of namespaces) expect(await readFile(join(target, name, 'migration-fixture.bin'), 'utf8')).toBe(name);
    expect(await readFile(join(target, 'legacy-flat.png'))).toEqual(f.bytes);
    await expect(stat(join(target, 'backend.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(target, 'master-key.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(original.path)).toEqual(f.bytes);
    await f.backend.close();
    const journalPath = join(f.options.dataDir, 'workspace-migration.json');
    const committedJournal = JSON.parse(await readFile(journalPath, 'utf8'));
    await writeFile(journalPath, JSON.stringify({ ...committedJournal, state: 'VERIFYING' }));
    const reopened = await open(f.options);
    expect((await reopened.backend.invokeHost('host.workspaceStatus', {}))).toMatchObject({ directory: target, configured: true, state: 'READY' });
    expect(JSON.parse(await readFile(journalPath, 'utf8')).state).toBe('COMMITTED');
    const migrated = await reopened.backend.invokeHost('host.resolveResource', { ref: { kind: 'ASSET', id: asset.id } });
    expect(migrated.path.startsWith(target)).toBe(true); expect(await readFile(migrated.path)).toEqual(f.bytes);
    expect(reopened.context.repository.getProvider(f.provider.id)!.encryptedApiKey).toBe(cipher);
    expect((await stat(databasePath)).ino).toBe(beforeDb.ino);
    expect(await readFile(keyPath, 'utf8')).toBe('synthetic-safeStorage-envelope');
    expect((await reopened.backend.invoke('listProjects', {})).items.some(project => project.id === f.project.id)).toBe(true);
  });

  it('blocks new commands and host writes, drains already accepted query writes, and prevents parallel migrations', async () => {
    const f = await fixture(); await f.backend.close();
    let unblock!: () => void, began!: () => void;
    const held = new Promise<void>(resolve => { unblock = resolve; }), entered = new Promise<void>(resolve => { began = resolve; });
    const backend = await createBackend(f.options, undefined, { commands: context => ({ ...registerDomainCommands(context), listAssets: async (_ctx, input) => {
      began(); await held; await writeFile(context.storage.absolute('exports/accepted-query.txt'), 'completed before snapshot');
      return { items: [], nextCursor: null };
    } }) });
    try {
      const accepted = backend.invoke('listAssets', { projectId: f.project.id }); await entered;
      const target = await directory(); await backend.invokeHost('host.workspaceChoose', { directory: target });
      await expect(backend.invoke('getHealth', {})).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' });
      await expect(backend.invokeHost('host.prepareUpdateInstall', {})).rejects.toMatchObject({ code: 'UPDATE_BUSY' });
      await expect(backend.invokeHost('host.archiveGeneratedFile', { name: 'x.json', mimeType: 'application/json', base64: 'e30=' })).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' });
      await expect(backend.invokeHost('host.workspaceChoose', { directory: await directory() })).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
      unblock(); await accepted;
      expect((await settle(backend)).state).toBe('RESTARTING');
      expect(await readFile(join(target, 'PixelMuse', 'exports', 'accepted-query.txt'), 'utf8')).toBe('completed before snapshot');
    } finally { unblock(); await backend.close(); }
  });

  it('rejects queued and active jobs without requesting cancellation', async () => {
    const f = await fixture();
    const queued = f.context.repository.createJob({ id: f.context.idFactory(), projectId: f.project.id, storyboardItemId: null, type: 'PLAN', status: 'QUEUED', input: {} });
    await expect(f.backend.invokeHost('host.workspaceChoose', { directory: await directory() })).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
    await expect(f.backend.invokeHost('host.prepareUpdateInstall', {})).rejects.toMatchObject({ code: 'UPDATE_BUSY' });
    expect(f.context.repository.getJob(queued.id)).toMatchObject({ status: 'QUEUED', cancelRequested: false });
    f.context.repository.updateJob(queued.id, { status: 'RUNNING' });
    await expect(f.backend.invokeHost('host.workspaceChoose', { directory: await directory() })).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
    await expect(f.backend.invokeHost('host.prepareUpdateInstall', {})).rejects.toMatchObject({ code: 'UPDATE_BUSY' });
    expect(f.context.repository.getJob(queued.id)).toMatchObject({ status: 'RUNNING', cancelRequested: false });
  });

  it('cancels while draining accepted operations, keeps source/config and resumes work', async () => {
    const userData = await directory(), target = await directory(), source = join(userData, 'data');
    await mkdir(join(source, 'assets'), { recursive: true }); await writeFile(join(source, 'assets', 'original.txt'), 'original');
    const workspace = new MediaWorkspace(source); await workspace.initialize();
    let release!: () => void, left = false;
    workspace.attach({ enter: () => new Promise<void>(resolve => { release = resolve; }), leave: () => { left = true; }, references: () => [] });
    try {
      await workspace.choose(target); const cancelled = workspace.cancel(); release();
      expect((await cancelled).state).toBe('READY'); expect(left).toBe(true);
      expect(await readFile(join(source, 'assets', 'original.txt'), 'utf8')).toBe('original');
      await expect(stat(join(source, 'workspace-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(target)).toEqual([]);
    } finally { await workspace.close(); }
  });

  it('cancels during actual stream copying and removes only its staging directory', async () => {
    const f = await fixture(), target = await directory();
    await writeFile(join(target, 'unrelated.txt'), 'keep');
    const original = join(f.options.dataDir, 'assets', 'large.bin'); await writeFile(original, Buffer.alloc(32 * 1024 * 1024, 71));
    await f.backend.invokeHost('host.workspaceChoose', { directory: target });
    await poll(async () => { const status = await f.backend.invokeHost('host.workspaceStatus', {}); return status.state === 'COPYING' && status.copiedBytes > 0 ? status : undefined; }, 'stream copy to begin');
    expect((await f.backend.invokeHost('host.workspaceCancel', {})).state).toBe('READY');
    expect((await stat(original)).size).toBe(32 * 1024 * 1024);
    expect(await readdir(target)).toEqual(['unrelated.txt']);
    expect(await f.backend.invoke('getHealth', {})).toMatchObject({ status: 'ready' });
    await expect(stat(join(f.options.dataDir, 'workspace-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects source mutation after inventory and preserves both source and old active config', async () => {
    const f = await fixture(), target = await directory();
    await writeFile(join(f.options.dataDir, 'assets', 'a-large.bin'), Buffer.alloc(24 * 1024 * 1024, 72));
    const changed = join(f.options.dataDir, 'assets', 'z-changed.txt'); await writeFile(changed, 'before');
    await f.backend.invokeHost('host.workspaceChoose', { directory: target });
    await poll(async () => { const status = await f.backend.invokeHost('host.workspaceStatus', {}); return status.copiedBytes > 0 ? status : undefined; }, 'copy after inventory');
    await writeFile(changed, 'after mutation');
    expect((await settle(f.backend)).state).toBe('FAILED');
    expect(await readFile(changed, 'utf8')).toBe('after mutation');
    expect(await readdir(target)).toEqual([]);
    await expect(stat(join(f.options.dataDir, 'workspace-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.backend.invoke('getHealth', {})).toMatchObject({ status: 'ready' });
  });

  it.each(['changed', 'added', 'deleted'] as const)('revalidates the entire source before committing when an already copied file is %s', async mutation => {
    const f = await fixture(), target = await directory();
    const first = join(f.options.dataDir, 'assets', 'a-first.txt');
    await writeFile(first, 'before');
    await writeFile(join(f.options.dataDir, 'assets', 'z-large.bin'), Buffer.alloc(32 * 1024 * 1024, 74));
    await f.backend.invokeHost('host.workspaceChoose', { directory: target });
    await poll(async () => {
      const status = await f.backend.invokeHost('host.workspaceStatus', {});
      return status.state === 'COPYING' && status.copiedFiles >= 1 ? status : undefined;
    }, 'first source file to finish copying');
    if (mutation === 'changed') await writeFile(first, 'edited'); // 同大小修改也必须重新 hash。
    else if (mutation === 'added') await writeFile(join(f.options.dataDir, 'assets', 'new-file.txt'), 'new source');
    else await rm(first);
    expect((await settle(f.backend)).state).toBe('FAILED');
    if (mutation !== 'deleted') expect(await readFile(first, 'utf8')).toBe(mutation === 'changed' ? 'edited' : 'before');
    if (mutation === 'added') expect(await readFile(join(f.options.dataDir, 'assets', 'new-file.txt'), 'utf8')).toBe('new source');
    expect((await stat(join(f.options.dataDir, 'assets', 'z-large.bin'))).size).toBe(32 * 1024 * 1024);
    expect(await readdir(target)).toEqual([]);
    await expect(stat(join(f.options.dataDir, 'workspace-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.backend.invoke('getHealth', {})).toMatchObject({ status: 'ready' });
  });

  it.each(['changed', 'added'] as const)('rejects source %s during final verification after target publication', async mutation => {
    const f = await fixture(), parent = await directory(), target = join(parent, 'PixelMuse');
    const first = join(f.options.dataDir, 'assets', 'a-first.txt');
    await writeFile(first, 'before');
    await writeFile(join(f.options.dataDir, 'assets', 'z-large.bin'), Buffer.alloc(32 * 1024 * 1024, 75));
    await f.backend.invokeHost('host.workspaceChoose', { directory: parent });
    await poll(async () => {
      try { await stat(join(target, 'assets', 'a-first.txt')); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; }
    }, 'target publication before final source verification');
    if (mutation === 'changed') await writeFile(first, 'edited');
    else await writeFile(join(f.options.dataDir, 'assets', 'new-after-publication.txt'), 'new source');
    expect((await settle(f.backend)).state).toBe('FAILED');
    expect(await readFile(first, 'utf8')).toBe(mutation === 'changed' ? 'edited' : 'before');
    if (mutation === 'added') expect(await readFile(join(f.options.dataDir, 'assets', 'new-after-publication.txt'), 'utf8')).toBe('new source');
    expect(await readdir(parent)).toEqual([]);
    await expect(stat(join(f.options.dataDir, 'workspace-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['changed', 'deleted', 'added'] as const)('rejects destination %s during final source verification without committing config', async mutation => {
    const f = await fixture(), parent = await directory(), target = join(parent, 'PixelMuse');
    const source = join(f.options.dataDir, 'assets', 'a-first.txt'), destination = join(target, 'assets', 'a-first.txt');
    await writeFile(source, 'before');
    await writeFile(join(f.options.dataDir, 'assets', 'z-large.bin'), Buffer.alloc(64 * 1024 * 1024, 77));
    await f.backend.invokeHost('host.workspaceChoose', { directory: parent });
    await poll(async () => {
      try { await stat(destination); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; }
    }, 'target publication before final paired verification');
    await expect(acquireMediaOwner(target)).rejects.toMatchObject({ code: 'WORKSPACE_IN_USE' });
    if (mutation === 'changed') await writeFile(destination, 'edited');
    else if (mutation === 'deleted') await rm(destination);
    else await writeFile(join(target, 'assets', 'new-file.txt'), 'external target content');
    expect((await settle(f.backend)).state).toBe('FAILED');
    expect(await readFile(source, 'utf8')).toBe('before');
    expect((await stat(join(f.options.dataDir, 'assets', 'z-large.bin'))).size).toBe(64 * 1024 * 1024);
    await expect(stat(join(f.options.dataDir, 'workspace-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(parent)).toEqual([]);
    expect(await f.backend.invoke('getHealth', {})).toMatchObject({ status: 'ready' });
  });

  it.each(['changed', 'deleted'] as const)('refuses a %s target identity marker before configuration commit', async mutation => {
    const f = await fixture(), parent = await directory(), target = join(parent, 'PixelMuse');
    await writeFile(join(f.options.dataDir, 'assets', 'z-large.bin'), Buffer.alloc(32 * 1024 * 1024, 78));
    await f.backend.invokeHost('host.workspaceChoose', { directory: parent });
    const markerPath = join(target, '.pixelmuse-workspace.json');
    await poll(async () => {
      try { await stat(markerPath); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; }
    }, 'published target identity');
    if (mutation === 'deleted') await rm(markerPath);
    else await writeFile(markerPath, JSON.stringify({ version: 1, owner: 'external-identity', complete: true }));
    expect((await settle(f.backend)).state).toBe('FAILED');
    await expect(stat(join(f.options.dataDir, 'workspace-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    // 标记身份不再属于本轮，不删未知目录；原素材仍可正常使用。
    expect(await readdir(parent)).toEqual(['PixelMuse']);
    expect((await stat(join(target, 'assets', 'z-large.bin'))).size).toBe(32 * 1024 * 1024);
    expect(await f.backend.invoke('getHealth', {})).toMatchObject({ status: 'ready' });
  });

  it('reconnects the restored default root by its owner identity and keeps real asset storage guarded', async () => {
    const parent = await directory(), source = join(parent, 'data'), disconnected = join(parent, 'disconnected');
    await mkdir(source);
    const workspace = new MediaWorkspace(source); await workspace.initialize();
    const storage = new WorkspaceAssetStore(source, () => workspace.assertStorageRoot());
    await storage.initialize();
    await writeFile(storage.absolute('assets/original.txt'), 'default media');
    let paused = 0;
    workspace.attach({ enter: async () => {}, leave: () => {}, references: () => [], unavailable: () => { paused++; } });
    try {
      await rename(source, disconnected);
      expect(() => storage.absolute('assets/new.txt')).toThrowError(expect.objectContaining({ code: 'WORKSPACE_UNAVAILABLE' }));
      expect(workspace.status()).toMatchObject({ state: 'FAILED', configured: false, directory: source });
      expect(paused).toBeGreaterThan(0);
      await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
      await rename(disconnected, source);
      const originalIdentity = await readFile(join(source, 'workspace-owner.json'), 'utf8');
      await writeFile(join(source, 'workspace-owner.json'), JSON.stringify({ version: 1, owner: '00000000-0000-0000-0000-000000000000' }));
      await expect(workspace.choose(source)).rejects.toMatchObject({ code: 'INVALID_WORKSPACE' });
      expect(workspace.usable).toBe(false);
      await writeFile(join(source, 'workspace-owner.json'), originalIdentity);
      expect(await workspace.choose(source)).toMatchObject({ state: 'RESTARTING', configured: false, directory: source });
      expect(await readFile(storage.absolute('assets/original.txt'), 'utf8')).toBe('default media');
      await expect(stat(join(source, 'workspace-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(acquireMediaOwner(source)).rejects.toMatchObject({ code: 'WORKSPACE_IN_USE' });
    } finally { await workspace.close(); }
    const reopened = new MediaWorkspace(source); await reopened.initialize();
    try { reopened.assertStorageRoot(); expect(reopened.status()).toMatchObject({ state: 'READY', configured: false }); }
    finally { await reopened.close(); }
  });

  it.each(['copy', 'published'] as const)('recovers a real process killed during %s, removes abandoned roots and keeps source', async phase => {
    const userData = await directory(), source = join(userData, 'data'), target = await directory();
    await mkdir(join(source, 'assets'), { recursive: true });
    const sourceFile = join(source, 'assets', 'large.bin'); await writeFile(sourceFile, Buffer.alloc(32 * 1024 * 1024, 73));
    const moduleUrl = pathToFileURL(join(process.cwd(), 'packages/backend/src/workspace/index.ts')).href;
    const child = spawn(process.execPath, ['--import', pathToFileURL(join(process.cwd(), 'node_modules/tsx/dist/loader.mjs')).href, '--input-type=module', '-e', `
      import { existsSync } from 'node:fs';
      import { join } from 'node:path';
      const { MediaWorkspace } = await import(${JSON.stringify(moduleUrl)});
      const workspace = new MediaWorkspace(process.argv[1]); await workspace.initialize();
      workspace.attach({ enter: async () => {}, leave: () => {}, references: () => [] });
      await workspace.choose(process.argv[2]);
      const timer = setInterval(() => {
        const status = workspace.status();
        const ready = process.argv[3] === 'copy' ? status.copiedBytes > 0 && status.state === 'COPYING' : existsSync(join(process.argv[2], 'PixelMuse', 'assets', 'large.bin'));
        if (ready) { clearInterval(timer); process.send({ ready: true }); }
      }, 1);
    `, source, target, phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = ''; child.stderr!.on('data', bytes => { errors += String(bytes); });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`child copy did not begin: ${errors}`)), 10000);
        child.once('message', () => { clearTimeout(timeout); resolve(); });
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', () => { clearTimeout(timeout); reject(new Error(`child exited before copy: ${errors}`)); });
      });
    } finally { child.kill(); await exited; }
    expect((await readdir(target)).some(name => phase === 'copy' ? name.startsWith('.pixelmuse-migration-') : name === 'PixelMuse')).toBe(true);
    const recovered = new MediaWorkspace(source); await recovered.initialize();
    try {
      expect(recovered.status()).toMatchObject({ configured: false, state: 'FAILED', directory: source });
      expect(recovered.usable).toBe(true);
      expect((await stat(sourceFile)).size).toBe(32 * 1024 * 1024);
      expect(await readdir(target)).toEqual([]);
      await expect(stat(join(source, 'workspace-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await recovered.close(); }
  });

  it('never silently falls back after selected workspace disappears, and explicitly reconnects the same identity', async () => {
    const f = await fixture(), targetParent = await directory();
    await f.backend.invokeHost('host.workspaceChoose', { directory: targetParent }); expect((await settle(f.backend)).state).toBe('RESTARTING');
    await f.backend.close();
    const target = join(targetParent, 'PixelMuse'), moved = join(targetParent, 'disconnected'); await rename(target, moved);
    const unavailable = await open(f.options);
    expect(await unavailable.backend.invokeHost('host.workspaceStatus', {})).toMatchObject({ state: 'FAILED', directory: target, configured: true });
    await expect(unavailable.backend.invoke('listProjects', {})).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' });
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await rename(moved, target);
    expect(await unavailable.backend.invokeHost('host.workspaceChoose', { directory: target })).toMatchObject({ state: 'RESTARTING' });
    await unavailable.backend.close();
    expect((await (await open(f.options)).backend.invoke('listProjects', {})).items).toHaveLength(1);
  });

  it('refuses runtime writes when a configured directory vanishes and reconnects without cancelling queued work', async () => {
    const f = await fixture(), targetParent = await directory();
    await f.backend.invokeHost('host.workspaceChoose', { directory: targetParent }); expect((await settle(f.backend)).state).toBe('RESTARTING');
    await f.backend.close(); const reopened = await open(f.options);
    const target = join(targetParent, 'PixelMuse'), disconnected = join(targetParent, 'runtime-disconnected');
    await rename(target, disconnected);
    await expect(reopened.backend.invoke('uploadAsset', { projectId: f.project.id, file: file(f.bytes) })).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' });
    expect(await reopened.backend.invokeHost('host.workspaceStatus', {})).toMatchObject({ state: 'FAILED', directory: target });
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    const queued = reopened.context.repository.createJob({ id: reopened.context.idFactory(), projectId: f.project.id, storyboardItemId: null, type: 'PLAN', status: 'QUEUED', input: {} });
    await rename(disconnected, target);
    expect(await reopened.backend.invokeHost('host.workspaceChoose', { directory: target })).toMatchObject({ state: 'RESTARTING' });
    expect(reopened.context.repository.getJob(queued.id)).toMatchObject({ status: 'QUEUED', cancelRequested: false });
    reopened.context.repository.updateJob(queued.id, { status: 'CANCELLED' });
  });

  it('enforces independent media ownership and recovers an interrupted copy without committing or removing source', async () => {
    const source = await directory();
    const workspace = new MediaWorkspace(source); await workspace.initialize();
    try { await expect(acquireMediaOwner(source)).rejects.toMatchObject({ code: 'WORKSPACE_IN_USE' }); }
    finally { await workspace.close(); }
    await writeFile(join(source, 'workspace-migration.json'), JSON.stringify({ version: 1, state: 'VERIFYING' }));
    const reopened = new MediaWorkspace(source); await reopened.initialize();
    try { expect(reopened.usable).toBe(true); expect(reopened.status()).toMatchObject({ state: 'FAILED', directory: source, configured: false }); }
    finally { await reopened.close(); }
  });

  it('rejects overlapping directories, occupied targets, junctions and hard-linked media without overwriting', async () => {
    const f = await fixture();
    await expect(f.backend.invokeHost('host.workspaceChoose', { directory: f.options.dataDir })).rejects.toMatchObject({ code: 'INVALID_WORKSPACE' });
    await expect(f.backend.invokeHost('host.workspaceChoose', { directory: f.root })).rejects.toMatchObject({ code: 'INVALID_WORKSPACE' });
    const occupied = await directory(); await mkdir(join(occupied, 'PixelMuse')); await writeFile(join(occupied, 'PixelMuse', 'keep'), 'untouched');
    await expect(f.backend.invokeHost('host.workspaceChoose', { directory: occupied })).rejects.toMatchObject({ code: 'INVALID_WORKSPACE' });
    expect(await readFile(join(occupied, 'PixelMuse', 'keep'), 'utf8')).toBe('untouched');
    const target = await directory(), outside = await directory();
    const junction = join(target, 'junction'); await symlink(outside, junction, 'junction');
    await expect(f.backend.invokeHost('host.workspaceChoose', { directory: junction })).rejects.toMatchObject({ code: 'INVALID_WORKSPACE' });
    const original = join(f.options.dataDir, 'assets', 'linked.txt'), alias = join(outside, 'alias.txt');
    await writeFile(original, 'no linked copies'); await link(original, alias);
    await f.backend.invokeHost('host.workspaceChoose', { directory: target });
    expect((await settle(f.backend)).state).toBe('FAILED');
    expect(await readFile(alias, 'utf8')).toBe('no linked copies');
    await expect(stat(join(f.options.dataDir, 'workspace-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.backend.invoke('getHealth', {})).toMatchObject({ status: 'ready' });
  });
});
