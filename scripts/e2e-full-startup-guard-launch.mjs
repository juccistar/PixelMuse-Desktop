import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const lifecycleReasons = {
  'launcher-error': 'Owned Electron launcher failed',
  'startup-exit': 'Electron exited during startup',
  'startup-timeout': 'Guarded Electron startup timed out',
  'guard-policy': 'E2E guard requires explicit loopback fixture origins',
  'guard-token': 'Owned Electron guard token mismatch',
  'guard-current': 'Browser startup guard changed',
  'startup-gate-selftest': 'Intentional startup gate failure',
  'window-timeout': 'Owned Electron first window timed out',
  'backend-timeout': 'Timed out polling renderer bridge and Backend health',
  'backend-startup-timeout': '后台启动超时',
  'backend-initialization-failed': '后台初始化失败',
  'backend-startup-failed': '后台未能启动，请检查数据目录。',
  'launch-failed': 'Owned Electron launch failed',
  'close-timeout': 'Test-owned Electron close timed out',
  'close-failed': 'Test-owned Electron close failed',
  'diagnostics-failed': 'Lifecycle diagnostics unavailable',
};
const systemCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ESRCH', 'EIO', 'ENOSPC', 'EBUSY']);
const lifecycleStages = new Set(['launcher', 'inspector', 'guard', 'renderer', 'backend', 'close', 'diagnostics']);
function lifecycleProperty(error, key) {
  try { return error?.[key]; } catch { return undefined; }
}
export function lifecycleFailure(error, fallback = 'launch-failed', stage = 'launcher') {
  // Snapshot once and admit primitive values only: coercion/getters/toJSON must
  // neither enter evidence nor bypass launch cleanup with a second exception.
  const suppliedReason = lifecycleProperty(error, 'lifecycleReason');
  const message = lifecycleProperty(error, 'message');
  const code = lifecycleProperty(error, 'code');
  const cleanupReason = lifecycleProperty(error, 'cleanupReason');
  const defaultReason = typeof fallback === 'string' && Object.hasOwn(lifecycleReasons, fallback) ? fallback : 'launch-failed';
  const reason = typeof suppliedReason === 'string' && Object.hasOwn(lifecycleReasons, suppliedReason) ? suppliedReason
    : (typeof message === 'string' ? Object.keys(lifecycleReasons).find(key => lifecycleReasons[key] === message) : undefined) ?? defaultReason;
  const safe = new Error(lifecycleReasons[reason]);
  safe.lifecycleReason = reason;
  safe.lifecycleStage = typeof stage === 'string' && lifecycleStages.has(stage) ? stage : 'launcher';
  if (typeof code === 'string' && systemCodes.has(code)) { safe.code = code; safe.message += ` (${code})`; }
  if (typeof cleanupReason === 'string' && Object.hasOwn(lifecycleReasons, cleanupReason)) {
    safe.cleanupReason = cleanupReason; safe.message += `; cleanup: ${lifecycleReasons[cleanupReason]}`;
  }
  return safe;
}

function guardLaunchOptions({ executable, args, env }) {
  if (process.platform !== 'win32') throw Error('Guard executable bridge currently requires Windows');
  if (!env.ECOMGEN_DESKTOP_DATA_DIR) throw Error('An isolated Electron data directory is required');
  // Native Chromium may initialize before the production main sets userData.
  // Apply the same temporary profile at process creation as well.
  return { args: [`--user-data-dir=${env.ECOMGEN_DESKTOP_DATA_DIR}`, ...args], env: { ...env, ECOMGEN_E2E_GUARD_EXECUTABLE: executable,
    ECOMGEN_E2E_GUARD_MODULE: fileURLToPath(new URL('./e2e-full-network.mjs', import.meta.url)) } };
}

// _electron.launch in Playwright 1.64 leaves sibling waitForLine promises
// unhandled on early exit. Own the real child and attach through its actual
// inspector/CDP endpoints, so every launch rejection reaches harness cleanup.
export async function launchGuardedElectron({ executable, args, env, timeout = 45000 }) {
  const { chromium } = await import('playwright-core');
  const options = guardLaunchOptions({ executable, args, env });
  const bridge = fileURLToPath(new URL('./e2e-full-startup-guard-bootstrap.mjs', import.meta.url));
  const child = spawn(process.execPath, [bridge, '--remote-debugging-port=0', ...options.args], {
    env: options.env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let browser, inspector, timer, closed = false, cancelled = false;
  let stderrLines = 0, stderrCharacters = 0, startupPolicyRejected = false, startupSystemCode;
  let nodeEndpoint, chromeEndpoint, stage = 'launcher';
  const startedAt = Date.now();
  const exited = new Promise(resolve => child.once('close', resolve));
  let rejectStartup;
  const failure = new Promise((_resolve, reject) => { rejectStartup = reject; });
  // The race below observes this promise before any asynchronous process event.
  const endpoints = new Promise(resolve => {
    createInterface({ input: child.stderr }).on('line', line => {
      stderrLines++; stderrCharacters += line.length;
      if (line.includes('E2E guard requires explicit loopback fixture origins')) startupPolicyRejected = true;
      const systemCode = /^code: '(ENOENT|EACCES|EPERM|ESRCH|EIO|ENOSPC|EBUSY)',$/.exec(line.trim())?.[1]
        ?? /^E2E guard bootstrap failed: spawn .+ (ENOENT|EACCES|EPERM|ESRCH|EIO|ENOSPC|EBUSY)$/.exec(line)?.[1];
      if (systemCode) startupSystemCode = systemCode;
      const node = /^Debugger listening on (ws:\/\/.*)$/.exec(line);
      const chrome = /^DevTools listening on (ws:\/\/.*)$/.exec(line);
      if (node) nodeEndpoint = node[1];
      if (chrome) chromeEndpoint = chrome[1];
      if (nodeEndpoint && chromeEndpoint) resolve();
    });
  });
  const launchError = (reason, error) => {
    const safe = lifecycleFailure(error ?? { code: startupSystemCode }, startupPolicyRejected ? 'guard-policy' : reason, stage);
    if (Number.isSafeInteger(child.pid)) safe.message += `; owned launcher PID ${child.pid}`;
    return safe;
  };
  child.once('error', error => rejectStartup(launchError('launcher-error', error)));
  child.once('exit', () => rejectStartup(launchError('startup-exit')));
  const app = {
    process: () => child,
    diagnostics: () => ({ launcherPid: child.pid, exitCode: child.exitCode,
      signalCode: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV'].includes(child.signalCode) ? child.signalCode : null,
      stage, elapsedMs: Date.now() - startedAt, stderr: { lines: stderrLines, characters: stderrCharacters },
      nodeEndpointSeen: Boolean(nodeEndpoint), chromeEndpointSeen: Boolean(chromeEndpoint), startupPolicyRejected }),
    async evaluate(fn, input) {
      if (!inspector) throw Error('Owned Electron inspector is unavailable');
      const response = await inspector.command('Runtime.evaluate', {
        expression: `(${fn.toString()})(require('electron'), ${JSON.stringify(input) ?? 'undefined'})`,
        includeCommandLineAPI: true, awaitPromise: true, returnByValue: true,
      });
      if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      return response.result?.value;
    },
    async firstWindow({ timeout: windowTimeout = 45000 } = {}) {
      const context = browser.contexts()[0];
      return context.pages().find(page => !page.isClosed()) ?? context.waitForEvent('page', { timeout: windowTimeout });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (child.exitCode === null && child.signalCode === null && inspector) {
        const quit = app.evaluate(({ app }) => { app.quit(); }).catch(() => {});
        inspector.close();
        await quit;
      } else inspector?.close();
      await browser?.close().catch(() => {});
      await exited;
    },
  };
  try {
    timer = setTimeout(() => rejectStartup(launchError('startup-timeout')), timeout);
    await Promise.race([failure, (async () => {
      await endpoints;
      if (cancelled) return;
      stage = 'inspector';
      inspector = await connectInspector(nodeEndpoint);
      if (cancelled) { inspector.close(); return; }
      // Observe the fixed production startup modal without dismissing it or
      // turning initialization failure into a successful unattended launch.
      await app.evaluate(({ dialog }) => {
        const original = dialog.showErrorBox.bind(dialog);
        const append = require('node:fs').appendFileSync;
        const auditFile = globalThis.__ecomgenFullGuard.auditFile;
        dialog.showErrorBox = (title, content) => {
          if (title === 'PixelMuse 启动失败') {
            const expected = '无法初始化本地应用。请检查数据目录权限和系统密钥保护是否可用。';
            try { append(auditFile,
              JSON.stringify({ event: 'startup-error-modal', pid: process.pid, type: process.type, title,
                message: content === expected ? content : '[nonstandard startup message omitted]' }) + '\n'); } catch { /* Reporting must preserve the native failure modal. */ }
          }
          return original(title, content);
        };
      });
      if (cancelled) return;
      // Recheck the exact live process before attaching its renderer transport.
      stage = 'guard';
      const identity = await app.evaluate(() => ({ pid: process.pid, token: globalThis.__ecomgenFullGuard?.token }));
      if (identity.token !== env.ECOMGEN_E2E_GUARD_TOKEN) throw Error('Owned Electron guard token mismatch');
      if (cancelled) return;
      stage = 'renderer';
      browser = await chromium.connectOverCDP(chromeEndpoint, { timeout });
      if (cancelled) await browser.close();
    })()]);
    return app;
  } catch (error) {
    cancelled = true;
    const safe = launchError('launch-failed', error);
    try { await closeOwnedElectron(app, 1000); } catch (cleanupError) {
      safe.cleanupReason = lifecycleFailure(cleanupError, 'close-failed', 'close').lifecycleReason;
      safe.message += `; cleanup: ${lifecycleReasons[safe.cleanupReason]}`;
    }
    safe.launchDiagnostics = app.diagnostics();
    throw safe;
  } finally { clearTimeout(timer); }
}

async function connectInspector(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1') throw Error('Expected owned loopback inspector');
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const connection = {
    command(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) request.reject(Error('Owned Electron inspector disconnected'));
    pending.clear();
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(Error('Owned Electron inspector connection failed')), { once: true });
  });
  return connection;
}

/** Close only the process tree returned by this test's launcher. */
export async function closeOwnedElectron(app, timeout = 20000) {
  const child = app.process();
  let timer;
  const closed = Promise.resolve().then(() => app.close());
  try {
    await Promise.race([closed, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Error('Test-owned Electron close timed out')), timeout);
    })]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        // Playwright starts a cmd.exe parent on Windows; killing only cmd leaks Electron.
        await new Promise((resolve, reject) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], taskError => taskError && child.exitCode === null ? reject(lifecycleFailure(taskError, 'close-failed', 'close')) : resolve()));
      } else child.kill('SIGKILL');
    }
    await Promise.race([closed.catch(() => {}), new Promise(resolve => {
      const deadline = setTimeout(resolve, 3000);
      if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(deadline); resolve(); }
      else child.once('exit', () => { clearTimeout(deadline); resolve(); });
    })]);
    throw lifecycleFailure(error, 'close-failed', 'close');
  } finally { clearTimeout(timer); }
}
