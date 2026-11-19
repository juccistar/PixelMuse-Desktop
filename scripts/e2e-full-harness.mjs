import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './e2e-full-support.mjs';
import { decodePublicErrorMessage } from '../packages/contracts/dist/index.js';
import { launchGuardedElectron, closeOwnedElectron, lifecycleFailure } from './e2e-full-startup-guard-launch.mjs';
import { captureRuntimeIdentity } from './pixelmuse-runtime-identity.mjs';
export { unzip } from './e2e-full-support.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const workspace = resolve(root, '..');
export const desktop = join(root, 'apps/desktop');
export const appPackage = join(desktop, 'package.json');
export const requireApp = createRequire(appPackage);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export class Blocked extends Error {}
// Only a rejection caught inside the real renderer bridge can satisfy a negative test.
export class RendererRejection extends Error {
  constructor(error) {
    const { message, code } = decodePublicErrorMessage(error.message) ?? error;
    super(message); this.code = code;
  }
}
const invalidInput = /^(?:请求参数不符合契约|命令参数无效。|业务参数无效。)$/;
const domainRejections = {
  testProviderConnection: /^modelId is not declared by the selected provider$/,
  createProvider: /^models\[\d+\] cannot declare both imageApiKind and segmentationProtocol$/,
  deleteProject: /^只能永久删除已归档项目。$/,
  getProject: /^project not found: /i,
  getResource: /^(?:(?:asset|resource) not found: |文件不存在或尚未生成。$|资源不存在。$|无效的资源引用$)/i,
  uploadAsset: /^(?:相同图片已上传到项目|项目最多上传 6 张(?:商品图|参考图)|图片类型与内容不符。)$/,
  copyLibraryAssetToProject: /^相同图片已上传到项目$/,
  createPlanningJob: /^(?:requestedTypes contains an unknown ecom-details-image template ID or alias|MANUAL planning requires requestedTypes or requestedSuiteShots|PIXEL_PROTECTED planning requires at least one PRODUCT_TRUTH image)$/,
  confirmStoryboard: /^分镜已被其他修改更新（当前版本 \d+），请刷新后重试$/,
  updateStoryboardItem: /^(?:Generated storyboard items only allow generation-setting updates|Generating storyboard items cannot be updated|Storyboard item image type is immutable)$/,
  approveEditTurn: /^Edit turn is not ready for generation$/,
  updatePatternDraft: /^草稿已在别处更新（服务端版本 \d+）$/,
  createDraftBatch: /^引用的参考图不存在：/,
  retryJob: /^此任务不能直接重试，请先处理其中断状态。$/,
  notAnOperation: /^不支持的操作$/,
  'host.resolveResource': /^不支持的操作$/,
  'host.assetPath': /^不支持的操作$/,
};
export function assertDomainRejection(operation, error, pattern) {
  if (!(error instanceof RendererRejection)) throw error;
  // Decode bridge errors before asserting. Never let a generic failure message
  // or an infrastructure code turn into a passing domain assertion.
  assert.doesNotMatch(`${error.code ?? ''} ${error.message}`, /COMMAND_UNAVAILABLE|INTERNAL_ERROR|BACKEND_UNAVAILABLE|LOCAL_OPERATION_FAILED|INVALID_RESPONSE|PRIVATE_OUTPUT|E2E_NETWORK_BLOCKED|尚未接入|后台尚未就绪|返回数据校验失败|本地操作失败|本地操作未完成|操作失败，请重试|not a function|Target.*closed|browser.*closed|crash|ECONN|connection.*(?:closed|refused|reset)/i);
  if (pattern !== undefined) assert.match(error.message, pattern);
  else if (!invalidInput.test(error.message)) {
    const expected = domainRejections[operation];
    assert.ok(expected, `${operation} needs an explicit expected domain rejection pattern`);
    assert.match(error.message, expected);
  }
}
export const need = (value, message) => { if (!value) throw new Blocked(message); return value; };
export const items = value => Array.isArray(value) ? value : need(value?.items, 'Expected a real collection DTO');
export const sleep = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
export async function poll(query, accept, { timeout = 45000, label = 'resolved query' } = {}) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await query();
    if (await accept(value)) return value;
    await sleep(100);
  }
  throw new Error(`Timed out polling ${label}`);
}
const lifecycleLabels = new Set(['launch-failed', 'launch-cleaned', 'close-failed', 'healthy-diagnostic-entry',
  'expected-startup-failed', 'expected-startup-cleaned', 'diagnostic-selftest-failed']);
const lifecycleStages = new Set(['launcher', 'inspector', 'guard', 'renderer', 'backend', 'close', 'diagnostics']);
const lifecycleInteger = value => Number.isSafeInteger(value) ? value : null;
const lifecycleCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const lifecyclePid = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const lifecycleBoolean = value => typeof value === 'boolean' ? value : null;
const lifecycleSignal = value => ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV'].includes(value) ? value : null;
function lifecycleErrorRecord(error) {
  if (!error) return null;
  let stage;
  try { stage = error.lifecycleStage; } catch { /* Untrusted accessor metadata is omitted. */ }
  const safe = lifecycleFailure(error, 'launch-failed', stage);
  return { reason: safe.lifecycleReason, stage: safe.lifecycleStage,
    code: safe.code ?? null, cleanupReason: safe.cleanupReason ?? null };
}
function lifecycleLauncherRecord(value) {
  if (!value) return null;
  return { launcherPid: lifecyclePid(value.launcherPid), exitCode: lifecycleInteger(value.exitCode), signalCode: lifecycleSignal(value.signalCode),
    stage: lifecycleStages.has(value.stage) ? value.stage : null, elapsedMs: lifecycleCount(value.elapsedMs),
    stderr: { lines: lifecycleCount(value.stderr?.lines), characters: lifecycleCount(value.stderr?.characters) },
    nodeEndpointSeen: lifecycleBoolean(value.nodeEndpointSeen), chromeEndpointSeen: lifecycleBoolean(value.chromeEndpointSeen),
    startupPolicyRejected: lifecycleBoolean(value.startupPolicyRejected) };
}
const lifecycleAuditEvents = new Set(['installed', 'utility-spawn', 'utility-exit', 'utility-ready', 'utility-closed',
  'blocked', 'blocked-renderer', 'session-guard-installed', 'network-verified', 'startup-error-modal']);
function lifecycleAuditRecord(row) {
  if (!row || !lifecycleAuditEvents.has(row.event)) return null;
  const safe = { event: row.event, pid: lifecyclePid(row.pid), type: ['browser', 'utility', 'node'].includes(row.type) ? row.type : null };
  if (['utility-spawn', 'utility-ready', 'utility-closed'].includes(row.event)) safe.childPid = lifecyclePid(row.childPid);
  if (row.event === 'utility-spawn') safe.serviceName = row.serviceName === 'EcomGen Backend' ? 'EcomGen Backend' : null;
  if (row.event === 'utility-exit') safe.code = lifecycleInteger(row.code);
  if (row.event === 'network-verified') { safe.denied = lifecycleCount(row.denied); safe.fixture = lifecycleBoolean(row.fixture); }
  if (row.event === 'startup-error-modal') {
    safe.expectedTitle = row.title === 'PixelMuse 启动失败';
    safe.expectedMessage = row.message === '无法初始化本地应用。请检查数据目录权限和系统密钥保护是否可用。';
  }
  return safe;
}
function lifecycleMainLog(text) {
  let omittedLines = 0;
  const events = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    // Match the entire fixed production line, never arbitrary suffixes or metadata.
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (Backend emitted a diagnostic error\.|Backend restart failed\.|Backend exited \((-?\d+)\)\.)$/.exec(line);
    if (!match) { omittedLines++; continue; }
    const event = match[2] === 'Backend emitted a diagnostic error.' ? 'backend-diagnostic-output'
      : match[2] === 'Backend restart failed.' ? 'backend-restart-failed' : 'backend-exited';
    events.push({ event, atMs: Number.isFinite(Date.parse(match[1])) ? Date.parse(match[1]) : null,
      ...(event === 'backend-exited' ? { code: lifecycleInteger(Number(match[3])) } : {}) });
  }
  return { events, omittedLines };
}
const lifecycleObserverEvents = new Set(['backend-startup-observer-installed', 'closed-profile-counts', 'closed-profile-counts-unavailable',
  'startup-cpu-locations', 'backend-startup-ready', 'backend-startup-fatal', 'startup-exception-code', 'caught-exception-location']);
function lifecycleObserverLog(text) {
  let omittedLines = 0;
  const events = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { omittedLines++; continue; }
    if (!row || !lifecycleObserverEvents.has(row.event)) { omittedLines++; continue; }
    const safe = { event: row.event, atMs: lifecycleCount(row.at) };
    if (row.event === 'closed-profile-counts') safe.counts = Object.fromEntries(
      ['jobs', 'desktop_resources', 'desktop_cleanup_queue'].map(name => [name, lifecycleCount(row.counts?.[name])]));
    if (['startup-cpu-locations', 'startup-exception-code', 'caught-exception-location'].includes(row.event)) {
      // Function names, URLs, classes and exception metadata are free-form too.
      safe.frames = Array.isArray(row.frames) ? row.frames.map(frame => ({ line: lifecycleCount(frame?.line),
        column: lifecycleCount(frame?.column), ticks: lifecycleCount(frame?.ticks) })) : [];
    }
    if (row.event === 'startup-exception-code') safe.code = ['ENOENT', 'EACCES', 'EPERM', 'SQLITE_ERROR', 'SQLITE_BUSY', 'SQLITE_CORRUPT'].includes(row.code) ? row.code : null;
    events.push(safe);
  }
  return { events, omittedLines };
}
export async function makeContext() {
  const { startFullMockProvider, defaultReplyForRequest, editPlanReply, storyboardReply } = await import('./full-mock-provider.mjs');
  const sharp = createRequire(join(root, 'packages/backend/package.json'))('sharp');
  const artifacts = resolve(process.env.ECOMGEN_E2E_ARTIFACTS || join(root, '.cache/e2e-full', new Date().toISOString().replace(/[:.]/g, '-')));
  await mkdir(artifacts, { recursive: true });
  const fixture = await mkdtemp(join(tmpdir(), 'ecomgen-full-'));
  let initialized = false;
  let mock;
  try {
  const observations = [];
  const state = { editVariant: 'confirmation', storyboardOptions: {}, jobs: new Map(), operations: new Map(), ui: new Set(), screenshots: [], events: [] };
  const observeRequest = request => {
    // Preserve assertions about actual protocol inputs without persisting full prompts, keys or image payloads.
    const text = request.body.toString('utf8');
    observations.push({ kind: request.kind, workflow: request.workflow, requestId: request.requestId, model: request.json?.model ?? request.fields.model ?? null, payload: request.payload,
      markers: Object.fromEntries(['synthetic ceramic', 'no medical claims', 'e2e-full-custom-marker', 'PRODUCT_TRUTH', 'STYLE_REFERENCE', 'Identity reference', '@图1', '#ff7755'].map(marker => [marker, text.includes(marker)])) });
    return text;
  };
  mock = await startFullMockProvider({ width: 128, height: 96, models: ['mock-reasoner', 'mock-image', 'gpt-image-1', 'sam-3', 'grounded-sam', 'sam3', 'doubao-seedream-5.0-pro-layerize'], imageMode: 'url', maxRecords: 10000,
    replyForRequest(request) {
      const text = observeRequest(request);
      if (request.workflow === 'edit-plan') return editPlanReply(state.editVariant, state.editOverrides ?? {});
      if (request.workflow === 'storyboard') {
        if (state.researchToolPending) {
          state.researchToolPending = false;
          return { toolCalls: [{ id: 'full-research', name: 'research_visual_direction', arguments: { query: 'ceramic studio composition and soft daylight', maxResults: 3 } }] };
        }
        const reply = defaultReplyForRequest(request);
        if(text.includes('e2e-full-custom-marker'))for(const item of reply.items)item.promptInstruction+=' e2e-full-custom-marker soft daylight.';
        if (Object.keys(state.storyboardOptions).length) return storyboardReply({
          assetTypes: reply.items.map(item=>item.assetType), targetImageCount: reply.items.length,
          candidateCount: reply.items[0]?.candidateCount, mode: reply.items[0]?.mode,
          referencedAssets: reply.items[0]?.referencedAssets, ...state.storyboardOptions,
        });
        return reply;
      }
      return undefined;
    },
    imageForRequest: async (request, images) => {
      // The provider's reply hook only sees reasoning; image prompts need their own observation.
      observeRequest(request);
      // Each synthetic candidate needs distinct bytes; identical portraits are correctly deduplicated by content.
      return ['image-generation','image-edit'].includes(request.kind) ? sharp(images.image).modulate({ hue: ((request.kind === 'image-edit' ? 140 : 0) + request.kindCall * 37) % 360 }).png().toBuffer() : undefined;
    },
  });
  const image = join(fixture, 'product.png'), reference = join(fixture, 'reference.png');
  await writeFile(image, mock.images.image);
  await sharp(mock.images.image).modulate({ hue: 75 }).png().toFile(reference);
  const byteFile = async (filename = image) => ({ name: filename.split(/[\\/]/).pop(), mimeType: 'image/png', base64: (await readFile(filename)).toString('base64') });
  const userData = join(fixture, 'user-data');
  await mkdir(userData);
  const result = { version: 1, runId: randomUUID(), startedAt: new Date().toISOString(), integration: 'running', executable: process.env.ECOMGEN_E2E_EXECUTABLE || 'installed development Electron',
    nativeDialogs: 'showOpenDialog/showSaveDialog are controlled only in the test-owned Electron process; every save uses the real resource bridge and filesystem copy',
    isolation: { generatedImages: true, syntheticCredentials: true, temporaryUserData: true, network: 'fixture origin only; startup guard required in browser and utility process' }, scenarios: [] };
  const ctx = { fixture, artifacts, state, mock, observations, sharp, image, reference, userData, result, byteFile, fakeKey: 'offline-test-credential', current: null, app: null, page: null, activeData: userData,
    check(condition, message) { assert.ok(condition, message); if (ctx.current) ctx.current.assertions++; },
    equal(actual, expected, message) { assert.deepEqual(actual, expected, message); if (ctx.current) ctx.current.assertions++; },
    async evidence(name, data) {
      const filename = join(artifacts, `${ctx.current?.id ?? 'run'}-${name}.json`);
      await writeFile(filename, ctx.redact(JSON.stringify(data, null, 2)));
      ctx.current?.evidence.push(filename);
      return filename;
    },
    async screenshot(name = 'screen') {
      if (!ctx.page || ctx.page.isClosed()) return;
      const filename = join(artifacts, `${ctx.current?.id ?? 'run'}-${name}.png`);
      await ctx.page.screenshot({ path: filename, fullPage: true });
      ctx.current?.evidence.push(filename); state.screenshots.push(filename);
    },
    async lifecycleDiagnostics(label, app = ctx.app, error) {
      // The evidence boundary is a structured allowlist, independent of known
      // fixture secrets. Never serialize raw errors, logs, utility output or rows.
      const optionalLog = async (filename, project) => {
        try { return { status: 'read', ...project((await readFile(filename, 'utf8')).slice(-64000)) }; }
        catch (readError) { return { status: readError.code === 'ENOENT' ? 'absent' : 'unavailable' }; }
      };
      let launcher;
      try { launcher = lifecycleLauncherRecord(app?.diagnostics?.() ?? error?.launchDiagnostics); }
      catch { launcher = { status: 'unavailable' }; }
      let audit, auditStatus;
      try { audit = (await ctx.guardAudit()).map(lifecycleAuditRecord).filter(Boolean); auditStatus = 'read'; }
      catch { audit = []; auditStatus = 'unavailable'; }
      let ownerLock;
      try { await access(join(ctx.activeData, 'data', 'backend.lock')); ownerLock = 'present'; }
      catch (lockError) { ownerLock = lockError.code === 'ENOENT' ? 'absent' : 'unavailable'; }
      const safeLabel = lifecycleLabels.has(label) ? label : 'other';
      const filename = join(artifacts, `lifecycle-${safeLabel}-${randomUUID()}.json`);
      await writeFile(filename, JSON.stringify({ label: safeLabel, atMs: Date.now(), error: lifecycleErrorRecord(error), launcher,
        mainLog: await optionalLog(join(ctx.activeData, 'logs', 'main.log'), lifecycleMainLog),
        startupExceptionLocations: await optionalLog(join(fixture, 'startup-exception-locations.jsonl'), lifecycleObserverLog),
        auditStatus, audit, ownerLock }, null, 2));
      ctx.current?.evidence.push(filename);
      return filename;
    },
    async launch(data = userData, { startupDiagnostics = false } = {}) {
      need(!ctx.app, 'Stop the current test-owned Electron before launching another');
      ctx.activeData = data;
      ctx.startupGuard = null;
      const token = randomUUID();
      const env = { ...process.env, ECOMGEN_DESKTOP_DATA_DIR: data, ECOMGEN_E2E_GUARD_ORIGINS: JSON.stringify([mock.origin]), ECOMGEN_E2E_GUARD_AUDIT: join(fixture, 'network-audit.jsonl'), ECOMGEN_E2E_APP_PACKAGE: appPackage, ECOMGEN_E2E_GUARD_TOKEN: token,
        // Do not inherit user preloads, proxy credentials, dev URLs or Node mode.
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1', http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '127.0.0.1' };
      delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
      const packaged = Boolean(process.env.ECOMGEN_E2E_EXECUTABLE);
      let launchStage = 'launcher';
      try {
        ctx.app = await launchGuardedElectron({ fixture,
          executable: process.env.ECOMGEN_E2E_EXECUTABLE || requireApp('electron'),
          args: packaged ? [] : [startupDiagnostics ? join(root, 'scripts/e2e-full-lifecycle-cdx-20261106-diagnostic-main.cjs') : desktop], env, timeout: 45000 });
        launchStage = 'inspector';
        let runtimeIdentity;
        try { runtimeIdentity = await captureRuntimeIdentity(ctx.app, { mode: packaged ? 'exe' : 'source', runId: result.runId }); }
        catch { result.runtimeIdentityError = 'Runtime identity capture failed'; throw Error(result.runtimeIdentityError); }
        if (result.runtimeIdentity) {
          try { assert.deepEqual(runtimeIdentity, result.runtimeIdentity, 'Runtime identity changed between launches'); }
          catch { result.runtimeIdentityError = 'Runtime identity changed between launches'; throw Error(result.runtimeIdentityError); }
        } else result.runtimeIdentity = runtimeIdentity;
        launchStage = 'guard';
        const browser = await ctx.app.evaluate(() => ({ pid: process.pid, guard: globalThis.__ecomgenFullGuard }));
        need(browser.guard?.token === token, 'Startup network guard was not loaded before production entry; no provider scenario was started');
        ctx.startupGuard = { token, browserPid: browser.pid, backendPid: null };
        launchStage = 'renderer';
        ctx.page = await ctx.app.firstWindow({ timeout: 45000 });
        ctx.page.setDefaultTimeout(12000);
        ctx.page.on('pageerror', error => state.events.push({ type: 'pageerror', message: ctx.redact(error.message) }));
        launchStage = 'guard';
        await ctx.assertGuardCurrent();
        launchStage = 'backend';
        await poll(async () => { try { return await ctx.invoke('getHealth'); } catch { return null; } }, value => value?.status === 'ready', { label: 'renderer bridge and Backend health' });
        await ctx.page.evaluate(() => {
          window.__e2eBackendStatuses = []; window.__e2eChanges = [];
          window.ecomgen.onBackendStatus(status => window.__e2eBackendStatuses.push(status));
          window.ecomgen.onChanged(change => window.__e2eChanges.push(change));
        });
      } catch (error) {
        const failedApp = ctx.app;
        const safe = lifecycleFailure(error, launchStage === 'renderer' && error?.name === 'TimeoutError' ? 'window-timeout' : 'launch-failed', launchStage);
        safe.launchDiagnostics = lifecycleLauncherRecord(error?.launchDiagnostics);
        const launcherPid = safe.launchDiagnostics?.launcherPid;
        if (launcherPid) safe.message += `; owned launcher PID ${launcherPid}`;
        try { await ctx.lifecycleDiagnostics('launch-failed', failedApp, safe); }
        catch { safe.message += '; Lifecycle diagnostics unavailable'; }
        try { await ctx.stop(); } catch (cleanupError) {
          const cleanup = lifecycleFailure(cleanupError, 'close-failed', 'close');
          safe.cleanupReason = cleanup.lifecycleReason; safe.message += `; launch cleanup: ${cleanup.message}`;
        }
        try { await ctx.lifecycleDiagnostics('launch-cleaned', failedApp, safe); }
        catch { safe.message += '; Lifecycle diagnostics unavailable'; }
        throw safe;
      }
    },
    async assertGuardCurrent() {
      need(ctx.app && ctx.startupGuard, 'Verified startup network guard is unavailable');
      const { token, browserPid } = ctx.startupGuard;
      const backendPid = await ctx.app.evaluate(({ app }, expected) => {
        if (globalThis.__ecomgenFullGuard?.token !== expected.token || process.pid !== expected.browserPid) throw Error('Browser startup guard changed');
        const children = app.getAppMetrics().filter(metric => metric.type === 'Utility' && metric.name === 'EcomGen Backend');
        if (children.length !== 1) throw Error('Expected one current test-owned Backend');
        return children[0].pid;
      }, { token, browserPid });
      if (ctx.startupGuard.backendPid !== backendPid) {
        const rows = await ctx.guardAudit();
        need(rows.some(row => row.token === token && row.event === 'installed' && row.type === 'browser' && row.pid === browserPid) &&
          rows.some(row => row.token === token && row.event === 'utility-spawn' && row.pid === browserPid && row.childPid === backendPid && row.serviceName === 'EcomGen Backend') &&
          rows.some(row => row.token === token && row.event === 'installed' && row.type === 'utility' && row.pid === backendPid),
        'Current browser and Backend startup guard audit did not match; provider/business IPC is blocked');
        ctx.startupGuard.backendPid = backendPid;
      }
    },
    async guardAudit() { try { return (await readFile(join(fixture, 'network-audit.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } },
    async stop() {
      if (!ctx.app) return;
      const closing = ctx.app; ctx.app = null; ctx.page = null; ctx.startupGuard = null;
      try { await closeOwnedElectron(closing); }
      catch (error) {
        const safe = lifecycleFailure(error, 'close-failed', 'close');
        try { await ctx.lifecycleDiagnostics('close-failed', closing, safe); }
        catch { safe.message += '; Lifecycle diagnostics unavailable'; }
        throw safe;
      }
    },
    async restartBackend() {
      need(ctx.app, 'Application is unavailable');
      await ctx.page.evaluate(() => { window.__e2eBackendStatuses = []; });
      const previous = await ctx.app.evaluate(({ app }) => { const owned = app.getAppMetrics().filter(metric => metric.type === 'Utility' && metric.name === 'EcomGen Backend'); if (owned.length !== 1) throw Error('Expected one test-owned Backend'); return owned[0].pid; });
      // Only the child pid obtained from this app's metrics is ever terminated.
      await ctx.app.evaluate((_electron, pid) => process.kill(pid), previous);
      await poll(async () => ctx.page.evaluate(() => window.__e2eBackendStatuses), values => values.includes('disconnected') && values.includes('ready'), { label: 'disconnect/restart status events' });
      await poll(async () => { try { return await ctx.invoke('getHealth'); } catch { return null; } }, value => value?.status === 'ready', { label: 'restarted Backend health' });
    },
    async invoke(operation, input = {}) {
      need(ctx.page && !ctx.page.isClosed(), 'Actual Electron window is unavailable');
      await ctx.assertGuardCurrent();
      const entry = state.operations.get(operation) ?? { calls: 0, resolved: 0, rejected: 0 };
      state.operations.set(operation, entry); entry.calls++;
      const scenarioEntry = ctx.current ? (ctx.current.operations[operation] ??= { calls: 0, resolved: 0, rejected: 0 }) : null;
      if (scenarioEntry) scenarioEntry.calls++;
      try {
        // Catch in the renderer so Playwright transport failures stay separate and
        // any code that survives contextBridge is copied as plain serializable data.
        const response = await ctx.page.evaluate(async ({ operation, input }) => {
          try { return { ok: true, data: await window.ecomgen.invoke(operation, input) }; }
          catch (error) { return { ok: false, error: { message: String(error?.message ?? error), code: typeof error?.code === 'string' ? error.code : undefined } }; }
        }, { operation, input });
        if (!response.ok) throw new RendererRejection(response.error);
        const output = response.data;
        entry.resolved++;
        if (scenarioEntry) scenarioEntry.resolved++;
        const text = JSON.stringify(output);
        assert.ok(!text?.includes(ctx.fakeKey), 'secret is absent from public DTO');
        for (const path of [fixture, fixture.replaceAll('\\', '/'), fixture.replaceAll('\\', '\\\\')]) assert.ok(!text?.includes(path), 'managed absolute path is absent from DTO');
        if (operation === 'getPatternListingResult' && output?.copy?.title) ctx.current?.verifiedBranches.push('COPYWRITE:LISTING');
        return output;
      } catch (error) {
        entry.rejected++;
        if (scenarioEntry) scenarioEntry.rejected++;
        if (/COMMAND_UNAVAILABLE|尚未接入|not a function/.test(error.message)) throw new Blocked(`${operation}: ${ctx.redact(error.message)}`);
        throw error;
      }
    },
    async rejects(operation, input, pattern) {
      let rejected;
      try { await ctx.invoke(operation, input); } catch (error) { rejected = error; }
      assert.ok(rejected, `${operation} must reject`);
      assertDomainRejection(operation, rejected, pattern);
      if (ctx.current) ctx.current.assertions++;
    },
    async waitJob(id, expected = 'SUCCEEDED') {
      need(id, 'Submission did not return a durable job ID');
      const job = await poll(() => ctx.invoke('getJob', { jobId: id }), value => ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(value.status), { label: `job ${id}` });
      ctx.equal(job.status, expected, `job ${job.type} terminal state`);
      state.jobs.set(id, job);
      if (ctx.current) ctx.current.jobs.push({ id, type: job.type, status: job.status });
      await ctx.evidence(`job-${id}`, { job, requests: await ctx.invoke('getJobRequests', { jobId: id }) });
      return job;
    },
    async save(ref, extension = 'png') {
      need(ctx.app, 'Actual app required for native save');
      const path = join(artifacts, `${ctx.current?.id ?? 'run'}-${ref.kind}-${ref.id}${'index' in ref ? '-' + ref.index : ''}.${extension}`);
      await ctx.app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path);
      const saved = await ctx.page.evaluate(ref => window.ecomgen.saveArtifact(ref), ref);
      ctx.equal(saved, true, 'native resource save completed');
      const bytes = await readFile(path);
      ctx.check(bytes.length > 0, 'real saved bytes'); ctx.current?.evidence.push(path);
      return bytes;
    },
    async imageRef(ref, { alpha = false, expectedHash } = {}) {
      const bytes = await ctx.save(ref);
      const metadata = await sharp(bytes).metadata();
      const pixels = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      ctx.check(metadata.width > 0 && metadata.height > 0, 'actual image decodes');
      if (expectedHash) ctx.equal(sha256(bytes), expectedHash, 'file content hash');
      if (alpha) ctx.check(pixels.data.some((value, index) => index % 4 === 3 && value < 255), 'actual transparent pixels');
      await ctx.evidence(`${ref.kind}-${ref.id}-pixels`, { width: metadata.width, height: metadata.height, format: metadata.format, hasAlpha: metadata.hasAlpha, hash: sha256(bytes), sample: [...pixels.data.subarray(0, 16)] });
      return { bytes, metadata, ...pixels };
    },
    async click(name, scope = ctx.page) { await scope.getByRole('button', { name, exact: typeof name === 'string' }).click(); },
    async navigate(name, heading) {
      await ctx.click(name, ctx.page.getByRole('navigation', { name: '全局导航' }));
      await ctx.page.getByRole('heading', { name: heading, exact: typeof heading === 'string' }).waitFor({ state: 'visible' });
    },
    async inspect(mode = 'summary', ids) {
      await ctx.assertGuardCurrent();
      return ctx.app.evaluate((_electron, input) => {
        if (typeof globalThis.__ecomgenFullInspectDatabase !== 'function') throw Error('Test-only guarded database inspector is unavailable');
        return globalThis.__ecomgenFullInspectDatabase(input);
      }, { filename: join(ctx.activeData, 'data/backend.sqlite'), appPackage: join(root, 'packages/backend/package.json'), electronPackage: appPackage, mode, ids });
    },
    redact(text) { return redact(String(text), [ctx.fakeKey, 'e2e-full-synthetic-v2-key']).replaceAll(fixture, '[isolated-fixture]'); },
    async cleanup() {
      const errors = [];
      try { await ctx.stop(); } catch (error) { errors.push(ctx.redact(error.message)); }
      try { await mock.close(); } catch (error) { errors.push(ctx.redact(error.message)); }
      try { await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch (error) { errors.push(ctx.redact(error.message)); }
      return errors;
    },
  };
  initialized = true;
  return ctx;
  } finally {
    if (!initialized) {
      await mock?.close();
      await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    }
  }
}
export async function executeScenario(ctx, scenario) {
  const record = { id: scenario.id, title: scenario.title, jobTypes: scenario.jobTypes ?? [], status: 'blocked', assertions: 0, evidence: [], operations: {}, jobs: [], verifiedBranches: [], fixtureBefore: ctx.mock.control.snapshot().counts, startedAt: new Date().toISOString() };
  ctx.current = record; ctx.result.scenarios.push(record);
  try {
    const dependencies = (scenario.needs ?? []).filter(id => ctx.result.scenarios.find(row => row.id === id)?.status !== 'passed');
    need(dependencies.length === 0, `Prerequisite scenarios did not pass: ${dependencies.join(', ')}`);
    await scenario.run(ctx);
    assert.ok(record.assertions > 0, 'Scenario needs behavior assertions, not only submitted IDs');
    await ctx.evidence('observations', { operations: record.operations, jobs: record.jobs, assertions: record.assertions });
    record.status = 'passed';
  } catch (error) {
    record.status = error instanceof Blocked ? 'blocked' : 'failed';
    record.error = ctx.redact(error.message);
    await ctx.screenshot('failure').catch(() => {});
  } finally {
    record.finishedAt = new Date().toISOString();
    const after = ctx.mock.control.snapshot().counts;
    record.fixtureDelta = Object.fromEntries(Object.keys(after).map(kind => [kind, after[kind] - record.fixtureBefore[kind]]));
    delete record.fixtureBefore;
    ctx.mock.control.clearFaults();
    ctx.state.editVariant = 'confirmation'; ctx.state.editOverrides = {}; ctx.state.storyboardOptions = {}; ctx.state.researchToolPending = false;
    ctx.current = null;
    await writeFile(join(ctx.artifacts, 'result.json'), ctx.redact(JSON.stringify(ctx.result, null, 2)));
    console.log(`${record.status.toUpperCase()} ${record.id}${record.error ? ' ' + record.error : ''}`);
  }
  return record;
}
