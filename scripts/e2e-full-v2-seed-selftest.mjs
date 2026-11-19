import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareIsolatedV2Profile, seedIsolatedV2 } from './e2e-full-persistence.mjs';

async function withFixture(run) {
  const fixture = await mkdtemp(join(tmpdir(), 'ecomgen-v2-seed-unit-'));
  const live = join(fixture, 'user-data');
  await mkdir(live);
  const config = { fixture, userData: join(fixture, 'migration-user-data'), image: join(fixture, 'product.png'), baseUrl: 'http://127.0.0.1:12345/v1' };
  const previous = globalThis.__ecomgenFullGuard;
  globalThis.__ecomgenFullGuard = { origins: ['http://127.0.0.1:12345'] };
  const host = { app: { isReady: () => true, getPath: () => live }, auditFile: join(fixture, 'network-audit.jsonl'), safeStorage: { isEncryptionAvailable: () => true, encryptString: () => { throw Error('Unexpected encryption in rejected fixture'); } } };
  try { await run({ fixture, live, config, host }); }
  finally { globalThis.__ecomgenFullGuard = previous; await rm(fixture, { recursive: true, force: true }); }
}

test('seed refuses main before ready without waiting for Electron startup', async () => {
  await assert.rejects(seedIsolatedV2({}, { app: { isReady: () => false } }), /requires a ready main/);
});
test('seed rejects live data, traversal and alternate children before fixture writes', async () => {
  await withFixture(async ({ fixture, live, config, host }) => {
    const sentinel = join(live, 'backend.sqlite'); await writeFile(sentinel, 'live-database-sentinel', { flag: 'wx' });
    for (const userData of [live, join(fixture, '..', 'migration-user-data'), join(fixture, 'other-child')]) {
      await assert.rejects(seedIsolatedV2({ ...config, userData }, host), /separate migration fixture child/);
    }
    assert.equal(await readFile(sentinel, 'utf8'), 'live-database-sentinel');
    await assert.rejects(access(config.userData), { code: 'ENOENT' });
  });
});
test('seed rejects a different guard fixture and non-fixture image', async () => {
  await withFixture(async ({ fixture, config, host }) => {
    await assert.rejects(seedIsolatedV2(config, { ...host, auditFile: join(fixture, 'other', 'audit.jsonl') }), /current guard fixture/);
    await assert.rejects(seedIsolatedV2({ ...config, image: join(fixture, '..', 'product.png') }, host), /separate migration fixture child/);
    await assert.rejects(access(config.userData), { code: 'ENOENT' });
  });
});
test('seed rejects unguarded provider origin before opening SQLite or writing envelopes', async () => {
  await withFixture(async ({ config, host }) => {
    await assert.rejects(seedIsolatedV2({ ...config, baseUrl: 'http://127.0.0.1:12346/v1' }, host), /guarded fixture origin/);
    await assert.rejects(access(config.userData), { code: 'ENOENT' });
  });
});

test('profile handoff writes only its DPAPI envelope and never overwrites a child profile', { skip: process.platform !== 'win32' }, async () => {
  await withFixture(async ({ fixture, live, config }) => {
    await mkdir(config.userData);
    const encryptedKey = Buffer.from('DPAPI-synthetic-protected-envelope').toString('base64');
    const state = { os_crypt: { encrypted_key: encryptedKey, unrelated: 'omit' }, unrelated: { profile: 'omit' } };
    await writeFile(join(live, 'Local State'), JSON.stringify(state), { flag: 'wx' });
    const input = { fixture, sourceUserData: live, userData: config.userData };
    await prepareIsolatedV2Profile(input);
    const target = await readFile(join(config.userData, 'Local State'), 'utf8');
    assert.deepEqual(JSON.parse(target), { os_crypt: { encrypted_key: encryptedKey } });
    await assert.rejects(prepareIsolatedV2Profile(input), { code: 'EEXIST' });
    assert.equal(await readFile(join(config.userData, 'Local State'), 'utf8'), target);
    assert.deepEqual(JSON.parse(await readFile(join(live, 'Local State'), 'utf8')), state);
    await assert.rejects(prepareIsolatedV2Profile({ ...input, userData: live }), /separate direct fixture children/);
  });
});

test('real isolated-v2-upgrade: production migration, preserved history and owned PID cleanup', { skip: process.env.ECOMGEN_E2E_SEED_REAL !== '1', timeout: 150000 }, async t => {
  const { makeContext, executeScenario, root, poll } = await import('./e2e-full-harness.mjs');
  const { recoveryScenarios } = await import('./e2e-full-recovery.mjs');
  assert.equal(process.env.ECOMGEN_E2E_EXECUTABLE, undefined, 'This narrow regression uses built source Electron');
  const artifacts = process.env.ECOMGEN_E2E_ARTIFACTS || join(root, '.cache/e2e-full', 'v2-seed-' + new Date().toISOString().replace(/[:.]/g, '-'));
  process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
  const ctx = await makeContext();
  const pids = new Set();
  const launch = ctx.launch.bind(ctx);
  ctx.launch = async (...args) => {
    try { await launch(...args); }
    catch (error) {
      const data = args[0] || ctx.userData;
      const mainLog = await readFile(join(data, 'logs/main.log'), 'utf8').catch(() => 'No main log');
      await ctx.evidence('migration-launch-failure', { mainLog, audit: await ctx.guardAudit() });
      throw error;
    }
    pids.add(ctx.app.process().pid);
    for (const pid of await ctx.app.evaluate(({ app }) => [process.pid, ...app.getAppMetrics().map(metric => metric.pid)])) pids.add(pid);
  };
  let record;
  try {
    await ctx.launch();
    const liveBefore = await ctx.inspect();
    // The renderer keeps its production whitelist; only the Node inspector can seed.
    assert.equal(await ctx.page.evaluate(() => typeof window.__ecomgenFullSeedV2), 'undefined');
    const input = { fixture: ctx.fixture, userData: join(ctx.fixture, 'migration-user-data'), image: ctx.image, width: ctx.mock.images.width, height: ctx.mock.images.height, baseUrl: ctx.mock.baseUrl };
    await assert.rejects(ctx.app.evaluate((_electron, input) => globalThis.__ecomgenFullSeedV2(input, 'wrong-token'), input), /Ready guarded main/);
    await assert.rejects(access(input.userData), { code: 'ENOENT' });
    record = await executeScenario(ctx, recoveryScenarios.find(scenario => scenario.id === 'isolated-v2-upgrade'));
    assert.equal(record.status, 'passed', record.error);
    assert.deepEqual(await ctx.inspect(), liveBefore, 'seeding/migration never changes the original live database');
    // A repeat seed must reject before overwriting the migrated DB or its envelope.
    const database = join(input.userData, 'data/backend.sqlite');
    const keyFile = join(input.userData, 'master-key.enc');
    const before = [await readFile(database), await readFile(keyFile)];
    await assert.rejects(ctx.app.evaluate((_electron, { input, token }) => globalThis.__ecomgenFullSeedV2(input, token), { input, token: ctx.startupGuard.token }), /EEXIST/);
    assert.deepEqual([await readFile(database), await readFile(keyFile)], before);
    await ctx.page.getByRole('navigation', { name: '全局导航' }).waitFor({ state: 'visible' });
    await ctx.screenshot('v2-seed-restored-app');
    assert.equal(ctx.mock.state.total, 0, 'isolated migration made no fixture network request');
  } finally {
    const audit = await ctx.guardAudit();
    for (const row of audit) { pids.add(row.pid); if (row.childPid) pids.add(row.childPid); }
    const errors = await ctx.cleanup();
    await poll(async () => [...pids].filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }), alive => alive.length === 0, { timeout: 10000, label: 'all owned Electron PIDs exited' });
    ctx.result.cleanup = { status: errors.length ? 'failed' : 'passed', errors, temporaryUserDataRemoved: errors.length === 0, exitedPids: [...pids] };
    ctx.result.integration = record?.status === 'passed' && errors.length === 0 ? 'isolated-scenario-passed' : 'failed';
    ctx.result.completion = false;
    ctx.result.finishedAt = new Date().toISOString();
    await writeFile(join(ctx.artifacts, 'result.json'), ctx.redact(JSON.stringify(ctx.result, null, 2)));
    assert.deepEqual(errors, []);
    await assert.rejects(access(ctx.fixture), { code: 'ENOENT' });
    t.diagnostic(JSON.stringify({ artifacts: ctx.artifacts, scenario: record?.status, assertions: record?.assertions, cleanup: ctx.result.cleanup, completion: false }));
  }
});
