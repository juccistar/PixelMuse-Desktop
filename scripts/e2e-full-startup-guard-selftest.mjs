import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { root, desktop, appPackage, requireApp, makeContext, poll } from './e2e-full-harness.mjs';
import { launchGuardedElectron, closeOwnedElectron } from './e2e-full-startup-guard-launch.mjs';

const auditRows = async filename => (await readFile(filename, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
async function verifyActualProcesses(app, page, auditFile, token, origin, { productionBoundary = true } = {}) {
  const identity = await app.evaluate(({ app, BrowserWindow }) => ({
    pid: process.pid, guard: globalThis.__ecomgenFullGuard, version: app.getVersion(),
    electron: process.versions.electron, appPath: app.getAppPath(), userData: app.getPath('userData'),
    backendPid: app.getAppMetrics().find(metric => metric.type === 'Utility' && metric.name === 'EcomGen Backend')?.pid,
    preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  }));
  assert.equal(identity.guard.token, token);
  assert.ok(identity.backendPid && identity.backendPid !== identity.pid);
  assert.equal(identity.preferences.contextIsolation, true);
  assert.equal(identity.preferences.nodeIntegration, false);
  assert.equal(identity.preferences.sandbox, true);
  assert.match(page.url(), /^file:/);
  await page.waitForFunction(() => Boolean(window.ecomgen));
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await app.evaluate(() => globalThis.__ecomgenFullGuardVerify());
  const native = await app.evaluate(async ({ session }, { origin, token, productionBoundary }) => {
    const isolated = session.fromPartition('guard-selftest-' + token);
    // Later listener replacement cannot remove the guard; null cannot either.
    isolated.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: false }));
    isolated.webRequest.onBeforeRequest(null);
    const allowed = await isolated.fetch(origin + '/health');
    await allowed.arrayBuffer();
    let denied = 0;
    for (const url of ['http://127.0.0.1:1/health', 'http://192.0.2.1:8088/health']) {
      try { await isolated.fetch(url); } catch { denied++; }
    }
    let productionDenied = false;
    if (productionBoundary) {
      try { await session.defaultSession.fetch(origin + '/health'); } catch { productionDenied = true; }
    }
    return { fixture: allowed.ok, denied, productionDenied };
  }, { origin, token, productionBoundary });
  assert.equal(native.fixture, true);
  assert.equal(native.denied, 2);
  if (productionBoundary) assert.equal(native.productionDenied, true, 'production renderer boundary still rejects the fixture HTTP origin');
  const rows = await poll(() => auditRows(auditFile), values => values.some(row => row.event === 'network-verified' && row.pid === identity.backendPid && row.token === token), { timeout: 10000, label: 'real current Backend network checks' });
  for (const [pid, type] of [[identity.pid, 'browser'], [identity.backendPid, 'utility']]) {
    assert.ok(rows.some(row => row.event === 'installed' && row.pid === pid && row.type === type && row.token === token));
    assert.ok(rows.some(row => row.event === 'network-verified' && row.pid === pid && row.type === type && row.token === token && row.denied === 8 && row.fixture));
  }
  assert.ok(rows.some(row => row.event === 'utility-spawn' && row.pid === identity.pid && row.childPid === identity.backendPid && row.token === token));
  assert.ok(rows.filter(row => row.event === 'blocked-renderer' && row.pid === identity.pid).length >= 2);
  await page.waitForFunction(() => document.body.innerText.trim().length > 0, null, { timeout: 15000 });
  assert.ok(await page.locator('body').innerText(), 'actual renderer has visible application text');
  return { browserPid: identity.pid, backendPid: identity.backendPid, version: identity.version, electron: identity.electron, appPath: identity.appPath, userData: identity.userData };
}

test('real source Electron: guarded production main/renderer/Backend reach ready, current-PID gate fails closed', { timeout: 60000 }, async t => {
  const artifacts = await mkdtemp(join(tmpdir(), 'ecomgen-guard-regression-'));
  const before = { executable: process.env.ECOMGEN_E2E_EXECUTABLE, selftest: process.env.ECOMGEN_E2E_GUARD_SELFTEST, artifacts: process.env.ECOMGEN_E2E_ARTIFACTS };
  let ctx;
  try {
    delete process.env.ECOMGEN_E2E_EXECUTABLE;
    process.env.ECOMGEN_E2E_GUARD_SELFTEST = '1'; process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
    ctx = await makeContext();
    await ctx.launch();
    assert.equal((await ctx.invoke('getHealth')).status, 'ready');
    const identity = await verifyActualProcesses(ctx.app, ctx.page, join(ctx.fixture, 'network-audit.jsonl'), ctx.startupGuard.token, ctx.mock.origin);
    assert.equal(resolve(identity.appPath), resolve(desktop));
    assert.equal(resolve(identity.userData), resolve(ctx.userData));
    if (process.env.ECOMGEN_GUARD_SCREENSHOT) await ctx.page.screenshot({ path: process.env.ECOMGEN_GUARD_SCREENSHOT, fullPage: true });
    const inspection = await ctx.inspect();
    assert.ok(Number.isSafeInteger(inspection.version) && inspection.version > 0);
    assert.equal(inspection.integrity, 'ok'); assert.deepEqual(inspection.foreignKeys, []);
    assert.equal(inspection.counts.providers, 0); assert.equal(inspection.counts.jobs, 0);
    t.diagnostic(JSON.stringify({ mode: 'source', ...identity, health: 'ready', businessCalls: 0,
      inspection: { databaseVersion: inspection.version, integrity: inspection.integrity, providers: inspection.counts.providers, jobs: inspection.counts.jobs } }));
    assert.equal(ctx.mock.control.snapshot().counts.chat, 0);
    assert.equal(ctx.mock.control.snapshot().counts['image-generation'], 0);
    const valid = ctx.startupGuard;
    ctx.startupGuard = { ...valid, token: randomUUID() };
    await assert.rejects(ctx.invoke('getHealth'), /Browser startup guard changed/);
    await assert.rejects(ctx.inspect(), /Browser startup guard changed/);
    ctx.startupGuard = valid;
    const owned = ctx.app.process();
    await ctx.stop();
    assert.notEqual(owned.exitCode ?? owned.signalCode, null, 'owned launcher has exited after cleanup');
    const rows = await ctx.guardAudit();
    assert.ok(rows.some(row => row.event === 'utility-exit' && row.pid === identity.browserPid && row.code === 0));
    // Force a failure after real Electron/Backend startup, before any business
    // dispatch. A failed launch must close the actual owned process tree.
    const verifyGuard = ctx.assertGuardCurrent;
    let failedLaunchChild;
    ctx.assertGuardCurrent = async () => {
      await verifyGuard();
      failedLaunchChild = ctx.app.process();
      throw Error('Intentional startup gate failure');
    };
    await assert.rejects(ctx.launch(), /Intentional startup gate failure/);
    ctx.assertGuardCurrent = verifyGuard;
    assert.equal(ctx.app, null); assert.equal(ctx.page, null); assert.equal(ctx.startupGuard, null);
    assert.ok(failedLaunchChild.exitCode !== null || failedLaunchChild.signalCode !== null, 'failed launch left no owned launcher running');
  } finally {
    if (ctx) assert.deepEqual(await ctx.cleanup(), []);
    for (const [key, value] of Object.entries({ ECOMGEN_E2E_EXECUTABLE: before.executable, ECOMGEN_E2E_GUARD_SELFTEST: before.selftest, ECOMGEN_E2E_ARTIFACTS: before.artifacts })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(artifacts, { recursive: true, force: true });
  }
});

test('invalid guard policy aborts before original production entry without a Backend database', { timeout: 30000 }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'ecomgen-rejected-guard-'));
  const data = join(fixture, 'user-data'); await mkdir(data);
  const env = { ...process.env, ECOMGEN_DESKTOP_DATA_DIR: data,
    ECOMGEN_E2E_GUARD_ORIGINS: '["https://example.invalid"]', ECOMGEN_E2E_GUARD_AUDIT: join(fixture, 'audit.jsonl'),
    ECOMGEN_E2E_APP_PACKAGE: appPackage, ECOMGEN_E2E_GUARD_TOKEN: randomUUID() };
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) delete env[key];
  try {
    await assert.rejects(launchGuardedElectron({ fixture, executable: requireApp('electron'), args: [desktop], env }),
      /explicit loopback fixture origins/);
    await nextTurn();
    await assert.rejects(access(join(data, 'data/backend.sqlite')), { code: 'ENOENT' });
    await assert.rejects(access(join(data, 'logs/main.log')), { code: 'ENOENT' });
  } finally { await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('normal acceptance entry reports and cleans an exit before debugger endpoints exist', { timeout: 30000 }, async () => {
  const artifacts = await mkdtemp(join(tmpdir(), 'ecomgen-entry-failure-'));
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, 'scripts/e2e-full.mjs'), '--startup-only'], {
        cwd: root, env: { ...process.env, ECOMGEN_E2E_ARTIFACTS: artifacts, ECOMGEN_E2E_EXECUTABLE: join(artifacts, 'absent.exe') },
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 25000,
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
      child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /unhandled|coreBundle|Process failed to launch/i);
    const report = JSON.parse(await readFile(join(artifacts, 'result.json'), 'utf8'));
    const coverage = JSON.parse(await readFile(join(artifacts, 'coverage.json'), 'utf8'));
    assert.equal(report.integration, 'failed'); assert.equal(coverage.completion, false);
    assert.equal(coverage.startupProbe.status, 'failed'); assert.match(coverage.error, /ENOENT/);
    assert.deepEqual(report.cleanup, { status: 'passed', errors: [], temporaryUserDataRemoved: true });
    assert.ok(report.scenarios.every(row => row.status === 'blocked' && row.assertions === 0 && row.jobs.length === 0));
    const launcherPid = /owned launcher PID (\d+)/.exec(coverage.error)?.[1];
    assert.ok(launcherPid); assert.throws(() => process.kill(Number(launcherPid), 0), { code: 'ESRCH' });
  } finally { await rm(artifacts, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('real packaged EXE: guard precedes unchanged asar entry and protects its current Backend', { timeout: 60000, skip: !process.env.ECOMGEN_GUARD_PACKAGED_EXECUTABLE }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'ecomgen-packaged-guard-'));
  const data = join(fixture, 'user-data'), auditFile = join(fixture, 'audit.jsonl'), token = randomUUID();
  await mkdir(data);
  let requests = 0, app;
  const server = createServer((_request, response) => { requests++; response.end('isolated fixture'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env, ECOMGEN_DESKTOP_DATA_DIR: data, ECOMGEN_E2E_GUARD_ORIGINS: JSON.stringify([origin]), ECOMGEN_E2E_GUARD_AUDIT: auditFile,
      ECOMGEN_E2E_APP_PACKAGE: appPackage, ECOMGEN_E2E_GUARD_TOKEN: token, ECOMGEN_E2E_GUARD_SELFTEST: '1',
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1', http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '127.0.0.1' };
    for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) delete env[key];
    app = await launchGuardedElectron({ fixture, executable: process.env.ECOMGEN_GUARD_PACKAGED_EXECUTABLE, args: [], env, timeout: 45000 });
    const page = await app.firstWindow({ timeout: 30000 });
    // The permitted 0.2 baseline validates guard startup only; 0.3 must also
    // retain the production request boundary verified against current source.
    const productionBoundary = await app.evaluate(({ app }) => app.getVersion() !== '0.2.0');
    const identity = await verifyActualProcesses(app, page, auditFile, token, origin, { productionBoundary });
    assert.match(identity.appPath, /resources[\\/]app\.asar$/);
    assert.equal(resolve(identity.userData), resolve(data));
    assert.equal(requests, 3, 'only browser Node, Backend Node and isolated native session reached the fixture');
    const inspection = await app.evaluate((_electron, input) => globalThis.__ecomgenFullInspectDatabase(input), {
      filename: join(data, 'data/backend.sqlite'), appPackage: join(root, 'packages/backend/package.json'), electronPackage: appPackage, mode: 'summary',
    });
    assert.ok(Number.isSafeInteger(inspection.version) && inspection.version > 0);
    assert.equal(inspection.integrity, 'ok'); assert.deepEqual(inspection.foreignKeys, []);
    assert.equal(inspection.counts.providers, 0); assert.equal(inspection.counts.jobs, 0);
    t.diagnostic(JSON.stringify({ mode: 'packaged-startup-only', ...identity, requests, providerConfigurations: 0, businessCalls: 0,
      inspection: { databaseVersion: inspection.version, integrity: inspection.integrity, providers: inspection.counts.providers, jobs: inspection.counts.jobs } }));
    await closeOwnedElectron(app); app = null;
  } finally {
    try { if (app) await closeOwnedElectron(app); }
    finally { await new Promise(resolve => server.close(resolve)); await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }
});
