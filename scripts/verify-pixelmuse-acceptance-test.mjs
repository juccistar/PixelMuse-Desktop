import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { captureRuntimeIdentity, fingerprintRuntime, hashPhysicalFile } from './pixelmuse-runtime-identity.mjs';
import { verifyAcceptance, requiredNewScenarios, requiredSettingsScenarios } from './verify-pixelmuse-acceptance.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function put(filename, value) {
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, typeof value === 'string' ? value : JSON.stringify(value));
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pixelmuse-verifier-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const appRoot = join(root, 'apps/desktop');
  const workspace = join(appRoot, 'node_modules/@ecomgen');
  await put(join(appRoot, 'package.json'), { name: '@ecomgen/desktop', version: '0.4.0', dependencies: { '@ecomgen/backend': 'workspace:*' } });
  for (const [name, text] of Object.entries({ 'main/index.js': 'compiled main', 'main/backend.js': 'compiled backend', 'preload/index.cjs': 'compiled preload', 'renderer/index.html': 'compiled html', 'renderer/assets/app.js': 'compiled renderer' }))
    await put(join(appRoot, 'out', name), text);
  await put(join(workspace, 'backend/package.json'), { name: '@ecomgen/backend', dependencies: { '@ecomgen/contracts': 'workspace:*' }, exports: { '.': { import: './dist/index.js' } } });
  await put(join(workspace, 'backend/dist/index.js'), 'compiled backend package');
  // This dependency is only reachable through backend and only resolves from its
  // own nested node_modules. Flat app-only enumeration would silently miss it.
  const nested = join(workspace, 'backend/node_modules/@ecomgen/contracts');
  await put(join(nested, 'package.json'), { name: '@ecomgen/contracts', dependencies: { '@ecomgen/backend': 'workspace:*' }, main: './dist/index.js' });
  await put(join(nested, 'dist/index.js'), 'compiled transitive contract');
  await put(join(nested, 'dist/index.d.ts'), 'declaration not runtime');
  await put(join(nested, 'dist/index.js.map'), 'private source paths not runtime');
  const expected = fingerprintRuntime(appRoot);
  assert.ok(expected.files.some(row => row.key === '@ecomgen/contracts/dist/index.js'));
  const releaseDir = join(root, 'release/0.4.0');
  const archive = join(releaseDir, 'win-unpacked/resources/app.asar');
  const executable = join(releaseDir, 'win-unpacked/PixelMuse.exe');
  const installer = join(releaseDir, 'PixelMuse-0.4.0-x64-Setup.exe');
  await put(archive, 'fixture physical ASAR'); await put(executable, 'fixture physical EXE'); await put(installer, 'fixture installer');
  const archiveHash = await hashPhysicalFile(archive), exeHash = await hashPhysicalFile(executable);
  const options = { '--source-app-root': appRoot, '--release-report': join(root, 'release-report.json'), '--payload-report': join(root, 'payload.json'), '--output': join(root, 'acceptance.json') };
  const docs = new Map();
  const cleanup = { status: 'passed', temporaryUserDataRemoved: true, errors: [] };
  for (const [flag, mode, full] of [['--source-dir', 'source', true], ['--exe-dir', 'exe', true], ['--source-pixelmuse-dir', 'source', false], ['--exe-pixelmuse-dir', 'exe', false], ['--source-settings-dir', 'source', false], ['--exe-settings-dir', 'exe', false]]) {
    const settings = flag.includes('settings');
    options[flag] = join(root, flag.slice(2));
    const runtimeIdentity = { runId: randomUUID(), mode, version: '0.4.0', packaged: mode === 'exe', ...structuredClone(expected),
      ...(mode === 'exe' ? { archive: { path: archive, sha256: archiveHash }, executable: { path: executable, sha256: exeHash } } : {}) };
    const scenarios = (full ? Array.from({ length: 64 }, (_, i) => `old-${i}`) : settings ? requiredSettingsScenarios : requiredNewScenarios).map(id => ({ id, status: 'passed', assertions: 1 }));
    const result = { runId: runtimeIdentity.runId, integration: 'passed', runtimeIdentity, cleanup: structuredClone(cleanup), scenarios,
      globalChecks: full || settings ? { rendererErrors: 0, fixtureCallbackErrors: 0 } : { rendererErrors: 0 },
      ...(full ? { summary: { complete: true, counts: { passed: 64, failed: 0, blocked: 0 }, missingJobTypes: [], operationGaps: [] } } : {}) };
    docs.set(join(options[flag], full || settings ? 'result.json' : 'pixelmuse-result.json'), result);
    if (full) docs.set(join(options[flag], 'coverage.json'), { runId: runtimeIdentity.runId, runtimeIdentity: structuredClone(runtimeIdentity), integration: 'passed', completion: true,
      scenarios: structuredClone(scenarios), operations: Array.from({ length: 131 }, (_, i) => ({ original: `operation-${i}`, status: 'passed' })),
      features: Array.from({ length: 29 }, (_, i) => ({ id: `feature-${i}`, status: 'passed' })) });
  }
  const checks = [
    { id: 'required-inputs', status: 'passed', details: { archive, executable, installer } },
    { id: 'asar-readable', status: 'passed', details: { bytes: Buffer.byteLength('fixture physical ASAR'), sha256: archiveHash } },
    { id: 'installer-identity', status: 'passed', details: { bytes: Buffer.byteLength('fixture installer'), sha256: await hashPhysicalFile(installer) } },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `other-${i}`, status: 'passed', details: {} })),
  ];
  docs.set(options['--release-report'], { version: '0.4.0', status: 'passed', releaseDir, checks });
  docs.set(options['--payload-report'], { status: 'passed', installer, installerSha256: await hashPhysicalFile(installer), unpacked: dirname(executable), files: 2, runtimeExtras: [],
    matched: [{ path: 'resources/app.asar', sha256: archiveHash }, { path: 'PixelMuse.exe', sha256: exeHash }] });
  const result = flag => docs.get(join(options[flag], flag.includes('pixelmuse') ? 'pixelmuse-result.json' : 'result.json'));
  const coverage = flag => docs.get(join(options[flag], 'coverage.json'));
  const save = async () => { for (const [filename, data] of docs) await put(filename, data); };
  return { root, appRoot, nested, archive, executable, installer, options, docs, result, coverage, save, expected,
    payload: docs.get(options['--payload-report']), release: docs.get(options['--release-report']) };
}

test('valid fixture passes all six independent runs through actual CLI', async t => {
  const f = await fixture(t); await f.save();
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./verify-pixelmuse-acceptance.mjs', import.meta.url)), ...Object.entries(f.options).flat()], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(await readFile(f.options['--output'], 'utf8'));
  assert.equal(report.status, 'passed'); assert.equal(report.runs.length, 6);
  assert.equal(new Set(report.runs.map(row => row.runtimeIdentity.runId)).size, 6);
  assert.equal(report.runtimeHash, f.expected.runtimeHash);
});

const mutations = [
  ['duplicate source and EXE directory', f => { f.options['--exe-dir'] = f.options['--source-dir']; }, /Duplicate run directories/],
  ['copied historical run IDs', f => { const id = f.result('--source-dir').runtimeIdentity.runId; f.result('--source-pixelmuse-dir').runtimeIdentity.runId = id; f.result('--source-pixelmuse-dir').runId = id; }, /Duplicate runtime runId/],
  ['historical report without runtime identity', f => { delete f.result('--source-dir').runtimeIdentity; }, /Missing runtimeIdentity/],
  ['source report relabeled as EXE', f => { f.result('--exe-dir').runtimeIdentity.mode = 'source'; }, /mode mismatch/],
  ['EXE report from unpackaged Electron', f => { f.result('--exe-dir').runtimeIdentity.packaged = false; }, /packaged state mismatch/],
  ['old actual runtime version', f => { f.result('--source-dir').runtimeIdentity.version = '0.3.0'; }, /runtime version mismatch/],
  ['historical common fingerprint on all six reports', f => { for (const flag of ['--source-dir', '--exe-dir', '--source-pixelmuse-dir', '--exe-pixelmuse-dir', '--source-settings-dir', '--exe-settings-dir']) { const i = f.result(flag).runtimeIdentity; i.files[0].sha256 = 'a'.repeat(64); i.runtimeHash = hash(JSON.stringify(i.files)); } }, /differs from current compiled source/],
  ['settings directory reuses source run', f => { f.options['--source-settings-dir'] = f.options['--source-dir']; }, /Duplicate run directories/],
  ['settings evidence missing pricing and responsive UI', f => { f.result('--source-settings-dir').scenarios = f.result('--source-settings-dir').scenarios.filter(row => row.id !== 'settings-pages-pricing-ui'); }, /scenario count/],
  ['settings replaced by unrelated successful scenario', f => { f.result('--exe-settings-dir').scenarios[0].id = 'unrelated-settings'; }, /exact settings scenario set/],
  ['settings runtime copied from other observation', f => { const id = f.result('--source-dir').runtimeIdentity.runId; f.result('--source-settings-dir').runtimeIdentity.runId = id; f.result('--source-settings-dir').runId = id; }, /Duplicate runtime runId/],
  ['settings renderer errors', f => { f.result('--exe-settings-dir').globalChecks.rendererErrors = 1; }, /Renderer or fixture errors/],
  ['settings cleanup failure', f => { f.result('--source-settings-dir').cleanupErrors = ['fixture not removed']; }, /Cleanup errors/],
  ['tampered runtime hash', f => { f.result('--source-dir').runtimeIdentity.runtimeHash = 'a'.repeat(64); }, /internally inconsistent/],
  ['coverage from different run', f => { f.coverage('--source-dir').runtimeIdentity.runId = randomUUID(); }, /Coverage runtimeIdentity/],
  ['runtime changed on later launch', f => { f.result('--source-dir').runtimeIdentityError = 'Runtime identity changed between launches'; }, /Runtime changed/],
  ['missing responsive scenario', f => { f.result('--source-pixelmuse-dir').scenarios = f.result('--source-pixelmuse-dir').scenarios.filter(row => row.id !== 'pixelmuse-responsive-ui'); }, /scenario count/],
  ['missing manual collection scenario replaced by unrelated row', f => { f.result('--source-pixelmuse-dir').scenarios.find(row => row.id === 'pixelmuse-collection-manual').id = 'unrelated'; }, /exact new scenario set/],
  ['missing main close scenario replaced by duplicate', f => { const rows = f.result('--exe-pixelmuse-dir').scenarios; rows.find(row => row.id === 'pixelmuse-main-close').id = rows[0].id; }, /duplicate id/],
  ['extra scenario', f => { f.result('--exe-pixelmuse-dir').scenarios.push({ id: 'extra', status: 'passed', assertions: 1 }); }, /scenario count/],
  ['new scenario without behavior assertion', f => { f.result('--exe-pixelmuse-dir').scenarios[0].assertions = 0; }, /scenario not passed/],
  ['old summary hides a blocked scenario', f => { f.result('--source-dir').scenarios[0].status = 'blocked'; }, /scenario not passed/],
  ['duplicate old operation evidence', f => { const rows = f.coverage('--source-dir').operations; rows[1].original = rows[0].original; }, /duplicate original/],
  ['cleanup error hidden behind passed flag', f => { f.result('--exe-pixelmuse-dir').cleanup.errors.push('cleanup failure'); }, /Cleanup errors/],
  ['renderer error hidden behind passed flag', f => { f.result('--exe-pixelmuse-dir').globalChecks.rendererErrors = 1; }, /Renderer errors/],
  ['stale actual ASAR hash', f => { f.result('--exe-dir').runtimeIdentity.archive.sha256 = 'a'.repeat(64); f.coverage('--exe-dir').runtimeIdentity.archive.sha256 = 'a'.repeat(64); }, /Runtime ASAR differs/],
  ['stale actual EXE hash', f => { f.result('--exe-pixelmuse-dir').runtimeIdentity.executable.sha256 = 'a'.repeat(64); }, /Runtime EXE differs/],
  ['mismatched installer payload ASAR', f => { f.payload.matched[0].sha256 = 'a'.repeat(64); }, /Installer payload ASAR differs/],
  ['mismatched installer payload EXE', f => { f.payload.matched[1].sha256 = 'a'.repeat(64); }, /Installer payload EXE differs/],
  ['missing installer payload matched evidence', f => { f.payload.matched = []; }, /Installer payload ASAR differs/],
  ['case alias duplicate installer payload entry', f => { f.payload.matched.push({ ...f.payload.matched[0], path: 'Resources/APP.ASAR' }); }, /Duplicate payload matched path/],
  ['installer changed after payload inspection', f => { f.payload.installerSha256 = 'a'.repeat(64); }, /strictly equal/],
  ['unapproved unpacked file extra', f => { f.payload.runtimeExtras = ['credentials.json']; }, /assertion|false|falsy/i],
];
for (const [name, mutate, expectedError] of mutations) test(`rejects ${name}`, async t => {
  const f = await fixture(t); mutate(f); await f.save();
  await assert.rejects(verifyAcceptance(f.options), expectedError);
});

test('rejects directory aliases pointing to one physical run', async t => {
  const f = await fixture(t); await f.save();
  const alias = join(f.root, 'run-alias');
  await symlink(f.options['--source-dir'], alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.options['--exe-dir'] = alias;
  await assert.rejects(verifyAcceptance(f.options), /Duplicate run directories/);
});
test('compiled transitive dependency edit invalidates every historical report', async t => {
  const f = await fixture(t); await f.save();
  await put(join(f.nested, 'dist/index.js'), 'newly compiled contract');
  await assert.rejects(verifyAcceptance(f.options), /differs from current compiled source/);
});
test('compiled app edit invalidates historical report', async t => {
  const f = await fixture(t); await f.save();
  await put(join(f.appRoot, 'out/renderer/assets/app.js'), 'new renderer');
  await assert.rejects(verifyAcceptance(f.options), /differs from current compiled source/);
});
test('physical release file change invalidates release report', async t => {
  const f = await fixture(t); await f.save(); await put(f.archive, 'replacement ASAR bytes');
  await assert.rejects(verifyAcceptance(f.options));
});
test('fingerprint handles cyclic BFS, nested import-only packages and excludes declarations/maps', async t => {
  const f = await fixture(t);
  assert.equal(f.expected.files.filter(row => row.key.startsWith('@ecomgen/contracts/')).length, 1);
  assert.deepEqual(fingerprintRuntime(f.appRoot), f.expected);
  await put(join(f.nested, 'dist/index.d.ts'), 'changed types');
  assert.deepEqual(fingerprintRuntime(f.appRoot), f.expected);
  await put(join(f.nested, 'dist/.env'), 'must never appear in evidence');
  assert.throws(() => fingerprintRuntime(f.appRoot), /Private file/);
});
test('fingerprint rejects private JSON and links to user profiles', async t => {
  const f = await fixture(t);
  const privateFile = join(f.nested, 'dist/credentials.json');
  await put(privateFile, 'private credential canary');
  assert.throws(() => fingerprintRuntime(f.appRoot), /Private file/);
  await rm(privateFile);
  const profile = join(f.root, 'profile');
  await put(join(profile, 'user.db'), 'private database canary');
  await symlink(profile, join(f.nested, 'dist/linked-profile'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => fingerprintRuntime(f.appRoot), /filesystem links/);
});
test('capture evaluates collector in owned inspector and validates actual packaged mode', async t => {
  const f = await fixture(t); const runId = randomUUID();
  const app = { evaluate: async (fn, input) => runInNewContext(`(${fn.toString()})(electron, input)`, {
    electron: { app: { getAppPath: () => f.appRoot, getVersion: () => '0.4.0', isPackaged: false } },
    process: { execPath: process.execPath }, require: createRequire(join(f.appRoot, 'package.json')), input,
  }) };
  const identity = await captureRuntimeIdentity(app, { mode: 'source', runId });
  assert.deepEqual(JSON.parse(JSON.stringify(identity)), { runId, mode: 'source', version: '0.4.0', packaged: false, ...f.expected });
  await assert.rejects(captureRuntimeIdentity(app, { mode: 'exe', runId }), /Actual Electron mode/);
});
test('packaged capture streams physical ASAR and EXE using inspector-provided paths', async t => {
  const f = await fixture(t); const runId = randomUUID();
  const app = { evaluate: async () => ({ version: '0.4.0', packaged: true, appPath: f.archive, execPath: f.executable, ...f.expected }) };
  const identity = await captureRuntimeIdentity(app, { mode: 'exe', runId });
  assert.equal(identity.archive.sha256, hash('fixture physical ASAR'));
  assert.equal(identity.executable.sha256, hash('fixture physical EXE'));
  await put(f.executable, 'changed EXE');
  const changed = await captureRuntimeIdentity(app, { mode: 'exe', runId });
  assert.notDeepEqual(changed, identity);
});
