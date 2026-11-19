import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { makeContext, executeScenario, poll, appPackage } from './e2e-full-harness.mjs';
import { modelCapability, projectInput } from './e2e-full-business.mjs';

// 定向维护验证：真实窗口/IPC/SQLite，断连由本机假 Provider 制造。
const artifacts = resolve(process.env.ECOMGEN_E2E_ARTIFACTS || process.argv[2] || '');
if (!process.env.ECOMGEN_E2E_ARTIFACTS && !process.argv[2]) throw Error('Pass a new artifacts directory');
await mkdir(artifacts, { recursive: true });
if ((await readdir(artifacts)).length) throw Error('Artifacts directory must be empty');
process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
const version = JSON.parse(await readFile(appPackage, 'utf8')).version;
const c = await makeContext();
const paidCalls = () => ['chat', 'responses', 'image-generation', 'image-edit'].reduce((sum, kind) => sum + (c.mock.state.counts[kind] || 0), 0);
const drawer = () => c.page.getByRole('dialog', { name: '任务详情', exact: true });
async function launch() {
  await c.launch();
  await c.app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('file:'));
    const area = screen.getPrimaryDisplay().workArea;
    if (window.isMaximized()) window.unmaximize();
    if (window.isMinimized()) window.restore();
    window.setBounds({ x: area.x, y: area.y, width: Math.min(1440, area.width), height: Math.min(960, area.height) });
    window.webContents.setZoomFactor(1); window.show(); window.focus();
    if (!window.isVisible()) throw Error('Test window is not visible');
  });
  await c.page.emulateMedia({ reducedMotion: 'reduce' });
}
async function screenshot(name) {
  await c.page.evaluate(async () => { await document.fonts.ready; });
  const data = await c.app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('file:'));
    if (!window.isVisible()) throw Error('Test window is not visible');
    return (await window.webContents.capturePage()).toPNG().toString('base64');
  });
  const path = join(artifacts, `${name}.png`);
  await writeFile(path, Buffer.from(data, 'base64'));
  c.current.evidence.push(path);
}
async function open(project) {
  if (await drawer().isVisible()) await c.page.keyboard.press('Escape');
  await c.page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '项目', exact: true }).click();
  await c.page.getByRole('region', { name: '项目画廊' }).getByText(project.name, { exact: true }).click();
  await c.page.getByRole('navigation', { name: '工作阶段' }).getByRole('button').nth(1).click();
  await c.page.getByRole('button', { name: '任务详情', exact: true }).click();
  await drawer().waitFor();
}
async function noRecoveryForm(existingModals = 0) {
  c.equal(await c.page.locator('.ant-modal:visible').count(), existingModals, 'retry/end never opens an additional modal or fee confirmation');
  c.equal(await c.page.getByRole('textbox', { name: '核实依据', exact: true }).count(), 0, 'no evidence form');
}
async function createProject(name) {
  const project = await c.invoke('createProject', projectInput(c, name, { candidatesPerType: 1 }));
  await c.invoke('uploadAsset', { projectId: project.id, kind: 'PRODUCT', role: 'PRODUCT_TRUTH', file: await c.byteFile() });
  const { planning } = await c.invoke('saveProjectImagePlanning', { projectId: project.id, expectedRevision: 0, config: { mainCount: 3, detailCount: 0, skuImagesPerGroup: 1, shareImages: false }, skus: [], imageGroups: [] });
  return { project, planning };
}
async function generation(project, board, drops) {
  await c.invoke('confirmStoryboard', { projectId: project.id, version: board.storyboard.version });
  const current = board.items.filter(item => !item.planningSuperseded);
  c.check(current.every(item => item.referencedAssets.length > 0), 'fixture generation includes the uploaded product reference');
  for (let index = 0; index < drops; index++) c.mock.control.failNext('image-edit', { type: 'drop' });
  const result = await c.invoke('createGenerationJobs', { projectId: project.id, storyboardItemIds: board.items.filter(item => !item.planningSuperseded).map(item => item.id), generationBatchId: randomUUID(), regenerationKey: randomUUID() });
  await poll(async () => Promise.all(result.jobs.map(job => c.invoke('getJob', { jobId: job.id }))), jobs => jobs.every(job => ['SUCCEEDED', 'UNKNOWN', 'FAILED', 'CANCELLED'].includes(job.status)));
  return Promise.all(result.jobs.map(job => c.invoke('getJob', { jobId: job.id })));
}
const state = {};
const scenarios = [
  { id: 'direct-retry', title: 'Interrupted planning retries on one click with no form or confirmation', run: async () => {
    c.equal((await c.page.evaluate(() => window.ecomgen.application('info', {}))).version, version);
    const { project, planning } = await createProject('直接重试专项'); state.project = project;
    c.mock.control.failNext('chat', { type: 'drop' });
    const job = await c.invoke('createProductImagePlanningJob', { projectId: project.id, expectedRevision: planning.revision });
    await c.waitJob(job.id, 'UNKNOWN');
    const before = paidCalls();
    await open(project);
    await screenshot('interrupted-task-actions');
    c.equal(paidCalls(), before, 'viewing an interrupted task never resends');
    await drawer().getByRole('button', { name: /^(重试任务|重试)$/ }).click();
    await noRecoveryForm();
    await poll(() => c.invoke('getJob', { jobId: job.id }), value => value.status === 'SUCCEEDED');
    c.equal(paidCalls(), before + 1, 'one explicit click sends one replacement planning request');
    state.board = await c.invoke('getStoryboard', { projectId: project.id });
    c.equal(state.board.items.filter(item => !item.planningSuperseded).length, 3);
    const requests = await c.invoke('getJobRequests', { jobId: job.id });
    c.check(requests.items.some(item => item.state === 'COMPLETED'));
    await screenshot('single-retry-completed');
  } },
  { id: 'batch-retry', title: 'One click retries interrupted image tasks and preserves success and other projects', run: async () => {
    const jobs = await generation(state.project, state.board, 2);
    const unknown = jobs.filter(job => job.status === 'UNKNOWN');
    c.equal(unknown.length, 2); c.equal(jobs.filter(job => job.status === 'SUCCEEDED').length, 1);
    const existing = (await c.invoke('listOutputs', { projectId: state.project.id })).items.map(output => output.id);
    c.equal(existing.length, 1);
    const foreign = await createProject('不参与批量处理'); state.foreign = foreign.project;
    c.mock.control.failNext('chat', { type: 'drop' });
    state.foreignJob = await c.invoke('createProductImagePlanningJob', { projectId: foreign.project.id, expectedRevision: foreign.planning.revision });
    await c.waitJob(state.foreignJob.id, 'UNKNOWN');
    const before = paidCalls();
    await drawer().getByRole('button', { name: /^(重试异常任务|批量重试)$/ }).click();
    await noRecoveryForm();
    await poll(async () => Promise.all(unknown.map(job => c.invoke('getJob', { jobId: job.id }))), rows => rows.every(job => job.status === 'SUCCEEDED'));
    c.equal(paidCalls(), before + 2, 'batch replaces exactly the two interrupted image calls');
    const outputs = (await c.invoke('listOutputs', { projectId: state.project.id })).items;
    c.equal(outputs.length, 3); c.check(existing.every(id => outputs.some(output => output.id === id)), 'successful output identity survives retry');
    c.equal((await c.invoke('getJob', { jobId: state.foreignJob.id })).status, 'UNKNOWN');
    state.outputs = outputs.map(output => output.id).sort();
    await screenshot('batch-retry-completed');
  } },
  { id: 'batch-and-single-end', title: 'End all interrupted tasks without calls or output loss, persist after restart', run: async () => {
    const jobs = await generation(state.project, state.board, 3);
    c.equal(jobs.filter(job => job.status === 'UNKNOWN').length, 3);
    const before = paidCalls();
    await drawer().getByRole('button', { name: /^(结束中断任务|批量结束)$/ }).click();
    await noRecoveryForm();
    await poll(async () => Promise.all(jobs.map(job => c.invoke('getJob', { jobId: job.id }))), rows => rows.every(job => job.status === 'CANCELLED'));
    c.equal(paidCalls(), before, 'batch end sends no requests');
    c.equal((await c.invoke('listOutputs', { projectId: state.project.id })).items.map(output => output.id).sort(), state.outputs);
    c.equal((await c.invoke('getJob', { jobId: state.foreignJob.id })).status, 'UNKNOWN', 'batch end is project scoped');
    await open(state.foreign);
    await drawer().getByRole('button', { name: /^(结束任务|结束)$/ }).click();
    await noRecoveryForm();
    await poll(() => c.invoke('getJob', { jobId: state.foreignJob.id }), job => job.status === 'CANCELLED');
    c.equal(paidCalls(), before, 'single end sends no requests');
    await c.stop(); await launch();
    c.equal(paidCalls(), before, 'restart does not resend ended requests');
    c.equal((await c.invoke('getJob', { jobId: state.foreignJob.id })).status, 'CANCELLED');
    c.equal((await c.invoke('listOutputs', { projectId: state.project.id })).items.map(output => output.id).sort(), state.outputs);
    const inspection = await c.inspect(); c.equal(inspection.integrity, 'ok'); c.equal(inspection.foreignKeys, []);
    await open(state.project);
    const endedBoard = await c.invoke('getStoryboard', { projectId: state.project.id });
    c.check(endedBoard.items.filter(item => !item.planningSuperseded).every(item => item.status === 'GENERATED'), 'ending restores completed storyboard state across restart');
    c.equal(await c.page.getByText('生成中', { exact: true }).count(), 0, 'planning cards do not stay busy after ending');
    await screenshot('ended-tasks-after-restart');
  } },
  { id: 'layer-direct-actions', title: 'Layer recognition retries and ends directly inside the editor', run: async () => {
    await c.page.keyboard.press('Escape');
    await c.page.getByRole('navigation', { name: '工作阶段' }).getByRole('button').nth(2).click();
    const card = c.page.locator(`article[data-output-id="${state.outputs[0]}"]`);
    await card.hover(); await card.getByRole('button', { name: /^修改这张 / }).click();
    const editor = c.page.getByRole('dialog').filter({ has: c.page.getByRole('button', { name: '返回成图', exact: true }) });
    await editor.getByRole('button', { name: 'AI 分层导出', exact: true }).click();
    c.mock.control.failNext('chat', { type: 'drop' });
    await editor.getByRole('button', { name: '智能识别', exact: true }).click();
    await editor.getByText('识别任务已中断，可以重试或结束。', { exact: true }).waitFor();
    const plan = await c.invoke('getLayerPlan', { outputId: state.outputs[0] });
    c.equal(plan.status, 'UNKNOWN');
    await screenshot('layer-interrupted-actions');
    const beforeRetry = paidCalls();
    await editor.getByRole('button', { name: '重试任务', exact: true }).click();
    await noRecoveryForm(1);
    await poll(() => c.invoke('getLayerPlan', { outputId: state.outputs[0] }), value => value.status === 'SUCCEEDED');
    await editor.getByRole('button', { name: '重新识别', exact: true }).waitFor();
    c.equal(paidCalls(), beforeRetry + 1, 'layer retry sends exactly one replacement recognition request');
    c.equal((await c.invoke('getLayerPlan', { outputId: state.outputs[0] })).jobId, plan.jobId, 'layer retry keeps the original task association');
    c.mock.control.failNext('chat', { type: 'drop' });
    await editor.getByRole('button', { name: '重新识别', exact: true }).click();
    await editor.getByText('识别任务已中断，可以重试或结束。', { exact: true }).waitFor();
    const beforeEnd = paidCalls();
    await editor.getByRole('button', { name: '结束任务', exact: true }).click();
    await noRecoveryForm(1);
    await poll(() => c.invoke('getLayerPlan', { outputId: state.outputs[0] }), value => value.status === 'CANCELLED');
    await editor.getByText('识别任务已中断，可以重试或结束。', { exact: true }).waitFor({ state: 'hidden' });
    c.equal(await editor.getByRole('button', { name: '智能识别', exact: true }).isEnabled(), true, 'ending refreshes the panel without closing the editor');
    c.equal(paidCalls(), beforeEnd, 'ending a layer task sends no requests');
    c.equal((await c.invoke('listOutputs', { projectId: state.project.id })).items.map(output => output.id).sort(), state.outputs);
    await screenshot('layer-task-ended');
    await editor.getByRole('button', { name: '返回成图', exact: true }).click();
  } },
];
try {
  await launch();
  c.state.provider = await c.invoke('createProvider', { name: '直接恢复专项', baseUrl: c.mock.baseUrl, apiKey: c.fakeKey, reasoningProtocol: 'openai', models: [modelCapability('mock-reasoner'), modelCapability('mock-image', { imageApiKind: 'openai_images' })] });
  for (const scenario of scenarios) await executeScenario(c, scenario);
} catch (error) { c.result.fatal = c.redact(error.message); }
finally {
  c.result.cleanupErrors = await c.cleanup();
  c.result.rendererErrors = c.state.events.filter(event => event.type === 'pageerror');
  c.result.scope = 'Direct task interruption recovery only; isolated real Electron/IPC/SQLite and local synthetic Provider; no real user data or paid external calls.';
  c.result.integration = !c.result.fatal && !c.result.cleanupErrors.length && !c.result.rendererErrors.length && c.result.scenarios.length === scenarios.length && c.result.scenarios.every(row => row.status === 'passed') ? 'passed' : 'failed';
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(c.result, null, 2));
  console.log(JSON.stringify({ integration: c.result.integration, scenarios: c.result.scenarios.map(row => ({ id: row.id, status: row.status, assertions: row.assertions })), fatal: c.result.fatal }));
  process.exitCode = c.result.integration === 'passed' ? 0 : 1;
}
