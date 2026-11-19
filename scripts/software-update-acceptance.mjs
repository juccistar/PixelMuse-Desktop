import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appPackage, executeScenario, makeContext, poll, requireApp, root } from './e2e-full-harness.mjs';

// Requires an already built source runtime. Never points at an installed app.
const args = process.argv.slice(2);
assert.equal(args.length, 2, 'Usage: node scripts/software-update-acceptance.mjs --artifacts <new-empty-directory>');
assert.equal(args[0], '--artifacts');
const artifacts = resolve(args[1]);
assert.equal((await readdir(artifacts)).length, 0, 'Artifacts directory must already exist and be empty');
assert.ok(!process.env.ECOMGEN_E2E_EXECUTABLE, 'Source Electron only');
process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
const resultPath = join(artifacts, 'result.json');
const report = { integration: 'failed', startedAt: new Date().toISOString(), limitations: ['Source Electron does not support installing updates', 'Updater fixture is separate from production IPC and does not validate installation or a GitHub release'], errors: [] };
let c, scratch;
const runSmoke = () => new Promise((resolveSmoke, reject) => {
  const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1', http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '127.0.0.1' };
  delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const child = spawn(requireApp('electron'), [join(root, 'scripts/software-update-smoke.cjs'), scratch, join(artifacts, 'updater-fixture.json'), appPackage], { env, stdio: 'ignore', windowsHide: true });
  let expired = false;
  const timer = setTimeout(() => { expired = true; child.kill(); }, 60000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', (code, signal) => { clearTimeout(timer); if (expired || code !== 0) reject(new Error(`Updater fixture process failed (code ${code}, signal ${signal}, timeout ${expired})`)); else resolveSmoke(); });
});
try {
  c = await makeContext();
  const native = (operation, input = {}) => c.page.evaluate(({ operation, input }) => window.ecomgen.application(operation, input), { operation, input });
  const category = async name => {
    await c.page.getByRole('button', { name: '设置', exact: true }).click();
    await c.page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name, exact: true }).click();
    await c.page.getByRole('heading', { name, exact: true }).waitFor();
  };
  await c.launch(c.userData, { startupDiagnostics: true });
  await executeScenario(c, { id: 'source-update', title: 'Source update page, fixed external link and persisted preferences', run: async () => {
    await c.app.evaluate(({ shell }) => { globalThis.__updateExternalCalls = []; shell.openExternal = async url => { globalThis.__updateExternalCalls.push(url); }; });
    await category('软件更新');
    const status = await native('updateStatus');
    c.equal(status.currentVersion, '0.4.8'); c.equal(status.state, 'UNSUPPORTED'); c.equal(status.supported, false);
    c.equal(status.releaseUrl, 'https://github.com/juccistar/pixelmuse-releases/releases');
    await c.page.getByText('0.4.8', { exact: true }).waitFor();
    await c.page.getByText('源码运行或解包版本不支持自动更新，请下载安装版后使用此功能。', { exact: true }).waitFor();
    await c.screenshot('unsupported');
    await c.page.getByRole('button', { name: '打开下载页面', exact: true }).click();
    await poll(() => c.app.evaluate(() => globalThis.__updateExternalCalls), calls => calls.length === 1, { label: 'captured release link' });
    c.equal(await c.app.evaluate(() => globalThis.__updateExternalCalls), [status.releaseUrl]);
    for (const [operation, input] of [['openUpdateReleases', { url: 'https://example.invalid/' }], ['openUpdateReleases', { extra: true }], ['setUpdatePreferences', { autoCheck: false, url: 'https://example.invalid/' }], ['updateStatus', { extra: true }], ['unknownUpdateOperation', {}]]) {
      const rejection = await c.page.evaluate(async ({ operation, input }) => { try { await window.ecomgen.application(operation, input); return false; } catch { return true; } }, { operation, input });
      c.equal(rejection, true, `Reject invalid ${operation} input`);
    }
    c.equal(await c.app.evaluate(() => globalThis.__updateExternalCalls), [status.releaseUrl]);
    const autoCheck = c.page.getByRole('switch', { name: '自动检查更新' });
    c.equal(await autoCheck.isChecked(), true);
    await autoCheck.click();
    await poll(() => native('updateStatus'), value => !value.autoCheck, { label: 'preference saved through settings switch' });
    c.equal(await autoCheck.isChecked(), false);
    await category('常规设置'); await category('软件更新');
    c.equal((await native('updateStatus')).autoCheck, false);
    await c.stop(); await c.launch(); await category('软件更新');
    c.equal((await native('updateStatus')).autoCheck, false);
    c.equal((await native('setUpdatePreferences', { autoCheck: true })).autoCheck, true);
    await c.stop(); await c.launch(); await category('软件更新');
    c.equal((await native('updateStatus')).autoCheck, true);
    await c.screenshot('restarted');
  } });
  report.source = c.result;
  assert.equal(c.result.scenarios[0].status, 'passed', 'Source update scenario failed');
  await c.stop();
  scratch = await mkdtemp(join(tmpdir(), 'pixelmuse-update-fixture-'));
  await runSmoke();
  report.updaterFixture = JSON.parse(await readFile(join(artifacts, 'updater-fixture.json'), 'utf8'));
  assert.equal(report.updaterFixture.passed, true);
  report.integration = 'passed';
} catch (error) {
  report.errors.push(c ? c.redact(error.message) : String(error.message));
} finally {
  const cleanupErrors = [];
  if (c) {
    cleanupErrors.push(...await c.cleanup());
    report.source = c.result;
    report.runtimeHash = c.result.runtimeIdentity?.runtimeHash ?? null;
    report.rendererErrors = c.state.events.filter(event => event.type === 'pageerror').length;
    report.fixtureCallbackErrors = c.mock.state.callbackErrors;
    if (report.rendererErrors || report.fixtureCallbackErrors) report.integration = 'failed';
    try { await readdir(c.fixture); cleanupErrors.push('Source fixture remains'); } catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(c.redact(error.message)); }
  }
  if (scratch) {
    try { await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch (error) { cleanupErrors.push(String(error.message)); }
    try { await readdir(scratch); cleanupErrors.push('Updater fixture remains'); } catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(String(error.message)); }
  }
  report.cleanup = { status: cleanupErrors.length ? 'failed' : 'passed', errors: cleanupErrors };
  if (cleanupErrors.length) report.integration = 'failed';
  report.finishedAt = new Date().toISOString();
  await writeFile(resultPath, c ? c.redact(JSON.stringify(report, null, 2)) : JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ integration: report.integration, result: resultPath }));
if (report.integration !== 'passed') process.exitCode = 1;
