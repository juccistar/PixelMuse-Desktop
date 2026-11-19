#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbidden = new Set(['fastify', 'bullmq', 'ioredis', 'openapi-fetch', '@ecomgen/api', '@ecomgen/jobs', '@ecomgen/worker', '@ecomgen/web']);
const removedLicenses = ['domain', 'ecom-skill', 'ecom-suite', 'ecom-suite-forge', 'providers', 'agent'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const slash = (value) => value.replaceAll('\\', '/').replace(/^\/+/, '');
const ownPath = (value) => {
  // The nearest package owns a nested dependency, including pnpm's canonical layout.
  const owners = [...value.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)(?=\/|$)/g)];
  const owner = owners.at(-1)?.[1];
  return !owner || owner.startsWith('@ecomgen/');
};
// Test ownership at each legacy segment: a third-party build/legacy is valid,
// but legacy/node_modules/third-party still includes the removed workspace root.
const legacyWorkspacePath = (value) => [...slash(value).matchAll(/(?:^|\/)legacy(?=\/|$)/gi)]
  .some((match) => ownPath(slash(value).slice(0, match.index + match[0].length)));
const bounded = (text, limit = 6000) => text.length <= limit ? text : `${text.slice(0, limit)} [truncated; ${text.length} characters total]`;
const assertNoViolations = (violations) => ensure(violations.length === 0,
  `${violations.slice(0, 12).map((message) => bounded(message, 420)).join('\n')}${violations.length > 12 ? `\n... ${violations.length - 12} further violations (${violations.length} total)` : ''}`);
const packageName = (specifier) => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

export function loadTooling(root = desktopRoot) {
  const appRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
  const builderRequire = createRequire(appRequire.resolve('electron-builder'));
  const libRequire = createRequire(builderRequire.resolve('app-builder-lib'));
  return { asar: libRequire('@electron/asar'), yaml: libRequire('js-yaml'), ts: createRequire(path.join(root, 'package.json'))('typescript') };
}

/** 从构建配置推导 Windows x64 产物名称；未知宏和路径字符直接拒绝。 */
export function releaseIdentity(config, version, manifest) {
  ensure(config && typeof config === 'object' && !Array.isArray(config), 'Builder configuration must be an object');
  const basename = (value, field) => {
    ensure(typeof value === 'string' && value.trim() === value && value.length > 0
      && !/[<>:"/\\\\|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value) && !['.', '..'].includes(value)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value), `Unsafe ${field}: ${String(value)}`);
    return value;
  };
  ensure(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version), 'Invalid expected version');
  const productName = basename(config.productName ?? manifest.productName ?? manifest.name, 'productName');
  const executableName = basename(config.win?.executableName ?? config.executableName ?? productName, 'executableName');
  const artifactName = config.nsis?.artifactName ?? config.win?.artifactName ?? config.artifactName ?? '${productName} Setup ${version}.${ext}';
  ensure(typeof artifactName === 'string', 'artifactName must be a string');
  const macros = { productName, name: manifest.name, version, arch: 'x64', ext: 'exe', os: 'win' };
  const installerBasename = basename(artifactName.replace(/\$\{([^}]+)\}/g, (_match, key) => {
    ensure(Object.hasOwn(macros, key), `Unsupported artifactName macro: ${key}`);
    return macros[key];
  }), 'artifactName');
  ensure(!installerBasename.includes('${') && installerBasename.endsWith('.exe'), 'artifactName must resolve to an .exe filename');
  return { productName, executableBasename: `${executableName}.exe`, installerBasename, appId: config.appId };
}

/** ASAR uses platform-normalized stat paths, even though its directory index uses slashes. */
export function archiveView(asar, archive) {
  const entries = asar.listPackage(archive).map(slash);
  const names = new Set(entries);
  function canonical(input) {
    let value = path.posix.normalize(slash(input));
    ensure(value !== '..' && !value.startsWith('../'), `Archive path escapes root: ${input}`);
    for (let depth = 0; depth < 32; depth++) {
      const parts = value.split('/');
      let redirected = false;
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        if (!names.has(prefix)) continue;
        const stat = asar.statFile(archive, path.normalize(prefix), false);
        if (stat.link) {
          ensure(!/^(?:[a-z]:|[\\/])/i.test(stat.link) && !stat.link.includes(':'), `Invalid absolute ASAR link: ${input}`);
          value = path.posix.normalize([slash(stat.link), ...parts.slice(i)].join('/'));
          ensure(value !== '..' && !value.startsWith('../'), `ASAR link escapes root: ${input}`);
          redirected = true;
          break;
        }
      }
      if (!redirected) return value;
    }
    throw new Error(`ASAR link cycle: ${input}`);
  }
  const stat = (name) => asar.statFile(archive, path.normalize(canonical(name)));
  const exists = (name) => { try { return !!stat(name); } catch { return false; } };
  const read = (name) => asar.extractFile(archive, path.normalize(canonical(name)));
  return { entries, canonical, stat, exists, read, json: (name) => JSON.parse(read(name).toString('utf8')) };
}

export function resolvePackage(view, importer, name) {
  let directory = path.posix.dirname(view.canonical(importer));
  for (;;) {
    const candidate = path.posix.join(directory, 'node_modules', name, 'package.json');
    if (view.exists(candidate)) return view.canonical(candidate);
    if (directory === '.') return undefined;
    directory = path.posix.dirname(directory);
  }
}

function exportTarget(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(exportTarget).find(Boolean);
  if (!value || typeof value !== 'object') return undefined;
  return exportTarget(value.import ?? value.node ?? value.default ?? value.require);
}

/** CommonJS conditions are tried in manifest declaration order, never import-first.
 * Arrays and unfamiliar conditions are deliberately unsupported rather than guessed.
 */
function requireExportTarget(value, filename) {
  if (typeof value === 'string' || value === null || value === undefined) return value;
  ensure(!Array.isArray(value) && typeof value === 'object', `Unsupported CommonJS export structure: ${filename}`);
  for (const [condition, target] of Object.entries(value)) {
    if (condition === 'import' || condition === 'types') continue;
    ensure(['require', 'node', 'node-addons', 'default'].includes(condition), `Unsupported CommonJS export condition ${condition}: ${filename}`);
    const resolved = requireExportTarget(target, filename);
    if (resolved !== undefined) return resolved; // null blocks later branches as in Node.
  }
  return undefined;
}

function literalPackageTarget(target, filename) {
  ensure(typeof target === 'string' && target.startsWith('./') && !/[\\\\%?#:]/.test(target)
    && target.slice(2).split('/').every((part) => part && !['.', '..', 'node_modules'].includes(part)),
  `Unsupported CommonJS export target: ${filename} -> ${String(target)}`);
  return path.posix.join(path.posix.dirname(filename), target);
}

function resolveFile(view, name) {
  return [name, `${name}.js`, `${name}.cjs`, `${name}.mjs`, `${name}.json`, `${name}/index.js`, `${name}/index.cjs`]
    .find((candidate) => view.exists(candidate) && !view.stat(candidate).files);
}

export function inspectGraph(view) {
  const manifests = new Map();
  for (const name of ['package.json', ...view.entries.filter((entry) => entry.endsWith('/package.json') && /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(entry))]) {
    const canonical = view.canonical(name);
    if (!manifests.has(canonical)) manifests.set(canonical, view.json(canonical));
  }
  const violations = [];
  const edges = [];
  for (const [filename, manifest] of manifests) {
    if (forbidden.has(manifest.name)) violations.push(`Forbidden packaged module: ${manifest.name} (${filename})`);
    for (const [dependency, range] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (forbidden.has(dependency)) violations.push(`Forbidden dependency: ${manifest.name} -> ${dependency}`);
      const resolved = resolvePackage(view, filename, dependency);
      const optional = Object.hasOwn(manifest.optionalDependencies ?? {}, dependency);
      if (dependency.startsWith('@ecomgen/')) edges.push({ from: manifest.name, dependency, range, resolved: resolved ?? null });
      if (!resolved && (!optional || dependency.startsWith('@ecomgen/'))) violations.push(`Unresolved dependency: ${filename} -> ${dependency}`);
      if (resolved && dependency.startsWith('@ecomgen/') && view.json(resolved).name !== dependency) violations.push(`Wrong workspace package identity: ${filename} -> ${dependency}`);
    }
    if (manifest.name?.startsWith('@ecomgen/')) {
      const target = manifest.main ?? exportTarget(manifest.exports?.['.'] ?? manifest.exports);
      if (!target || !resolveFile(view, path.posix.join(path.posix.dirname(filename), target))) violations.push(`Missing compiled workspace entry: ${filename}`);
    }
  }
  ensure(edges.length > 0, 'No packaged workspace dependency edges found');
  assertNoViolations(violations);
  return { packageCount: manifests.size, workspaceEdges: edges, manifests };
}

/** Third-party notices and provider HTTP/SSE clients are legitimate package resources. */
export function contaminationReason(input) {
  const name = slash(input);
  const base = path.posix.basename(name);
  if (/^\.env(?:\.|$)/i.test(base)) return 'Environment file';
  if (legacyWorkspacePath(name)) return 'Legacy workspace directory';
  if (/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i.test(base)) {
    if (name.endsWith('/@ecomgen/ecom-suite/dist/builtin-suites.db')) return undefined;
    return 'Unexpected database';
  }
  if (/\.(?:zip|7z|rar|tar|tgz|psd)$/i.test(base)) return 'Archive or user export';
  if (ownPath(name) && /(?:^|\/)(?:userdata|user-data|user_data|uploads|exports|backups|user-assets|user_assets|secrets|credentials)(?:\/|$)/i.test(name)) return 'User data directory';
  if (ownPath(name) && /^(?:master\.key|secrets\.json|credentials\.json|desktop\.json|ecomgen\.db)$/i.test(base)) return 'User state or secret file';
  if (ownPath(name) && /\.(?:png|jpe?g|webp|gif|avif|tiff?|mp4|mov)$/i.test(base) && !/^out\/renderer\/assets\//.test(name)) return 'Unexpected user media outside compiled renderer assets';
  return undefined;
}

export function scriptSpecifiers(ts, text, filename) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const specs = [];
  let eventSource = false;
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) specs.push(node.arguments[0].text);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'EventSource') eventSource = true;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { specs, eventSource };
}

function inspectScripts(view, ts) {
  const files = view.entries.filter((name) => ownPath(name) && /\.(?:js|cjs|mjs)$/.test(name) && !view.stat(name).files);
  ensure(files.length > 0, 'No compiled scripts found');
  const violations = [];
  let imports = 0;
  for (const file of files) {
    const parsed = scriptSpecifiers(ts, view.read(file).toString('utf8'), file);
    if (parsed.eventSource && !file.includes('/@ecomgen/providers/') && !file.includes('/@ecomgen/agent/')) violations.push(`Legacy EventSource runtime: ${file}`);
    for (const specifier of parsed.specs) {
      imports++;
      const importedPath = specifier.startsWith('.') ? path.posix.join(path.posix.dirname(file), slash(specifier)) : `node_modules/${slash(specifier)}`;
      if (forbidden.has(packageName(specifier)) || legacyWorkspacePath(importedPath)) violations.push(`Forbidden import: ${file} -> ${specifier}`);
      if (specifier.startsWith('@ecomgen/')) {
        const manifest = resolvePackage(view, file, packageName(specifier));
        if (!manifest) { violations.push(`Unresolved workspace import: ${file} -> ${specifier}`); continue; }
        const metadata = view.json(manifest);
        const suffix = specifier.slice(packageName(specifier).length);
        const target = metadata.exports ? exportTarget(metadata.exports[suffix ? `.${suffix}` : '.'] ?? (!suffix ? metadata.exports : undefined)) : suffix || metadata.main || 'index.js';
        if (!target || !resolveFile(view, path.posix.join(path.posix.dirname(manifest), target))) violations.push(`Missing workspace import target: ${file} -> ${specifier}`);
      }
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && !resolveFile(view, path.posix.join(path.posix.dirname(file), specifier))) violations.push(`Missing relative import: ${file} -> ${specifier}`);
      if (!specifier.startsWith('.') && !specifier.startsWith('@ecomgen/') && !isBuiltin(specifier) && packageName(specifier) !== 'electron' && !resolvePackage(view, file, packageName(specifier))) violations.push(`Unresolved external module import: ${file} -> ${specifier}`);
    }
  }
  assertNoViolations(violations);
  return { compiledScripts: files.length, literalImports: imports, precision: 'AST literal imports/exports/require and EventSource constructors; computed imports are not statically proven' };
}

export function expectedCatalog(root) {
  const directory = path.join(root, 'packages/ecom-suite/src/suites');
  const files = fs.readdirSync(directory).filter((name) => /^\d{2,}-.+\.suite\.json$/.test(name)).sort();
  ensure(files.length > 0, 'No catalog source documents');
  const rows = files.map((file) => {
    const data = fs.readFileSync(path.join(directory, file), 'utf8');
    const document = JSON.parse(data);
    return { id: document.id.trim(), file, name: document.name.trim(), l1: document.category.l1, l2: document.category.l2, leaf: document.category.leaf, description: document.description?.trim() || null, hash: sha256(Buffer.from(data)), data };
  });
  ensure(new Set(rows.map((row) => row.id)).size === rows.length, 'Duplicate catalog source IDs');
  return { rows, totalHash: sha256(rows.map((row) => row.hash).join('\n')) };
}

export async function inspectCatalog(filename, expected) {
  const { DatabaseSync } = await import('node:sqlite');
  const header = Buffer.alloc(16);
  const descriptor = fs.openSync(filename, 'r');
  try { fs.readSync(descriptor, header, 0, 16, 0); } finally { fs.closeSync(descriptor); }
  ensure(header.equals(Buffer.from('SQLite format 3\0')), 'Catalog is not a SQLite database');
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    ensure(database.prepare('PRAGMA integrity_check').all().every((row) => Object.values(row)[0] === 'ok'), 'Catalog integrity check failed');
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    ensure(JSON.stringify(tables) === JSON.stringify(['meta', 'suites']), `Unexpected catalog tables: ${tables.join(', ')}`);
    const rows = database.prepare('SELECT id, file, name, l1, l2, leaf, description, hash, data FROM suites ORDER BY file').all();
    ensure(rows.length === expected.rows.length, `Catalog count ${rows.length} != expected ${expected.rows.length}`);
    for (let i = 0; i < rows.length; i++) for (const key of Object.keys(expected.rows[i])) ensure(rows[i][key] === expected.rows[i][key], `Catalog mismatch: ${expected.rows[i].file} column ${key}`);
    const meta = database.prepare('SELECT key, value FROM meta ORDER BY key').all();
    ensure(meta.length === 1 && meta[0].key === 'totalHash' && meta[0].value === expected.totalHash, 'Catalog totalHash mismatch or unexpected metadata');
    return { suites: rows.length, totalHash: expected.totalHash, fileSha256: sha256(fs.readFileSync(filename)), readonly: true };
  } finally { database.close(); }
}

function listFiles(directory, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    ensure(!entry.isSymbolicLink(), `Unexpected filesystem link: ${path.join(directory, entry.name)}`);
    if (entry.isDirectory()) result.push(...listFiles(path.join(directory, entry.name), relative));
    else result.push(relative);
  }
  return result;
}

function peIdentity(filename) {
  const descriptor = fs.openSync(filename, 'r');
  try {
    const header = Buffer.alloc(64);
    ensure(fs.readSync(descriptor, header, 0, 64, 0) === 64 && header.toString('ascii', 0, 2) === 'MZ', `Not a Windows executable (MZ header missing): ${filename}`);
    const pe = Buffer.alloc(24);
    ensure(fs.readSync(descriptor, pe, 0, 24, header.readUInt32LE(60)) === 24 && pe.toString('binary', 0, 4) === 'PE\0\0', `PE signature missing: ${filename}`);
    return { format: 'PE', machine: `0x${pe.readUInt16LE(4).toString(16)}` };
  } finally { fs.closeSync(descriptor); }
}

/** Follow literal local module edges without importing any packaged code. */
function reachableScripts(view, ts, filename) {
  const directory = path.posix.dirname(filename);
  const manifest = view.json(filename);
  // Native loaders are reached through CommonJS require, including sharp's own entry.
  const target = manifest.exports !== undefined
    ? requireExportTarget(manifest.exports?.['.'] ?? manifest.exports, filename)
    : manifest.main;
  const entry = target && (manifest.exports !== undefined
    ? literalPackageTarget(target, filename) : path.posix.join(directory, target));
  const pending = entry ? [manifest.exports !== undefined ? entry : resolveFile(view, entry)].filter((name) => name && view.exists(name)) : [];
  const scripts = new Map();
  while (pending.length) {
    const current = view.canonical(pending.pop());
    if (scripts.has(current) || !/\.(?:cjs|mjs|js)$/.test(current)) continue;
    ensure(scripts.size < 256, `Native loader traversal exceeds 256 scripts: ${filename}`);
    const source = view.read(current).toString('utf8');
    scripts.set(current, source);
    for (const specifier of scriptSpecifiers(ts, source, current).specs.filter((value) => value.startsWith('.'))) {
      const next = resolveFile(view, path.posix.join(path.posix.dirname(current), specifier));
      if (next && next.startsWith(`${directory}/`)) pending.push(next);
    }
  }
  return scripts;
}

/** Derive local candidates from supported require templates in the reachable loader. */
function sharpLocalCandidates(view, ts, loader, source, version, archive) {
  const parsed = ts.createSourceFile(loader, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const local = [];
  const wasm = [];
  const unsupported = () => `Unsupported sharp native loader local require: ${archive}/${loader}`;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const argument = node.arguments[0];
      if (argument && (ts.isTemplateExpression(argument) || ts.isStringLiteralLike(argument))) {
        const head = ts.isTemplateExpression(argument) ? argument.head.text : argument.text;
        if (head.startsWith('../src/build/')) {
          ensure(ts.isTemplateExpression(argument), unsupported());
          const expressions = argument.templateSpans.map((span) => span.expression.getText(parsed));
          const tails = argument.templateSpans.map((span) => span.literal.text);
          const platform = head === '../src/build/Release/sharp-' && expressions[0] === 'runtimePlatform';
          const versioned = expressions.length === 2 && expressions[1] === 'version' && tails[0] === '-' && tails[1] === '.node';
          const unversioned = expressions.length === 1 && tails[0] === '.node';
          const wasmVersioned = head === '../src/build/Release/sharp-wasm32-' && expressions.length === 1
            && expressions[0] === 'version' && tails[0] === '.node';
          ensure((platform && (versioned || unversioned)) || wasmVersioned, unsupported());
          const relative = wasmVersioned ? `${head}${version}.node`
            : `${head}win32-x64${versioned ? `-${version}` : ''}.node`;
          (wasmVersioned ? wasm : local).push(path.posix.join(path.posix.dirname(loader), relative));
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  // Multiple local platform attempts would require proving their control-flow order.
  ensure(local.length === 1, unsupported());
  return { local, wasm };
}

/** Only accept the observed CommonJS forwarding wrapper; imports alone cannot satisfy require. */
function sharpWrapperTarget(view, ts, wrapper, archive) {
  ensure(/\.(?:cjs|js)$/.test(wrapper) && !view.stat(wrapper).files, `Unsupported sharp addon wrapper: ${archive}/${wrapper}`);
  const parsed = ts.createSourceFile(wrapper, view.read(wrapper).toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const statements = parsed.statements.filter((statement) => !(ts.isExpressionStatement(statement)
    && ts.isStringLiteral(statement.expression) && statement.expression.text === 'use strict'));
  const assignment = statements.length === 1 && ts.isExpressionStatement(statements[0]) && statements[0].expression;
  const call = assignment && ts.isBinaryExpression(assignment) && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(assignment.left) && ts.isIdentifier(assignment.left.expression)
    && assignment.left.expression.text === 'module' && assignment.left.name.text === 'exports' && assignment.right;
  const argument = call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'require'
    && call.arguments.length === 1 && ts.isStringLiteralLike(call.arguments[0]) && call.arguments[0].text;
  ensure(argument && /^\.\/[^\n\\\\%?#:]+\.node$/.test(argument),
    `Unsupported sharp addon wrapper (expected module.exports = require with one literal local .node target): ${archive}/${wrapper}`);
  return path.posix.normalize(path.posix.join(path.posix.dirname(wrapper), argument));
}

/** Recognize supported package loaders; unknown layouts fail rather than guessing from addon names. */
export function inspectNativeResources(view, ts, archive) {
  const native = [...new Set(view.entries.filter((name) => /\.node$/i.test(name)).map(view.canonical))];
  const manifests = [...new Set(view.entries.filter((name) => name.endsWith('/package.json')).map(view.canonical))];
  const required = [];
  const inactive = new Map();
  for (const packageId of ['better-sqlite3', 'sharp']) {
    const packages = manifests.filter((filename) => view.json(filename).name === packageId);
    ensure(packages.length > 0, `Missing native runtime package: ${archive}/node_modules/${packageId}/package.json`);
    for (const filename of packages) {
      const directory = path.posix.dirname(filename);
      const scripts = reachableScripts(view, ts, filename);
      if (packageId === 'better-sqlite3') {
        const loader = `${directory}/lib/binding.js`;
        const source = scripts.get(loader) ?? '';
        // v13 selects the target prebuild first, then Debug, then Release. Only its
        // exact sibling prebuild paths qualify as inactive cross-platform resources.
        ensure(/getPrebuildPath\(\)/.test(source) && /require\(filename\)/.test(source)
          && /PREBUILD_PLATFORMS\s*=\s*\[\s*['"]linux['"]\s*,\s*['"]darwin['"]\s*,\s*['"]win32['"]\s*\]/.test(source)
          && /PREBUILD_ARCHS\s*=\s*\[\s*['"]x64['"]\s*,\s*['"]arm64['"]\s*\]/.test(source)
          && /PREBUILD_PLATFORMS\.includes\(process\.platform\)\s*&&\s*PREBUILD_ARCHS\.includes\(process\.arch\)/.test(source)
          && /const target\s*=\s*`\$\{isLinuxMusl\(\)\s*\?\s*['"]linuxmusl['"]\s*:\s*process\.platform\}-\$\{process\.arch\}`/.test(source)
          && /['"]prebuilds['"]\s*,\s*`\$\{target\}\.node`/.test(source)
          && /['"]build['"]\s*,\s*['"]Debug['"]\s*,\s*['"]better_sqlite3\.node['"]/.test(source)
          && /['"]build['"]\s*,\s*['"]Release['"]\s*,\s*['"]better_sqlite3\.node['"]/.test(source),
        `Unsupported SQLite native loader (expected reachable platform prebuild/Debug/Release selection): ${archive}/${loader}`);
        const candidates = [`${directory}/prebuilds/win32-x64.node`, `${directory}/build/Debug/better_sqlite3.node`, `${directory}/build/Release/better_sqlite3.node`];
        const selected = candidates.find((name) => view.exists(name));
        ensure(selected, `Missing Windows x64 SQLite runtime; loader ${archive}/${loader}; expected one of ${candidates.join(', ')}`);
        ensure(!view.stat(selected).files, `SQLite runtime path is a directory: ${archive}/${selected}`);
        required.push({ package: packageId, manifest: filename, loader, archivePath: view.canonical(selected), candidates });
        for (const name of native) {
          const relative = path.posix.relative(directory, name);
          if (/^prebuilds\/(?:(?:darwin|linux|linuxmusl)-(?:arm64|x64)|win32-arm64)\.node$/.test(relative)) {
            inactive.set(name, { archivePath: name, loader, target: path.posix.basename(name, '.node'), reason: 'Known better-sqlite3 platform prebuild not selected for win32-x64' });
          }
        }
      } else {
        const loader = [...scripts.keys()].find((name) => /\/(?:dist\/sharp\.cjs|lib\/sharp\.js)$/.test(name));
        const source = scripts.get(loader) ?? '';
        const platformSource = [...scripts.values()].find((text) => /const runtimePlatformArch\s*=\s*\(\)\s*=>\s*`\$\{process\.platform\}\$\{runtimeLibc\(\)\}-\$\{process\.arch\}`/.test(text));
        ensure(loader && platformSource && /runtimePlatformArch\(\)/.test(source)
          && (source.includes('@img/sharp-win32-x64/sharp.node') || source.includes('@img/sharp-${runtimePlatform}/sharp.node')),
        `Unsupported sharp native loader (expected reachable runtimePlatformArch and @img target): ${archive}/${filename}`);
        // A local build takes precedence in sharp's loader; validate it when present.
        const version = view.json(filename).version;
        ensure(typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version), `Unsupported sharp version: ${archive}/${filename}`);
        const { local, wasm } = sharpLocalCandidates(view, ts, loader, source, version, archive);
        let selected = local.find((name) => view.exists(name));
        ensure(selected || !wasm.some((name) => view.exists(name)), `Unsupported sharp local WASM fallback: ${archive}/${loader}`);
        let wrapper;
        if (!selected) {
          const platformManifest = resolvePackage(view, loader, '@img/sharp-win32-x64');
          ensure(platformManifest, `Missing Windows x64 sharp runtime: ${archive}/${loader} -> @img/sharp-win32-x64/package.json`);
          const manifest = view.json(platformManifest);
          ensure(manifest.name === '@img/sharp-win32-x64' && manifest.os?.includes('win32') && manifest.cpu?.includes('x64'), `Wrong sharp platform package identity/OS/CPU: ${archive}/${platformManifest}`);
          const target = requireExportTarget(manifest.exports?.['./sharp.node'], `${archive}/${platformManifest}`);
          ensure(target, `Missing sharp.node export for CommonJS require: ${archive}/${platformManifest}`);
          wrapper = literalPackageTarget(target, platformManifest);
          ensure(view.exists(wrapper) && !view.stat(wrapper).files, `Missing sharp platform export: ${archive}/${wrapper}`);
          const platformDirectory = `${path.posix.dirname(platformManifest)}/`;
          ensure(view.canonical(wrapper).startsWith(platformDirectory), `Sharp addon escapes its platform package: ${archive}/${wrapper}`);
          if (/\.node$/.test(wrapper)) selected = wrapper;
          else {
            ensure(!(/\.js$/.test(wrapper) && manifest.type === 'module'), `Unsupported sharp ES module require wrapper: ${archive}/${wrapper}`);
            selected = sharpWrapperTarget(view, ts, wrapper, archive);
          }
          ensure(view.canonical(selected).startsWith(platformDirectory), `Sharp addon escapes its platform package: ${archive}/${wrapper} -> ${selected}`);
        }
        ensure(view.exists(selected), `Missing Windows x64 sharp runtime: ${archive}/${selected} (loader ${loader})`);
        ensure(!view.stat(selected).files, `Sharp runtime path is a directory: ${archive}/${selected}`);
        required.push({ package: packageId, manifest: filename, loader, wrapper, archivePath: view.canonical(selected) });
      }
    }
  }
  // A selected runtime can never inherit an inactive prebuild exemption.
  for (const runtime of required) inactive.delete(runtime.archivePath);
  const files = [...new Set(view.entries.filter((name) => /\.node$/i.test(name) || /(?:^|\/)(?:sharp|@img)(?:\/|$)/.test(name))
    .filter((name) => !view.stat(name).files).map(view.canonical))];
  const violations = [];
  const validated = new Map();
  for (const name of files) {
    const physical = path.join(`${archive}.unpacked`, name);
    try {
      const stat = view.stat(name);
      ensure(stat.unpacked === true, `Native resource is packed: ${archive}/${name}`);
      ensure(fs.existsSync(physical), `Missing unpacked native resource: ${physical}`);
      const actual = fs.statSync(physical);
      ensure(actual.isFile() && actual.size === Number(stat.size) && actual.size > 0, `Missing or truncated unpacked native resource: ${physical} (expected ${stat.size} bytes, found ${actual.size})`);
      // Inactive foreign prebuilds still require intact unpacked resources; only
      // recognized platform siblings are exempt from the Windows x64 PE rule.
      const windowsSharpDll = /\.dll$/i.test(name) && /(?:^|\/)(?:sharp|@img\/sharp-win32-x64)\//.test(name);
      if ((/\.node$/i.test(name) && !inactive.has(name)) || windowsSharpDll) {
        const identity = peIdentity(physical);
        ensure(identity.machine === '0x8664', `Native binary is not Windows x64: ${physical} (machine ${identity.machine})`);
        validated.set(name, { physicalPath: physical, bytes: actual.size, ...identity });
      }
    } catch (error) { violations.push(error.message.includes(physical) ? error.message : `${physical}: ${error.message}`); }
  }
  for (const runtime of required) if (!validated.has(runtime.archivePath) && !violations.length) violations.push(`Required native runtime was not validated: ${archive}/${runtime.archivePath}`);
  assertNoViolations(violations);
  return { target: 'win32-x64', requiredRuntimeAddons: required.map((runtime) => ({ ...runtime, ...validated.get(runtime.archivePath) })), inactivePlatformPrebuilds: [...inactive.values()], nativeBinaries: native, unpackedFilesChecked: files.length, execution: 'not performed', limitation: 'Recognized loader patterns and literal local wrapper edges only; unknown layouts fail. Loader matching does not prove arbitrary control flow, configured nativeBinding overrides or computed imports. No packaged code executed; Electron ABI/DLL dependency loading not proven. Inactive prebuilds checked for unpacking/size, not foreign ABI validity' };
}

function signingStatus(filename) {
  if (process.platform !== 'win32') return { status: 'unverified', reason: 'Authenticode inspection requires Windows PowerShell' };
  const script = "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:ECOMGEN_VERIFY_INSTALLER; $v=(Get-Item -LiteralPath $env:ECOMGEN_VERIFY_INSTALLER).VersionInfo; [pscustomobject]@{status=[string]$s.Status;subject=$s.SignerCertificate.Subject;productName=$v.ProductName;productVersion=$v.ProductVersion;fileVersion=$v.FileVersion}|ConvertTo-Json -Compress";
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ECOMGEN_VERIFY_INSTALLER: filename }, encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (result.error || result.status !== 0) return { status: 'unverified', reason: result.error?.message ?? result.stderr.trim() };
  try {
    const detail = JSON.parse(result.stdout.replace(/^﻿/, '').trim());
    return { ...detail, authenticodeStatus: detail.status, status: detail.status === 'NotSigned' ? 'unsigned' : detail.status === 'Valid' ? 'signed' : 'unverified' };
  } catch (error) { return { status: 'unverified', reason: error.message }; }
}

export async function inspectRelease({ root = desktopRoot, releaseDir, expectedVersion, tooling } = {}) {
  const sourceApp = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'));
  const version = expectedVersion ?? sourceApp.version;
  ensure(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version), 'Invalid expected version');
  const release = path.resolve(releaseDir ?? path.join(root, 'release', version));
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'artifact-inspection-only', version, releaseDir: release, status: 'failed', checks: [], exclusions: ['GUI behavior', 'installer execution', 'installation', 'upgrade', 'native module execution under Electron ABI', 'real Provider calls', 'computed runtime import resolution'] };
  const check = async (id, callback) => {
    try { const details = await callback(); report.checks.push({ id, status: 'passed', details }); return details; }
    catch (error) { report.checks.push({ id, status: 'failed', error: `${id} (${release}): ${bounded(error.message)}` }); return undefined; }
  };
  const blocked = (id, reason) => report.checks.push({ id, status: 'blocked', error: reason });
  const tools = await check('inspection-tooling', () => { tooling ??= loadTooling(root); return { asar: '@electron/asar via electron-builder -> app-builder-lib', scripts: 'TypeScript AST', sqlite: 'node:sqlite readOnly', configuration: 'js-yaml safe data parsing' }; });
  let builderConfig;
  const identity = await check('release-configuration', () => {
    ensure(tools, 'Inspection tooling unavailable');
    builderConfig = tooling.yaml.load(fs.readFileSync(path.join(root, 'apps/desktop/electron-builder.yml'), 'utf8'));
    const expected = releaseIdentity(builderConfig, version, sourceApp);
    ensure(expected.appId === 'com.ecomgen.desktop', 'Application upgrade identity must remain com.ecomgen.desktop');
    ensure(builderConfig.nsis?.deleteAppDataOnUninstall === false, 'Uninstall must retain application data');
    ensure(sourceApp.productName === expected.productName, 'Source package productName differs from builder productName');
    return { ...expected, deleteAppDataOnUninstall: false };
  });
  const inputs = await check('required-inputs', () => {
    ensure(identity, 'Release configuration unavailable or invalid');
    const archive = path.join(release, 'win-unpacked/resources/app.asar');
    const resources = path.dirname(archive);
    const installer = path.join(release, identity.installerBasename);
    const executable = path.join(release, 'win-unpacked', identity.executableBasename);
    const missing = [archive, `${archive}.unpacked`, installer, executable].filter((name) => !fs.existsSync(name));
    ensure(missing.length === 0, `Missing/unbuilt inputs: ${missing.join(', ')}`);
    return { archive, resources, installer, executable };
  });
  let view;
  if (inputs && tools) await check('asar-readable', () => { view = archiveView(tooling.asar, inputs.archive); ensure(view.entries.length > 0, 'Empty ASAR'); return { entries: view.entries.length, bytes: fs.statSync(inputs.archive).size, sha256: sha256(fs.readFileSync(inputs.archive)) }; });
  else blocked('asar-readable', 'Required artifact inputs or inspection tooling unavailable');
  const archiveCheck = async (id, callback) => view ? check(id, callback) : blocked(id, 'ASAR unavailable');
  await archiveCheck('application-version', () => {
    const manifest = view.json('package.json');
    ensure(manifest.name === '@ecomgen/desktop' && manifest.version === version, `Expected @ecomgen/desktop ${version}; found ${manifest.name} ${manifest.version}`);
    ensure(manifest.main === 'out/main/index.js', `Unexpected main entry ${manifest.main}`);
    ensure(manifest.productName === identity.productName, `Packaged productName mismatch: ${manifest.productName}`);
    return { name: manifest.name, productName: manifest.productName, version: manifest.version, main: manifest.main };
  });
  await archiveCheck('brand-runtime-icon', () => {
    const icon = builderConfig.win?.icon;
    ensure(icon === 'build/icon.ico', 'Expected the shared runtime/Windows icon at build/icon.ico');
    ensure(builderConfig.nsis?.installerIcon === icon && builderConfig.nsis?.uninstallerIcon === icon, 'Installer and uninstaller must use the application icon');
    ensure(view.exists(icon) && !view.stat(icon).files, `Missing packaged runtime icon: ${icon}`);
    const source = fs.readFileSync(path.join(root, 'apps/desktop', icon));
    ensure(source.length >= 22 && source.readUInt16LE(0) === 0 && source.readUInt16LE(2) === 1 && source.readUInt16LE(4) > 0, 'Source icon is not an ICO');
    ensure(view.read(icon).equals(source), 'Packaged runtime icon differs from the build source');
    const executable = peIdentity(inputs.executable);
    ensure(executable.machine === '0x8664', `Application executable is not Windows x64: ${inputs.executable}`);
    return { archivePath: icon, bytes: source.length, sha256: sha256(source), executable, limitation: 'Runtime icon bytes verified; embedded EXE/installer icon appearance requires visual inspection' };
  });
  await archiveCheck('production-dependency-graph', () => {
    const { manifests, ...details } = inspectGraph(view);
    return { ...details, packages: [...manifests.entries()].map(([filename, manifest]) => ({ filename, name: manifest.name, version: manifest.version })) };
  });
  await archiveCheck('compiled-artifacts-and-imports', () => {
    const required = ['out/main/index.js', 'out/main/backend.js', 'out/preload/index.cjs', 'out/renderer/index.html'];
    ensure(required.every((name) => view.exists(name) && view.read(name).length > 0), 'Missing main/preload/renderer/Backend entry');
    const html = view.read('out/renderer/index.html').toString('utf8');
    const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]).filter((name) => name.startsWith('./') || name.startsWith('/assets/'));
    ensure(assets.some((name) => /\.js(?:$|\?)/.test(name)), 'Renderer HTML has no compiled JavaScript entry');
    ensure(assets.every((name) => view.exists(path.posix.join('out/renderer', name.replace(/^\//, '').split('?')[0]))), 'Renderer HTML references missing assets');
    ensure(view.read('out/main/backend.js').includes(Buffer.from('@ecomgen/backend')), 'Backend utility entry does not reference @ecomgen/backend');
    return { required, rendererAssets: assets, ...inspectScripts(view, tooling.ts) };
  });
  await archiveCheck('unpacked-native-resources', () => inspectNativeResources(view, tooling.ts, inputs.archive));
  await archiveCheck('builtin-sqlite-catalog', async () => {
    const candidates = view.entries.filter((name) => name.endsWith('/builtin-suites.db'));
    ensure(candidates.length === 1 && candidates[0].endsWith('/@ecomgen/ecom-suite/dist/builtin-suites.db'), `Expected one canonical built-in catalog; found ${candidates.length}`);
    const name = candidates[0];
    ensure(view.stat(name).unpacked === true, 'Catalog is not unpacked');
    const filename = path.join(`${inputs.archive}.unpacked`, view.canonical(name));
    ensure(fs.statSync(filename).size === Number(view.stat(name).size), 'Unpacked catalog size differs from ASAR metadata');
    return { archivePath: name, ...await inspectCatalog(filename, expectedCatalog(root)) };
  });
  await archiveCheck('packaged-data-hygiene', () => {
    const violations = [];
    for (const name of view.entries) { const reason = contaminationReason(name); if (reason) violations.push(`${reason}: app.asar/${name}`); }
    const physical = listFiles(path.join(release, 'win-unpacked'));
    for (const name of physical) {
      const normalized = name.replace(/^resources\/app\.asar\.unpacked\//, '');
      const reason = contaminationReason(normalized);
      if (reason) violations.push(`${reason}: win-unpacked/${name}`);
      if (name.startsWith('resources/app.asar.unpacked/')) ensure(view.exists(normalized) && view.stat(normalized).unpacked === true, `Unexpected orphan unpacked file: ${name}`);
    }
    assertNoViolations(violations);
    return { archiveEntriesChecked: view.entries.length, physicalFilesChecked: physical.length, allowedDatabase: '@ecomgen/ecom-suite/dist/builtin-suites.db', mediaPolicy: 'Compiled renderer assets allowed; user media elsewhere rejected', limitation: 'Path/type inspection cannot establish the provenance of arbitrary bytes disguised as legitimate compiled assets' };
  });
  await check('own-license-removal', () => {
    const sourcePaths = removedLicenses.map((name) => path.join(root, 'packages', name, 'LICENSE'));
    ensure(sourcePaths.every((name) => !fs.existsSync(name)), `Removed project LICENSE returned: ${sourcePaths.filter((name) => fs.existsSync(name)).join(', ')}`);
    ensure(view, 'ASAR unavailable; packaged licenses and metadata cannot be verified');
    const ownManifests = ['package.json', ...view.entries.filter((name) => /(?:^|\/)node_modules\/@ecomgen\/[^/]+\/package\.json$/.test(name))];
    for (const name of ownManifests) {
      const manifest = view.json(name);
      const license = JSON.stringify([manifest.license, manifest.licenses]);
      ensure(!/\bMIT\b/i.test(license), `Own MIT metadata returned: ${name}`);
    }
    const ownLicenses = view.entries.filter((name) => /(?:^|\/)node_modules\/@ecomgen\/[^/]+\/LICENSE(?:\.[^/]*)?$/i.test(name));
    ensure(ownLicenses.length === 0, `Own LICENSE files returned: ${ownLicenses.join(', ')}`);
    return { removedSourceLicensePaths: sourcePaths, ownPackageManifestsChecked: ownManifests.length, thirdPartyNotices: 'preserved; not rejected or removed' };
  });
  if (inputs) await check('installer-identity', async () => {
    const bytes = fs.statSync(inputs.installer).size;
    ensure(bytes > 0, 'Installer is empty');
    const installerIdentity = peIdentity(inputs.installer);
    const hash = createHash('sha256');
    const nsisSignature = Buffer.from([0xef, 0xbe, 0xad, 0xde, ...Buffer.from('NullsoftInst')]);
    let tail = Buffer.alloc(0);
    let nsis = false;
    for await (const chunk of fs.createReadStream(inputs.installer)) {
      hash.update(chunk);
      const window = Buffer.concat([tail, chunk]);
      nsis ||= window.includes(nsisSignature);
      tail = window.subarray(-nsisSignature.length + 1);
    }
    ensure(nsis, 'Installer is not identifiable as NSIS (NullsoftInst header missing)');
    const signing = signingStatus(inputs.installer);
    if (signing.productName) ensure(signing.productName === identity.productName, `Installer product name mismatch: ${signing.productName}`);
    if (signing.productVersion) ensure(signing.productVersion === version || signing.productVersion === `${version}.0`, `Installer product version mismatch: ${signing.productVersion}`);
    return { filename: inputs.installer, expectedBasename: identity.installerBasename, expectedProductName: identity.productName, bytes, sha256: hash.digest('hex'), ...installerIdentity, installerFormat: 'NSIS', signing, identityLimit: 'Filename, PE/NSIS signatures and available version metadata; installer payload not executed or extracted' };
  });
  else blocked('installer-identity', 'Installer or other required release inputs missing');
  report.status = report.checks.every((item) => item.status === 'passed') ? 'passed' : 'failed';
  return report;
}

export function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = { '--release-dir': 'releaseDir', '--output': 'output', '--expected-version': 'expectedVersion' }[args[i]];
    if (args[i] === '--help') return { help: true };
    ensure(key && args[i + 1] && !args[i + 1].startsWith('--'), `Unknown option or missing value: ${args[i]}`);
    ensure(!Object.hasOwn(result, key), `Duplicate option: ${args[i]}`);
    result[key] = args[++i];
  }
  ensure(result.output, '--output is required');
  return result;
}

export async function main(args = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(args); }
  catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
  if (options.help) {
    process.stdout.write('Usage: node desktop/scripts/verify-release.mjs --output <report.json> [--release-dir <directory>] [--expected-version <version>]\nDefault release: desktop/release/<current app package version>. Artifact names come from apps/desktop/electron-builder.yml. Artifact inspection only; does not run the app or installer.\n');
    return 0;
  }
  const output = path.resolve(options.output);
  const release = path.resolve(options.releaseDir ?? path.join(desktopRoot, 'release', options.expectedVersion ?? JSON.parse(fs.readFileSync(path.join(desktopRoot, 'apps/desktop/package.json'), 'utf8')).version));
  try {
    ensure(output.endsWith('.json'), '--output must name a JSON file');
    ensure(output !== release && !output.startsWith(`${release}${path.sep}`), '--output must be outside the inspected release directory');
    ensure(!fs.existsSync(output), '--output already exists; choose a new report path');
    let report;
    try { report = await inspectRelease(options); }
    catch (error) { report = { schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'artifact-inspection-only', status: 'failed', checks: [{ id: 'inspection-startup', status: 'failed', error: error.message }] }; }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${report.status}: ${output}\n`);
    return report.status === 'passed' ? 0 : 1;
  } catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
