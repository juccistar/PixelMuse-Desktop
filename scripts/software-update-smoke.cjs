'use strict';
// Test-owned Electron entry. Synthetic bytes are never executed or installed.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createServer } = require('node:http');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const { app, session } = require('electron');
const [scratch, resultPath, appPackage] = process.argv.slice(2);
const requireApp = createRequire(appPackage);
const { NsisUpdater } = requireApp('electron-updater');
const { ElectronHttpExecutor } = requireApp('electron-updater/out/electronHttpExecutor');
app.setPath('userData', join(scratch, 'user-data'));
app.disableHardwareAcceleration();
const bytes = Buffer.from('PixelMuse synthetic updater fixture; not an executable.\n');
const sha = createHash('sha512').update(bytes).digest('base64');
const result = { kind: 'isolated-nsis-updater-fixture', passed: false, requests: [], blockedRequests: [], limitations: ['generic loopback fixture; not GitHub', 'synthetic unsigned bytes; no installer or upgrade executed', 'separate from production application IPC and UI'] };
let server;
const deny = () => { throw new Error('Fixture prohibits installation, quit hooks and relaunch'); };
async function run() {
  await mkdir(scratch, { recursive: true });
  await app.whenReady();
  server = createServer((req, res) => {
    result.requests.push(req.url);
    const bad = req.url.startsWith('/bad/');
    if (/^\/(good|bad)\/latest\.yml(?:\?.*)?$/.test(req.url)) {
      const digest = bad ? createHash('sha512').update('different fixture').digest('base64') : sha;
      res.writeHead(200, { 'Content-Type': 'text/yaml' });
      res.end(`version: 0.4.9\nfiles:\n  - url: fixture.exe\n    sha512: ${digest}\n    size: ${bytes.length}\npath: fixture.exe\nsha512: ${digest}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`);
    } else if (/^\/(good|bad)\/fixture\.exe(?:\?.*)?$/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length }); res.end(bytes);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Chromium's updater session and default session may access only this server.
  const guard = (details, callback) => {
    let allowed = false;
    try { allowed = new URL(details.url).origin === origin; } catch {}
    if (!allowed) result.blockedRequests.push(details.url);
    callback({ cancel: !allowed });
  };
  const makeUpdater = async name => {
    const directory = join(scratch, name); await mkdir(directory, { recursive: true });
    const config = join(directory, 'app-update.yml');
    await writeFile(config, 'updaterCacheDirName: fixture-cache\n');
    const adapter = { version: '0.4.8', name: 'PixelMuseFixture', isPackaged: true, userDataPath: directory, baseCachePath: directory, appUpdateConfigPath: config, whenReady: () => Promise.resolve(), quit: deny, relaunch: deny, onQuit: deny };
    const updater = new NsisUpdater(undefined, adapter);
    updater.httpExecutor = new ElectronHttpExecutor();
    updater.setFeedURL({ provider: 'generic', url: `${origin}/${name}/` });
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false; updater.disableDifferentialDownload = true; updater.disableWebInstaller = true;
    updater.quitAndInstall = deny; updater.install = deny; updater.doInstall = deny;
    updater.on('error', () => {}); updater.logger = null;
    updater.netSession.webRequest.onBeforeRequest(guard);
    return updater;
  };
  session.defaultSession.webRequest.onBeforeRequest(guard);
  const good = await makeUpdater('good');
  assert.equal((await good.checkForUpdates()).isUpdateAvailable, true);
  const downloaded = await good.downloadUpdate();
  assert.ok(downloaded.length > 0); assert.deepEqual(await readFile(downloaded[0]), bytes);
  result.good = { checked: true, downloaded: true, sha512: sha };
  const bad = await makeUpdater('bad');
  assert.equal((await bad.checkForUpdates()).isUpdateAvailable, true);
  let failure;
  try { await bad.downloadUpdate(); } catch (error) { failure = error; }
  assert.ok(failure, 'Invalid sha512 must reject the download');
  assert.match(`${failure.code || ''} ${failure.message}`, /checksum|sha512/i);
  assert.ok(result.requests.some(path => path.startsWith('/bad/fixture.exe')), 'Bad fixture bytes must actually be requested');
  assert.deepEqual(result.blockedRequests, []);
  result.bad = { checksumRejected: true, code: failure.code || null };
  result.passed = true;
}
run().catch(error => { result.error = String(error.stack || error); }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  app.exit(result.passed ? 0 : 1);
});
