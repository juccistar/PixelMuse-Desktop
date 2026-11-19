const { createRequire } = require('node:module');
const { join, dirname } = require('node:path');
const { appendFileSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { app, BrowserWindow, utilityProcess } = createRequire(process.env.ECOMGEN_E2E_APP_PACKAGE)('electron');
const root = dirname(process.env.ECOMGEN_E2E_APP_PACKAGE);
const data = process.env.ECOMGEN_DESKTOP_DATA_DIR;
if (globalThis.__ecomgenFullGuard?.['token'] !== process.env.ECOMGEN_E2E_GUARD_TOKEN) throw Error('Owned startup guard required');
const record = event => appendFileSync(join(data, 'controlled-close.jsonl'), JSON.stringify({ event, at: Date.now(), pid: process.pid }) + '\n');
app.setPath('userData', data);
let backend, quitting = false;
app.on('before-quit', event => {
  record('before-quit');
  if (quitting) return;
  event.preventDefault(); quitting = true;
  globalThis.__solStopPending = true;
  record('backend-stop-pending');
  setTimeout(() => {
    record('backend-shutdown-sent');
    backend.once('exit', code => { record(`backend-exit-${code}`); app.quit(); });
    backend.postMessage({ type: 'shutdown' });
  }, 1000);
});
app.on('will-quit', () => record('will-quit'));
app.on('window-all-closed', () => { record('window-all-closed'); app.quit(); });
app.whenReady().then(() => {
  backend = utilityProcess.fork(join(root, 'out/main/backend.js'), [], { serviceName: 'EcomGen Backend', stdio: 'pipe' });
  backend.once('spawn', () => backend.postMessage({ type: 'init', options: { dataDir: join(data, 'data'), masterKey: randomBytes(32).toString('base64'), version: '0.3.0' } }));
  backend.on('message', message => {
    if (message.type === 'closed') record('backend-closed');
    if (message.type === 'ready') {
      record('backend-ready');
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      void window.loadURL('about:blank');
    }
  });
});
