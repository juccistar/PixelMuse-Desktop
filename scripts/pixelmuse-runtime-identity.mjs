import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// This function also executes inside the owned Electron inspector. Keep it closed
// over nothing so ASAR reads and dependency resolution use Electron's actual fs.
function collectRuntimeFingerprint(appPath, load) {
  const fs = load('node:fs');
  const path = load('node:path');
  const { createRequire } = load('node:module');
  const { createHash } = load('node:crypto');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const ensure = (condition, message) => { if (!condition) throw Error(message); };
  const files = new Map();
  const queue = [{ directory: appPath, name: '@ecomgen/desktop', app: true }];
  const visited = new Set();
  const packageRoots = new Map();
  function record(key, filename) {
    const before = fs.statSync(filename);
    ensure(before.isFile(), 'Runtime input must be a regular file');
    const sha256 = hash(fs.readFileSync(filename));
    const after = fs.statSync(filename);
    ensure(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
      'Runtime input changed during capture');
    ensure(!files.has(key) || files.get(key) === sha256, 'Conflicting workspace runtime versions');
    files.set(key, sha256);
  }
  function visit(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      ensure(!entry.isSymbolicLink(), 'Runtime trees must not contain filesystem links');
      const key = `${prefix}/${entry.name}`;
      // Never inspect profiles, credentials or source maps (which contain source
      // paths). Only the compiled out/dist trees are traversed.
      ensure(!/(?:^|\/)(?:\.env(?:\.[^/]*)?|userdata|user-data|user_data|uploads|backups|secrets(?:\.json)?|credentials(?:\.json)?|master[.-]key(?:\.enc)?|desktop\.json)(?:\/|$)/i.test(key),
        'Private file in compiled runtime tree');
      if (entry.isDirectory()) visit(path.join(directory, entry.name), key);
      else {
        ensure(entry.isFile(), 'Unexpected compiled runtime entry');
        if (/\.map$|\.d\.(?:ts|cts|mts)$/i.test(entry.name)) continue;
        ensure(!/\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/i.test(entry.name) ||
          key === '@ecomgen/ecom-suite/dist/builtin-suites.db', 'Unexpected runtime database');
        record(key, path.join(directory, entry.name));
      }
    }
  }
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    const directory = fs.realpathSync(current.directory);
    const filename = path.join(directory, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
    ensure(manifest.name === current.name, 'Resolved workspace package identity mismatch');
    ensure(!packageRoots.has(current.name) || packageRoots.get(current.name) === directory,
      'Multiple physical runtime packages share a workspace identity');
    packageRoots.set(current.name, directory);
    if (visited.has(directory)) continue;
    visited.add(directory);
    const subtree = current.app ? 'out' : 'dist';
    const prefix = current.app ? 'app/out' : `${current.name}/dist`;
    const before = files.size;
    visit(path.join(directory, subtree), prefix);
    ensure(files.size > before || [...files.keys()].some(key => key.startsWith(`${prefix}/`)), 'Empty compiled runtime tree');
    const importer = createRequire(filename);
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) {
      if (!name.startsWith('@ecomgen/')) continue;
      ensure(/^@ecomgen\/[a-z0-9-]+$/.test(name), 'Invalid workspace dependency name');
      // Import-only exports can hide package.json from require.resolve. Use the
      // real importer's Node lookup order to locate its package boundary instead
      // of guessing a checkout-wide packages directory or flat node_modules.
      const candidate = (importer.resolve.paths(name) ?? [])
        .map(base => path.join(base, name, 'package.json')).find(value => fs.existsSync(value));
      ensure(candidate, 'Unresolved runtime workspace dependency');
      queue.push({ directory: path.dirname(candidate), name, app: false });
    }
  }
  for (const key of ['app/out/main/index.js', 'app/out/main/backend.js', 'app/out/preload/index.cjs', 'app/out/renderer/index.html'])
    ensure(files.has(key), 'Missing compiled application entry');
  ensure([...files.keys()].some(key => key.startsWith('@ecomgen/')), 'Missing workspace runtime dependencies');
  const rows = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, sha256]) => ({ key, sha256 }));
  return { runtimeHash: hash(JSON.stringify(rows)), files: rows };
}

/** 读取指定应用目录的编译文件指纹，不导入业务代码。 */
export function fingerprintRuntime(appPath) {
  const absolute = resolve(appPath);
  return collectRuntimeFingerprint(absolute, createRequire(`${absolute}/package.json`));
}

/** 流式计算物理文件的 SHA-256，避免把安装包整体读入内存。 */
export async function hashPhysicalFile(filename) {
  const before = await stat(filename);
  assert.ok(before.isFile(), 'Physical runtime input must be a regular file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  const after = await stat(filename);
  assert.ok(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
    'Physical runtime file changed during hashing');
  return hash.digest('hex');
}

/** 从已启动且由测试拥有的 inspector 捕获运行身份。 */
export async function captureRuntimeIdentity(app, { mode, runId }) {
  assert.ok(['source', 'exe'].includes(mode), 'Runtime mode must be source or exe');
  assert.match(runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'Runtime runId must be a random UUID');
  const actual = await app.evaluate(({ app }, collectorSource) => {
    const collect = new Function('appPath', 'load', `return (${collectorSource})(appPath, load);`);
    const appPath = app.getAppPath();
    return { version: app.getVersion(), packaged: app.isPackaged, appPath, execPath: process.execPath,
      ...collect(appPath, require) };
  }, collectRuntimeFingerprint.toString());
  assert.equal(actual.packaged, mode === 'exe', 'Actual Electron mode differs from requested mode');
  const identity = { runId, mode, version: actual.version, packaged: actual.packaged,
    runtimeHash: actual.runtimeHash, files: actual.files };
  if (actual.packaged) {
    assert.match(actual.appPath, /[\\/]resources[\\/]app\.asar$/i, 'Packaged runtime must use its physical ASAR');
    assert.match(actual.execPath, /[\\/]PixelMuse\.exe$/i, 'Expected actual PixelMuse executable');
    identity.archive = { path: resolve(actual.appPath), sha256: await hashPhysicalFile(actual.appPath) };
    identity.executable = { path: resolve(actual.execPath), sha256: await hashPhysicalFile(actual.execPath) };
  }
  return identity;
}
