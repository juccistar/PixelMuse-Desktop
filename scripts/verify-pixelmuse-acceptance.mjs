import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintRuntime, hashPhysicalFile } from './pixelmuse-runtime-identity.mjs';

const defaultAppRoot = fileURLToPath(new URL('../apps/desktop', import.meta.url));
const runFlags = ['--source-dir', '--exe-dir', '--source-pixelmuse-dir', '--exe-pixelmuse-dir', '--source-settings-dir', '--exe-settings-dir'];
const requiredFlags = [...runFlags, '--release-report', '--payload-report', '--output'];
/** 设置中心的发布验收必须包含原生边界、模型配置、持久偏好、用量和实际页面操作。 */
export const requiredSettingsScenarios = ['settings-native-boundary', 'settings-model-ui', 'settings-scale-startup', 'settings-usage-notifications', 'settings-pages-pricing-ui'];
/** 新功能验收必须完整覆盖的场景集合。 */
export const requiredNewScenarios = [
  'pixelmuse-0.3-seed', 'pixelmuse-brand-seed', 'pixelmuse-responsive-ui',
  'pixelmuse-workspace-cancel', 'pixelmuse-workspace-busy', 'pixelmuse-workspace-output',
  'pixelmuse-workspace-relocate', 'pixelmuse-canvas-archive', 'pixelmuse-workspace-restart',
  'pixelmuse-collection-import', 'pixelmuse-collection-isolation', 'pixelmuse-collection-manual',
  'pixelmuse-collection-sources-restart', 'pixelmuse-main-close',
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha = /^[0-9a-f]{64}$/;
function unique(rows, key, label) {
  assert.ok(Array.isArray(rows), `${label}: expected array`);
  const ids = rows.map(row => row[key]);
  assert.ok(ids.every(id => typeof id === 'string' && id.length > 0), `${label}: missing identity`);
  assert.equal(new Set(ids).size, ids.length, `${label}: duplicate ${key}`);
}
function scenariosPassed(rows, count, label) {
  unique(rows, 'id', label);
  assert.equal(rows.length, count, `${label}: scenario count`);
  assert.ok(rows.every(row => row.status === 'passed' && Number.isSafeInteger(row.assertions) && row.assertions > 0), `${label}: scenario not passed`);
}
async function canonical(filename) {
  const actual = await realpath(filename);
  return process.platform === 'win32' ? actual.toLowerCase() : actual;
}
async function sameFile(actual, expected, label) {
  assert.equal(typeof actual, 'string', `${label}: missing path`);
  assert.equal(await canonical(actual), await canonical(expected), `${label}: wrong physical path`);
}
function commonIdentity(identity, expected, mode) {
  assert.ok(identity && typeof identity === 'object', 'Missing runtimeIdentity');
  assert.match(identity.runId, uuid, 'Invalid runtime runId');
  assert.equal(identity.mode, mode, 'Actual runtime mode mismatch');
  assert.equal(identity.packaged, mode === 'exe', 'Actual packaged state mismatch');
  assert.equal(identity.version, '0.4.0', 'Actual runtime version mismatch');
  unique(identity.files, 'key', 'runtime files');
  assert.ok(identity.files.every(row => sha.test(row.sha256)), 'Invalid runtime file hash');
  assert.equal(identity.runtimeHash, hash(JSON.stringify(identity.files)), 'Runtime fingerprint is internally inconsistent');
  assert.equal(identity.runtimeHash, expected.runtimeHash, 'Runtime fingerprint differs from current compiled source');
  assert.deepEqual(identity.files, expected.files, 'Runtime file set differs from current compiled source');
  if (mode === 'source') {
    assert.equal(identity.archive, undefined, 'Source runtime must not claim packaged archive');
    assert.equal(identity.executable, undefined, 'Source runtime must not claim packaged executable');
  }
}

/** 汇总真实运行与当前发布产物；任一证据不一致均拒绝验收。 */
export async function verifyAcceptance(options) {
  const sourceAppRoot = resolve(options['--source-app-root'] ?? defaultAppRoot);
  const desktopRoot = resolve(sourceAppRoot, '../..');
  const releaseDir = join(desktopRoot, 'release/0.4.0');
  const expectedPaths = {
    archive: join(releaseDir, 'win-unpacked/resources/app.asar'),
    executable: join(releaseDir, 'win-unpacked/PixelMuse.exe'),
    installer: join(releaseDir, 'PixelMuse-0.4.0-x64-Setup.exe'),
  };
  const sourcePackage = JSON.parse(await readFile(join(sourceAppRoot, 'package.json'), 'utf8'));
  assert.equal(sourcePackage.name, '@ecomgen/desktop');
  assert.equal(sourcePackage.version, '0.4.0');
  const expected = fingerprintRuntime(sourceAppRoot);
  const evidence = [];
  async function json(filename) {
    const bytes = await readFile(filename);
    evidence.push({ file: filename, sha256: hash(bytes) });
    return JSON.parse(bytes.toString('utf8'));
  }
  const directories = await Promise.all(runFlags.map(flag => canonical(options[flag])));
  assert.equal(new Set(directories).size, runFlags.length, 'Duplicate run directories (including filesystem aliases)');
  const runs = [], runIds = new Set(), identities = [];
  function acceptIdentity(result, mode) {
    assert.equal(result.runtimeIdentityError, undefined, 'Runtime changed or capture failed');
    const identity = result.runtimeIdentity;
    commonIdentity(identity, expected, mode);
    const normalized = identity.runId.toLowerCase();
    assert.ok(!runIds.has(normalized), 'Duplicate runtime runId');
    runIds.add(normalized);
    if (result.runId !== undefined) assert.equal(result.runId, identity.runId, 'Result runId differs from runtimeIdentity');
    identities.push(identity);
    return identity;
  }
  for (const key of ['--source-dir', '--exe-dir']) {
    const result = await json(join(options[key], 'result.json'));
    const coverage = await json(join(options[key], 'coverage.json'));
    const runtimeIdentity = acceptIdentity(result, key === '--source-dir' ? 'source' : 'exe');
    assert.deepEqual(coverage.runtimeIdentity, runtimeIdentity, 'Coverage runtimeIdentity differs from result');
    assert.equal(coverage.runId, runtimeIdentity.runId, 'Coverage runId differs from result');
    assert.equal(result.integration, 'passed', key);
    assert.equal(result.summary.complete, true, key);
    assert.deepEqual(result.summary.counts, { passed: 64, failed: 0, blocked: 0 }, key);
    assert.deepEqual(result.summary.missingJobTypes, [], key);
    assert.deepEqual(result.summary.operationGaps, [], key);
    assert.deepEqual(result.globalChecks, { rendererErrors: 0, fixtureCallbackErrors: 0 }, key);
    assert.equal(result.cleanup.status, 'passed', key);
    assert.equal(result.cleanup.temporaryUserDataRemoved, true, key);
    assert.deepEqual(result.cleanup.errors, [], `${key}: Cleanup errors`);
    scenariosPassed(result.scenarios, 64, key);
    assert.equal(coverage.completion, true, key);
    assert.equal(coverage.integration, 'passed', key);
    assert.deepEqual(coverage.scenarios, result.scenarios, 'Coverage scenarios differ from result');
    assert.equal(coverage.operations.length, 131, key);
    assert.equal(coverage.features.length, 29, key);
    unique(coverage.operations, 'original', 'coverage operations');
    unique(coverage.features, 'id', 'coverage features');
    assert.ok(coverage.operations.every(row => row.status === 'passed'), key);
    assert.ok(coverage.features.every(row => row.status === 'passed'), key);
    assert.ok(!coverage.error && !result.error, 'Run contains a fatal error');
    runs.push({ kind: key.slice(2), runtimeIdentity, summary: result.summary, cleanup: result.cleanup, globalChecks: result.globalChecks });
  }
  for (const key of ['--source-pixelmuse-dir', '--exe-pixelmuse-dir']) {
    const result = await json(join(options[key], 'pixelmuse-result.json'));
    const runtimeIdentity = acceptIdentity(result, key === '--source-pixelmuse-dir' ? 'source' : 'exe');
    assert.equal(result.integration, 'passed', key);
    assert.equal(result.cleanup.status, 'passed', key);
    assert.equal(result.cleanup.temporaryUserDataRemoved, true, key);
    assert.deepEqual(result.cleanup.errors, [], `${key}: Cleanup errors`);
    assert.equal(result.globalChecks.rendererErrors, 0, `${key}: Renderer errors`);
    if (result.globalChecks.fixtureCallbackErrors !== undefined) assert.equal(result.globalChecks.fixtureCallbackErrors, 0, key);
    assert.ok(!result.error, 'Run contains a fatal error');
    scenariosPassed(result.scenarios, requiredNewScenarios.length, key);
    assert.deepEqual(result.scenarios.map(row => row.id).sort(), [...requiredNewScenarios].sort(), `${key}: exact new scenario set`);
    runs.push({ kind: key.slice(2), runtimeIdentity, scenarios: result.scenarios.map(({ id, status, assertions }) => ({ id, status, assertions })), cleanup: result.cleanup, globalChecks: result.globalChecks });
  }
  for (const key of ['--source-settings-dir', '--exe-settings-dir']) {
    const result = await json(join(options[key], 'result.json'));
    const runtimeIdentity = acceptIdentity(result, key === '--source-settings-dir' ? 'source' : 'exe');
    assert.equal(result.integration, 'passed', key);
    assert.equal(result.cleanup.status, 'passed', key);
    assert.equal(result.cleanup.temporaryUserDataRemoved, true, key);
    assert.deepEqual(result.cleanup.errors, [], `${key}: Cleanup errors`);
    assert.deepEqual(result.cleanupErrors ?? [], [], `${key}: Cleanup errors`);
    assert.deepEqual(result.globalChecks, { rendererErrors: 0, fixtureCallbackErrors: 0 }, `${key}: Renderer or fixture errors`);
    assert.ok(!result.error, 'Settings run contains a fatal error');
    scenariosPassed(result.scenarios, requiredSettingsScenarios.length, key);
    assert.deepEqual(result.scenarios.map(row => row.id).sort(), [...requiredSettingsScenarios].sort(), `${key}: exact settings scenario set`);
    runs.push({ kind: key.slice(2), runtimeIdentity, scenarios: result.scenarios.map(({ id, status, assertions }) => ({ id, status, assertions })), cleanup: result.cleanup, globalChecks: result.globalChecks });
  }
  // Business, collection/workspace and settings runs must observe the same frozen build independently.
  const release = await json(options['--release-report']);
  assert.equal(release.version, '0.4.0');
  assert.equal(release.status, 'passed');
  await sameFile(release.releaseDir, releaseDir, 'Current checked release');
  unique(release.checks, 'id', 'release checks');
  assert.ok(release.checks.length >= 11);
  assert.ok(release.checks.every(row => row.status === 'passed'));
  const details = id => {
    const row = release.checks.find(row => row.id === id);
    assert.ok(row?.details, `Missing release check: ${id}`);
    return row.details;
  };
  const required = details('required-inputs');
  for (const [key, filename] of Object.entries(expectedPaths)) await sameFile(required[key], filename, `release ${key}`);
  const hashes = [];
  for (const [id, key] of [['asar-readable', 'archive'], ['installer-identity', 'installer'], ['application-executable', 'executable']]) {
    const filename = expectedPaths[key];
    const bytes = (await stat(filename)).size;
    assert.ok(bytes > 0, `${id}: empty artifact`);
    const sha256 = await hashPhysicalFile(filename);
    if (key !== 'executable') {
      assert.equal(bytes, details(id).bytes, id);
      assert.equal(sha256, details(id).sha256, id);
    }
    hashes.push({ id, file: filename, bytes, sha256 });
  }
  const archiveHash = hashes.find(row => row.id === 'asar-readable').sha256;
  const executableHash = hashes.find(row => row.id === 'application-executable').sha256;
  for (const identity of identities.filter(row => row.mode === 'exe')) {
    await sameFile(identity.archive?.path, expectedPaths.archive, 'Runtime ASAR');
    await sameFile(identity.executable?.path, expectedPaths.executable, 'Runtime EXE');
    assert.equal(identity.archive.sha256, archiveHash, 'Runtime ASAR differs from checked release');
    assert.equal(identity.executable.sha256, executableHash, 'Runtime EXE differs from checked release');
  }
  const payload = await json(options['--payload-report']);
  assert.equal(payload.status, 'passed');
  assert.equal(payload.installerSha256, hashes.find(row => row.id === 'installer-identity').sha256);
  await sameFile(payload.installer, expectedPaths.installer, 'Payload installer');
  await sameFile(payload.unpacked, dirname(expectedPaths.executable), 'Payload unpacked directory');
  assert.ok(Number.isSafeInteger(payload.files) && payload.files > 0);
  assert.ok(Array.isArray(payload.runtimeExtras) && payload.runtimeExtras.every(filename => filename === 'debug.log'));
  unique(payload.matched, 'path', 'payload matched files');
  const matched = new Map();
  for (const row of payload.matched) {
    assert.equal(typeof row.path, 'string', 'Missing payload path');
    assert.ok(!/[\\:\x00-\x1f]/.test(row.path) && row.path.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe payload path');
    const key = row.path.toLowerCase();
    assert.ok(!matched.has(key), 'Duplicate payload matched path');
    assert.match(row.sha256, sha, 'Invalid payload file hash');
    matched.set(key, row.sha256);
  }
  assert.equal(matched.get('resources/app.asar'), archiveHash, 'Installer payload ASAR differs from current release');
  assert.equal(matched.get('pixelmuse.exe'), executableHash, 'Installer payload EXE differs from current release');
  assert.deepEqual(fingerprintRuntime(sourceAppRoot), expected, 'Compiled source changed while verifying');
  return { status: 'passed', version: '0.4.0', product: 'PixelMuse', positioning: '商品视觉创作工作台',
    generatedAt: new Date().toISOString(), sourceAppRoot, runtimeHash: expected.runtimeHash, runs,
    artifactChecks: release.checks.length, installerPayloadFiles: payload.files, hashes, evidence,
    limits: ['Local synthetic product pages and fake Provider; no real model quality or all-platform collection claim',
      'Installer content inspected; installation, upgrade and uninstall not executed',
      'Native dialog selections are test-controlled in isolated app profiles'] };
}

/** 解析验收命令并写入全新的汇总报告。 */
export async function main(args = process.argv.slice(2)) {
  const flags = new Set([...requiredFlags, '--source-app-root']);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    assert.ok(flags.has(flag) && value && !value.startsWith('--'), `Invalid argument: ${flag}`);
    assert.ok(!(flag in options), `Duplicate argument: ${flag}`);
    options[flag] = resolve(value);
  }
  for (const flag of requiredFlags) assert.ok(options[flag], `Required argument: ${flag}`);
  const report = await verifyAcceptance(options);
  await writeFile(options['--output'], JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, version: report.version, runs: report.runs.length,
    artifactChecks: report.artifactChecks, installerPayloadFiles: report.installerPayloadFiles, output: options['--output'] }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
