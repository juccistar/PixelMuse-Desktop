import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, appPackage, requireApp, makeContext, executeScenario } from './e2e-full-harness.mjs';
import { launchGuardedElectron, closeOwnedElectron } from './e2e-full-startup-guard-launch.mjs';
import { scenarios } from './e2e-full-registry.mjs';
assert.equal(process.versions.node.split('.')[0], '22');
assert.ok(!process.env.ECOMGEN_E2E_EXECUTABLE, 'Development Electron only');
const mode = process.argv[2] ?? 'full';
const base = join(root, '.cache/e2e-full'); await mkdir(base, { recursive: true });
const artifacts = await mkdtemp(join(base, `lifecycle-cdx-${mode}-`));
process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
let ctx, app;
const report = { mode, completion: false, artifacts, runtime: process.version, startedAt: new Date().toISOString() };
try {
  ctx = await makeContext();
  ctx.catalog = JSON.parse(await readFile(join(root, 'packages/contracts/command-catalog.json'), 'utf8'));
  if (mode === 'full-diagnostic' || mode === 'isolate') {
    const launch = ctx.launch.bind(ctx);
    ctx.launch = data => launch(data, { startupDiagnostics: true });
  }
  if (mode === 'controlled') {
    const env = { ...process.env, ECOMGEN_DESKTOP_DATA_DIR: ctx.userData, ECOMGEN_E2E_APP_PACKAGE: appPackage,
      ECOMGEN_E2E_GUARD_TOKEN: randomUUID(), ECOMGEN_E2E_GUARD_ORIGINS: JSON.stringify([ctx.mock.origin]),
      ECOMGEN_E2E_GUARD_AUDIT: join(ctx.fixture, 'network-audit.jsonl'),
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' };
    for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) delete env[key];
    app = await launchGuardedElectron({ executable: requireApp('electron'), args: [join(root, 'scripts/e2e-full-lifecycle-cdx-20261106-fixture.cjs')], env });
    await app.firstWindow();
    const started = Date.now();
    const child = app.process();
    await closeOwnedElectron(app); app = null;
    report.elapsedMs = Date.now() - started; report.exitCode = child.exitCode;
    report.trace = (await readFile(join(ctx.userData, 'controlled-close.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    await ctx.lifecycleDiagnostics('controlled-close');
    assert.ok(report.trace.some(row => row.event === 'backend-exit-0'), 'Backend must exit normally before Electron');
    assert.ok(report.elapsedMs >= 1000, 'Actual Backend stop wait is preserved');
  } else {
    await ctx.launch();
    const selected = mode === 'focused'
      ? scenarios.filter(row => ['provider-multimodel', 'project-facts-assets', 'creative-ai-manual', 'storyboard-candidates', 'pattern-import', 'pattern-print-listing', 'draft-partial-retry', 'receipt-replay-download-failure', 'unknown-no-retry', 'abort-inflight', 'backend-crash-status', 'persisted-records-restart'].includes(row.id))
      : mode === 'isolate' ? scenarios.slice(0, scenarios.findIndex(row => row.id.startsWith('ui-'))).filter(row => row.id !== 'planning-history') : scenarios;
    for (const scenario of selected) {
      const record = await executeScenario(ctx, scenario);
      if (record.status !== 'passed' && scenario.id === 'receipt-replay-download-failure') break;
      if (mode === 'isolate') {
        report.restartingAfter = scenario.id;
        await ctx.stop(); await ctx.launch();
      }
    }
    report.scenarios = ctx.result.scenarios;
    report.globalChecks = { rendererErrors: ctx.state.events.filter(row => row.type === 'pageerror').length, fixtureCallbackErrors: ctx.mock.state.callbackErrors };
    report.fixture = ctx.mock.control.snapshot();
    await ctx.lifecycleDiagnostics('run-end');
    assert.ok(report.scenarios.every(row => row.status === 'passed'), 'Every selected scenario must pass');
    assert.equal(report.globalChecks.rendererErrors, 0); assert.equal(report.globalChecks.fixtureCallbackErrors, 0);
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = ctx?.redact(error.stack ?? error.message) ?? error.message;
  if (ctx) {
    report.scenarios = ctx.result.scenarios;
    await ctx.lifecycleDiagnostics('reproducer-failed', app ?? ctx.app, error).catch(() => {});
    if (mode === 'controlled') {
      report.trace = await readFile(join(ctx.userData, 'controlled-close.jsonl'), 'utf8').catch(() => 'unavailable');
    }
  }
} finally {
  if (app) await closeOwnedElectron(app, 1000).catch(() => {});
  report.cleanup = ctx ? await ctx.cleanup() : [];
  if (report.cleanup.length) report.status = 'failed';
  report.finishedAt = new Date().toISOString();
  await writeFile(join(artifacts, 'reproducer-result.json'), ctx ? ctx.redact(JSON.stringify(report, null, 2)) : JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, mode, error: report.error, trace: report.trace, elapsedMs: report.elapsedMs, counts: report.scenarios?.reduce((counts, row) => ({ ...counts, [row.status]: (counts[row.status] ?? 0) + 1 }), {}), cleanup: report.cleanup, artifacts }));
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
