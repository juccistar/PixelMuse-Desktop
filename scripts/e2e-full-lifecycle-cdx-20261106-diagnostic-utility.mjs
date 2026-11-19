import { Session } from 'node:inspector';
import { appendFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
if (!globalThis.__ecomgenFullGuard || process.type !== 'utility') throw Error('Guarded utility required');
const filename = join(dirname(globalThis.__ecomgenFullGuard.auditFile), 'startup-exception-locations.jsonl');
const record = row => appendFileSync(filename, JSON.stringify({ at: Date.now(), ...row }) + '\n');
record({ event: 'backend-startup-observer-installed' });
// Do not add a parentPort receiver before production registers its listener:
// that could consume the queued init message during an awaited module import.
// Closed-profile counts only: no row payloads, keys, receipts or database copies.
const database = join(process.env.ECOMGEN_DESKTOP_DATA_DIR, 'data', 'backend.sqlite');
try { if (existsSync(database)) {
  const Database = createRequire(new URL('../packages/backend/package.json', import.meta.url))('better-sqlite3');
  const db = new Database(database, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const names = ['jobs', 'desktop_resources', 'desktop_cleanup_queue'];
    record({ event: 'closed-profile-counts', counts: Object.fromEntries(names.filter(name => tables.has(name)).map(name => [name, db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n])) });
  } finally { db.close(); }
} } catch { record({ event: 'closed-profile-counts-unavailable' }); }
const inspector = new Session(); inspector.connect();
let profiled = false;
const stopProfile = () => {
  if (profiled) return; profiled = true;
  inspector.post('Profiler.stop', (error, result) => {
    if (error) return;
    const frames = result.profile.nodes.filter(node => node.hitCount).sort((a, b) => b.hitCount - a.hitCount).slice(0, 20)
      .map(node => ({ function: node.callFrame.functionName, url: node.callFrame.url, line: node.callFrame.lineNumber + 1, ticks: node.hitCount }));
    record({ event: 'startup-cpu-locations', frames });
  });
};
inspector.post('Profiler.enable'); inspector.post('Profiler.start');
const profileTimer = setTimeout(stopProfile, 5000); profileTimer.unref();
const postMessage = process.parentPort.postMessage.bind(process.parentPort);
process.parentPort.postMessage = (message, ...args) => {
  if (message?.type === 'ready' || message?.type === 'fatal') {
    record({ event: `backend-startup-${message.type}` });
    // Only startup is observed; ordinary business exceptions are not recorded.
    clearTimeout(profileTimer); stopProfile(); inspector.disconnect();
  }
  return postMessage(message, ...args);
};
const scripts = new Map();
inspector.on('Debugger.scriptParsed', ({ params }) => scripts.set(params.scriptId, params.url));
inspector.on('Debugger.paused', ({ params }) => {
  const frames = params.callFrames.slice(0, 12).map(frame => ({
    function: frame.functionName, url: scripts.get(frame.location.scriptId) ?? frame.url,
    line: frame.location.lineNumber + 1, column: frame.location.columnNumber + 1,
  }));
  // Description/value can include Provider bodies or keys; record locations and
  // identifier-shaped system/domain error codes only, never message properties.
  if (params.data?.objectId) inspector.post('Runtime.getProperties', { objectId: params.data.objectId, ownProperties: true }, (error, result) => {
    const code = result?.result?.find(property => property.name === 'code')?.value?.value;
    if (!error && typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)) record({ event: 'startup-exception-code', code, frames });
  });
  record({ event: 'caught-exception-location', reason: params.reason, class: params.data?.className, frames });
  inspector.post('Debugger.resume');
});
await new Promise((resolve, reject) => inspector.post('Debugger.enable', error => error ? reject(error) : resolve()));
await new Promise((resolve, reject) => inspector.post('Debugger.setPauseOnExceptions', { state: 'all' }, error => error ? reject(error) : resolve()));
await import(pathToFileURL(process.env.ECOMGEN_E2E_LIFECYCLE_REAL_ENTRY).href);
