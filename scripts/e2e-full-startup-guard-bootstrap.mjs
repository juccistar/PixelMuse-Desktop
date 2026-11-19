// Test-only executable bridge. Pause the REAL Electron before its first script,
// install the guard through its owned loopback inspector, then let Playwright attach.
// This also works when packaged Electron ignores NODE_OPTIONS and --require.
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const executable = process.env.ECOMGEN_E2E_GUARD_EXECUTABLE;
const modulePath = process.env.ECOMGEN_E2E_GUARD_MODULE;
if (!executable || !modulePath || !process.env.ECOMGEN_E2E_GUARD_TOKEN) throw Error('Missing isolated startup guard configuration');
const args = process.argv.slice(2).filter(arg => !/^--inspect(?:-brk)?(?:=|$)/.test(arg));
const child = spawn(executable, ['--inspect-brk=0', ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout);
let socket;
let bootstrapped = false;
let inspectorLine;
let settled = false;
const deadline = setTimeout(() => fail(Error('Electron guard bootstrap timed out before guarded entry')), 20000);
const pending = new Map();
let nextId = 0;
let pauseResolve;
const paused = new Promise(resolve => { pauseResolve = resolve; });
let devtoolsResolve;
const devtoolsReady = new Promise(resolve => { devtoolsResolve = resolve; });
function command(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
}
function fail(error) {
  if (settled) return;
  settled = true; clearTimeout(deadline);
  process.stderr.write(`E2E guard bootstrap failed: ${error.message}\n`);
  socket?.close();
  if (process.platform === 'win32' && child.pid && child.exitCode === null && child.signalCode === null) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
  } else child.kill();
  process.exitCode = 1;
}
async function bootstrap(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1') throw Error('Expected this child\'s loopback inspector');
  socket = new WebSocket(url);
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Debugger.paused') pauseResolve(message.params);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(Error(JSON.stringify(message.error)));
      else request?.resolve(message.result);
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(Error('Owned inspector connection failed')), { once: true });
  });
  await command('Runtime.enable');
  await command('Debugger.enable');
  await command('Runtime.runIfWaitingForDebugger');
  const pause = await paused;
  if (pause.reason !== 'Break on start') throw Error(`Unexpected first pause: ${pause.reason}`);
  const result = await command('Runtime.evaluate', {
    expression: `(() => { const load = require('node:module').createRequire(${JSON.stringify(modulePath)}); load(${JSON.stringify(modulePath)}); const guard = globalThis.__ecomgenFullGuard; if (!guard || guard.token !== process.env.ECOMGEN_E2E_GUARD_TOKEN) throw Error('Startup guard missing before entry'); if (process.env.ECOMGEN_E2E_GUARD_SELFTEST === '1') globalThis.__ecomgenFullGuardVerify = load(require('node:path').join(require('node:path').dirname(${JSON.stringify(modulePath)}), 'e2e-full-startup-guard-checks.mjs')).verifyNodeGuard; if (process.env.ECOMGEN_E2E_CLOSE_LOAD_TEST) load(require('node:path').join(require('node:path').dirname(${JSON.stringify(modulePath)}), 'e2e-full-startup-guard-close-fixture.mjs')).installCloseLoadRegression(); return { pid: process.pid, token: guard.token }; })()`,
    includeCommandLineAPI: true, returnByValue: true,
  });
  if (result.exceptionDetails || !result.result?.value?.pid) throw Error(`Cannot install guard before app entry: ${JSON.stringify(result.exceptionDetails ?? result)}`);
  await command('Debugger.resume');
  // Wait for Chromium initialization before disabling the initial debugger.
  // Detaching while the ESM entry is compiling can crash Electron natively.
  await devtoolsReady;
  await command('Debugger.disable');
  await new Promise(resolve => { socket.addEventListener('close', resolve, { once: true }); socket.close(); });
  bootstrapped = true; clearTimeout(deadline);
  // Keep this endpoint hidden from Playwright until installation and resume finish.
  process.stderr.write(inspectorLine + '\n');
}
createInterface({ input: child.stderr }).on('line', line => {
  if (/^DevTools listening on ws:\/\//.test(line)) devtoolsResolve();
  const match = /^Debugger listening on (ws:\/\/.*)$/.exec(line);
  if (match && !inspectorLine) {
    inspectorLine = line;
    bootstrap(match[1]).catch(fail);
  } else process.stderr.write(line + '\n');
});
child.once('error', fail);
child.once('exit', (code, signal) => {
  clearTimeout(deadline); settled = true; socket?.close();
  if (!bootstrapped) process.stderr.write('Electron exited before startup guard was installed\n');
  process.exitCode = code ?? (signal ? 1 : 0);
});
