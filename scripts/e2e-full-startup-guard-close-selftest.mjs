import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appPackage, desktop, makeContext, requireApp } from './e2e-full-harness.mjs';
import { closeOwnedElectron } from './e2e-full-startup-guard-launch.mjs';
import { prepareIsolatedV2Profile } from './e2e-full-persistence.mjs';

// Separate from the startup suite: verify actual graceful close after the
// production renderer finishes loadFile, including a real migrated profile.
test('real ordinary and migrated profiles close gracefully after renderer initialization', { timeout: 120000 }, async t => {
  const artifacts = await mkdtemp(join(tmpdir(), 'ecomgen-close-regression-'));
  const previousArtifacts = process.env.ECOMGEN_E2E_ARTIFACTS;
  const previousExecutable = process.env.ECOMGEN_E2E_EXECUTABLE;
  let ctx;
  const processes = [];
  try {
    process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
    delete process.env.ECOMGEN_E2E_EXECUTABLE;
    ctx = await makeContext();
    const closeProfile = async label => {
      await ctx.page.waitForLoadState('load');
      await ctx.page.getByRole('navigation', { name: '全局导航' }).waitFor({ state: 'visible' });
      const identity = await ctx.app.evaluate(({ app, BrowserWindow }) => ({
        browserPid: process.pid,
        backendPid: app.getAppMetrics().find(metric => metric.type === 'Utility' && metric.name === 'EcomGen Backend')?.pid,
        loading: BrowserWindow.getAllWindows().some(window => window.webContents.isLoading()),
      }));
      const child = ctx.app.process();
      const started = Date.now();
      processes.push(identity.browserPid, identity.backendPid, child.pid);
      await ctx.stop();
      assert.equal(child.exitCode, 0, 'orderly bridge exit without forced process termination');
      for (const pid of [identity.browserPid, identity.backendPid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      const audit = await ctx.guardAudit();
      assert.ok(audit.some(row => row.event === 'utility-exit' && row.pid === identity.browserPid && row.code === 0), 'Backend closed through the production shutdown path');
      t.diagnostic(JSON.stringify({ label, ...identity, milliseconds: Date.now() - started, launcherExitCode: child.exitCode }));
    };
    await ctx.launch();
    const userData = join(ctx.fixture, 'migration-user-data');
    const seeded = await ctx.app.evaluate((_electron, { config, token }) => globalThis.__ecomgenFullSeedV2(config, token), {
      config: { fixture: ctx.fixture, userData, image: ctx.image, width: ctx.mock.images.width, height: ctx.mock.images.height, baseUrl: ctx.mock.baseUrl },
      token: ctx.startupGuard.token,
    });
    await closeProfile('source before migration');
    await prepareIsolatedV2Profile({ fixture: ctx.fixture, sourceUserData: ctx.userData, userData });
    for (let pass = 1; pass <= 3; pass++) {
      await ctx.launch(userData);
      const inspection = await ctx.inspect('migration', seeded.ids);
      assert.equal(inspection.version, 6); assert.equal(inspection.integrity, 'ok');
      assert.deepEqual(inspection.foreignKeys, []); assert.equal(inspection.decryptable, true);
      assert.equal(inspection.providerId, seeded.ids.provider); assert.equal(inspection.ciphertextHash, seeded.ciphertextHash);
      assert.equal(inspection.histories.length, 5); assert.equal(inspection.jobs.length, 5);
      assert.equal(ctx.mock.state.total, 0, 'old paid intents never execute');
      await closeProfile(`migrated profile ${pass}`);
    }
    await ctx.launch();
    await closeProfile('ordinary source reopened');
    assert.ok((await readFile(join(ctx.userData, 'Local State'), 'utf8')).includes('os_crypt'), 'orderly shutdown flushed safeStorage profile state');
  } finally {
    if (ctx) assert.deepEqual(await ctx.cleanup(), []);
    for (const pid of processes) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    if (previousArtifacts === undefined) delete process.env.ECOMGEN_E2E_ARTIFACTS; else process.env.ECOMGEN_E2E_ARTIFACTS = previousArtifacts;
    if (previousExecutable === undefined) delete process.env.ECOMGEN_E2E_EXECUTABLE; else process.env.ECOMGEN_E2E_EXECUTABLE = previousExecutable;
    await rm(artifacts, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

for (const mode of ['quit', 'error']) test(mode === 'quit'
  ? 'quit during real pending loadFile avoids a startup error modal'
  : 'real startup navigation failure still reports the startup error', { timeout: 45000 }, async t => {
  const artifacts = await mkdtemp(join(tmpdir(), `ecomgen-close-load-${mode}-`));
  const previousArtifacts = process.env.ECOMGEN_E2E_ARTIFACTS;
  let ctx, child;
  const ownedPids = [];
  try {
    process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
    ctx = await makeContext();
    const env = { ...process.env,
      ECOMGEN_DESKTOP_DATA_DIR: ctx.userData, ECOMGEN_E2E_APP_PACKAGE: appPackage,
      ECOMGEN_E2E_GUARD_EXECUTABLE: requireApp('electron'),
      ECOMGEN_E2E_GUARD_MODULE: fileURLToPath(new URL('./e2e-full-network.mjs', import.meta.url)),
      ECOMGEN_E2E_GUARD_TOKEN: randomUUID(), ECOMGEN_E2E_GUARD_ORIGINS: JSON.stringify([ctx.mock.origin]),
      ECOMGEN_E2E_GUARD_AUDIT: join(ctx.fixture, 'network-audit.jsonl'), ECOMGEN_E2E_CLOSE_LOAD_TEST: mode,
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1',
    };
    for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ECOMGEN_E2E_GUARD_SELFTEST']) delete env[key];
    child = spawn(process.execPath, [fileURLToPath(new URL('./e2e-full-startup-guard-bootstrap.mjs', import.meta.url)),
      '--remote-debugging-port=0', `--user-data-dir=${ctx.userData}`, desktop], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    ownedPids.push(child.pid);
    let diagnostic = '';
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-16000); });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    // The exact owned tree is the sole termination fallback on test failure.
    await closeOwnedElectron({ process: () => child, close: () => exited }, 25000);
    assert.equal(await exited, 0, diagnostic);
    const rows = (await readFile(join(ctx.fixture, 'close-load-audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const audit = await ctx.guardAudit();
    const browserPid = rows.find(row => row.event === 'observer-installed')?.pid;
    const backendPid = audit.find(row => row.event === 'utility-spawn' && row.pid === browserPid)?.childPid;
    assert.ok(browserPid && backendPid); ownedPids.push(browserPid, backendPid);
    assert.ok(audit.some(row => row.event === 'installed' && row.pid === browserPid && row.type === 'browser' && row.token === env.ECOMGEN_E2E_GUARD_TOKEN));
    assert.ok(audit.some(row => row.event === 'installed' && row.pid === backendPid && row.type === 'utility' && row.token === env.ECOMGEN_E2E_GUARD_TOKEN));
    assert.ok(audit.some(row => row.event === 'utility-ready' && row.childPid === backendPid));
    assert.ok(audit.some(row => row.event === 'utility-exit' && row.pid === browserPid && row.code === 0));
    assert.ok(rows.some(row => row.event === 'renderer-navigation-pending' && row.resourceType === 'mainFrame'));
    assert.ok(rows.some(row => row.event === 'renderer-navigation-failed' && row.mainFrame && row.code < 0), 'native Chromium navigation actually failed');
    const errors = rows.filter(row => row.event === 'startup-error-reported');
    if (mode === 'quit') {
      assert.ok(rows.some(row => row.event === 'quit-requested-before-load-completion'));
      const deferred = rows.findIndex(row => row.event === 'quit-deferred');
      const failed = rows.findIndex(row => row.event === 'renderer-navigation-failed' && row.mainFrame && row.code < 0);
      const resumed = rows.findIndex(row => row.event === 'quit-resumed-after-navigation-failed');
      assert.ok(deferred >= 0 && failed > deferred && resumed > failed, 'explicit quit is deferred until native cancellation propagates');
      assert.ok(!rows.some(row => row.event === 'quit-resumed-without-navigation-evidence'));
      assert.equal(errors.length, 0, 'expected quit must not report startup failure');
    } else {
      assert.equal(errors.length, 1, 'genuine startup failure still reaches native dialog reporting');
      assert.equal(errors[0].title, 'PixelMuse 启动失败'); assert.ok(errors[0].content.length > 0);
      assert.ok(rows.findIndex(row => row.event === 'startup-error-reported') < rows.findIndex(row => row.event === 'before-quit'));
    }
    assert.equal(ctx.mock.state.total, 0);
    t.diagnostic(JSON.stringify({ mode, browserPid, backendPid, launcherPid: child.pid, launcherExitCode: child.exitCode, startupErrors: errors.length }));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) await closeOwnedElectron({ process: () => child, close: () => new Promise(resolve => child.once('close', resolve)) }, 1000).catch(() => {});
    if (ctx) assert.deepEqual(await ctx.cleanup(), []);
    for (const pid of ownedPids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    if (previousArtifacts === undefined) delete process.env.ECOMGEN_E2E_ARTIFACTS; else process.env.ECOMGEN_E2E_ARTIFACTS = previousArtifacts;
    await rm(artifacts, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
