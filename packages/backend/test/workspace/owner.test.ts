import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fsPromises, { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireMediaOwner, MediaWorkspace } from '../../src/workspace/index.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function directory() {
  const parent = await mkdtemp(join(tmpdir(), 'pixelmuse-owner-')), root = join(parent, 'media');
  await mkdir(root);
  cleanups.push(() => rm(parent, { recursive: true, force: true, maxRetries: 3 }));
  return root;
}
const prefix = (root: string) => `.pixelmuse-storage-${createHash('sha256').update(root.toLowerCase()).digest('hex')}-`;
const claims = async (root: string) => (await readdir(dirname(root))).filter(name => name.startsWith(prefix(root)) && name.endsWith('.claim'));
function worker() {
  const url = pathToFileURL(join(process.cwd(), 'packages/backend/src/workspace/index.ts')).href;
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(process.cwd(), 'node_modules/tsx/dist/loader.mjs')).href, '--input-type=module', '-e', `
    import { open } from 'node:fs/promises';
    import { dirname, join } from 'node:path';
    import { createHash, randomUUID } from 'node:crypto';
    const { acquireMediaOwner } = await import(${JSON.stringify(url)});
    let release, incomplete;
    process.on('message', async ({ id, operation, root }) => {
      try {
        if (operation === 'acquire') release = await acquireMediaOwner(root);
        else if (operation === 'release') { await release?.(); release = undefined; }
        else if (operation === 'publish') {
          const key = createHash('sha256').update(root.toLowerCase()).digest('hex');
          incomplete = await open(join(dirname(root), '.pixelmuse-storage-' + key + '-' + process.pid + '-' + randomUUID() + '.claim'), 'wx');
        }
        process.send({ id, ok: true });
      } catch (error) { process.send({ id, ok: false, code: error.code, message: error.message }); }
    });
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '', next = 0;
  const pending = new Map<number, { resolve: (value: { ok: boolean; code?: string }) => void; reject: (error: Error) => void }>();
  child.stderr!.on('data', bytes => { errors += String(bytes); });
  child.on('message', message => {
    const value = message as { id: number; ok: boolean; code?: string };
    pending.get(value.id)?.resolve(value); pending.delete(value.id);
  });
  child.on('error', error => { for (const callback of pending.values()) callback.reject(error); pending.clear(); });
  const exited = new Promise<void>(resolve => child.once('exit', () => {
    for (const callback of pending.values()) callback.reject(new Error(`owner worker exited: ${errors}`));
    pending.clear(); resolve();
  }));
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; };
  cleanups.push(stop);
  return { pid: child.pid!, stop, request: (operation: string, root: string) => new Promise<{ ok: boolean; code?: string }>((resolve, reject) => {
    const id = ++next;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`owner worker stalled: ${errors}`)); }, 10000);
    pending.set(id, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
    child.send({ id, operation, root });
  }) };
}

interface CleanupAcquisition { started: string; completed: string; heldUntil: string; rootPresent: boolean }
interface CleanupReport { denied: number; deniedAt: string[]; missing: number; acquisitions: CleanupAcquisition[] }
interface CleanupMessage { kind: 'ready' | 'denied' | 'acquired' | 'result'; tick: string; report?: CleanupReport }
interface CleanupBoundary { entered: string; invoked: string; finished: string; error?: unknown }

function cleanupProbeSource(moduleUrl: string) {
  return `
    import { mkdir, stat, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const { acquireMediaOwner } = await import(${JSON.stringify(moduleUrl)});
    const root = process.argv[1], control = process.argv[2] === 'control';
    const tick = () => process.hrtime.bigint().toString();
    let started = false, done = false, denied = 0, missing = 0, held;
    const acquisitions = [], deniedAt = [];
    const probing = (async () => {
      while (!done) {
        if (started && !held) {
          const attempt = tick();
          try {
            held = await acquireMediaOwner(root);
            const acquisition = { started: attempt, completed: tick(), heldUntil: '', rootPresent: false };
            acquisitions.push(acquisition);
            try { await stat(root); acquisition.rootPresent = true; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            // 保持成功取得的 owner，直到父进程确认实际 rm 已结束，避免掩盖接管后的删除。
            process.send({ kind: 'acquired', tick: tick() });
          } catch (error) {
            if (error.code === 'WORKSPACE_IN_USE') {
              deniedAt.push(tick());
              if (++denied === 1) process.send({ kind: 'denied', tick: tick() });
            } else if (error.code === 'ENOENT') missing++;
            else throw error;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    })();
    void probing.catch(error => { console.error(error); process.exit(1); });
    process.on('message', async message => {
      if (message.begin) { started = true; return; }
      done = true; await probing;
      if (held) { held.assert(); acquisitions[0].heldUntil = tick(); await held(); }
      if (!control) {
        await mkdir(root, { recursive: true });
        const release = await acquireMediaOwner(root);
        try { await writeFile(join(root, 'successor.txt'), 'successor survives'); release.assert(); }
        finally { await release(); }
      }
      process.send({ kind: 'result', tick: tick(), report: { denied, deniedAt, missing, acquisitions } }, () => process.exit(0));
    });
    process.send({ kind: 'ready', tick: tick() });
  `;
}

function cleanupProbe(root: string, control = false) {
  const spawnedAt = process.hrtime.bigint();
  const moduleUrl = pathToFileURL(join(process.cwd(), 'packages/backend/src/workspace/index.ts')).href;
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(process.cwd(), 'node_modules/tsx/dist/loader.mjs')).href, '--input-type=module', '-e', cleanupProbeSource(moduleUrl), root, ...(control ? ['control'] : [])], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '';
  child.stderr!.on('data', bytes => { errors += String(bytes); });
  const inbox: CleanupMessage[] = [];
  const pending = new Map<CleanupMessage['kind'], { resolve: (message: CleanupMessage) => void; reject: (error: Error) => void }>();
  child.on('message', value => {
    const message = value as CleanupMessage;
    const waiting = pending.get(message.kind);
    if (waiting) { pending.delete(message.kind); waiting.resolve(message); }
    else inbox.push(message);
  });
  child.on('error', error => { for (const waiting of pending.values()) waiting.reject(error); pending.clear(); });
  const exited = new Promise<void>(resolve => child.once('exit', () => {
    for (const waiting of pending.values()) waiting.reject(new Error(`cleanup contender exited: ${errors}`));
    pending.clear(); resolve();
  }));
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
  const message = (kind: CleanupMessage['kind']) => new Promise<CleanupMessage>((resolve, reject) => {
    const index = inbox.findIndex(value => value.kind === kind);
    if (index !== -1) { resolve(inbox.splice(index, 1)[0]!); return; }
    if (child.exitCode !== null || child.signalCode !== null) { reject(new Error(`cleanup contender exited: ${errors}`)); return; }
    const timeout = setTimeout(() => { pending.delete(kind); reject(new Error(`cleanup contender timed out (${kind}): ${errors}`)); }, 15000);
    pending.set(kind, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
  });
  return {
    message,
    ready: async () => {
      const value = await message('ready');
      // 同机 hrtime 必须落在 IPC 往返区间内，避免跨进程时钟基准误判。
      expect(BigInt(value.tick) >= spawnedAt && BigInt(value.tick) <= process.hrtime.bigint()).toBe(true);
    },
    begin: async () => {
      const sentAt = process.hrtime.bigint(), blocked = message('denied');
      child.send({ begin: true });
      const value = await blocked;
      expect(BigInt(value.tick) >= sentAt && BigInt(value.tick) <= process.hrtime.bigint()).toBe(true);
    },
    finish: async () => {
      const result = message('result'); child.send({ done: true });
      const value = await result; await exited;
      expect(child.exitCode, errors).toBe(0);
      return value.report!;
    },
  };
}

function observeCleanup(root: string, beforeDelete: () => Promise<void>) {
  const realRm = fsPromises.rm, boundaries: CleanupBoundary[] = [];
  // 只包装指定根的真实 rm；不替代文件删除，也不改运行源码。
  fsPromises.rm = (async (path, options) => {
    if (String(path) !== root || !options?.recursive) return realRm(path, options);
    const boundary: CleanupBoundary = { entered: process.hrtime.bigint().toString(), invoked: '', finished: '' };
    boundaries.push(boundary);
    try {
      await beforeDelete();
      boundary.invoked = process.hrtime.bigint().toString();
      return await realRm(path, options);
    } catch (error) { boundary.error = error; throw error; }
    finally { boundary.finished = process.hrtime.bigint().toString(); }
  }) as typeof fsPromises.rm;
  syncBuiltinESMExports();
  return { boundaries, restore: () => { fsPromises.rm = realRm; syncBuiltinESMExports(); } };
}

function overlappingAcquisitions(report: CleanupReport, boundary: CleanupBoundary) {
  expect(boundary.error).toBeUndefined();
  expect(boundary.entered).not.toBe(''); expect(boundary.invoked).not.toBe(''); expect(boundary.finished).not.toBe('');
  // 成功接管后始终持有至 finish；用实际持有区间与真实 rm 区间求交，连删除前抢占也必须检出。
  for (const value of report.acquisitions) {
    expect(BigInt(value.started) >= BigInt(boundary.entered)).toBe(true);
    expect(BigInt(value.completed) >= BigInt(value.started)).toBe(true);
    expect(BigInt(value.heldUntil) >= BigInt(value.completed)).toBe(true);
  }
  return report.acquisitions.filter(value => BigInt(value.completed) <= BigInt(boundary.finished) && BigInt(value.heldUntil) >= BigInt(boundary.invoked));
}

describe('media ownership across real processes', () => {
  it('never gives two contenders a stale owner in 100 rounds, and cannot reclaim a live winner', async () => {
    const root = await directory(), dead = worker();
    expect(await dead.request('publish', root)).toMatchObject({ ok: true }); await dead.stop();
    const contenders = [worker(), worker()];
    let doubleOwners = 0, winners = 0, collisions = 0;
    for (let round = 0; round < 100; round++) {
      await writeFile(join(root, '.pixelmuse-storage.lock'), JSON.stringify({ pid: dead.pid, token: randomUUID() }));
      await writeFile(join(dirname(root), `${prefix(root)}${dead.pid}-${randomUUID()}.claim`), '');
      const results = await Promise.all(contenders.map(child => child.request('acquire', root)));
      const owners = results.filter(result => result.ok).length;
      if (owners > 1) doubleOwners++;
      if (owners === 0) collisions++;
      winners += owners;
      if (owners === 1) {
        await expect(acquireMediaOwner(root)).rejects.toMatchObject({ code: 'WORKSPACE_IN_USE' });
        const loser = contenders[results.findIndex(result => !result.ok)]!;
        expect(await loser.request('acquire', root)).toMatchObject({ ok: false, code: 'WORKSPACE_IN_USE' });
      }
      await Promise.all(contenders.map(child => child.request('release', root)));
      const remaining = await claims(root);
      // 双方可能先见到对方而安全拒绝，尚未走到死 claim；不得留下任何活动申请者的 claim。
      expect(remaining.every(name => name.startsWith(`${prefix(root)}${dead.pid}-`))).toBe(true);
      expect(results.filter(result => !result.ok).every(result => result.code === 'WORKSPACE_IN_USE')).toBe(true);
    }
    // 同时发布允许双方安全拒绝；无竞争时必须可立即恢复。
    const release = await acquireMediaOwner(root); release.assert(); await release();
    expect(await claims(root)).toEqual([]);
    console.info(`[workspace ownership] rounds=100 doubleOwners=${doubleOwners} winners=${winners} safeCollisions=${collisions}`);
    expect(doubleOwners).toBe(0);
  });

  it('honors an empty claim from a live process and recovers after that publisher is killed', async () => {
    const root = await directory(), child = worker();
    expect(await child.request('publish', root)).toMatchObject({ ok: true });
    await expect(acquireMediaOwner(root)).rejects.toMatchObject({ code: 'WORKSPACE_IN_USE' });
    await child.stop();
    const release = await acquireMediaOwner(root);
    try { release.assert(); expect(await claims(root)).toHaveLength(1); }
    finally { await release(); }
  });

  it.each(['', '{"pid":', '{"pid":123,"token":"'])('recovers incomplete legacy JSON %j without blocking default startup', async contents => {
    const root = await directory();
    await writeFile(join(root, '.pixelmuse-storage.lock'), contents);
    const workspace = new MediaWorkspace(root); await workspace.initialize();
    try { workspace.assertStorageRoot(); expect(workspace.usable).toBe(true); }
    finally { await workspace.close(); }
    expect(await readFile(join(root, '.pixelmuse-storage.lock'), 'utf8')).toBe(contents);
  });

  it('honors a complete live legacy lock and never unlinks it during acquisition failure', async () => {
    const root = await directory(), contents = JSON.stringify({ pid: process.pid, token: randomUUID() });
    await writeFile(join(root, '.pixelmuse-storage.lock'), contents);
    await expect(acquireMediaOwner(root)).rejects.toMatchObject({ code: 'WORKSPACE_IN_USE' });
    expect(await readFile(join(root, '.pixelmuse-storage.lock'), 'utf8')).toBe(contents);
    expect(await claims(root)).toEqual([]);
  });

  it('detects a controlled premature ownership release while cleanup files still exist', async () => {
    const root = await directory(), remaining = join(root, 'not-yet-deleted.txt');
    await writeFile(remaining, 'cleanup is still pending');
    const release = await acquireMediaOwner(root); cleanups.push(release);
    const probe = cleanupProbe(root, true); await probe.ready();
    const observer = observeCleanup(root, async () => {
      await probe.begin();
      const premature = probe.message('acquired'); await release(); await premature;
      expect(await readFile(remaining, 'utf8')).toBe('cleanup is still pending');
    });
    try {
      await fsPromises.rm(root, { recursive: true });
      const result = await probe.finish();
      expect(observer.boundaries).toHaveLength(1);
      const boundary = observer.boundaries[0]!, unsafe = overlappingAcquisitions(result, boundary);
      expect(result.denied).toBeGreaterThan(0); expect(result.missing).toBe(0);
      expect(unsafe).toHaveLength(1); expect(unsafe[0]!.rootPresent).toBe(true);
      expect(BigInt(unsafe[0]!.completed) < BigInt(boundary.invoked)).toBe(true);
      console.info(`[workspace cleanup negative control] ${JSON.stringify({ ...result, unsafe: unsafe.length, boundary })}`);
    } finally { observer.restore(); }
  });

  it.each(['staging', 'published'] as const)('retains outside ownership through real 10k-file abandoned %s cleanup', async location => {
    const source = await directory(), parent = await directory();
    const setup = new MediaWorkspace(source); await setup.initialize(); await setup.close();
    const owner = JSON.parse(await readFile(join(source, 'workspace-owner.json'), 'utf8')).owner;
    const migration = randomUUID(), staging = join(parent, `.pixelmuse-migration-${migration}`), target = join(parent, 'PixelMuse');
    const root = location === 'staging' ? staging : target;
    await mkdir(root);
    await writeFile(join(root, '.pixelmuse-workspace.json'), JSON.stringify({ version: 1, owner, migration, complete: location === 'published' }));
    for (let batch = 0; batch < 100; batch++) {
      const sub = join(root, `assets-${batch}`); await mkdir(sub);
      await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(sub, `file-${index}`), 'fixture')));
    }
    await writeFile(join(source, 'workspace-migration.json'), JSON.stringify({ version: 1, migration, state: 'VERIFYING', source, staging, target }));
    const probe = cleanupProbe(root); await probe.ready();
    const observer = observeCleanup(root, () => probe.begin());
    const recovered = new MediaWorkspace(source);
    try {
      await recovered.initialize();
      expect(recovered.status().state).toBe('FAILED');
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
      // 确认 rm 完成后才重建目录；同一观察者必须接受合法后继，不能把“目录存在”当作删除重叠。
      const successor = probe.message('acquired'); await mkdir(root); await successor;
      const result = await probe.finish();
      expect(observer.boundaries).toHaveLength(1);
      const boundary = observer.boundaries[0]!, unsafe = overlappingAcquisitions(result, boundary);
      const deniedDuringRm = result.deniedAt.filter(tick => BigInt(tick) >= BigInt(boundary.invoked) && BigInt(tick) <= BigInt(boundary.finished)).length;
      expect(result.denied).toBeGreaterThan(0); expect(deniedDuringRm).toBeGreaterThan(0);
      expect(unsafe, JSON.stringify({ result, boundary })).toEqual([]);
      expect(result.acquisitions).toHaveLength(1);
      expect(result.acquisitions[0]!.rootPresent).toBe(true);
      expect(BigInt(result.acquisitions[0]!.completed) > BigInt(boundary.finished)).toBe(true);
      await recovered.close();
      expect(await readFile(join(root, 'successor.txt'), 'utf8')).toBe('successor survives');
      console.info(`[workspace cleanup] ${JSON.stringify({ location, files: 10000, ...result, deniedDuringRm, unsafe: unsafe.length, boundary })}`);
    } finally { observer.restore(); await recovered.close(); }
  }, 45000);

  it('protects the final namespace before and after rename, and releases only its own claim', async () => {
    const parent = await directory(), root = join(parent, 'staging'), target = join(parent, 'PixelMuse');
    await mkdir(root);
    const stagingOwner = await acquireMediaOwner(root), finalOwner = await acquireMediaOwner(target, { allowMissing: true });
    try {
      await expect(acquireMediaOwner(target, { allowMissing: true })).rejects.toMatchObject({ code: 'WORKSPACE_IN_USE' });
      await rename(root, target);
      stagingOwner.assert(); finalOwner.assert();
      await stagingOwner();
      expect(await claims(root)).toEqual([]);
      await expect(acquireMediaOwner(target)).rejects.toMatchObject({ code: 'WORKSPACE_IN_USE' });
      await finalOwner();
      const successor = await acquireMediaOwner(target);
      try {
        await finalOwner(); successor.assert();
        expect(() => finalOwner.assert()).toThrow();
        expect(await claims(target)).toHaveLength(1);
      } finally { await successor(); }
    } finally { await stagingOwner(); await finalOwner(); }
  });
});
