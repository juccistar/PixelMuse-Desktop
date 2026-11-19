import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeContext, executeScenario, poll, items, root, appPackage } from './e2e-full-harness.mjs';
import { modelCapability, projectInput, plan, generate } from './e2e-full-business.mjs';

// Run only after a unified build. The shipped renderer/preload/main/Backend stay
// intact; the harness owns its profile, loopback Provider and OS dialog sinks.
const expectedVersion = JSON.parse(await readFile(appPackage, 'utf8')).version;
const artifacts = resolve(process.env.ECOMGEN_E2E_ARTIFACTS || join(root, '.cache/e2e-full', `settings-${Date.now()}-${randomUUID()}`));
await mkdir(artifacts, { recursive: true });
assert.equal((await readdir(artifacts)).length, 0, 'Use a new empty artifacts directory');
process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
const c = await makeContext();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const native = (operation, input = {}) => c.page.evaluate(({ operation, input }) => window.ecomgen.application(operation, input), { operation, input });
const zoom = () => c.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('file:')).webContents.getZoomFactor());
const closeEnough = expected => async () => { await poll(zoom, value => Math.abs(value - expected) < 0.0001, { label: `native zoom ${expected}` }); c.check(true, 'actual webContents zoom matches persisted preference'); };
async function category(name) {
  await c.page.getByRole('button', { name: '设置', exact: true }).click();
  await c.page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name, exact: true }).click();
  await c.page.getByRole('heading', { name, exact: true }).waitFor();
}
async function select(label, option) {
  await c.page.getByRole('combobox', { name: label, exact: true }).click();
  await c.page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: option }).click();
}
async function dialogs(path) {
  await c.app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => path ? { canceled: false, filePath: path } : { canceled: true }; }, path);
}
async function notificationSink() {
  await c.app.evaluate(({ Notification }) => {
    globalThis.__settingsNotificationCount = 0;
    Notification.prototype.show = function () { globalThis.__settingsNotificationCount++; };
  });
}
const notificationCount = () => c.app.evaluate(() => globalThis.__settingsNotificationCount);
async function rejectedNative(operation, input) {
  const result = await c.page.evaluate(async ({ operation, input }) => {
    try { await window.ecomgen.application(operation, input); return { rejected: false }; }
    catch (error) { return { rejected: true, message: error.message }; }
  }, { operation, input });
  c.equal(result.rejected, true);
  c.check(!result.message.includes(c.fixture) && !result.message.includes(c.fakeKey), 'native errors are public safe');
}

const scenarios = [
  { id: 'settings-native-boundary', title: 'Typed app information, trusted frame boundary, fixed directories, safe diagnostic and CSV saves', run: async () => {
    const info = await native('info'); c.equal(info.name, 'PixelMuse'); c.equal(info.version, expectedVersion);
    c.equal(Object.keys(info).sort(), ['name', 'version', 'platform', 'arch', 'electronVersion', 'chromeVersion', 'nodeVersion', 'packaged', 'notificationsSupported'].sort());
    const forbidden = await c.app.evaluate(async ({ BrowserWindow, ipcMain }) => {
      const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('file:'));
      return ipcMain._invokeHandlers.get('ecomgen:application')({ sender: window.webContents, senderFrame: null }, 'info', {});
    });
    c.equal(forbidden.ok, false); c.equal(forbidden.error.code, 'FORBIDDEN');
    await rejectedNative('openDirectory', { target: 'C:/private' });
    await rejectedNative('openDirectory', { target: 'logs', path: 'C:/private' });
    await rejectedNative('notAnOperation', {});
    await c.app.evaluate(({ shell }) => { globalThis.__settingsOpenedPaths = []; shell.openPath = async path => { globalThis.__settingsOpenedPaths.push(path); return ''; }; });
    await native('openDirectory', { target: 'applicationData' }); await native('openDirectory', { target: 'logs' });
    c.equal(await c.app.evaluate(() => globalThis.__settingsOpenedPaths), [c.userData, join(c.userData, 'logs')]);
    await appendFile(join(c.userData, 'logs/main.log'), `\nsynthetic private log ${c.fakeKey} https://private.invalid PRODUCT_TRUTH synthetic-private-facts\n`);
    const path = join(c.artifacts, 'safe-diagnostics.json'); await dialogs(path);
    c.equal(await native('exportDiagnostics'), { saved: true });
    const diagnostics = JSON.parse(await readFile(path, 'utf8'));
    c.equal(Object.keys(diagnostics).sort(), ['formatVersion', 'generatedAt', 'application', 'health'].sort());
    c.equal(Object.keys(diagnostics.health).sort(), ['backend', 'workspace']);
    c.equal(diagnostics.application, info); c.equal(diagnostics.health.backend, 'READY');
    c.check(Number.isFinite(Date.parse(diagnostics.generatedAt)));
    for (const privateValue of [c.fakeKey, c.fixture, 'private.invalid', 'synthetic-private-facts', 'PRODUCT_TRUTH']) c.check(!JSON.stringify(diagnostics).includes(privateValue), 'diagnostics exclude private data');
    await dialogs(null); c.equal(await native('exportDiagnostics'), { saved: false });
    const csv = { name: 'settings-usage.csv', base64: Buffer.from('model,requests\r\nsynthetic,1\r\n').toString('base64') };
    const csvPath = join(c.artifacts, csv.name); await dialogs(csvPath);
    c.equal(await native('saveUsageReport', csv), { saved: true }); c.equal((await readFile(csvPath)).toString('base64'), csv.base64);
    for (const invalid of [{ ...csv, name: '../bad.csv' }, { ...csv, name: 'bad.exe' }, { ...csv, mimeType: 'text/csv' }, { ...csv, base64: 'AB==' }]) await rejectedNative('saveUsageReport', invalid);
    await dialogs(join(c.artifacts, 'bad.exe')); await rejectedNative('saveUsageReport', csv);
    await dialogs(null); c.equal(await native('saveUsageReport', csv), { saved: false });
    c.state.nativeInfo = info;
  } },
  { id: 'settings-model-ui', needs: ['settings-native-boundary'], title: 'Model connection saved through the actual settings UI without generation, blank key edit retains encrypted key', run: async () => {
    c.state.provider = await c.invoke('createProvider', { name: 'Existing connection', baseUrl: c.mock.baseUrl, apiKey: c.fakeKey, reasoningProtocol: 'openai', models: [modelCapability('mock-reasoner'), modelCapability('mock-image', { imageApiKind: 'openai_images' })] });
    c.state.existing = await c.invoke('createProject', projectInput(c, 'Existing project preserves selection'));
    c.state.masterKeyHash = digest(await readFile(join(c.userData, 'master-key.enc')));
    await category('模型配置'); await c.page.getByRole('tab', { name: '服务连接', exact: true }).click();
    await c.page.getByRole('button', { name: '添加服务连接', exact: true }).click();
    const form = c.page.getByRole('dialog', { name: '添加模型与服务连接', exact: true });
    await form.getByLabel('名称', { exact: true }).fill('Settings UI connection');
    await form.getByLabel('Base URL', { exact: true }).fill(c.mock.baseUrl);
    await form.getByLabel('API Key').fill(c.fakeKey);
    await form.getByPlaceholder('模型 ID，如 gpt-image-1').fill('mock-reasoner');
    await form.getByRole('button', { name: '添加模型', exact: true }).click();
    await form.getByPlaceholder('模型 ID，如 gpt-image-1').nth(1).fill('mock-image');
    await form.getByRole('combobox', { name: '模型 2 的模型类型', exact: true }).click();
    await c.page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'OpenAI Images' }).click();
    const before = c.mock.state.total;
    await form.getByRole('button', { name: '添加', exact: true }).click();
    c.state.uiProvider = await poll(async () => items(await c.invoke('listProviders')).find(p => p.name === 'Settings UI connection'), Boolean, { label: 'UI connection persisted' });
    c.equal(c.state.uiProvider.hasApiKey, true); c.equal(c.mock.state.total, before, 'save makes no model request');
    await form.waitFor({ state: 'hidden' });
    await c.page.getByRole('row').filter({ has: c.page.getByText('Settings UI connection', { exact: true }) }).getByRole('button', { name: '编辑', exact: true }).click();
    const edit = c.page.getByRole('dialog', { name: '编辑模型与服务连接', exact: true });
    await edit.waitFor(); c.equal(await edit.getByLabel('API Key').inputValue(), '');
    await edit.getByLabel('名称', { exact: true }).fill('Settings UI retained key');
    await edit.getByRole('button', { name: '保存', exact: true }).click();
    const saved = await poll(async () => items(await c.invoke('listProviders')).find(p => p.id === c.state.uiProvider.id), p => p?.name === 'Settings UI retained key', { label: 'blank key edit retained identity' });
    c.equal(saved.hasApiKey, true); c.equal(saved.id, c.state.uiProvider.id); c.equal(c.mock.state.total, before);
    c.equal(digest(await readFile(join(c.userData, 'master-key.enc'))), c.state.masterKeyHash);
    await edit.waitFor({ state: 'hidden' });
    const probe = await c.invoke('testProviderConnection', { providerId: saved.id, modelId: 'mock-reasoner', kind: 'reasoning' }); c.equal(probe.ok, true);
    await c.page.getByRole('tab', { name: '默认用途', exact: true }).click();
    await select('默认推理模型', `${saved.name} / mock-reasoner`);
    await poll(() => c.invoke('getApplicationSettings'), value => value.defaults.reasoningModel?.providerId === saved.id, { label: 'reasoning default saved by UI' });
    await select('默认生图模型', `${saved.name} / mock-image`);
    const settings = await poll(() => c.invoke('getApplicationSettings'), value => value.defaults.imageModel?.providerId === saved.id, { label: 'image default saved by UI' });
    await category('常规设置');
    await select('提示词语言', '英文'); await select('图片尺寸', '2K'); await select('每类候选数量', '2 张');
    await c.page.getByRole('button', { name: '保存常规设置', exact: true }).click();
    await poll(() => c.invoke('getApplicationSettings'), value => value.defaults.promptLanguage === 'ENGLISH' && value.defaults.imageResolution === '2K' && value.defaults.candidatesPerType === 2, { label: 'creation preferences saved through UI' });
    await c.page.getByRole('button', { name: '项目', exact: true }).click();
    await c.page.getByRole('button', { name: '新建项目', exact: true }).click();
    const created = await poll(async () => items(await c.invoke('listProjects')).find(p => p.id !== c.state.existing.id), Boolean, { label: 'new UI project uses global defaults' });
    const project = await c.invoke('getProject', { projectId: created.id });
    c.equal(project.reasoningProviderId, saved.id); c.equal(project.imageProviderId, saved.id); c.equal(project.promptLanguage, 'ENGLISH'); c.equal(project.imageResolution, '2K'); c.equal(project.candidatesPerType, 2);
    const existing = await c.invoke('getProject', { projectId: c.state.existing.id }); c.equal(existing.reasoningProviderId, c.state.provider.id); c.equal(existing.imageProviderId, c.state.provider.id); c.equal(existing.imageResolution, '1K');
    c.state.created = project; await c.screenshot('models-defaults');
  } },
  { id: 'settings-scale-startup', needs: ['settings-model-ui'], title: 'General UI applies scale, persists across restart, restores startup page, and resets native zoom to 100%', run: async () => {
    await category('常规设置'); await select('界面缩放', '120%'); await select('启动时打开', '恢复上次创作页面');
    await c.page.getByRole('button', { name: '保存常规设置', exact: true }).click();
    await poll(() => c.invoke('getApplicationSettings'), value => value.interfaceScale === 1.2 && value.startupPage === 'last', { label: 'general UI settings saved' });
    await closeEnough(1.2)();
    await c.page.getByRole('button', { name: '资产库', exact: true }).click();
    await poll(() => c.invoke('getApplicationSettings'), value => value.lastWorkspaceRoute === '/library', { label: 'last workspace route recorded' });
    await c.stop(); await c.launch(); await closeEnough(1.2)();
    await poll(() => c.page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '资产库', exact: true }).getAttribute('aria-current'), value => value === 'page', { label: 'startup restores library after renderer settings query' });
    c.check(true, 'persisted startup preference restores the actual route');
    await category('常规设置'); await select('界面缩放', '100%'); await select('启动时打开', '所有项目');
    await c.page.getByRole('button', { name: '保存常规设置', exact: true }).click();
    await poll(() => c.invoke('getApplicationSettings'), value => value.interfaceScale === 1 && value.startupPage === 'projects', { label: '100% reset persisted' });
    await closeEnough(1)(); await c.stop(); await c.launch(); await closeEnough(1)();
    await c.page.getByRole('region', { name: '项目画廊' }).waitFor();
    c.equal(digest(await readFile(join(c.userData, 'master-key.enc'))), c.state.masterKeyHash);
    c.equal((await c.invoke('getProject', { projectId: c.state.existing.id })).reasoningProviderId, c.state.provider.id);
    await c.screenshot('startup-projects');
  } },
  { id: 'settings-usage-notifications', needs: ['settings-scale-startup'], title: 'Actual planning and generation produce unique usage rows and CSV, enabled terminal notifications have no historical duplicates', run: async () => {
    await notificationSink(); await c.invoke('updateApplicationSettings', { taskNotifications: true });
    const filter = { projectId: c.state.existing.id };
    const before = await c.invoke('getUsageSummary', filter);
    const existingAssets = await c.invoke('listAssets', { projectId: c.state.existing.id });
    if (!existingAssets.items.some(asset => asset.role === 'PRODUCT_TRUTH')) await c.invoke('uploadAsset', { projectId: c.state.existing.id, role: 'PRODUCT_TRUTH', file: await c.byteFile(c.image) });
    const requestBefore = c.mock.state.total;
    c.mock.control.failNext('chat', { type: 'delay', ms: 1000 });
    const board = await plan(c, c.state.existing); const generated = await generate(c, c.state.existing, board);
    const summary = await c.invoke('getUsageSummary', filter); const rows = await c.invoke('listUsage', { ...filter, limit: 200 });
    c.check(summary.requestCount > before.requestCount, 'real protocol requests recorded');
    const actualRequests = c.mock.state.records.filter(record => record.id > requestBefore && record.method === 'POST' && ['chat', 'responses', 'gemini', 'image-generation', 'image-edit'].includes(record.kind));
    c.equal(summary.requestCount - before.requestCount, actualRequests.length, 'usage count matches actual model protocol requests, excluding resource downloads');
    c.equal(summary.taskCount - before.taskCount, 1 + generated.submission.jobs.length, 'task count remains separate from request count');
    c.equal(rows.total, summary.requestCount); c.equal(new Set(rows.items.map(row => `${row.jobId}:${row.requestKey}`)).size, rows.items.length);
    c.equal(summary.completedCount, rows.items.filter(row => row.state === 'COMPLETED').length);
    c.equal(summary.inFlightCount, 0); c.check(summary.outputCount >= generated.outputs.length);
    const tokenRows = rows.items.filter(row => row.inputTokens !== null);
    c.equal(summary.inputTokens, tokenRows.length ? tokenRows.reduce((sum, row) => sum + row.inputTokens, 0) : null);
    c.check(rows.items.every(row => row.inputTokens !== null || row.usageSource === 'UNAVAILABLE'), 'missing usage remains unknown');
    const exported = await c.invoke('exportUsage', filter); c.equal(exported.mimeType, 'text/csv');
    const path = join(c.artifacts, exported.name); await dialogs(path);
    c.equal(await native('saveUsageReport', { name: exported.name, base64: exported.base64 }), { saved: true });
    c.equal((await readFile(path)).toString('base64'), exported.base64); c.check(!(await readFile(path, 'utf8')).includes(c.fakeKey));
    if (c.state.nativeInfo.notificationsSupported) await poll(notificationCount, count => count > 0, { label: 'OS notification sink observes actual terminal transition' });
    else c.equal(await notificationCount(), 0);
    await c.invoke('updateApplicationSettings', { taskNotifications: false });
    const notificationBefore = await notificationCount(); await plan(c, c.state.existing);
    c.equal(await notificationCount(), notificationBefore, 'disabled notification preference honored');
    const persisted = await c.invoke('getUsageSummary', filter); await c.stop(); await c.launch(); await notificationSink();
    const restarted = await c.invoke('getUsageSummary', filter); c.equal(restarted.requestCount, persisted.requestCount); c.equal(restarted.inputTokens, persisted.inputTokens);
    await c.invoke('updateApplicationSettings', { taskNotifications: true }); await c.invoke('listJobs', { limit: 100 });
    c.equal(await notificationCount(), 0, 'enabling on restart does not replay historical terminal jobs');
    await c.evidence('usage', { summary: restarted, rowCount: rows.total, uniqueRequests: true, notificationSupport: c.state.nativeInfo.notificationsSupported });
  } },
  { id: 'settings-pages-pricing-ui', needs: ['settings-usage-notifications'], title: 'All six settings pages render at desktop and minimum size; actual pricing UI affects only subsequent requests', run: async () => {
    await category('用量统计');
    await c.page.getByRole('table', { name: '服务请求明细', exact: true }).waitFor();
    await c.page.getByRole('tab', { name: '模型单价', exact: true }).click();
    await select('选择计价模型', `${c.state.provider.name} / mock-image`);
    await c.page.getByRole('spinbutton', { name: '每次请求', exact: true }).fill('0.04');
    const before = c.mock.state.total;
    await c.page.getByRole('button', { name: '保存模型单价', exact: true }).click();
    await poll(() => c.invoke('listModelPricing', {}), value => value.items.some(item => item.providerId === c.state.provider.id && item.modelId === 'mock-image' && item.perRequest === 0.04), { label: 'model price saved by actual UI' });
    c.equal(c.mock.state.total, before, 'saving price never invokes a model');
    const board = await plan(c, c.state.existing);
    const generated = await generate(c, c.state.existing, board, { revision: 'Change the background to soft blue while preserving exact product identity.' });
    const priced = await c.invoke('listUsage', { projectId: c.state.existing.id, modelId: 'mock-image', limit: 200 });
    const recorded = priced.items.filter(item => generated.submission.jobs.some(job => job.id === item.jobId));
    c.check(recorded.length > 0 && recorded.every(item => item.estimatedAmount === 0.04 && item.currency === 'USD'), 'new requests use configured price snapshot');
    await c.page.getByRole('spinbutton', { name: '每次请求', exact: true }).fill('0.08');
    await c.page.getByRole('button', { name: '保存模型单价', exact: true }).click();
    await poll(() => c.invoke('listModelPricing', {}), value => value.items.some(item => item.providerId === c.state.provider.id && item.modelId === 'mock-image' && item.perRequest === 0.08), { label: 'updated model price saved by actual UI' });
    const unchanged = await c.invoke('listUsage', { projectId: c.state.existing.id, modelId: 'mock-image', limit: 200 });
    for (const entry of recorded) c.equal(unchanged.items.find(item => item.id === entry.id)?.estimatedAmount, 0.04, 'price edits do not change historical estimate');
    const sections = ['常规设置', '模型配置', '用量统计', '工作空间与数据', '搜索与采集', '关于 PixelMuse'];
    for (const width of [1440, 1000]) {
      await c.app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:')).setSize(width, width === 1000 ? 740 : 960), width);
      for (const section of sections) {
        await category(section);
        await poll(() => c.page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name: section, exact: true }).getAttribute('aria-current'), value => value === 'page', { label: `settings section ${section}` });
        const sidebar = c.page.getByRole('complementary', { name: '工作空间侧栏', exact: true });
        c.equal(await sidebar.getByRole('button', { name: /本地工作空间|工作空间位置|选择工作空间目录/ }).count(), 0, 'sidebar has no workspace configuration entrypoints');
        c.equal(await c.page.getByRole('dialog', { name: '本地工作空间', exact: true }).count(), 0, 'obsolete workspace modal is absent');
        if (section === '工作空间与数据') {
          const panel = c.page.getByRole('region', { name: '设置内容', exact: true });
          await panel.getByLabel('当前工作空间目录').waitFor();
          c.equal(await c.page.getByRole('button', { name: '选择工作空间目录', exact: true }).count(), 1, 'only storage settings exposes directory selection');
          const current = await c.page.evaluate(() => window.ecomgen.workspace('status', {}));
          c.equal(await panel.getByLabel('当前工作空间目录').textContent(), current.directory, 'storage settings displays the actual native directory');
        } else c.equal(await c.page.getByRole('button', { name: '选择工作空间目录', exact: true }).count(), 0, 'other settings pages have no directory selection');
        const viewport = await c.page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        c.check(viewport.scroll <= viewport.width + 1, `${section} has no document overflow at ${width}`);
        await c.screenshot(`settings-${width}-${sections.indexOf(section) + 1}`);
      }
    }
    await c.page.getByRole('button', { name: '项目', exact: true }).click();
    await c.page.getByRole('region', { name: '项目画廊' }).getByText(c.state.created.name, { exact: true }).click();
    await c.page.getByLabel('项目名称', { exact: true }).waitFor();
    const beforePaste = await c.invoke('listAssets', { projectId: c.state.created.id });
    const pastedFile = await c.byteFile(c.image);
    const pasteImage = () => c.page.evaluate(file => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(file.base64), char => char.charCodeAt(0))], 'settings-paste.png', { type: file.mimeType }));
      document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }, pastedFile);
    await category('常规设置'); await pasteImage();
    const pasteDeadline = Date.now() + 1000;
    await poll(async () => {
      const assets = await c.invoke('listAssets', { projectId: c.state.created.id });
      c.equal(assets.items.map(item => item.id), beforePaste.items.map(item => item.id), 'image paste in settings does not upload into hidden project');
      return Date.now() >= pasteDeadline;
    }, Boolean, { label: 'hidden business image paste remains inactive' });
    await c.page.getByRole('button', { name: '返回创作页面', exact: true }).click();
    await c.page.getByLabel('项目名称', { exact: true }).waitFor(); await pasteImage();
    await poll(() => c.invoke('listAssets', { projectId: c.state.created.id }), assets => assets.items.length === beforePaste.items.length + 1, { label: 'image paste resumes after returning to source project' });
    c.check(true, 'same document paste is effective only in active business workspace');
    await c.page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '项目', exact: true }).click();
    await c.page.getByRole('region', { name: '项目画廊' }).getByText(c.state.existing.name, { exact: true }).click();
    await c.page.getByRole('navigation', { name: '工作阶段' }).getByRole('button', { name: '3 结果', exact: true }).click();
    const lightbox = c.page.getByRole('button', { name: '灯箱', exact: true }).first();
    await lightbox.locator('xpath=ancestor::article').hover(); await lightbox.click();
    await c.page.getByRole('button', { name: '编辑图片', exact: true }).click();
    const editor = c.page.getByRole('dialog', { name: '编辑图片', exact: true }); await editor.waitFor();
    const draft = editor.getByPlaceholder('例如：把选中的菠萝颜色调得更金黄，保留叶片和背景光线');
    await draft.fill('Preserve this unsent edit draft while configuring models.');
    const editorCanvas = editor.locator('canvas[data-tool]').first();
    await poll(() => editorCanvas.evaluate(canvas => ({ width: canvas.width, height: canvas.height })), size => size.width > 0 && size.height > 0, { label: 'retained source editor canvas initialized' });
    await editor.getByRole('button', { name: '涂抹可编辑区域', exact: true }).click();
    await editorCanvas.scrollIntoViewIfNeeded();
    const canvasBox = await editorCanvas.boundingBox(); c.check(Boolean(canvasBox), 'source editor canvas has a real pointer surface');
    await c.page.mouse.move(canvasBox.x + canvasBox.width * 0.35, canvasBox.y + canvasBox.height * 0.35); await c.page.mouse.down();
    await c.page.mouse.move(canvasBox.x + canvasBox.width * 0.55, canvasBox.y + canvasBox.height * 0.55, { steps: 8 }); await c.page.mouse.up();
    await poll(() => editorCanvas.evaluate(canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some(value => value !== 0)), Boolean, { label: 'source mask stroke drawn before settings navigation' });
    // The display canvas also draws the hover brush outline. Compare the persisted
    // stroke with the pointer outside the canvas on both sides of navigation.
    await editor.getByRole('heading', { name: '告诉我想怎么改', exact: true }).hover();
    await c.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const beforeSettingsCanvas = await editorCanvas.evaluate(canvas => canvas.toDataURL());
    await editor.getByRole('button', { name: /本次生成设置/ }).click();
    await editor.getByRole('button', { name: '管理模型', exact: true }).first().click();
    await c.page.getByRole('heading', { name: '模型配置', exact: true }).waitFor();
    c.equal(await editor.isVisible(), false, 'source editor portal is inactive while settings is visible');
    await c.page.getByRole('button', { name: '返回创作页面', exact: true }).click();
    await editor.waitFor(); c.equal(await draft.inputValue(), 'Preserve this unsent edit draft while configuring models.', 'return preserves unsent editor text');
    c.equal(await editorCanvas.evaluate(canvas => canvas.toDataURL()), beforeSettingsCanvas, 'return preserves source editor canvas');
    await c.screenshot('settings-retained-source-editor');
    const closeButtons = c.page.locator('.ant-modal:visible .ant-modal-close, .ant-drawer:visible .ant-drawer-close');
    while (await closeButtons.count()) { const count = await closeButtons.count(); await closeButtons.last().click(); await poll(() => closeButtons.count(), remaining => remaining < count, { label: 'close retained source editor dialogs' }); }
    await c.invoke('updateApplicationSettings', { interfaceScale: 1.3 }); await closeEnough(1.3)(); await category('常规设置');
    const scaled = await c.page.evaluate(() => {
      const panel = document.querySelector('[aria-label="设置内容"]');
      const controls = [...panel.querySelectorAll('button,input,select,textarea,.ant-select')].map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0);
      return { width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth, controlBounds: controls.map(({ left, right }) => ({ left, right })) };
    });
    c.check(scaled.scroll <= scaled.width + 1, '130% scale has no document overflow');
    c.check(scaled.controlBounds.length > 0 && scaled.controlBounds.every(rect => rect.left >= 0 && rect.right <= scaled.width + 1), '130% scale retains full horizontal form controls');
    const returnBounds = await c.page.getByRole('button', { name: '返回创作页面', exact: true }).evaluate(element => element.getBoundingClientRect().toJSON());
    c.check(returnBounds.left >= 0 && returnBounds.right <= scaled.width + 1, '130% scale retains the complete return button');
    // Playwright capture clips Electron zoomed views to CSS dimensions. Native
    // capture records the whole rendered window at its actual pixel dimensions.
    const nativeScreen = await c.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:')).webContents.capturePage()).toPNG().toString('base64'));
    await writeFile(join(c.artifacts, 'settings-minimum-130-native.png'), Buffer.from(nativeScreen, 'base64'));
    await c.evidence('scaled-control-geometry', scaled);
    const saveSettings = c.page.getByRole('button', { name: '保存常规设置', exact: true });
    await saveSettings.scrollIntoViewIfNeeded();
    const saveBounds = await saveSettings.evaluate(element => element.getBoundingClientRect().toJSON());
    c.check(saveBounds.left >= 0 && saveBounds.right <= scaled.width + 1 && saveBounds.top >= 0 && saveBounds.bottom <= scaled.height + 1, '130% scale allows scrolling the save action fully into view');
    await saveSettings.click();
    await c.page.getByText('常规设置已保存', { exact: true }).waitFor();
    c.equal((await c.invoke('getApplicationSettings')).interfaceScale, 1.3, 'actual save remains functional at 130% scale');
    await c.invoke('updateApplicationSettings', { interfaceScale: 1 }); await closeEnough(1)();
    await c.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:')).setSize(1440, 960));
    c.check(!c.state.events.some(event => event.type === 'pageerror'), 'settings operations have no renderer page errors');
  } },
];

try {
  await c.launch();
  for (const scenario of scenarios) await executeScenario(c, scenario);
  c.result.integration = c.result.scenarios.every(scenario => scenario.status === 'passed') ? 'passed' : 'failed';
} catch (error) {
  c.result.integration = 'failed'; c.result.error = c.redact(error.message);
} finally {
  c.result.cleanupErrors = await c.cleanup();
  let temporaryUserDataRemoved = false;
  try { await readdir(c.fixture); } catch (error) { if (error.code === 'ENOENT') temporaryUserDataRemoved = true; else c.result.cleanupErrors.push(c.redact(error.message)); }
  c.result.cleanup = { status: c.result.cleanupErrors.length === 0 && temporaryUserDataRemoved ? 'passed' : 'failed', temporaryUserDataRemoved, errors: c.result.cleanupErrors };
  c.result.globalChecks = { rendererErrors: c.state.events.filter(event => event.type === 'pageerror').length, fixtureCallbackErrors: c.mock.state.callbackErrors };
  if (c.result.cleanup.status !== 'passed' || c.result.globalChecks.rendererErrors || c.result.globalChecks.fixtureCallbackErrors) c.result.integration = 'failed';
  c.result.finishedAt = new Date().toISOString();
  await writeFile(join(c.artifacts, 'result.json'), c.redact(JSON.stringify(c.result, null, 2)));
}
console.log(JSON.stringify({ integration: c.result.integration, result: join(c.artifacts, 'result.json') }));
if (c.result.integration !== 'passed') process.exitCode = 1;
