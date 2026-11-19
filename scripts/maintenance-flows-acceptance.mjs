import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeContext, executeScenario, poll, root, appPackage } from './e2e-full-harness.mjs';
import { modelCapability, projectInput } from './e2e-full-business.mjs';
import { modelSpec } from './e2e-full-patterns.mjs';

// 范围专项：只运行本次修复的流程；隔离 userData、真实 IPC/SQLite、本机假 Provider。
const artifacts = resolve(process.env.ECOMGEN_E2E_ARTIFACTS || process.argv[2] || '');
if (!process.env.ECOMGEN_E2E_ARTIFACTS && !process.argv[2]) throw Error('Pass a new artifacts directory');
await mkdir(artifacts, { recursive: true });
if ((await readdir(artifacts)).length) throw Error('Artifacts directory must be empty');
process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
const expectedVersion = JSON.parse(await readFile(appPackage, 'utf8')).version;
const c = await makeContext();
async function screenshot(name) {
  await c.page.evaluate(async () => { await document.fonts.ready; await Promise.allSettled(document.getAnimations().filter(a => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished)); });
  const image = await c.app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('file:'));
    window.show(); if (window.isMinimized()) window.restore();
    if (!window.isVisible()) throw Error('Test window is not visible');
    return (await window.webContents.capturePage()).toPNG().toString('base64');
  });
  const filename = join(c.artifacts, `${name}.png`);
  await writeFile(filename, Buffer.from(image, 'base64'));
  c.current.evidence.push(filename);
}
async function category(name) {
  await c.page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name, exact: true }).click();
  await c.page.getByRole('heading', { name, exact: true }).waitFor();
}
async function launchVisible() {
  await c.launch();
  await c.app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('file:'));
    const area = screen.getPrimaryDisplay().workArea;
    if (window.isMaximized()) window.unmaximize(); if (window.isMinimized()) window.restore();
    window.setBounds({ x: area.x, y: area.y, width: Math.min(1440, area.width), height: Math.min(960, area.height) });
    window.webContents.setZoomFactor(1); window.show(); window.focus();
    if (!window.isVisible()) throw Error('Test window is not visible');
  });
  await c.page.emulateMedia({ reducedMotion: 'reduce' });
}
async function choose(label, text) {
  await c.page.getByRole('combobox', { name: label, exact: true }).click();
  const option = c.page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: text });
  try { await option.click(); }
  catch (error) {
    await c.evidence(`select-${label}`, await c.page.evaluate(() => ({ viewport: [innerWidth, innerHeight], active: document.activeElement?.outerHTML, dropdowns: [...document.querySelectorAll('.ant-select-dropdown')].map(element => ({ classes: element.className, style: element.getAttribute('style'), bounds: element.getBoundingClientRect().toJSON() })) })));
    throw error;
  }
}
async function openProject(project) {
  await c.page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '项目', exact: true }).click();
  await c.page.getByRole('region', { name: '项目画廊' }).getByText(project.name, { exact: true }).click();
  await c.page.getByRole('navigation', { name: '工作阶段' }).getByRole('button').nth(1).click();
}
async function submitReview(jobId, outcome, evidence) {
  const recovery = await c.invoke('getJobRecovery', { jobId });
  const request = recovery.requests.find(request => request.state === 'UNKNOWN');
  await choose('请求记录', request.requestKey);
  await choose('核实结论', outcome);
  const modal = c.page.getByRole('dialog', { name: '核实外部请求', exact: true });
  await modal.getByRole('textbox', { name: '核实依据' }).fill(evidence);
  await modal.getByRole('checkbox').check();
  await modal.getByRole('button', { name: '保存核实记录', exact: true }).click();
  await poll(() => c.invoke('getJobRecovery', { jobId }), value => value.reviews.length > recovery.reviews.length);
}
const scenarios = [
  { id: 'settings-drafts', title: 'Settings draft protection for category changes, global navigation and pricing switches', run: async () => {
    const info = await c.page.evaluate(() => window.ecomgen.application('info', {}));
    c.equal(info.version, expectedVersion);
    const before = c.mock.state.total;
    await c.page.getByRole('button', { name: '设置', exact: true }).click();
    await c.page.getByRole('textbox', { name: '图片文案语言', exact: true }).fill('English');
    await c.page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name: '用量统计', exact: true }).click();
    const leave = c.page.getByRole('dialog', { name: '有未保存的设置', exact: true });
    await leave.getByRole('button', { name: '继续编辑', exact: true }).click();
    c.equal(await c.page.getByRole('textbox', { name: '图片文案语言', exact: true }).inputValue(), 'English');
    await c.page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name: '用量统计', exact: true }).click();
    await leave.getByRole('button', { name: '保存并继续', exact: true }).click();
    await c.page.getByRole('heading', { name: '用量统计', exact: true }).waitFor();
    c.equal((await c.invoke('getApplicationSettings')).defaults.copyLanguage, 'English');
    await category('常规设置');
    await c.page.getByRole('textbox', { name: '图片文案语言', exact: true }).fill('丢弃的草稿');
    await c.page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '项目', exact: true }).click();
    await leave.getByRole('button', { name: '放弃修改', exact: true }).click();
    await c.page.getByRole('region', { name: '项目画廊' }).waitFor();
    c.equal((await c.invoke('getApplicationSettings')).defaults.copyLanguage, 'English');
    await c.page.getByRole('button', { name: '设置', exact: true }).click();
    await category('用量统计');
    await c.page.getByRole('tab', { name: '模型单价', exact: true }).click();
    await choose('选择计价模型', 'mock-reasoner');
    await c.page.getByRole('spinbutton', { name: '每次请求', exact: true }).fill('1.25');
    await choose('选择计价模型', 'mock-image');
    await leave.getByRole('button', { name: '继续编辑', exact: true }).click();
    c.equal(Number(await c.page.getByRole('spinbutton', { name: '每次请求', exact: true }).inputValue()), 1.25);
    await c.page.getByRole('tab', { name: '请求与业务明细', exact: true }).click();
    await leave.getByRole('button', { name: '放弃修改', exact: true }).click();
    await c.page.getByRole('tab', { name: '模型单价', exact: true }).click();
    c.equal(await c.page.getByRole('spinbutton', { name: '每次请求', exact: true }).inputValue(), '');
    c.equal((await c.invoke('listModelPricing')).items.length, 0);
    c.equal(c.mock.state.total, before, 'saving or abandoning settings never invokes a model');
    await screenshot('settings-draft-protection');
  } },
  { id: 'unknown-review-restart-retry', title: 'Unknown request survives restart, explicit review ends it without sending and separate retry succeeds', run: async () => {
    const project = await c.invoke('createProject', projectInput(c, '核实与恢复专项', { candidatesPerType: 1 }));
    await c.invoke('uploadAsset', { projectId: project.id, kind: 'PRODUCT', role: 'PRODUCT_TRUTH', file: await c.byteFile() });
    const planning = (await c.invoke('saveProjectImagePlanning', { projectId: project.id, expectedRevision: 0, config: { mainCount: 2, detailCount: 0, skuImagesPerGroup: 1, shareImages: false }, skus: [], imageGroups: [] })).planning;
    c.mock.control.failNext('chat', { type: 'drop' });
    const job = await c.invoke('createProductImagePlanningJob', { projectId: project.id, expectedRevision: planning.revision });
    await c.waitJob(job.id, 'UNKNOWN');
    const requests = c.mock.state.total;
    await openProject(project);
    const drawer = c.page.getByRole('dialog', { name: '任务详情', exact: true });
    await c.page.getByRole('button', { name: '任务详情', exact: true }).click();
    await drawer.getByRole('button', { name: '核实请求', exact: true }).click();
    await submitReview(job.id, '尚未确定', '服务商工单仍在核对');
    c.equal((await c.invoke('getJob', { jobId: job.id })).status, 'UNKNOWN');
    await screenshot('unknown-review-unresolved');
    await c.stop(); await launchVisible();
    const persisted = await c.invoke('getJobRecovery', { jobId: job.id });
    c.equal(persisted.reviews.length, 1); c.equal(persisted.canReview, true); c.equal(c.mock.state.total, requests);
    await c.rejects('retryJob', { jobId: job.id });
    await openProject(project);
    await c.page.getByRole('button', { name: '任务详情', exact: true }).click();
    await c.page.getByRole('dialog', { name: '任务详情', exact: true }).getByRole('button', { name: '核实请求', exact: true }).click();
    await submitReview(job.id, '确认失败', '服务商工单确认本次请求失败，没有生成结果');
    c.equal((await c.invoke('getJob', { jobId: job.id })).status, 'FAILED');
    c.equal(c.mock.state.total, requests, 'review never sends a paid request');
    const audited = await c.invoke('getJobRecovery', { jobId: job.id });
    c.equal(audited.requests[0].state, 'VERIFIED_FAILED'); c.equal(audited.reviews.length, 2);
    await screenshot('unknown-review-ended');
    await c.page.getByRole('dialog', { name: '核实外部请求', exact: true }).getByRole('button', { name: '关闭', exact: true }).last().click();
    await c.page.getByRole('dialog', { name: '任务详情', exact: true }).getByRole('button', { name: '重试任务', exact: true }).click();
    await c.waitJob(job.id); c.check(c.mock.state.total > requests, 'only explicit retry sends the replacement request');
    const recovered = await c.invoke('getJobRecovery', { jobId: job.id });
    c.check(recovered.requests.some(request => request.state === 'VERIFIED_FAILED'));
    c.check(recovered.requests.some(request => request.state === 'COMPLETED'));
    const activeItems = async () => (await c.invoke('getStoryboard', { projectId: project.id })).items.filter(item => !item.planningSuperseded);
    const before = await activeItems(); c.equal(before.length, 2);
    const heading = await c.page.getByRole('heading', { name: '图片规划', exact: true }).boundingBox();
    await c.page.mouse.click(heading.x + 15, heading.y + 15);
    await c.page.getByRole('dialog', { name: '任务详情', exact: true }).waitFor({ state: 'hidden' });
    c.check(true, 'outside click dismisses task drawer');
    const card = c.page.locator(`[data-storyboard-item-id="${before[0].id}"]`);
    await card.getByRole('button', { name: /删除/ }).click();
    const confirmation = c.page.getByRole('dialog', { name: '取消此图片需求？', exact: true });
    await confirmation.getByRole('button', { name: '保留需求', exact: true }).click();
    c.equal((await activeItems()).length, 2);
    await card.getByRole('button', { name: /删除/ }).click();
    await confirmation.getByRole('button', { name: '取消图片需求', exact: true }).click();
    const after = await poll(activeItems, items => items.length === 1);
    c.equal(after[0].id, before[1].id);
    await confirmation.waitFor({ state: 'hidden' });
    await c.page.locator(`[data-storyboard-item-id="${before[0].id}"]`).waitFor({ state: 'hidden' });
    c.equal(await c.page.locator('[data-storyboard-item-id]').count(), 1, 'deleted card disappears from the rendered planning page');
    await screenshot('planning-card-deletion');
  } },
  { id: 'persistent-listing-and-model-history', title: 'Listing results and unknown model casts remain discoverable after app restart', run: async () => {
    const pattern = await c.invoke('uploadPattern', { file: await c.byteFile(c.reference), name: '持久文案专项', tags: JSON.stringify(['synthetic']) });
    const listingJob = await c.invoke('createPatternListingJob', { patternId: pattern.id, providerId: c.state.provider.id, modelId: 'mock-reasoner', platform: 'ETSY', sellingPoints: 'Synthetic botanical artwork', bannedWords: 'disney', idempotencyKey: 'maintenance-listing' });
    await c.waitJob(listingJob.id);
    const result = await c.invoke('getPatternListingResult', { patternId: pattern.id, jobId: listingJob.id });
    const model = await c.invoke('createModel', { name: '待核实定妆专项', spec: modelSpec, notes: 'Synthetic fixture' });
    c.mock.control.failNext('image-generation', { type: 'drop' });
    const cast = await c.invoke('createModelCastJob', { modelId: model.id, providerId: c.state.provider.id, imageModelId: 'mock-image', aspectRatio: 'AUTO', candidateCount: 1 });
    await c.waitJob(cast.id, 'UNKNOWN');
    const requests = c.mock.state.total;
    await c.stop(); await launchVisible();
    const history = await c.invoke('listPatternListingHistory', { patternId: pattern.id });
    c.equal(history.items[0].job.id, listingJob.id); c.equal(history.items[0].sellingPoints, 'Synthetic botanical artwork');
    await c.page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '花型工坊', exact: true }).click();
    await c.page.locator(`[data-pattern-id="${pattern.id}"]`).click();
    await c.page.getByRole('button', { name: /分步操作/ }).click();
    await c.page.locator('[aria-label="文案历史"]').getByRole('button').first().click();
    await c.page.getByText(result.copy.title, { exact: true }).waitFor();
    await c.page.getByText(result.copy.title, { exact: true }).scrollIntoViewIfNeeded();
    c.check(true, 'persisted listing title is visible'); await screenshot('listing-history-result');
    await c.page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '模特库', exact: true }).click();
    await c.page.getByRole('button', { name: '核实请求', exact: true }).click();
    await c.page.getByRole('dialog', { name: '核实外部请求', exact: true }).waitFor();
    c.equal((await c.invoke('listModelCastHistory', { modelId: model.id })).items[0].id, cast.id);
    c.equal(c.mock.state.total, requests, 'history navigation and restart never resubmit');
    await screenshot('model-cast-persistent-unknown');
  } },
];
try {
  await launchVisible();
  c.state.provider = await c.invoke('createProvider', { name: '流程维护专项', baseUrl: c.mock.baseUrl, apiKey: c.fakeKey, reasoningProtocol: 'openai', models: [modelCapability('mock-reasoner'), modelCapability('mock-image', { imageApiKind: 'openai_images' })] });
  for (const scenario of scenarios) await executeScenario(c, scenario);
} catch (error) { c.result.fatal = c.redact(error.message); }
finally {
  c.result.cleanupErrors = await c.cleanup();
  c.result.rendererErrors = c.state.events.filter(event => event.type === 'pageerror');
  c.result.scope = 'Maintenance flows only; isolated real Electron, IPC and SQLite with local synthetic Provider. No real user data or paid model calls.';
  c.result.integration = !c.result.fatal && !c.result.cleanupErrors.length && !c.result.rendererErrors.length && c.result.scenarios.length === scenarios.length && c.result.scenarios.every(row => row.status === 'passed') ? 'passed' : 'failed';
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(c.result, null, 2));
  console.log(JSON.stringify({ integration: c.result.integration, scenarios: c.result.scenarios.map(row => ({ id: row.id, status: row.status, assertions: row.assertions })), fatal: c.result.fatal }));
  process.exitCode = c.result.integration === 'passed' ? 0 : 1;
}
