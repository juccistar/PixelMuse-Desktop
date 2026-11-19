// Unique observer: actual production main and BackendHost retain all deadlines.
const { createRequire } = require('node:module');
const { join, dirname } = require('node:path');
const { appendFileSync } = require('node:fs');
const load = createRequire(process.env.ECOMGEN_E2E_APP_PACKAGE);
const { app, utilityProcess } = load('electron');
const guard = globalThis.__ecomgenFullGuard;
if (!guard || guard['token'] !== process.env.ECOMGEN_E2E_GUARD_TOKEN) throw Error('Owned guard required');
const record = (event, extra = {}) => appendFileSync(join(dirname(guard.auditFile), 'sol-shutdown-trace.jsonl'), JSON.stringify({ event, at: Date.now(), pid: process.pid, ...extra }) + '\n');
app.setAppPath(dirname(process.env.ECOMGEN_E2E_APP_PACKAGE));
app.setVersion(load(process.env.ECOMGEN_E2E_APP_PACKAGE).version);
app.on('before-quit', () => record('before-quit'));
app.on('will-quit', () => record('will-quit'));
const fork = utilityProcess.fork.bind(utilityProcess);
utilityProcess.fork = (entry, args, options = {}) => {
  const child = fork(join(__dirname, 'e2e-full-lifecycle-sol-independent-20261106-7f21-shutdown-utility.mjs'), args, { ...options, env: { ...process.env, ...options.env, ECOMGEN_SOL_REAL_ENTRY: entry } });
  globalThis.__solOwnedBackend = child;
  child.on('message', message => {
    if (message.type === '__sol-seeded') { globalThis.__solSeeded = message.counts; record('synthetic-cleanup-seeded', message.counts); }
    if (message.type === 'closed') record('backend-closed');
  });
  child.on('exit', code => record('backend-exit', { code }));
  return child;
};
load(join(dirname(process.env.ECOMGEN_E2E_APP_PACKAGE), 'out/main/index.js'));
