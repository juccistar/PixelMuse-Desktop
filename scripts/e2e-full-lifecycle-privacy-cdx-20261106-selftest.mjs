import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeContext, root, executeScenario, appPackage, requireApp } from './e2e-full-harness.mjs';
import { launchGuardedElectron, closeOwnedElectron, lifecycleFailure } from './e2e-full-startup-guard-launch.mjs';

// Read the actual evidence sink, including result.json and generated filenames.
// All inputs are synthetic and live only in the test-owned temporary profile.
const artifacts = await mkdtemp(join(root, '.cache/e2e-full/lifecycle-privacy-cdx-'));
process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
delete process.env.ECOMGEN_E2E_EXECUTABLE;
const ctx = await makeContext();
const canaries = [];
let passedChecks = 0;
const privacyTest = (name, options, run) => test(name, typeof options === 'function' ? {} : options, async t => {
  await (typeof options === 'function' ? options : run)(t);
  passedChecks++;
});
const privateText = () => {
  const key = `unknown-key-${randomUUID()}`, snapshot = `private-snapshot-${randomUUID()}`;
  canaries.push(key, snapshot);
  return `${key} ${snapshot}`;
};
const checkSink = async () => {
  const files = await readdir(artifacts);
  const serialized = files.join('\n') + '\n' + (await Promise.all(files.filter(name => name.endsWith('.json'))
    .map(name => readFile(join(artifacts, name), 'utf8')))).join('\n');
  assert.ok(canaries.every(value => !serialized.includes(value)), 'actual serialized evidence and filenames exclude every canary');
  return files;
};
const readEvidence = async (label, app, error) => JSON.parse(await readFile(await ctx.lifecycleDiagnostics(label, app, error), 'utf8'));
const auditEvents = ['installed', 'utility-spawn', 'utility-exit', 'utility-ready', 'utility-closed', 'blocked',
  'blocked-renderer', 'session-guard-installed', 'network-verified', 'startup-error-modal'];
const observerEvents = ['backend-startup-observer-installed', 'closed-profile-counts', 'closed-profile-counts-unavailable',
  'startup-cpu-locations', 'backend-startup-ready', 'backend-startup-fatal', 'startup-exception-code', 'caught-exception-location'];

try {
  await privacyTest('error metadata cannot coerce boxed enums, throw from accessors, or change between reads', async () => {
    const box = value => { const result = new String(value); const marker = privateText(); result.toJSON = () => marker; return result; };
    const errors = [
      { lifecycleReason: box('launch-failed'), cleanupReason: box('close-failed') },
      { lifecycleReason: { toString() { throw Error(privateText()); } } },
      new Proxy({}, { get() { throw Error(privateText()); } }),
    ];
    for (const field of ['lifecycleReason', 'cleanupReason', 'message', 'code', 'lifecycleStage']) {
      const error = {};
      Object.defineProperty(error, field, { get() { throw Error(privateText()); } });
      errors.push(error);
    }
    const reads = { lifecycleReason: 0, cleanupReason: 0, message: 0, code: 0 };
    const alternating = {};
    for (const field of Object.keys(reads)) Object.defineProperty(alternating, field, { get() {
      reads[field]++;
      return reads[field] === 1 ? ({ lifecycleReason: 'launch-failed', cleanupReason: 'close-failed', message: 'Owned Electron launch failed', code: 'ENOENT' })[field] : box('launch-failed');
    } });
    const safe = lifecycleFailure(alternating);
    assert.ok(Object.values(reads).every(count => count === 1), 'each Error property is read once');
    assert.ok(safe.lifecycleReason === 'launch-failed' && safe.cleanupReason === 'close-failed' && safe.code === 'ENOENT');
    for (const error of errors) {
      const record = lifecycleFailure(error);
      assert.ok(typeof record.lifecycleReason === 'string' && (!record.cleanupReason || typeof record.cleanupReason === 'string'));
      await readEvidence('launch-failed', null, error);
    }
    await checkSink();
  });
  await privacyTest('actual lifecycle writer allowlists every nested launcher/log/observer/audit/error channel', async () => {
    await mkdir(join(ctx.userData, 'logs'), { recursive: true });
    const at = '2026-11-06T12:34:56.000Z';
    await writeFile(join(ctx.userData, 'logs/main.log'), [privateText(), `${at} Backend emitted a diagnostic error.`,
      `${at} Backend restart failed.`, `${at} Backend exited (0).`, `${at} Backend exited (-1).`,
      `${at} Backend emitted a diagnostic error. ${privateText()}`, `${at} ${privateText()}`].join('\n'));
    const audit = auditEvents.flatMap(event => [{ event, pid: 123, childPid: 456, type: 'browser', code: 0,
      serviceName: 'EcomGen Backend', title: 'PixelMuse 启动失败', message: '无法初始化本地应用。请检查数据目录权限和系统密钥保护是否可用。',
      denied: 8, fixture: true, token: privateText(), modulePath: privateText(), responseBody: privateText(), snapshot: { secret: privateText() } },
    { event, pid: privateText(), childPid: privateText(), type: privateText(), code: privateText(), serviceName: privateText(),
      title: privateText(), message: privateText(), denied: privateText(), fixture: privateText(), token: privateText() }]);
    audit.push({ event: privateText(), snapshot: privateText() }, null, { event: { secret: privateText() } });
    await writeFile(join(ctx.fixture, 'network-audit.jsonl'), audit.map(JSON.stringify).join('\n'));
    const observer = observerEvents.flatMap(event => [{ event, at: 1234,
      counts: { jobs: 0, desktop_resources: 299, desktop_cleanup_queue: 41, [privateText()]: privateText() },
      frames: [{ function: privateText(), url: privateText(), line: 12, column: 5, ticks: 42, snapshot: privateText() }],
      code: privateText(), class: privateText(), reason: privateText(), error: { message: privateText() }, initialization: privateText() },
    { event, at: privateText(), counts: { jobs: privateText(), desktop_resources: privateText(), desktop_cleanup_queue: privateText() },
      frames: [{ function: privateText(), url: privateText(), line: privateText(), column: privateText(), ticks: privateText() }] }]);
    observer.push({ event: privateText(), frames: privateText() }, null);
    await writeFile(join(ctx.fixture, 'startup-exception-locations.jsonl'), observer.map(JSON.stringify).join('\n') + '\n' + privateText());
    const launcher = { launcherPid: 789, exitCode: 1, signalCode: 'SIGTERM', stage: 'backend', elapsedMs: 30000,
      stderr: { lines: 3, characters: 99, text: privateText(), nested: { snapshot: privateText() } },
      nodeEndpointSeen: true, chromeEndpointSeen: false, startupPolicyRejected: false,
      stdout: privateText(), error: privateText(), initialization: { secret: privateText() }, [privateText()]: privateText() };
    const error = Object.assign(Error(privateText()), { code: privateText(), lifecycleReason: privateText(), lifecycleStage: privateText(),
      cleanupReason: privateText(), cause: Error(privateText()), launchDiagnostics: { stderr: privateText() }, snapshot: privateText() });
    error.stack = privateText();
    const evidence = await readEvidence(privateText(), { diagnostics: () => launcher }, error);
    assert.equal(evidence.label, 'other');
    assert.deepEqual(evidence.mainLog.events.map(row => row.event), ['backend-diagnostic-output', 'backend-restart-failed', 'backend-exited', 'backend-exited']);
    assert.equal(evidence.mainLog.omittedLines, 3);
    assert.equal(evidence.audit.filter(row => row.event === 'utility-closed').length, 2);
    assert.equal(evidence.audit.find(row => row.event === 'startup-error-modal').expectedMessage, true);
    assert.equal(evidence.audit.find(row => row.event === 'utility-spawn').childPid, 456);
    assert.equal(evidence.launcher.launcherPid, 789); assert.deepEqual(evidence.launcher.stderr, { lines: 3, characters: 99 });
    assert.deepEqual(evidence.startupExceptionLocations.events.find(row => row.event === 'closed-profile-counts').counts,
      { jobs: 0, desktop_resources: 299, desktop_cleanup_queue: 41 });
    assert.equal(evidence.error.reason, 'launch-failed'); assert.equal(evidence.ownerLock, 'absent');
    await checkSink();
  });

  await privacyTest('fallback launch diagnostics and invalid scalar types cannot become serialized text', async () => {
    const launcher = Object.fromEntries(['launcherPid', 'exitCode', 'signalCode', 'stage', 'elapsedMs', 'nodeEndpointSeen',
      'chromeEndpointSeen', 'startupPolicyRejected'].map(name => [name, privateText()]));
    launcher.stderr = privateText(); launcher.response = privateText();
    const error = Object.assign(Error(privateText()), { launchDiagnostics: launcher });
    let evidence = await readEvidence('launch-failed', null, error);
    assert.equal(evidence.launcher.launcherPid, null); assert.deepEqual(evidence.launcher.stderr, { lines: null, characters: null });
    launcher.stderr = { lines: privateText(), characters: { secret: privateText() } };
    evidence = await readEvidence('launch-cleaned', null, error);
    assert.deepEqual(evidence.launcher.stderr, { lines: null, characters: null });
    await writeFile(join(ctx.fixture, 'network-audit.jsonl'), privateText());
    await writeFile(join(ctx.fixture, 'startup-exception-locations.jsonl'), privateText());
    evidence = await readEvidence('close-failed', { diagnostics: () => { throw Error(privateText()); } }, error);
    assert.equal(evidence.launcher.status, 'unavailable'); assert.equal(evidence.auditStatus, 'unavailable');
    await mkdir(join(ctx.userData, 'data'), { recursive: true });
    await writeFile(join(ctx.userData, 'data/backend.lock'), privateText());
    evidence = await readEvidence('close-failed', null, Error('Test-owned Electron close timed out'));
    assert.equal(evidence.ownerLock, 'present'); assert.equal(evidence.error.reason, 'close-timeout');
    await rm(join(ctx.userData, 'data/backend.lock'));
    await checkSink();
  });

  await privacyTest('fixed reasons retain startup/backend/close failure distinctions without raw Error properties', async () => {
    for (const [message, reason] of [['Guarded Electron startup timed out', 'startup-timeout'],
      ['Timed out polling renderer bridge and Backend health', 'backend-timeout'], ['后台启动超时', 'backend-startup-timeout'],
      ['后台初始化失败', 'backend-initialization-failed'], ['后台未能启动，请检查数据目录。', 'backend-startup-failed'],
      ['Test-owned Electron close timed out', 'close-timeout']]) {
      const evidence = await readEvidence('launch-failed', null, Object.assign(Error(message), { snapshot: privateText(), cause: Error(privateText()) }));
      assert.equal(evidence.error.reason, reason);
    }
    const safe = lifecycleFailure(Object.assign(Error(privateText()), { code: 'ENOENT', cause: Error(privateText()) }));
    assert.equal(safe.code, 'ENOENT'); assert.equal(safe.cause, undefined);
    assert.ok(canaries.every(value => !safe.message.includes(value)));
    const child = { exitCode: 0, signalCode: null };
    await assert.rejects(closeOwnedElectron({ process: () => child, close: async () => { throw Error(privateText()); } }), error => {
      assert.equal(error.lifecycleReason, 'close-failed');
      assert.ok(canaries.every(value => !error.message.includes(value))); return true;
    });
    await checkSink();
  });

  await privacyTest('real launcher stderr and exit diagnostics contain only fixed fields and preserve failure', { timeout: 30000 }, async () => {
    const env = { ...process.env, ECOMGEN_DESKTOP_DATA_DIR: ctx.userData, ECOMGEN_E2E_APP_PACKAGE: appPackage,
      ECOMGEN_E2E_GUARD_TOKEN: randomUUID(), ECOMGEN_E2E_GUARD_ORIGINS: JSON.stringify([ctx.mock.origin]),
      ECOMGEN_E2E_GUARD_AUDIT: join(ctx.fixture, 'network-audit.jsonl'),
      ECOMGEN_PRIVACY_TEST_KEY: privateText(), ECOMGEN_PRIVACY_TEST_SNAPSHOT: privateText(),
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' };
    for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL']) delete env[key];
    let failure;
    try {
      const app = await launchGuardedElectron({ executable: requireApp('electron'),
        args: [join(root, 'scripts/e2e-full-lifecycle-privacy-cdx-20261106-fixture.cjs')], env, timeout: 10000 });
      await closeOwnedElectron(app);
    } catch (error) { failure = error; }
    assert.ok(failure, 'early exit stays a rejected launch');
    assert.equal(failure.lifecycleReason, 'startup-exit');
    assert.equal(failure.launchDiagnostics.exitCode, 7);
    assert.ok(failure.launchDiagnostics.stderr.lines > 0);
    assert.ok(canaries.every(value => !JSON.stringify(failure).includes(value) && !failure.message.includes(value)));
    await ctx.evidence('private-launcher-error', { message: failure.message, diagnostics: failure.launchDiagnostics });
    const evidence = await readEvidence('launch-failed', null, failure);
    assert.equal(evidence.launcher.exitCode, 7);
    assert.throws(() => process.kill(evidence.launcher.launcherPid, 0), { code: 'ESRCH' });
    await checkSink();
  });

  await privacyTest('real source launch preserves failed status and cleans the current guarded process when nested wrapper errors are private', { timeout: 60000 }, async () => {
    await rm(join(ctx.fixture, 'network-audit.jsonl'), { force: true });
    await rm(join(ctx.fixture, 'startup-exception-locations.jsonl'), { force: true });
    const verify = ctx.assertGuardCurrent.bind(ctx), diagnose = ctx.lifecycleDiagnostics.bind(ctx), stop = ctx.stop.bind(ctx);
    let child, identity;
    ctx.assertGuardCurrent = async () => {
      await verify();
      identity = { ...ctx.startupGuard }; child = ctx.app.process();
      const error = Object.assign(Error(privateText()), { launchDiagnostics: { stderr: privateText() }, cause: Error(privateText()) });
      error.lifecycleReason = { toString() { throw Error(privateText()); } };
      throw error;
    };
    ctx.lifecycleDiagnostics = async (...args) => { await diagnose(...args); throw Error(privateText()); };
    ctx.stop = async () => { await stop(); throw Error(privateText()); };
    try {
      const record = await executeScenario(ctx, { id: 'lifecycle-private-wrapper', title: 'Synthetic lifecycle failure', run: context => context.launch() });
      assert.equal(record.status, 'failed'); assert.match(record.error, /Owned Electron launch failed/);
      assert.match(record.error, /Lifecycle diagnostics unavailable/); assert.match(record.error, /Test-owned Electron close failed/);
      assert.ok(child && identity.backendPid); assert.notEqual(child.exitCode ?? child.signalCode, null);
      for (const pid of [identity.browserPid, identity.backendPid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      const audit = await ctx.guardAudit();
      assert.ok(audit.some(row => row.event === 'utility-closed' && row.childPid === identity.backendPid));
      assert.equal(ctx.app, null); assert.equal(ctx.page, null); assert.equal(ctx.startupGuard, null);
      assert.equal(ctx.mock.state.total, 0);
      const files = await checkSink();
      const actual = await Promise.all(files.filter(name => name.startsWith('lifecycle-launch-cleaned-')).map(async name => JSON.parse(await readFile(join(artifacts, name), 'utf8'))));
      assert.ok(actual.some(row => row.ownerLock === 'absent' && row.audit.some(event => event.event === 'utility-closed' && event.childPid === identity.backendPid)));
    } finally {
      ctx.assertGuardCurrent = verify; ctx.lifecycleDiagnostics = diagnose; ctx.stop = stop;
    }
  });
} finally {
  assert.deepEqual(await ctx.cleanup(), []);
  await checkSink();
  const summary = { status: passedChecks === 6 ? 'passed' : 'failed', artifacts, passedChecks, expectedChecks: 6,
    evidencePrivacy: 'checked-actual-files', injectedCanaries: canaries.length, syntheticLaunchScenario: 'failed-as-required', cleanup: 'passed' };
  await writeFile(join(artifacts, 'privacy-result.json'), JSON.stringify(summary, null, 2));
  await checkSink();
  console.log(JSON.stringify(summary));
}
