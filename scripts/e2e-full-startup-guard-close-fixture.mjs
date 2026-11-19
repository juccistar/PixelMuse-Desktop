// Fixed test-only observer loaded while the real Electron is paused before entry.
// Cancel a genuine renderer navigation either during quit or as a startup error.
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export function installCloseLoadRegression() {
  const mode = process.env.ECOMGEN_E2E_CLOSE_LOAD_TEST;
  const guard = globalThis.__ecomgenFullGuard;
  if (!['quit', 'error'].includes(mode) || process.type !== 'browser' || !guard || guard['token'] !== process.env.ECOMGEN_E2E_GUARD_TOKEN) throw Error('Invalid guarded close regression');
  const { app, dialog } = createRequire(process.env.ECOMGEN_E2E_APP_PACKAGE)('electron');
  if (app.isReady()) throw Error('Close regression must precede production entry');
  const filename = join(dirname(guard.auditFile), 'close-load-audit.jsonl');
  const record = (event, extra = {}) => appendFileSync(filename, JSON.stringify({ event, pid: process.pid, mode, ...extra }) + '\n');
  record('observer-installed');
  // Observe the actual production decision to report a startup failure without
  // leaving an OS modal open in unattended tests. The error control requires it.
  dialog.showErrorBox = (title, content) => record('startup-error-reported', { title, content });
  let holdQuit = false, releaseScheduled = false, quitDeadline;
  const releaseQuit = event => {
    clearTimeout(quitDeadline);
    holdQuit = false;
    record(event);
    app.quit();
  };
  // Keep the actual window alive while the native navigation cancellation and
  // original loadFile rejection propagate. Production's before-quit listener
  // still runs, sets quitting, and stops the real Backend on every request.
  app.on('before-quit', event => {
    record('before-quit');
    if (holdQuit) { event.preventDefault(); record('quit-deferred'); }
  });
  app.on('browser-window-created', (_event, window) => {
    for (const kind of ['did-fail-load', 'did-fail-provisional-load']) window.webContents.on(kind, (_event, code, _description, _url, mainFrame) => {
      record('renderer-navigation-failed', { kind, code, mainFrame });
      if (holdQuit && mainFrame && code < 0 && !releaseScheduled) {
        releaseScheduled = true;
        clearTimeout(quitDeadline);
        setTimeout(() => releaseQuit('quit-resumed-after-navigation-failed'), 50);
      }
    });
  });
  let intercepted = false;
  app.on('session-created', current => {
    // Network guard registered first and still composes this production listener.
    const request = current.webRequest;
    const register = request.onBeforeRequest.bind(request);
    request.onBeforeRequest = (...args) => {
      const listener = args.at(-1);
      return register(...args.slice(0, -1), (details, callback) => {
        const proceed = decision => {
          if (!intercepted && !decision?.cancel && details.resourceType === 'mainFrame' && /^file:.*\/renderer\/index\.html$/.test(details.url)) {
            intercepted = true;
            record('renderer-navigation-pending', { resourceType: details.resourceType });
            if (mode === 'quit') {
              holdQuit = true;
              quitDeadline = setTimeout(() => releaseQuit('quit-resumed-without-navigation-evidence'), 1500);
              record('quit-requested-before-load-completion');
              app.quit();
            }
            // This is a native Chromium navigation failure, not a fabricated
            // loadFile promise. In quit mode before-quit has already run.
            callback({ cancel: true });
          } else callback(decision ?? {});
        };
        if (typeof listener === 'function') listener(details, proceed);
        else proceed({});
      });
    };
  });
}
