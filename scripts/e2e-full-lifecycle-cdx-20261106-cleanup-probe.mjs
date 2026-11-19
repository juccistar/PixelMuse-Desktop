import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { root, makeContext, requireApp } from './e2e-full-harness.mjs';
assert.equal(process.versions.node.split('.')[0], '22');
const base = join(root, '.cache/e2e-full'); await mkdir(base, { recursive: true });
const artifacts = await mkdtemp(join(base, 'lifecycle-cdx-cleanup-probe-'));
process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
const c = await makeContext();
const plain = process.argv.includes('--plain'), cleanupCount = process.argv.includes('--one') ? 1 : 41;
const report = { status: 'failed', plain, cleanupCount, scope: 'Minimal synthetic resource cleanup/reopen probe; no business coverage claim', artifacts };
try {
  await c.launch(); await c.page.waitForLoadState('load'); await c.stop();
  const child = spawnSync(requireApp('electron'), [join(root, 'scripts/e2e-full-lifecycle-cdx-20261106-seed-cleanup.mjs'),
    join(c.userData, 'data/backend.sqlite'), c.fixture, c.image, String(cleanupCount)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr); report.seed = JSON.parse(child.stdout.trim());
  const started = Date.now();
  await c.launch(c.userData, { startupDiagnostics: !plain });
  report.firstStartupMs = Date.now() - started;
  report.summary = await c.inspect();
  assert.equal(report.summary.counts.desktop_resources, 299 - cleanupCount); assert.equal(report.summary.counts.desktop_cleanup_queue, 0);
  await c.stop();
  report.lockAfterClose = await access(join(c.userData, 'data/backend.lock')).then(() => true, () => false);
  assert.equal(report.lockAfterClose, false);
  await c.launch();
  assert.equal((await c.invoke('getHealth')).status, 'ready');
  await c.lifecycleDiagnostics('cleanup-probe-end');
  report.status = 'passed';
} catch (error) {
  report.error = c.redact(error.stack ?? error.message);
  await c.lifecycleDiagnostics('cleanup-probe-failed', c.app, error).catch(() => {});
} finally {
  report.cleanup = await c.cleanup();
  if (report.cleanup.length) report.status = 'failed';
  await writeFile(join(artifacts, 'cleanup-probe-result.json'), c.redact(JSON.stringify(report, null, 2)));
  console.log(JSON.stringify(report)); process.exitCode = report.status === 'passed' ? 0 : 1;
}
