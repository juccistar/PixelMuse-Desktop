import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { archiveView, contaminationReason, expectedCatalog, inspectCatalog, inspectGraph, inspectNativeResources, inspectRelease, loadTooling, parseArgs, releaseIdentity, resolvePackage, scriptSpecifiers } from './verify-release.mjs';

const tooling = loadTooling();
const script = fileURLToPath(new URL('./verify-release.mjs', import.meta.url));
const sqliteAddon = 'node_modules/better-sqlite3/prebuilds/win32-x64.node';
const sharpAddon = 'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.5.node';
const foreignTargets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'linuxmusl-arm64', 'linuxmusl-x64', 'win32-arm64'];
function foreignPrebuilds(tree) {
  for (const target of foreignTargets) {
    const bytes = target.startsWith('win32') ? pe(0xaa64) : Buffer.alloc(128);
    if (!target.startsWith('win32')) Buffer.from(target.startsWith('darwin') ? 'cffaedfe' : '7f454c46', 'hex').copy(bytes);
    put(tree, `node_modules/better-sqlite3/prebuilds/${target}.node`, bytes);
  }
}
function nativeResult(f) {
  return inspectNativeResources(archiveView(tooling.asar, f.archive), tooling.ts, f.archive);
}
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecomgen-release-fixture-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function put(root, name, content) {
  const filename = path.join(root, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, typeof content === 'object' && !Buffer.isBuffer(content) ? JSON.stringify(content) : content);
  return filename;
}
function pe(machine = 0x8664) {
  const bytes = Buffer.alloc(1024);
  bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.write('PE\0\0', 128, 'binary'); bytes.writeUInt16LE(machine, 132);
  Buffer.from([0xef, 0xbe, 0xad, 0xde, ...Buffer.from('NullsoftInst')]).copy(bytes, 512);
  return bytes;
}
function catalog(filename, expected) {
  const db = new DatabaseSync(filename);
  db.exec('CREATE TABLE suites (id TEXT PRIMARY KEY, file TEXT, name TEXT, l1 TEXT, l2 TEXT, leaf TEXT, description TEXT, hash TEXT, data TEXT); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  const insert = db.prepare('INSERT INTO suites VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of expected.rows) insert.run(...Object.values(row));
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('totalHash', expected.totalHash);
  db.close();
}
const brandConfig = {
  appId: 'com.ecomgen.desktop', productName: 'PixelMuse', artifactName: '${productName}-${version}-${arch}-Setup.${ext}',
  win: { icon: 'build/icon.ico' }, nsis: { deleteAppDataOnUninstall: false, installerIcon: 'build/icon.ico', uninstallerIcon: 'build/icon.ico' },
};
function ico() {
  const bytes = Buffer.alloc(38);
  bytes.writeUInt16LE(1, 2); bytes.writeUInt16LE(1, 4);
  bytes[6] = 16; bytes[7] = 16; bytes.writeUInt16LE(1, 10); bytes.writeUInt16LE(32, 12);
  bytes.writeUInt32LE(16, 14); bytes.writeUInt32LE(22, 18);
  return bytes;
}
async function fixture(t, mutate = () => {}, { unpack = '**/*' } = {}) {
  const root = temporary(t);
  put(root, 'apps/desktop/package.json', { name: '@ecomgen/desktop', productName: 'PixelMuse', version: '0.4.0' });
  put(root, 'apps/desktop/electron-builder.yml', tooling.yaml.dump(brandConfig));
  put(root, 'apps/desktop/build/icon.ico', ico());
  put(root, 'packages/ecom-suite/src/suites/01-synthetic.suite.json', { id: 'fixture', name: 'Synthetic suite', category: { l1: 'A', l2: 'B', leaf: 'C' } });
  const tree = path.join(root, 'synthetic-app');
  put(tree, 'package.json', { name: '@ecomgen/desktop', productName: 'PixelMuse', version: '0.4.0', main: 'out/main/index.js', dependencies: { '@ecomgen/backend': 'workspace:*' } });
  put(tree, 'build/icon.ico', ico());
  put(tree, 'out/main/index.js', 'import { utilityProcess } from "electron"; console.log(utilityProcess);');
  put(tree, 'out/main/backend.js', 'import { createBackend } from "@ecomgen/backend"; console.log(createBackend);');
  put(tree, 'out/preload/index.cjs', 'const { contextBridge } = require("electron");');
  put(tree, 'out/renderer/index.html', '<script type="module" src="./assets/index.js"></script><link href="./assets/index.css" rel="stylesheet">');
  put(tree, 'out/renderer/assets/index.js', 'const provider = "https://example.invalid/v1"; console.log(provider);');
  put(tree, 'out/renderer/assets/index.css', 'body { color: black; }');
  for (const [name, dependencies] of [['@ecomgen/backend', { '@ecomgen/ecom-suite': 'workspace:*', 'better-sqlite3': '1', sharp: '1' }], ['@ecomgen/ecom-suite', {}], ['better-sqlite3', {}], ['sharp', {}]]) {
    put(tree, `node_modules/${name}/package.json`, { name, version: '0.1.0', main: './dist/index.js', exports: { '.': { import: './dist/index.js' } }, dependencies });
    put(tree, `node_modules/${name}/dist/index.js`, 'export const createBackend = () => {};');
  }
  // Model the observed v13 SQLite loader and sharp's platform export wrapper.
  put(tree, 'node_modules/better-sqlite3/package.json', { name: 'better-sqlite3', version: '13.0.3', main: 'lib/index.js' });
  put(tree, 'node_modules/better-sqlite3/lib/index.js', 'module.exports = require("./database")(require("./binding").getBinding, true);');
  put(tree, 'node_modules/better-sqlite3/lib/database.js', 'module.exports = (getBinding) => getBinding;');
  put(tree, 'node_modules/better-sqlite3/lib/binding.js', `
    const fs = require('fs'); const path = require('path');
    const PREBUILD_PLATFORMS = ['linux', 'darwin', 'win32']; const PREBUILD_ARCHS = ['x64', 'arm64'];
    function isLinuxMusl() { return process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime; }
    function getPrebuildPath() {
      if (PREBUILD_PLATFORMS.includes(process.platform) && PREBUILD_ARCHS.includes(process.arch)) {
        const target = \`\${isLinuxMusl() ? 'linuxmusl' : process.platform}-\${process.arch}\`;
        const filename = path.join(__dirname, '..', 'prebuilds', \`\${target}.node\`);
        if (fs.existsSync(filename)) return filename;
      }
      return null;
    }
    exports.getBinding = () => {
      let filename = getPrebuildPath(); if (filename) return require(filename);
      filename = path.join(__dirname, '..', 'build', 'Debug', 'better_sqlite3.node');
      if (!fs.existsSync(filename)) filename = path.join(__dirname, '..', 'build', 'Release', 'better_sqlite3.node');
      return require(filename);
    };`);
  put(tree, 'node_modules/sharp/package.json', { name: 'sharp', version: '0.35.5', main: 'dist/index.cjs', optionalDependencies: { '@img/sharp-win32-x64': '0.35.5' } });
  put(tree, 'node_modules/sharp/dist/index.cjs', 'module.exports = require("./sharp.cjs");');
  put(tree, 'node_modules/sharp/dist/libvips.cjs', 'const runtimeLibc = () => ""; const runtimePlatformArch = () => `${process.platform}${runtimeLibc()}-${process.arch}`; exports.runtimePlatformArch = runtimePlatformArch;');
  put(tree, 'node_modules/sharp/dist/sharp.cjs', `const { runtimePlatformArch } = require('./libvips.cjs');
    const { version } = require('../package.json'); const runtimePlatform = runtimePlatformArch(); let sharp;
    try { sharp = require(\`../src/build/Release/sharp-\${runtimePlatform}-\${version}.node\`); } catch {}
    if (!sharp && runtimePlatform === 'win32-x64') sharp = require('@img/sharp-win32-x64/sharp.node'); module.exports = sharp;`);
  put(tree, 'node_modules/@img/sharp-win32-x64/package.json', { name: '@img/sharp-win32-x64', version: '0.35.5', os: ['win32'], cpu: ['x64'], exports: { './sharp.node': './index.cjs' } });
  put(tree, 'node_modules/@img/sharp-win32-x64/index.cjs', 'module.exports = require("./lib/sharp-win32-x64-0.35.5.node");');
  put(tree, sqliteAddon, pe());
  put(tree, sharpAddon, pe());
  const db = path.join(tree, 'node_modules/@ecomgen/ecom-suite/dist/builtin-suites.db');
  catalog(db, expectedCatalog(root));
  await mutate({ root, tree, db });
  const releaseDir = path.join(root, 'release/0.4.0');
  const resources = path.join(releaseDir, 'win-unpacked/resources');
  fs.mkdirSync(resources, { recursive: true });
  const archive = path.join(resources, 'app.asar');
  await tooling.asar.createPackageWithOptions(tree, archive, { unpack });
  put(releaseDir, 'win-unpacked/PixelMuse.exe', pe());
  put(releaseDir, 'PixelMuse-0.4.0-x64-Setup.exe', pe(0x14c));
  return { root, tree, db, releaseDir, archive };
}

test('CLI requires explicit report output and rejects malformed/duplicate options', () => {
  assert.throws(() => parseArgs([]), /--output is required/);
  assert.throws(() => parseArgs(['--output']), /missing value/);
  assert.throws(() => parseArgs(['--output', 'a', '--output', 'b']), /Duplicate/);
  assert.deepEqual(parseArgs(['--release-dir', 'C:\\fixture dir', '--output', 'result.json', '--expected-version', '0.4.0']), { releaseDir: 'C:\\fixture dir', output: 'result.json', expectedVersion: '0.4.0' });
});

test('release names follow builder configuration and reject unsupported macros or unsafe paths', () => {
  const manifest = { name: 'desktop-app', productName: 'PixelMuse' };
  assert.deepEqual(releaseIdentity(brandConfig, '0.4.0', manifest), {
    productName: 'PixelMuse', appId: 'com.ecomgen.desktop', executableBasename: 'PixelMuse.exe', installerBasename: 'PixelMuse-0.4.0-x64-Setup.exe',
  });
  const custom = { ...brandConfig, productName: 'Studio Two', win: { executableName: 'Studio Launcher', artifactName: '${productName}-${version}-${arch}.${ext}' } };
  assert.equal(releaseIdentity(custom, '1.2.3-beta.1', manifest).installerBasename, 'Studio Two-1.2.3-beta.1-x64.exe');
  assert.equal(releaseIdentity(custom, '1.2.3', manifest).executableBasename, 'Studio Launcher.exe');
  assert.equal(releaseIdentity({ ...custom, nsis: { artifactName: '${name}-Install.${ext}' } }, '1.2.3', manifest).installerBasename, 'desktop-app-Install.exe');
  for (const productName of ['../outside', 'C:\\escape', 'bad/name', 'trailing.', 'CON', '']) {
    assert.throws(() => releaseIdentity({ ...brandConfig, productName }, '0.4.0', manifest), /Unsafe productName/);
  }
  for (const artifactName of ['../Setup.exe', '${env.SECRET}.exe', '${unknown}.exe', '${productName}.zip', '${productName}-${']) {
    assert.throws(() => releaseIdentity({ ...brandConfig, artifactName }, '0.4.0', manifest), /Unsafe|Unsupported|must resolve/);
  }
});

test('checked-in PixelMuse branding preserves upgrade identity, retained data and multi-size original icons', () => {
  const root = path.resolve(path.dirname(script), '..');
  const app = path.join(root, 'apps/desktop');
  const manifest = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
  const config = tooling.yaml.load(fs.readFileSync(path.join(app, 'electron-builder.yml'), 'utf8'));
  assert.equal(manifest.name, '@ecomgen/desktop');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.productName, 'PixelMuse');
  assert.equal(manifest.description, 'PixelMuse 商品视觉创作工作台');
  assert.equal(config.appId, 'com.ecomgen.desktop');
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.equal(config.directories.output, `../../release/${manifest.version}`);
  assert.equal(config.win.icon, 'build/icon.ico');
  assert.ok(config.files.includes(config.win.icon));
  assert.equal(config.nsis.installerIcon, config.win.icon);
  assert.equal(config.nsis.uninstallerIcon, config.win.icon);
  const bytes = fs.readFileSync(path.join(app, config.win.icon));
  assert.equal(bytes.readUInt16LE(0), 0); assert.equal(bytes.readUInt16LE(2), 1);
  const count = bytes.readUInt16LE(4);
  assert.ok(count >= 6);
  const dimensions = [];
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 16;
    const length = bytes.readUInt32LE(offset + 8), start = bytes.readUInt32LE(offset + 12);
    dimensions.push(bytes[offset] || 256);
    assert.equal(bytes[offset], bytes[offset + 1], 'square icon entries');
    assert.ok(start >= 6 + count * 16 && length > 0 && start + length <= bytes.length, 'intact ICO entry');
  }
  for (const size of [16, 32, 48, 256]) assert.ok(dimensions.includes(size), `${size}px ICO entry`);
  const png = fs.readFileSync(path.join(app, 'build/icon-256.png'));
  assert.ok(png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
  assert.equal(png.readUInt32BE(16), 256); assert.equal(png.readUInt32BE(20), 256);
  assert.equal(releaseIdentity(config, manifest.version, manifest).installerBasename, `PixelMuse-${manifest.version}-x64-Setup.exe`);
});

test('branding checks fail for missing runtime icon, mismatched brand and broken upgrade retention', async (t) => {
  for (const scenario of [
    { name: 'missing runtime icon', mutate: ({ tree }) => fs.unlinkSync(path.join(tree, 'build/icon.ico')), check: 'brand-runtime-icon' },
    { name: 'tampered runtime icon', mutate: ({ tree }) => put(tree, 'build/icon.ico', Buffer.from('changed')), check: 'brand-runtime-icon' },
    { name: 'wrong packaged brand', mutate: ({ tree }) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8'));
      put(tree, 'package.json', { ...manifest, productName: 'Wrong Brand' });
    }, check: 'application-version' },
    { name: 'changed installation identity', config: { ...brandConfig, appId: 'com.pixelmuse.desktop' }, check: 'release-configuration' },
    { name: 'uninstall deletes user data', config: { ...brandConfig, nsis: { ...brandConfig.nsis, deleteAppDataOnUninstall: true } }, check: 'release-configuration' },
  ]) await t.test(scenario.name, async (child) => {
    const f = await fixture(child, (context) => scenario.mutate?.(context));
    if (scenario.config) put(f.root, 'apps/desktop/electron-builder.yml', tooling.yaml.dump(scenario.config));
    const report = await inspectRelease({ ...f, tooling });
    assert.equal(report.status, 'failed');
    assert.equal(report.checks.find((item) => item.id === scenario.check).status, 'failed');
  });
});

test('hygiene allows catalog and third-party notices, rejects databases/env/user data', () => {
  for (const name of ['node_modules/@ecomgen/ecom-suite/dist/builtin-suites.db', 'node_modules/sharp/LICENSE', 'node_modules/provider/NOTICE', 'node_modules/provider/lib/sse.js', 'out/renderer/assets/logo-abcd.png']) assert.equal(contaminationReason(name), undefined, name);
  for (const name of ['.env', 'node_modules/provider/.env.local', 'node_modules/@ecomgen/backend/dist/ecomgen.db', 'resources/userData/state.json', 'legacy/runtime.js', 'exports/output.zip', 'node_modules/@ecomgen/core/dist/user.jpg', 'out/renderer/assets/real.sqlite-wal']) assert.ok(contaminationReason(name), name);
  assert.equal(contaminationReason('node_modules/third-party/assets/icon.png'), undefined);
  for (const name of [
    'node_modules/@tanstack/query-core/build/legacy',
    'node_modules/@tanstack/react-query/build/legacy/index.cjs',
    'node_modules/.pnpm/@tanstack+query-core@5/node_modules/@tanstack/query-core/build/legacy/index.js',
    'node_modules/@ecomgen/backend/node_modules/third-party/build/legacy/index.js',
  ]) assert.equal(contaminationReason(name), undefined, name);
  for (const name of [
    'legacy/node_modules/@tanstack/query-core/index.js',
    'out/main/legacy/runtime.js',
    'node_modules/@ecomgen/backend/dist/legacy/runtime.js',
    'node_modules/.pnpm/own/node_modules/@ecomgen/backend/dist/legacy/runtime.js',
    'node_modules/third-party/node_modules/@ecomgen/backend/dist/legacy/runtime.js',
    'node_modules/@tanstack/query-core/build/legacy/.env.local',
    'node_modules/@tanstack/query-core/build/legacy/private.sqlite',
    'node_modules/@ecomgen/backend/dist/credentials.json',
    'node_modules/@ecomgen/backend/dist/master.key',
    'resources/userData/state.json',
  ]) assert.ok(contaminationReason(name), name);
});

test('AST inspection finds literal module edges without rejecting HTTP strings or provider parsing', () => {
  const parsed = scriptSpecifiers(tooling.ts, 'import x from "@ecomgen/core"; export * from "./a.js"; require("fastify"); import("openapi-fetch"); const url="http://example.invalid"; // require("ioredis")\n const parseSSE = "event: data";', 'sample.js');
  assert.deepEqual(parsed.specs, ['@ecomgen/core', './a.js', 'fastify', 'openapi-fetch']);
  assert.equal(parsed.eventSource, false);
  assert.equal(scriptSpecifiers(tooling.ts, 'new EventSource("/events")', 'renderer.js').eventSource, true);
});

test('synthetic ASAR resolves workspace edges and uses native Windows stat paths', async (t) => {
  const f = await fixture(t);
  const view = archiveView(tooling.asar, f.archive);
  assert.equal(view.read('out\\main\\index.js').length > 0, true);
  const graph = inspectGraph(view);
  assert.equal(graph.workspaceEdges.length, 2);
  assert.equal(resolvePackage(view, 'node_modules/@ecomgen/backend/dist/index.js', '@ecomgen/ecom-suite'), 'node_modules/@ecomgen/ecom-suite/package.json');
  assert.equal(resolvePackage(view, 'out/main/backend.js', '@ecomgen/missing'), undefined);
});

test('ASAR links resolve from canonical package location and nested node_modules', async (t) => {
  const root = temporary(t);
  const tree = path.join(root, 'tree');
  put(tree, 'node_modules/.pnpm/core/node_modules/@ecomgen/core/package.json', { name: '@ecomgen/core' });
  put(tree, 'node_modules/.pnpm/core/node_modules/@ecomgen/domain/package.json', { name: '@ecomgen/domain' });
  put(tree, 'node_modules/.pnpm/core/node_modules/@ecomgen/core/dist/index.js', 'export {};');
  fs.mkdirSync(path.join(tree, 'node_modules/@ecomgen'), { recursive: true });
  fs.symlinkSync('../.pnpm/core/node_modules/@ecomgen/core', path.join(tree, 'node_modules/@ecomgen/core'), 'dir');
  const archive = path.join(root, 'links.asar');
  await tooling.asar.createPackage(tree, archive);
  const view = archiveView(tooling.asar, archive);
  assert.equal(view.canonical('node_modules/@ecomgen/core/dist/index.js'), 'node_modules/.pnpm/core/node_modules/@ecomgen/core/dist/index.js');
  assert.equal(resolvePackage(view, 'node_modules/@ecomgen/core/dist/index.js', '@ecomgen/domain'), 'node_modules/.pnpm/core/node_modules/@ecomgen/domain/package.json');
  assert.throws(() => view.canonical('../outside'), /escapes/);
});

test('complete artifacts allow TanStack legacy builds and loader-inactive SQLite prebuilds', async (t) => {
  const f = await fixture(t, ({ tree }) => {
    foreignPrebuilds(tree);
    for (const name of ['@tanstack/query-core', '@tanstack/react-query']) {
      put(tree, `node_modules/${name}/package.json`, { name, version: '5.0.0', main: 'build/legacy/index.cjs' });
      put(tree, `node_modules/${name}/build/legacy/index.cjs`, 'module.exports = {};');
    }
  });
  const report = await inspectRelease({ ...f, tooling });
  assert.equal(report.status, 'passed', JSON.stringify(report.checks.filter((item) => item.status !== 'passed')));
  assert.equal(report.scope, 'artifact-inspection-only');
  assert.ok(report.exclusions.includes('installation'));
  assert.equal(report.checks.find((item) => item.id === 'builtin-sqlite-catalog').details.suites, 1);
  assert.match(report.checks.find((item) => item.id === 'installer-identity').details.sha256, /^[a-f0-9]{64}$/);
  const native = report.checks.find((item) => item.id === 'unpacked-native-resources').details;
  assert.deepEqual(native.requiredRuntimeAddons.map((item) => item.archivePath), [sqliteAddon, sharpAddon]);
  assert.equal(native.inactivePlatformPrebuilds.length, 7);
  assert.deepEqual(native.inactivePlatformPrebuilds.map((item) => item.target).sort(), foreignTargets.toSorted());
  for (const addon of native.requiredRuntimeAddons) {
    assert.equal(addon.machine, '0x8664');
    assert.equal(addon.bytes, 1024);
    assert.equal(addon.physicalPath, path.join(`${f.archive}.unpacked`, addon.archivePath));
  }
});

test('unresolved workspace dependency, forbidden module, import and self MIT all fail', async (t) => {
  const f = await fixture(t, ({ tree }) => {
    const filename = path.join(tree, 'node_modules/@ecomgen/backend/package.json');
    const manifest = JSON.parse(fs.readFileSync(filename));
    manifest.dependencies['@ecomgen/missing'] = 'workspace:*'; manifest.license = 'MIT';
    put(tree, 'node_modules/@ecomgen/backend/package.json', manifest);
    put(tree, 'node_modules/fastify/package.json', { name: 'fastify', version: '1' });
    put(tree, 'node_modules/@ecomgen/backend/dist/index.js', 'import "../../../../legacy/runtime.js"; import "fastify";');
  });
  const report = await inspectRelease({ ...f, tooling });
  for (const id of ['production-dependency-graph', 'compiled-artifacts-and-imports', 'own-license-removal']) assert.equal(report.checks.find((item) => item.id === id).status, 'failed', id);
});

test('unexpected data and orphan unpacked files cannot pass hygiene', async (t) => {
  const f = await fixture(t, ({ tree }) => put(tree, 'node_modules/@ecomgen/backend/dist/customer.sqlite', 'user data'));
  put(`${f.archive}.unpacked`, 'node_modules/@ecomgen/backend/unlisted.json', '{}');
  const report = await inspectRelease({ ...f, tooling });
  assert.equal(report.checks.find((item) => item.id === 'packaged-data-hygiene').status, 'failed');
});

test('catalog must be real SQLite matching every source row and total hash', async (t) => {
  const f = await fixture(t);
  const expected = expectedCatalog(f.root);
  assert.equal((await inspectCatalog(f.db, expected)).suites, 1);
  const db = new DatabaseSync(f.db);
  db.prepare('UPDATE suites SET data = ?').run('{"tampered":true}'); db.close();
  await assert.rejects(inspectCatalog(f.db, expected), /Catalog mismatch/);
  const repair = new DatabaseSync(f.db);
  repair.prepare('UPDATE suites SET data = ?').run(expected.rows[0].data);
  repair.prepare('UPDATE meta SET value = ?').run('wrong-hash'); repair.close();
  await assert.rejects(inspectCatalog(f.db, expected), /totalHash mismatch/);
  put(f.root, 'invalid.db', 'not SQLite');
  await assert.rejects(inspectCatalog(path.join(f.root, 'invalid.db'), expected), /not a SQLite/);
});

test('CLI missing final inputs produces failed/blocked report and exit 1', (t) => {
  const root = temporary(t);
  const output = path.join(root, 'report.json');
  const result = spawnSync(process.execPath, [script, '--release-dir', path.join(root, 'missing'), '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.status, 'failed');
  assert.equal(report.checks.find((item) => item.id === 'required-inputs').status, 'failed');
  assert.equal(report.checks.find((item) => item.id === 'builtin-sqlite-catalog').status, 'blocked');
  assert.equal(report.checks.find((item) => item.id === 'installer-identity').status, 'blocked');
  const second = spawnSync(process.execPath, [script, '--release-dir', path.join(root, 'missing'), '--output', output], { encoding: 'utf8' });
  assert.equal(second.status, 2);
  assert.match(second.stderr, /already exists/);
  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' }).status, 0);
  const inside = spawnSync(process.execPath, [script, '--release-dir', root, '--output', path.join(root, 'forbidden.json')], { encoding: 'utf8' });
  assert.equal(inside.status, 2);
  assert.match(inside.stderr, /outside the inspected release/);
});

test('wrong packaged version and missing native binary are failed required checks', async (t) => {
  const f = await fixture(t, ({ tree }) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(tree, 'package.json'))); manifest.version = '0.2.0'; put(tree, 'package.json', manifest);
    fs.unlinkSync(path.join(tree, sharpAddon));
  });
  const report = await inspectRelease({ ...f, tooling });
  for (const id of ['application-version', 'unpacked-native-resources']) assert.equal(report.checks.find((item) => item.id === id).status, 'failed');
});

test('foreign prebuilds never substitute for missing, corrupt, packed or wrong-architecture active addons', async (t) => {
  const cases = [
    { name: 'missing SQLite despite foreign prebuilds', mutate: ({ tree }) => fs.unlinkSync(path.join(tree, sqliteAddon)), error: /Missing Windows x64 SQLite runtime.*lib\/binding\.js/ },
    { name: 'missing sharp despite unrelated addon', mutate: ({ tree }) => fs.unlinkSync(path.join(tree, sharpAddon)), error: /Missing Windows x64 sharp runtime.*sharp-win32-x64-0\.35\.5\.node/ },
    { name: 'SQLite arm64 cannot serve x64', mutate: ({ tree }) => put(tree, sqliteAddon, pe(0xaa64)), error: /not Windows x64: .*win32-x64\.node.*0xaa64/ },
    { name: 'sharp ELF is not a Windows binary', mutate: ({ tree }) => put(tree, sharpAddon, Buffer.alloc(128)), error: /MZ header missing.*sharp-win32-x64-0\.35\.5\.node/ },
    { name: 'packed active addon', mutate: () => {}, options: { unpack: '**/*.db' }, error: /Native resource is packed: .*win32-x64\.node/ },
    { name: 'active binary removed from unpacked tree', mutate: () => {}, physical: (f) => fs.unlinkSync(path.join(`${f.archive}.unpacked`, sqliteAddon)), error: /Missing unpacked native resource: .*win32-x64\.node/ },
    { name: 'active binary truncated', mutate: () => {}, physical: (f) => fs.truncateSync(path.join(`${f.archive}.unpacked`, sharpAddon), 32), error: /truncated unpacked native resource: .*sharp-win32-x64-0\.35\.5\.node.*expected 1024 bytes, found 32/ },
    { name: 'directory cannot serve active addon', mutate: ({ tree }) => { fs.unlinkSync(path.join(tree, sqliteAddon)); put(tree, `${sqliteAddon}/placeholder.txt`, 'not an addon'); }, error: /SQLite runtime path is a directory: .*win32-x64\.node/ },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (child) => {
    const f = await fixture(child, (context) => { foreignPrebuilds(context.tree); scenario.mutate(context); }, scenario.options);
    scenario.physical?.(f);
    assert.throws(() => nativeResult(f), scenario.error);
  });
});

test('inactive exemptions still require intact unpacked files and a recognized reachable loader', async (t) => {
  for (const operation of ['missing', 'truncated']) await t.test(operation, async (child) => {
    const f = await fixture(child, ({ tree }) => foreignPrebuilds(tree));
    const physical = path.join(`${f.archive}.unpacked`, 'node_modules/better-sqlite3/prebuilds/linux-x64.node');
    if (operation === 'missing') fs.unlinkSync(physical); else fs.truncateSync(physical, 1);
    assert.throws(() => nativeResult(f), (error) => error.message.includes(physical) && /Missing|truncated/.test(error.message));
  });
  await t.test('foreign files packed', async (child) => {
    const f = await fixture(child, ({ tree }) => foreignPrebuilds(tree), { unpack: '**/win32-x64*.node' });
    assert.throws(() => nativeResult(f), /Native resource is packed: .*darwin-arm64\.node/);
  });
  for (const kind of ['unsupported', 'unreachable']) await t.test(`${kind} SQLite loader`, async (child) => {
    const f = await fixture(child, ({ tree }) => {
      foreignPrebuilds(tree);
      const binding = 'node_modules/better-sqlite3/lib/binding.js';
      if (kind === 'unsupported') put(tree, binding, fs.readFileSync(path.join(tree, binding), 'utf8').replace("${process.arch}", 'arm64'));
      else put(tree, 'node_modules/better-sqlite3/lib/index.js', 'module.exports = {};');
    });
    assert.throws(() => nativeResult(f), /Unsupported SQLite native loader.*better-sqlite3\/lib\/binding\.js/);
  });
  await t.test('lookalike foreign file outside prebuild directory', async (child) => {
    const f = await fixture(child, ({ tree }) => put(tree, 'node_modules/better-sqlite3/other/linux-x64.node', Buffer.alloc(128)));
    assert.throws(() => nativeResult(f), /MZ header missing.*better-sqlite3[/\\]other[/\\]linux-x64\.node/);
  });
});

test('SQLite loader precedence validates prebuild first and Debug before Release', async (t) => {
  const f = await fixture(t, ({ tree }) => {
    foreignPrebuilds(tree);
    fs.unlinkSync(path.join(tree, sqliteAddon));
    put(tree, 'node_modules/better-sqlite3/build/Debug/better_sqlite3.node', pe());
    put(tree, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node', pe());
  });
  assert.equal(nativeResult(f).requiredRuntimeAddons[0].archivePath, 'node_modules/better-sqlite3/build/Debug/better_sqlite3.node');
  const preferred = await fixture(t, ({ tree }) => put(tree, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node', pe()));
  assert.equal(nativeResult(preferred).requiredRuntimeAddons[0].archivePath, sqliteAddon);
});

test('sharp selection follows the platform export wrapper and rejects escape or unsupported loaders', async (t) => {
  await t.test('invalid local build cannot be hidden by a valid platform addon', async (child) => {
    const f = await fixture(child, ({ tree }) => put(tree, 'node_modules/sharp/src/build/Release/sharp-win32-x64-0.35.5.node', pe(0x14c)));
    assert.throws(() => nativeResult(f), /not Windows x64.*sharp-win32-x64-0\.35\.5\.node.*0x14c/);
  });
  await t.test('platform wrapper cannot borrow an inactive foreign binary', async (child) => {
    const f = await fixture(child, ({ tree }) => {
      foreignPrebuilds(tree);
      put(tree, 'node_modules/@img/sharp-win32-x64/index.cjs', 'module.exports = require("./../../better-sqlite3/prebuilds/linux-x64.node");');
    });
    assert.throws(() => nativeResult(f), /Sharp addon escapes its platform package.*index\.cjs/);
  });
  await t.test('unknown sharp loader fails', async (child) => {
    const f = await fixture(child, ({ tree }) => put(tree, 'node_modules/sharp/dist/sharp.cjs', 'module.exports = require("custom-loader");'));
    assert.throws(() => nativeResult(f), /Unsupported sharp native loader.*sharp\/package\.json/);
  });
});

test('unreferenced unversioned sharp build cannot replace a missing versioned runtime addon', async (t) => {
  const f = await fixture(t, ({ tree }) => {
    foreignPrebuilds(tree);
    fs.unlinkSync(path.join(tree, sharpAddon));
    // The v0.35 loader in this fixture references only the versioned local build.
    put(tree, 'node_modules/sharp/src/build/Release/sharp-win32-x64.node', pe());
  });
  const report = await inspectRelease({ ...f, tooling });
  const native = report.checks.find((item) => item.id === 'unpacked-native-resources');
  assert.equal(native.status, 'failed', 'An unreferenced stale local build must not hide the missing platform addon');
  assert.match(native.error, /Missing Windows x64 sharp runtime/);
  assert.equal(report.status, 'failed');
});

test('sharp CommonJS require export must exist even when its import export is intact', async (t) => {
  const f = await fixture(t, ({ tree }) => {
    put(tree, 'node_modules/@img/sharp-win32-x64/package.json', {
      name: '@img/sharp-win32-x64', version: '0.35.5', os: ['win32'], cpu: ['x64'],
      exports: { './sharp.node': { import: './index.cjs', require: './missing.node' } },
    });
  });
  // Resolve only: no fixture JavaScript or native code is executed.
  const loaderRequire = createRequire(path.join(f.tree, 'node_modules/sharp/dist/sharp.cjs'));
  assert.throws(() => loaderRequire.resolve('@img/sharp-win32-x64/sharp.node'), { code: 'MODULE_NOT_FOUND' });
  const report = await inspectRelease({ ...f, tooling });
  const native = report.checks.find((item) => item.id === 'unpacked-native-resources');
  assert.equal(native.status, 'failed', 'The import-only addon cannot satisfy the CommonJS require branch');
  assert.match(native.error, /Missing sharp platform export|Unsupported.*export|Missing Windows x64 sharp runtime/);
  assert.equal(report.status, 'failed');
});

test('sharp CommonJS conditions follow Node declaration order and nested branches', async (t) => {
  const cases = [
    { name: 'skip import before require', exports: { import: './missing.node', require: './index.cjs' } },
    { name: 'node before require', exports: { node: './index.cjs', require: './missing.node' } },
    { name: 'require before node', exports: { require: './index.cjs', node: './missing.node' } },
    { name: 'default before require', exports: { default: './index.cjs', require: './missing.node' } },
    { name: 'require before default', exports: { require: './index.cjs', default: './missing.node' } },
    { name: 'nested node branch', exports: { node: { import: './missing.node', require: './index.cjs' }, default: './missing.node' } },
    { name: 'unmatched nested branch falls through', exports: { node: { import: './missing.node' }, default: './index.cjs' } },
    { name: 'node-addons before default', exports: { 'node-addons': './index.cjs', default: './missing.node' } },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (child) => {
    const f = await fixture(child, ({ tree }) => put(tree, 'node_modules/@img/sharp-win32-x64/package.json', {
      name: '@img/sharp-win32-x64', version: '0.35.5', os: ['win32'], cpu: ['x64'], exports: { './sharp.node': scenario.exports },
    }));
    const loaderRequire = createRequire(path.join(f.tree, 'node_modules/sharp/dist/sharp.cjs'));
    assert.equal(loaderRequire.resolve('@img/sharp-win32-x64/sharp.node'), path.join(f.tree, 'node_modules/@img/sharp-win32-x64/index.cjs'));
    assert.equal(nativeResult(f).requiredRuntimeAddons[1].archivePath, sharpAddon);
  });
});

test('sharp unsupported exports, blocked branches and non-CommonJS wrappers fail conservatively', async (t) => {
  const cases = [
    { name: 'import only', exports: { import: './index.cjs' }, error: /Missing sharp.node export for CommonJS require/ },
    { name: 'null require blocks default', exports: { require: null, default: './index.cjs' }, error: /Missing sharp.node export for CommonJS require/ },
    { name: 'array targets unsupported', exports: ['./index.cjs'], error: /Unsupported CommonJS export structure/ },
    { name: 'unknown condition unsupported', exports: { 'module-sync': './index.cjs', default: './index.cjs' }, error: /Unsupported CommonJS export condition/ },
    { name: 'export cannot escape', exports: './../sharp/index.cjs', error: /Unsupported CommonJS export target/ },
    { name: 'ES import cannot serve CommonJS forwarding', wrapper: 'import "./lib/sharp-win32-x64-0.35.5.node";', error: /Unsupported sharp addon wrapper/ },
    { name: 'unexported require is not forwarding', wrapper: 'require("./lib/sharp-win32-x64-0.35.5.node"); module.exports = {};', error: /Unsupported sharp addon wrapper/ },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (child) => {
    const f = await fixture(child, ({ tree }) => {
      if (scenario.exports) put(tree, 'node_modules/@img/sharp-win32-x64/package.json', {
        name: '@img/sharp-win32-x64', version: '0.35.5', os: ['win32'], cpu: ['x64'], exports: { './sharp.node': scenario.exports },
      });
      if (scenario.wrapper) put(tree, 'node_modules/@img/sharp-win32-x64/index.cjs', scenario.wrapper);
    });
    assert.throws(() => nativeResult(f), scenario.error);
  });
});

test('sharp local candidates come from the reachable require template', async (t) => {
  await t.test('referenced unversioned layout selects the unversioned addon', async (child) => {
    const local = 'node_modules/sharp/src/build/Release/sharp-win32-x64.node';
    const f = await fixture(child, ({ tree }) => {
      const loader = 'node_modules/sharp/dist/sharp.cjs';
      put(tree, loader, fs.readFileSync(path.join(tree, loader), 'utf8').replace('sharp-${runtimePlatform}-${version}.node', 'sharp-${runtimePlatform}.node'));
      put(tree, local, pe());
      fs.unlinkSync(path.join(tree, sharpAddon));
    });
    assert.equal(nativeResult(f).requiredRuntimeAddons[1].archivePath, local);
  });
  await t.test('unknown local template fails instead of using guessed candidates', async (child) => {
    const f = await fixture(child, ({ tree }) => {
      const loader = 'node_modules/sharp/dist/sharp.cjs';
      put(tree, loader, fs.readFileSync(path.join(tree, loader), 'utf8').replace('sharp-${runtimePlatform}-${version}.node', 'sharp-custom-${version}.node'));
    });
    assert.throws(() => nativeResult(f), /Unsupported sharp native loader local require/);
  });
  await t.test('package entry cannot borrow the import branch loader', async (child) => {
    const f = await fixture(child, ({ tree }) => put(tree, 'node_modules/sharp/package.json', {
      name: 'sharp', version: '0.35.5', main: 'dist/index.cjs',
      exports: { '.': { import: './dist/index.cjs', require: './dist/missing.cjs' } },
    }));
    assert.throws(() => nativeResult(f), /Unsupported sharp native loader/);
  });
});

test('Windows sharp DLLs require x64 PE and intact unpacking', async (t) => {
  const dll = 'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll';
  for (const scenario of [
    { name: 'valid', bytes: pe() },
    { name: 'ELF', bytes: Buffer.alloc(128), error: /MZ header missing.*libvips-42\.dll/ },
    { name: 'arm64', bytes: pe(0xaa64), error: /not Windows x64.*libvips-42\.dll.*0xaa64/ },
    { name: 'missing unpacked DLL', bytes: pe(), remove: true, error: /Missing unpacked native resource.*libvips-42\.dll/ },
  ]) await t.test(scenario.name, async (child) => {
    const f = await fixture(child, ({ tree }) => put(tree, dll, scenario.bytes));
    if (scenario.remove) fs.unlinkSync(path.join(`${f.archive}.unpacked`, dll));
    if (scenario.error) assert.throws(() => nativeResult(f), scenario.error);
    else assert.equal(nativeResult(f).requiredRuntimeAddons[1].archivePath, sharpAddon);
  });
});

test('native failures report concrete paths with bounded diagnostic volume', async (t) => {
  const f = await fixture(t, ({ tree }) => {
    for (let i = 0; i < 30; i++) put(tree, `node_modules/other/native-${i}.node`, Buffer.alloc(128));
  });
  assert.throws(() => nativeResult(f), (error) => {
    assert.match(error.message, /MZ header missing.*native-\d+\.node/);
    assert.match(error.message, /18 further violations \(30 total\)/);
    assert.ok(error.message.length < 6000);
    return true;
  });
});
