import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireApp = createRequire(join(root, 'apps/desktop/package.json'));
const { build } = createRequire(requireApp.resolve('vite'))('esbuild');
const contracts = join(root, 'packages/contracts/src/index.ts');
const preload = join(root, 'apps/desktop/src/preload/index.ts');
const client = join(root, 'apps/desktop/src/renderer/api/client.ts');
const errors = join(root, 'apps/desktop/src/renderer/api/errors.ts');
const alias = { '@ecomgen/contracts': contracts };
const publicErrors = [
  ['updatePatternDraft', 'CONFLICT', '草稿已在别处更新（服务端版本 2）'],
  ['confirmStoryboard', 'REVISION_CONFLICT', '分镜版本已更新，请刷新后重试'],
  ['getResource', 'NOT_FOUND', '文件不存在或尚未生成。'],
  ['listProviders', 'BACKEND_UNAVAILABLE', '本地后台尚未就绪'],
];

async function temporaryFixture(run) {
  const fixture = await mkdtemp(join(tmpdir(), 'ecomgen-error-code-transport-'));
  try { await run(fixture); }
  finally { await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
}

function runElectron(entry, data) {
  return new Promise((resolveExit, reject) => {
    const env = { ...process.env };
    for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
    const child = spawn(requireApp('electron'), [`--user-data-dir=${data}`, entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = '', timedOut = false;
    const record = chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-12000); };
    child.stdout.on('data', record); child.stderr.on('data', record);
    const timer = setTimeout(() => {
      timedOut = true;
      // This is the child created above; no discovery or unrelated process cleanup.
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
      else child.kill('SIGKILL');
    }, 45000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) reject(Error(`Isolated Electron failed (${code ?? signal}; timeout=${timedOut}): ${diagnostic}`));
      else resolveExit({ pid: child.pid, diagnostic });
    });
  });
}

test('current production preload and renderer client preserve errors across real sandboxed contextBridge', { timeout: 60000 }, async t => {
  await temporaryFixture(async fixture => {
    const preloadFile = join(fixture, 'preload.cjs');
    const compiled = await build({ entryPoints: [preload], outfile: preloadFile, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], metafile: true });
    const imports = Object.values(compiled.metafile.outputs).flatMap(output => output.imports.map(item => item.path));
    assert.deepEqual(imports, ['electron'], 'sandbox preload retains Electron as its sole runtime import');
    const rendererFile = join(fixture, 'renderer.js');
    await build({ stdin: { contents: `
      import { invoke } from ${JSON.stringify(client)};
      import { ApiError, isApiError } from ${JSON.stringify(errors)};
      window.runErrorTransportProbe = async () => {
        const failures = [];
        for (const [operation] of ${JSON.stringify(publicErrors)}) {
          let direct, wrapped;
          try { await window.ecomgen.invoke(operation, {}); }
          catch (error) { direct = { message: error.message, code: error.code, isError: error instanceof Error }; }
          try { await invoke(operation, {}); }
          catch (error) {
            wrapped = { code: error.code, message: error.message, name: error.name,
              apiError: error instanceof ApiError && isApiError(error),
              conflict: error instanceof ApiError && ['CONFLICT', 'REVISION_CONFLICT'].includes(error.code),
              missing: error instanceof ApiError && error.code === 'NOT_FOUND' };
          }
          failures.push({ operation, direct, wrapped });
        }
        let infrastructure, nativeError;
        try { await invoke('listJobs', {}); }
        catch (error) { infrastructure = { code: error.code, message: error.message, apiError: error instanceof ApiError }; }
        try { await window.ecomgen.saveArtifact({ kind: 'ASSET', id: 'fixture' }); }
        catch (error) { nativeError = error.message; }
        return { failures, infrastructure, nativeError,
          success: await invoke('getHealth', {}),
          picker: await window.ecomgen.pickFiles(),
          clipboard: await window.ecomgen.readClipboardText(),
          clipboardWrite: (await window.ecomgen.writeClipboardText('fixture')) === undefined,
          generatedSave: await window.ecomgen.saveGeneratedFile({ name: 'fixture.json', mimeType: 'application/json', base64: 'e30=' }),
          resourceUrl: window.ecomgen.resourceUrl({ kind: 'ASSET', id: 'fixture' }),
          nodeRequire: typeof window.require,
        };
      };`, resolveDir: root, sourcefile: 'error-transport-renderer-fixture.js' }, outfile: rendererFile, bundle: true, platform: 'browser', format: 'iife', alias });
    await writeFile(join(fixture, 'index.html'), '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'"><script src="./renderer.js"></script>');
    const resultFile = join(fixture, 'result.json');
    const entry = join(fixture, 'main.cjs');
    const userData = join(fixture, 'profile'); await mkdir(userData);
    await writeFile(entry, `
      const { app, BrowserWindow, ipcMain, session } = require('electron');
      const { writeFileSync } = require('node:fs');
      app.setPath('userData', ${JSON.stringify(userData)});
      app.commandLine.appendSwitch('disable-background-networking');
      const responses = new Map(${JSON.stringify(publicErrors)}.map(([operation, code, message]) => [operation, { code, message, stack: 'PRIVATE_STACK', path: 'PRIVATE_PATH', rawResponse: 'PRIVATE_RESPONSE', cipher: 'PRIVATE_CIPHER' }]));
      const ok = data => ({ id: 'synthetic', ok: true, data });
      ipcMain.handle('ecomgen:invoke', (_event, operation) => {
        if (responses.has(operation)) return { id: 'synthetic', ok: false, error: responses.get(operation) };
        if (operation === 'getHealth') return ok({ status: 'ready', version: 'fixture', webResearchAvailable: false, activeJobs: 0 });
        if (operation === 'listJobs') throw Error('fixture IPC channel failed');
        throw Error('unexpected synthetic operation');
      });
      ipcMain.handle('ecomgen:save-artifact', () => ({ id: 'synthetic', ok: false, error: { code: 'NOT_FOUND', message: '原生保存文件不存在' } }));
      ipcMain.handle('ecomgen:pick-files', () => ok([]));
      ipcMain.handle('ecomgen:clipboard-read', () => ok('fixture clipboard'));
      ipcMain.handle('ecomgen:clipboard-write', () => ok(undefined));
      ipcMain.handle('ecomgen:save-generated', () => ok(true));
      app.whenReady().then(async () => {
        session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
        const window = new BrowserWindow({ show: false, webPreferences: { preload: ${JSON.stringify(preloadFile)}, sandbox: true, contextIsolation: true, nodeIntegration: false } });
        try {
          await window.loadFile(${JSON.stringify(join(fixture, 'index.html'))});
          const result = await window.webContents.executeJavaScript('window.runErrorTransportProbe()');
          const preferences = window.webContents.getLastWebPreferences();
          writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ result, preferences, electron: process.versions.electron }));
          app.quit();
        } catch (error) { console.error(error); app.exit(1); }
      }).catch(error => { console.error(error); app.exit(1); });
    `);
    await runElectron(entry, userData);
    const { result, preferences, electron } = JSON.parse(await readFile(resultFile, 'utf8'));
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(result.nodeRequire, 'undefined');
    for (const [index, [operation, code, message]] of publicErrors.entries()) {
      const row = result.failures[index];
      assert.equal(row.operation, operation);
      assert.equal(row.direct.code, undefined, 'actual Electron drops custom Error.code');
      assert.equal(row.direct.isError, true);
      assert.match(row.direct.message, /ecomgen.public-error/);
      assert.doesNotMatch(row.direct.message, /PRIVATE_/);
      assert.deepEqual(row.wrapped, { code, message, name: 'ApiError', apiError: true, conflict: ['CONFLICT', 'REVISION_CONFLICT'].includes(code), missing: code === 'NOT_FOUND' });
    }
    assert.deepEqual(result.success, { status: 'ready', version: 'fixture', webResearchAvailable: false, activeJobs: 0 });
    assert.equal(result.infrastructure.code, 'UNKNOWN');
    assert.equal(result.infrastructure.apiError, true);
    assert.match(result.infrastructure.message, /fixture IPC channel failed/);
    assert.doesNotMatch(result.infrastructure.message, /ecomgen.public-error/);
    assert.equal(result.nativeError, '原生保存文件不存在');
    assert.deepEqual(result.picker, []);
    assert.equal(result.clipboard, 'fixture clipboard');
    assert.equal(result.clipboardWrite, true);
    assert.equal(result.generatedSave, true);
    assert.equal(result.resourceUrl, 'ecomgen-resource://ASSET/fixture');
    t.diagnostic(`Electron ${electron}: production sources, sandbox/contextIsolation, 4 public codes, instanceof branches, success/native helpers, infrastructure rejection verified; synthetic main only`);
  });
});

test('current renderer client preserves same-realm ApiError identity and ordinary failures', async () => {
  await temporaryFixture(async fixture => {
    const entry = join(fixture, 'client.mjs');
    await build({ stdin: { contents: `export { invoke } from ${JSON.stringify(client)}; export { ApiError } from ${JSON.stringify(errors)};`, resolveDir: root, sourcefile: 'error-transport-client-fixture.js' }, outfile: entry, bundle: true, platform: 'node', format: 'esm', alias });
    const { invoke, ApiError } = await import(pathToFileURL(entry).href);
    const previous = globalThis.window;
    try {
      const original = new ApiError({ code: 'CONFLICT', message: '保留本地修改', details: { revision: 2 }, requestId: 'fixture' });
      for (const [rejection, check] of [
        [original, error => error === original],
        [Object.assign(Error('原有同域错误'), { code: 'REVISION_CONFLICT' }), error => error instanceof ApiError && error.code === 'REVISION_CONFLICT' && error.message === '原有同域错误'],
        [Error('IPC disconnected'), error => error instanceof ApiError && error.code === 'UNKNOWN' && error.message === 'IPC disconnected'],
        [null, error => error instanceof ApiError && error.code === 'UNKNOWN' && error.message === '本地后台操作失败'],
        [Error('{"kind":"ecomgen.public-error","version":2}'), error => error instanceof ApiError && error.code === 'UNKNOWN' && error.message === '本地后台操作失败'],
      ]) {
        globalThis.window = { ecomgen: { invoke: async () => { throw rejection; } } };
        await assert.rejects(invoke('getHealth', {}), check);
      }
    } finally {
      if (previous === undefined) delete globalThis.window;
      else globalThis.window = previous;
    }
  });
});

test('direct-invoke harness decodes marked errors and keeps domain and transport assertions strict', async () => {
  await temporaryFixture(async fixture => {
    const entry = join(fixture, 'harness.mjs');
    // Read current source without requiring a workspace build or changing dist.
    await build({ entryPoints: [join(root, 'scripts/e2e-full-harness.mjs')], outfile: entry,
      bundle: true, platform: 'node', format: 'esm', external: ['playwright-core'],
      plugins: [{ name: 'current-error-transport-source', setup(builder) {
        builder.onResolve({ filter: /contracts\/dist\/index\.js$/ }, () => ({ path: join(root, 'packages/contracts/src/error-transport.ts') }));
      } }] });
    const { RendererRejection, assertDomainRejection } = await import(pathToFileURL(entry).href);
    const encode = (code, message) => JSON.stringify({ kind: 'ecomgen.public-error', version: 1, error: { code, message } });
    const message = '草稿已在别处更新（服务端版本 2）';
    const domain = new RendererRejection({ message: encode('CONFLICT', message) });
    assert.equal(domain.code, 'CONFLICT');
    assert.equal(domain.message, message);
    assert.doesNotThrow(() => assertDomainRejection('updatePatternDraft', domain));
    assert.throws(() => assertDomainRejection('updatePatternDraft', domain, /^another error$/));
    for (const code of ['INTERNAL_ERROR', 'COMMAND_UNAVAILABLE', 'BACKEND_UNAVAILABLE', 'LOCAL_OPERATION_FAILED', 'INVALID_RESPONSE', 'PRIVATE_OUTPUT']) {
      const infrastructure = new RendererRejection({ message: encode(code, message) });
      assert.equal(infrastructure.code, code);
      assert.throws(() => assertDomainRejection('updatePatternDraft', infrastructure, /./));
    }
    const transport = Error(message);
    assert.throws(() => assertDomainRejection('updatePatternDraft', transport, /./), error => error === transport);
    assert.throws(() => assertDomainRejection('updatePatternDraft', new RendererRejection({ message: 'Target page, context or browser has been closed' }), /./));
  });
});
