import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeContext, root, appPackage, requireApp, executeScenario } from './e2e-full-harness.mjs';
import { scenarios } from './e2e-full-registry.mjs';
import { launchGuardedElectron, closeOwnedElectron } from './e2e-full-startup-guard-launch.mjs';
import { chromium } from 'playwright-core';
assert.equal(process.versions.node.split('.')[0], '22');
assert.ok(!process.env.ECOMGEN_E2E_EXECUTABLE, 'Only separate development Electron fixtures');
const phase = process.argv[2] ?? 'mixed';
const base = join(root, '.cache/e2e-full'); await mkdir(base, { recursive: true });
const artifacts = await mkdtemp(join(base, `lifecycle-sol-independent-${phase}-`));
process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
const report = { phase, runtime: process.version, artifacts, startedAt: new Date().toISOString(), status: 'failed', checks: [] };
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const shared = ['scripts/e2e-full-startup-guard-launch.mjs', 'scripts/e2e-full-harness.mjs', 'apps/desktop/out/main/index.js', 'apps/desktop/out/main/backend.js'];
report.hashesBefore = Object.fromEntries(await Promise.all(shared.map(async path => [path, await hash(join(root, path))])));
let c, owned;
const lockExists = data => access(join(data, 'data/backend.lock')).then(() => true, () => false);
const paid = ctx => ctx.mock.state.counts['image-generation'] + ctx.mock.state.counts['image-edit'];
try {
  c = await makeContext();
  if (phase === 'mixed') {
    const stop = c.stop.bind(c);
    c.stop = async () => {
      if (!c.app) return stop();
      const identity = { ...c.startupGuard }, child = c.app.process(), data = c.activeData;
      const at = Date.now();
      await stop();
      const rows = await c.guardAudit();
      const closed = rows.some(row => row.token === identity.token && row.pid === identity.browserPid && row.event === 'utility-closed' && row.childPid === identity.backendPid);
      const lock = await lockExists(data);
      report.checks.push({ type: 'production-close', browserPid: identity.browserPid, backendPid: identity.backendPid, launcherPid: child.pid, elapsedMs: Date.now() - at, launcherExitCode: child.exitCode, backendClosedMessage: closed, ownerLockRemains: lock });
      assert.equal(child.exitCode, 0);
      assert.equal(closed, true, 'Real Backend closed message required, code 0 alone is insufficient');
      assert.equal(lock, false, 'Graceful stop released owner lock');
      for (const pid of [identity.browserPid, identity.backendPid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    };
    c.catalog = JSON.parse(await readFile(join(root, 'packages/contracts/command-catalog.json'), 'utf8'));
    await c.launch();
    await c.page.waitForLoadState('load');
    await c.page.getByRole('navigation', { name: '全局导航' }).waitFor();
    await c.page.screenshot({ path: join(artifacts, 'actual-app.png') });
    const valid = { ...c.startupGuard };
    for (const mutation of [{ token: randomUUID() }, { browserPid: -1 }]) {
      c.startupGuard = { ...valid, ...mutation };
      await assert.rejects(c.invoke('getHealth'), /Browser startup guard changed/);
      await assert.rejects(c.inspect(), /Browser startup guard changed/);
    }
    c.startupGuard = valid;
    report.checks.push({ type: 'guard-identity-negative-controls', passed: true, providerRequests: c.mock.state.total });
    const ids = ['provider-multimodel', 'project-facts-assets', 'creative-ai-manual', 'storyboard-candidates', 'pattern-import', 'pattern-print-listing', 'draft-partial-retry', 'receipt-replay-download-failure', 'unknown-no-retry', 'abort-inflight', 'backend-crash-status', 'persisted-records-restart'];
    for (const scenario of scenarios.filter(row => ids.includes(row.id))) {
      const before = paid(c);
      if (scenario.id === 'receipt-replay-download-failure') report.mixedBeforeReceipt = await c.inspect();
      const record = await executeScenario(c, scenario);
      if (scenario.id === 'receipt-replay-download-failure') report.receipt = { status: record.status, imagePosts: paid(c) - before, downloadFailures: c.mock.state.downloadFailures, assertions: record.assertions };
      assert.equal(record.status, 'passed', `${record.id}: ${record.error ?? record.status}`);
    }
    report.scenarios = c.result.scenarios.map(({ id, status, assertions, fixtureDelta }) => ({ id, status, assertions, fixtureDelta }));
    report.finalSummary = await c.inspect();
    report.rendererErrors = c.state.events.filter(row => row.type === 'pageerror').length;
    assert.equal(report.rendererErrors, 0);
    assert.equal(c.mock.state.callbackErrors, 0);
    const before = paid(c);
    await c.stop(); await c.launch();
    assert.equal(paid(c), before, 'Additional persisted reopen cannot repeat paid POSTs');
    report.checks.push({ type: 'additional-persisted-reopen', paidPostDelta: paid(c) - before });
  } else if (phase === 'cleanup-one' || phase === 'cleanup-many') {
    await c.launch(); await c.page.waitForLoadState('load'); await c.stop();
    const count = phase === 'cleanup-one' ? 1 : 41;
    const seed = spawnSync(requireApp('electron'), [join(root, 'scripts/e2e-full-lifecycle-cdx-20261106-seed-cleanup.mjs'), join(c.userData, 'data/backend.sqlite'), c.fixture, c.image, String(count)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 15000 });
    assert.equal(seed.status, 0, 'Synthetic fixture seed completed');
    report.seed = JSON.parse(seed.stdout.trim());
    const at = Date.now();
    try {
      await c.launch(); report.startup = { status: 'ready', elapsedMs: Date.now() - at };
      report.summary = await c.inspect();
      assert.equal(report.summary.counts.jobs, 0);
      assert.equal(report.summary.counts.desktop_cleanup_queue, 0);
      await c.stop(); report.ownerLockAfterStop = await lockExists(c.userData);
      assert.equal(report.ownerLockAfterStop, false);
      await c.launch(); assert.equal((await c.invoke('getHealth')).status, 'ready');
    } catch (error) {
      report.startup = { status: 'failed', elapsedMs: Date.now() - at, message: c.redact(error.message) };
      const rows = await c.guardAudit();
      report.startupModal = rows.some(row => row.event === 'startup-error-modal');
      report.backendReady = rows.some(row => row.event === 'utility-ready' && row.token !== rows.find(row => row.event === 'installed')?.token);
      report.ownerLockAfterFailedLaunch = await lockExists(c.userData);
      assert.equal(phase, 'cleanup-many', 'Small workload must be healthy');
      assert.equal(report.startupModal, true, 'Native startup failure was observed');
    }
    report.providerRequests = c.mock.state.total;
    assert.equal(report.providerRequests, 0);
  } else if (phase === 'shutdown-one' || phase === 'shutdown-many') {
    const token = randomUUID();
    const env = { ...process.env, ECOMGEN_DESKTOP_DATA_DIR: c.userData, ECOMGEN_E2E_APP_PACKAGE: appPackage, ECOMGEN_E2E_GUARD_TOKEN: token, ECOMGEN_E2E_GUARD_ORIGINS: JSON.stringify([c.mock.origin]), ECOMGEN_E2E_GUARD_AUDIT: join(c.fixture, 'network-audit.jsonl'), ECOMGEN_SOL_SEED_IMAGE: c.image, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
    for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) delete env[key];
    c.app = await launchGuardedElectron({ executable: requireApp('electron'), args: [join(root, 'scripts/e2e-full-lifecycle-sol-independent-20261106-7f21-shutdown-main.cjs')], env });
    c.page = await c.app.firstWindow();
    const browserPid = await c.app.evaluate(() => process.pid);
    c.startupGuard = { token, browserPid, backendPid: null };
    await c.assertGuardCurrent();
    await c.page.waitForLoadState('load');
    await c.page.getByRole('navigation', { name: '全局导航' }).waitFor();
    assert.equal((await c.invoke('getHealth')).status, 'ready');
    const count = phase === 'shutdown-one' ? 1 : 41;
    await c.app.evaluate((_electron, { token, count }) => globalThis.__solOwnedBackend.postMessage({ type: '__sol-cleanup-seed', token, cleanupCount: count }), { token, count });
    for (let attempt = 0; attempt < 100; attempt++) {
      report.seed = await c.app.evaluate(() => globalThis.__solSeeded);
      if (report.seed) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(report.seed, { resources: 299, cleanupIntents: count, jobs: 0 });
    const identity = { ...c.startupGuard }, child = c.app.process(), at = Date.now();
    await c.stop();
    report.shutdownMs = Date.now() - at;
    report.launcherExitCode = child.exitCode;
    report.trace = (await readFile(join(c.fixture, 'sol-shutdown-trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    report.backendClosedMessage = report.trace.some(row => row.event === 'backend-closed');
    report.ownerLockRemains = await lockExists(c.userData);
    report.providerRequests = c.mock.state.total;
    assert.equal(report.providerRequests, 0);
    assert.equal(child.exitCode, 0);
    if (count === 1) {
      assert.equal(report.backendClosedMessage, true); assert.equal(report.ownerLockRemains, false); assert.ok(report.shutdownMs < 15000);
    } else {
      assert.equal(report.backendClosedMessage, false); assert.equal(report.ownerLockRemains, true); assert.ok(report.shutdownMs >= 14900 && report.shutdownMs < 20000);
    }
    for (const pid of [identity.browserPid, identity.backendPid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } else if (phase === 'controlled') {
    for (const mode of ['app-quit', 'cdp-disconnect-first', 'force-owned-process']) {
      const data = join(c.fixture, mode); await mkdir(data);
      const env = { ...process.env, ECOMGEN_DESKTOP_DATA_DIR: data, ECOMGEN_E2E_APP_PACKAGE: appPackage, ECOMGEN_E2E_GUARD_TOKEN: randomUUID(), ECOMGEN_E2E_GUARD_ORIGINS: JSON.stringify([c.mock.origin]), ECOMGEN_E2E_GUARD_AUDIT: join(c.fixture, 'network-audit.jsonl'), HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
      for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) delete env[key];
      owned = await launchGuardedElectron({ executable: requireApp('electron'), args: [join(root, 'scripts/e2e-full-lifecycle-sol-independent-20261106-7f21-fixture.cjs')], env });
      await owned.firstWindow();
      const identity = await owned.evaluate(({ app }) => ({ browserPid: process.pid, backendPid: app.getAppMetrics().find(row => row.name === 'EcomGen Backend')?.pid }));
      const child = owned.process();
      const at = Date.now();
      let disconnectPreservedApp, forceError = false;
      if (mode === 'cdp-disconnect-first') {
        const endpoint = /DevTools listening on (ws:\/\/[^\s]+)/.exec(owned.diagnostics().stderr)?.[1];
        assert.ok(endpoint);
        const connection = await chromium.connectOverCDP(endpoint);
        await connection.close();
        disconnectPreservedApp = await owned.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1);
        assert.equal(disconnectPreservedApp, true);
      }
      if (mode === 'force-owned-process') {
        await owned.evaluate(({ app }) => { app.quit(); });
        const pending = await owned.evaluate(() => globalThis.__solStopPending);
        assert.equal(pending, true);
        process.kill(identity.browserPid);
        try { await closeOwnedElectron(owned, 5000); } catch { forceError = true; }
      } else await closeOwnedElectron(owned);
      owned = null;
      const trace = (await readFile(join(data, 'controlled-close.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      const closed = trace.findIndex(row => row.event === 'backend-closed');
      const willQuit = trace.findIndex(row => row.event === 'will-quit');
      const backendExit = trace.findIndex(row => row.event === 'backend-exit-0');
      const lock = await access(join(data, 'data/backend.lock')).then(() => true, () => false);
      report.checks.push({ mode, ...identity, launcherPid: child.pid, launcherExitCode: child.exitCode, elapsedMs: Date.now() - at, disconnectPreservedApp, forceError, trace, ownerLockRemains: lock });
      if (mode !== 'force-owned-process') {
        assert.ok(closed >= 0 && backendExit > closed && willQuit > backendExit, 'Backend completed and exited before Electron quit');
        assert.equal(lock, false); assert.equal(child.exitCode, 0);
        assert.ok(Date.now() - at >= 1000);
      } else {
        assert.equal(closed, -1); assert.equal(willQuit, -1);
        assert.equal(lock, true, 'Forced termination control retains unreleased owner lock');
      }
      for (const pid of [identity.browserPid, identity.backendPid]) {
        const deadline = Date.now() + 5000;
        let alive = true;
        while (alive && Date.now() < deadline) {
          try { process.kill(pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
          if (alive) await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(alive, false, `Owned PID ${pid} exited`);
      }
    }
  } else throw Error('Unknown phase');
  report.status = 'passed';
} catch (error) {
  report.error = c?.redact(error.stack ?? error.message) ?? error.message;
} finally {
  if (owned) await closeOwnedElectron(owned, 1000).catch(() => {});
  report.cleanup = c ? await c.cleanup() : [];
  if (report.cleanup.length) report.status = 'failed';
  report.hashesAfter = Object.fromEntries(await Promise.all(shared.map(async path => [path, await hash(join(root, path))])));
  report.sharedFilesUnchanged = JSON.stringify(report.hashesBefore) === JSON.stringify(report.hashesAfter);
  report.finishedAt = new Date().toISOString();
  await writeFile(join(artifacts, 'independent-result.json'), c ? c.redact(JSON.stringify(report, null, 2)) : JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, phase, artifacts, error: report.error, receipt: report.receipt, startup: report.startup, cleanup: report.cleanup, sharedFilesUnchanged: report.sharedFilesUnchanged }));
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
