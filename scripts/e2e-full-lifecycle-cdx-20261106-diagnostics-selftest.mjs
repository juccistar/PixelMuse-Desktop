import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, appPackage, requireApp, makeContext } from './e2e-full-harness.mjs';
import { launchGuardedElectron, closeOwnedElectron } from './e2e-full-startup-guard-launch.mjs';
assert.equal(process.versions.node.split('.')[0], '22');
const base = join(root, '.cache/e2e-full'); await mkdir(base, { recursive: true });
const artifacts = await mkdtemp(join(base, 'lifecycle-cdx-diagnostics-'));
process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
const ctx = await makeContext();
const report = { artifacts, runtime: process.version, status: 'failed' };
let app;
const launch = async () => {
  const env = { ...process.env, ECOMGEN_DESKTOP_DATA_DIR: ctx.userData, ECOMGEN_E2E_APP_PACKAGE: appPackage,
    ECOMGEN_E2E_GUARD_TOKEN: randomUUID(), ECOMGEN_E2E_GUARD_ORIGINS: JSON.stringify([ctx.mock.origin]),
    ECOMGEN_E2E_GUARD_AUDIT: join(ctx.fixture, 'network-audit.jsonl'),
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' };
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) delete env[key];
  return launchGuardedElectron({ executable: requireApp('electron'), args: [join(root, 'scripts/e2e-full-lifecycle-cdx-20261106-diagnostic-main.cjs')], env, timeout: 10000 });
};
try {
  app = await launch();
  const page = await app.firstWindow();
  await page.getByRole('navigation', { name: '全局导航' }).waitFor({ state: 'visible' });
  assert.equal((await page.evaluate(() => window.ecomgen.invoke('getHealth', {}))).status, 'ready');
  await page.screenshot({ path: join(artifacts, 'diagnostic-entry-healthy.png') });
  const child = app.process(); await closeOwnedElectron(app); app = null;
  assert.equal(child.exitCode, 0);
  app = await launch();
  const reopened = await app.firstWindow();
  await reopened.getByRole('navigation', { name: '全局导航' }).waitFor({ state: 'visible' });
  assert.equal((await reopened.evaluate(() => window.ecomgen.invoke('getHealth', {}))).status, 'ready');
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), requireApp(appPackage).version);
  const reopenedChild = app.process(); await closeOwnedElectron(app); app = null;
  assert.equal(reopenedChild.exitCode, 0);
  await ctx.lifecycleDiagnostics('healthy-diagnostic-entry');
  const locations = await readFile(join(ctx.fixture, 'startup-exception-locations.jsonl'), 'utf8');
  await writeFile(join(artifacts, 'healthy-exception-locations.jsonl'), ctx.redact(locations));
  assert.ok(locations.split('\n').filter(Boolean).map(JSON.parse).some(row => row.event === 'closed-profile-counts'));
  // Genuine production credential initialization failure in the isolated profile.
  await writeFile(join(ctx.userData, 'master-key.enc'), Buffer.from('synthetic invalid DPAPI payload'));
  let launchError;
  try {
    app = await launch();
    await app.firstWindow({ timeout: 2000 });
  } catch (error) { launchError = error; }
  assert.ok(launchError, 'Real startup failure stays a failed launch');
  report.failureEvidence = await ctx.lifecycleDiagnostics('expected-startup-failed', app, launchError);
  assert.ok((await ctx.guardAudit()).some(row => row.event === 'startup-error-modal' && row.title === 'PixelMuse 启动失败'));
  let closeError;
  if (app) {
    try { await closeOwnedElectron(app, 1000); } catch (error) { closeError = error; }
  } else closeError = launchError;
  assert.match(closeError?.message ?? '', /close timed out/, 'Native failure modal remains visible and failure is retained');
  report.closeEvidence = await ctx.lifecycleDiagnostics('expected-startup-cleaned', app, closeError);
  app = null;
  const text = await readFile(report.failureEvidence, 'utf8');
  assert.ok(text.includes('mainLog') && text.includes('stderr') && text.includes('audit'));
  assert.ok(!text.includes(ctx.fakeKey));
  report.status = 'passed'; report.productionLaunchStatus = 'failed-as-expected';
} catch (error) {
  report.error = ctx.redact(error.stack ?? error.message);
  report.failureEvidence = await ctx.lifecycleDiagnostics('diagnostic-selftest-failed', app, error).catch(() => null);
}
finally {
  if (app) await closeOwnedElectron(app, 1000).catch(() => {});
  report.cleanup = await ctx.cleanup();
  if (report.cleanup.length) report.status = 'failed';
  await writeFile(join(artifacts, 'diagnostics-result.json'), ctx.redact(JSON.stringify(report, null, 2)));
  console.log(JSON.stringify(report));
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
