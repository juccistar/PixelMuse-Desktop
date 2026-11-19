// Installed before the actual Electron entry, and in each real utility Backend.
// No top-level await: the paused browser can synchronously require this ESM module.
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

export function installNetworkGuard({ origins, auditFile, appPackage }) {
  if (globalThis.__ecomgenFullGuard) return;
  const allowed = origins.map(value => new URL(value));
  if (!allowed.length || allowed.some(url => url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash)) {
    throw new Error('E2E guard requires explicit loopback fixture origins');
  }
  const token = process.env.ECOMGEN_E2E_GUARD_TOKEN;
  const audit = (event, extra = {}) => appendFileSync(auditFile, JSON.stringify({ event, pid: process.pid, type: process.type ?? 'node', token, ...extra }) + '\n');
  const deny = () => { audit('blocked'); throw new Error('E2E_NETWORK_BLOCKED'); };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    // net.connect passes an already normalized argument array to Socket.connect.
    const raw = Array.isArray(args[0]) ? args[0] : args;
    const [options] = net._normalizeArgs(raw);
    // IPC uses inherited handles. New named-pipe connections remain forbidden.
    if (options.path || !allowed.some(url => options.host === url.hostname && Number(options.port) === Number(url.port))) return deny();
    return Reflect.apply(connect, this, args);
  };
  const lookup = dns.lookup;
  dns.lookup = function (hostname, ...args) {
    if (hostname !== '127.0.0.1') return deny();
    return Reflect.apply(lookup, this, [hostname, ...args]);
  };
  for (const name of Object.keys(dns)) if (/^resolve|^reverse$/.test(name) && typeof dns[name] === 'function') dns[name] = deny;
  if (dns.promises) {
    const promiseLookup = dns.promises.lookup.bind(dns.promises);
    dns.promises.lookup = async (hostname, ...args) => hostname === '127.0.0.1' ? promiseLookup(hostname, ...args) : deny();
    for (const name of Object.keys(dns.promises)) if (/^resolve|^reverse$/.test(name)) dns.promises[name] = async () => deny();
  }
  for (const Resolver of [dns.Resolver, dns.promises?.Resolver]) if (Resolver) {
    for (const name of Object.getOwnPropertyNames(Resolver.prototype)) if (/^resolve|^reverse$/.test(name)) Resolver.prototype[name] = deny;
  }
  dgram.createSocket = deny;
  syncBuiltinESMExports();
  if (process.versions.electron && process.type === 'browser') {
    const { app, session, utilityProcess, safeStorage } = createRequire(appPackage)('electron');
    // Playwright's evaluated functions have no dynamic-import callback. Keep
    // the fixed test inspection module in this real ESM loader context instead.
    globalThis.__ecomgenFullInspectDatabase = async input => (await import('./e2e-full-persistence.mjs')).inspectDatabase(input);
    // Fixed main-only fixture helper: no import/file capability crosses IPC.
    globalThis.__ecomgenFullSeedV2 = async (input, expectedToken) => {
      if (!app.isReady() || globalThis.__ecomgenFullGuard?.['token'] !== token || expectedToken !== token) throw Error('Ready guarded main is required for v2 seed');
      return (await import('./e2e-full-persistence.mjs')).seedIsolatedV2(input, { app, safeStorage, auditFile });
    };
    const originalFork = utilityProcess.fork.bind(utilityProcess);
    utilityProcess.fork = (modulePath, args, options = {}) => {
      // utilityProcess ignores Node preloads on current Electron. Wrap only its
      // entry: the original production module keeps the real parentPort and IPC.
      const child = originalFork(fileURLToPath(new URL('./e2e-full-startup-guard-utility.mjs', import.meta.url)), args, {
        ...options,
        env: { ...process.env, ...options.env,
          ECOMGEN_E2E_GUARD_ORIGINS: JSON.stringify(allowed.map(url => url.origin)),
          ECOMGEN_E2E_GUARD_AUDIT: auditFile, ECOMGEN_E2E_GUARD_TOKEN: token,
          ECOMGEN_E2E_GUARD_UTILITY_ENTRY: modulePath },
      });
      child.once('spawn', () => audit('utility-spawn', { childPid: child.pid, serviceName: options.serviceName, modulePath }));
      child.once('exit', code => audit('utility-exit', { code }));
      child.on('message', message => { if (['ready', 'closed'].includes(message?.type)) audit(`utility-${message.type}`, { childPid: child.pid }); });
      return child;
    };
    const protectedSessions = new WeakSet();
    const protectSession = current => {
      if (protectedSessions.has(current)) return;
      protectedSessions.add(current);
      const webRequest = current.webRequest;
      const register = webRequest.onBeforeRequest.bind(webRequest);
      // Electron keeps only the last webRequest listener. Compose every later
      // production listener so it cannot replace this boundary, or be bypassed.
      webRequest.onBeforeRequest = (...args) => {
        const listener = args.at(-1);
        const guarded = (details, callback) => {
          let permit = false;
          try {
            const url = new URL(details.url);
            permit = ['file:', 'devtools:', 'ecomgen-resource:', 'ecomgen-asset:', 'data:', 'blob:'].includes(url.protocol) || allowed.some(item => item.origin === url.origin);
          } catch { /* Deny unparseable destinations. */ }
          if (!permit) { audit('blocked-renderer'); callback({ cancel: true }); }
          else if (typeof listener === 'function') listener(details, callback);
          else callback({ cancel: false });
        };
        // Register globally even when production supplies a narrower filter;
        // its filter must not create destinations outside the test boundary.
        if (args.length > 1) {
          const filter = args[0];
          if (filter?.urls?.length && !filter.urls.includes('<all_urls>')) throw Error('E2E guard does not support filtered production request listeners');
        }
        return register(guarded);
      };
      webRequest.onBeforeRequest(null);
      audit('session-guard-installed');
    };
    app.on('session-created', protectSession);
    app.once('ready', () => protectSession(session.defaultSession));
  }
  globalThis.__ecomgenFullGuard = { auditFile, origins: allowed.map(url => url.origin), token };
  audit('installed');
}
if (process.env.ECOMGEN_E2E_GUARD_ORIGINS) installNetworkGuard({
  origins: JSON.parse(process.env.ECOMGEN_E2E_GUARD_ORIGINS),
  auditFile: process.env.ECOMGEN_E2E_GUARD_AUDIT,
  appPackage: process.env.ECOMGEN_E2E_APP_PACKAGE,
});
