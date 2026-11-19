import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executeScenario, makeContext, poll } from './e2e-full-harness.mjs';
import { modelCapability, projectInput } from './e2e-full-business.mjs';
import { suiteReply } from './full-mock-replies.mjs';

if (!process.argv[2]) throw new Error('Pass a new empty artifacts directory');
await mkdir(process.argv[2]);
process.env.ECOMGEN_E2E_ARTIFACTS = process.argv[2];
const c = await makeContext();
const state = {};
const stage = index => c.page.getByRole('navigation', { name: '工作阶段' }).getByRole('button').nth(index);
async function screenshot(name) {
  await c.page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.allSettled(document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished));
    await new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)));
  });
  const image = await c.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:')).webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(join(c.artifacts, `${name}.png`), Buffer.from(image, 'base64'));
}
async function home() {
  await c.page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '项目', exact: true }).click();
}
async function openProject(project, index = 0) {
  await home();
  await c.page.getByRole('region', { name: '项目画廊' }).getByText(project.name, { exact: true }).click();
  await stage(index).click();
}
async function chooseSuite(scope = c.page) {
  await scope.getByRole('button', { name: '选择套图', exact: true }).click();
  const picker = c.page.getByRole('dialog').filter({ has: c.page.getByLabel('搜索套图') });
  await picker.getByLabel('搜索套图').fill(state.suite.name);
  const card = picker.locator('article').filter({ hasText: state.suite.name });
  await card.getByRole('button', { name: '选择整卷', exact: true }).click();
  await picker.getByRole('button', { name: /确定选择/ }).click();
}
const scenarios = [
  { id: 'visual-planning-ui', title: 'Actual Electron prepares reference-led plans and displays model sources', run: async () => {
    await c.launch();
    await c.page.emulateMedia({ reducedMotion: 'reduce' });
    await c.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:')); window.setSize(1440, 1000); });
    c.state.provider = await c.invoke('createProvider', { name: '参考规划本机专项', baseUrl: c.mock.baseUrl, apiKey: c.fakeKey, reasoningProtocol: 'openai', models: [modelCapability('mock-reasoner'), modelCapability('mock-image', { imageApiKind: 'openai_images' })] });
    state.projects = [];
    for (const name of ['视觉规划样品甲', '视觉规划样品乙']) {
      const project = await c.invoke('createProject', projectInput(c, name, { platformTargets: [], targetMarket: null, candidatesPerType: 2 }));
      await c.invoke('uploadAsset', { projectId: project.id, role: 'PRODUCT_TRUTH', file: await c.byteFile() });
      await c.invoke('uploadAsset', { projectId: project.id, role: 'STYLE_REFERENCE', file: await c.byteFile(c.reference) });
      state.projects.push(project);
    }
    const source = suiteReply({ name: '参考规划专项套图', shotCount: 2 });
    source.shots = source.shots.map((shot, index) => ({ ...shot, purpose: index ? 'DETAIL' : 'MAIN' }));
    delete source.id;
    state.suite = await c.invoke('createUserSuite', source);
    await openProject(state.projects[0]);
    const mainCount = c.page.getByRole('spinbutton', { name: '主图数量', exact: true });
    await mainCount.fill('2'); await mainCount.blur();
    const strategySection = c.page.getByRole('button', { name: '生成策略', exact: true });
    if (await strategySection.getAttribute('aria-expanded') !== 'true') await strategySection.click();
    await c.page.getByRole('button', { name: '模型自主规划', exact: true }).waitFor();
    c.equal(await c.page.getByRole('button', { name: '手动选择', exact: true }).count(), 0);
    await c.page.getByLabel('风格指导').fill('以参考图光线与构图为主，保持商品身份。');
    await screenshot('autonomous-setup');
    await c.page.getByRole('button', { name: /AI 一键规划/ }).click();
    const plan = await poll(async () => (await c.invoke('listJobs', { projectId: state.projects[0].id })).items.find(job => job.type === 'PLAN'), Boolean, { label: 'UI planning submission' });
    await c.waitJob(plan.id);
    const board = await c.invoke('getStoryboard', { projectId: state.projects[0].id });
    c.equal(board.items.length, 2); c.check(board.items.every(item => item.planningSource?.kind === 'MODEL_DIRECT' && item.candidateCount === 2));
    await stage(1).click();
    await c.page.getByRole('heading', { name: '图片规划', exact: true }).waitFor();
    c.check((await c.page.getByText(/^模型自主规划 ·/).count()) > 0);
    await screenshot('autonomous-storyboard');
  } },
  { id: 'suite-bound-counts-ui', title: 'Actual suite selection edits stable shots and derives image counts', needs: ['visual-planning-ui'], run: async () => {
    await openProject(state.projects[1]);
    const strategySection = c.page.getByRole('button', { name: '生成策略', exact: true });
    if (await strategySection.getAttribute('aria-expanded') !== 'true') await strategySection.click();
    await c.page.getByRole('button', { name: '套图批量规划', exact: true }).click();
    await chooseSuite();
    await c.page.getByLabel('镜头 1 标题').fill('参考主画面');
    await c.page.getByRole('button', { name: '新增镜头', exact: true }).click();
    await c.page.getByLabel('镜头 3 标题').fill('新增参考画面');
    c.equal(await c.page.getByRole('spinbutton', { name: '主图数量', exact: true }).isDisabled(), true);
    c.equal(await c.page.getByRole('spinbutton', { name: '详情图数量', exact: true }).isDisabled(), true);
    await screenshot('suite-shot-editor');
    await c.page.getByRole('button', { name: /AI 一键规划/ }).click();
    const plan = await poll(async () => (await c.invoke('listJobs', { projectId: state.projects[1].id })).items.find(job => job.type === 'PLAN'), Boolean, { label: 'suite UI planning submission' });
    await c.waitJob(plan.id);
    const saved = await c.invoke('getProjectImagePlanning', { projectId: state.projects[1].id });
    const board = await c.invoke('getStoryboard', { projectId: state.projects[1].id });
    c.equal(saved.config.mainCount, 2); c.equal(saved.config.detailCount, 1); c.equal(saved.config.suiteBlueprint.shots.length, 3);
    c.equal(board.items.length, 3); c.check(board.items.every(item => item.planningSource?.kind === 'SUITE'));
    await stage(1).click();
    await c.page.getByRole('button', { name: '保存为套图', exact: true }).click();
    const modal = c.page.getByRole('dialog', { name: '保存为套图', exact: true });
    await modal.getByLabel('套图名称').fill('复用参考方案');
    await modal.getByRole('button', { name: '创建草稿', exact: true }).click();
    const extraction = await poll(async () => (await c.invoke('listJobs', { projectId: state.projects[1].id })).items.find(job => job.type === 'SUITE_FORGE'), Boolean, { label: 'storyboard extraction' });
    await c.waitJob(extraction.id);
    const result = await c.invoke('getSuiteForgeResult', { jobId: extraction.id });
    c.equal(result.suite.shots.length, 3); c.equal(result.suite.shots.map(shot => shot.purpose).sort(), ['DETAIL', 'MAIN', 'MAIN']);
    c.check(result.suite.provenance.detached);
  } },
  { id: 'suite-batch-ui-and-reopen', title: 'Actual cross-product batch planning waits for confirmation and survives restart', needs: ['suite-bound-counts-ui'], run: async () => {
    await home();
    await c.page.getByRole('button', { name: '套图批量创作', exact: true }).click();
    const drawer = c.page.getByRole('dialog', { name: '套图批量创作', exact: true });
    await chooseSuite(drawer);
    for (const project of state.projects) await drawer.getByRole('checkbox', { name: project.name, exact: true }).check();
    await drawer.getByRole('button', { name: '提交批量规划', exact: true }).click();
    const batch = await poll(async () => (await c.invoke('listSuitePlanningBatches', {})).items[0], value => value?.entries.every(entry => entry.planJobId), { label: 'batch created from UI' });
    for (const entry of batch.entries) await c.waitJob(entry.planJobId);
    c.equal((await c.invoke('getSuitePlanningBatch', { batchId: batch.id })).entries.filter(entry => entry.ready).length, 2);
    c.equal(batch.entries.flatMap(entry => entry.generationJobIds).length, 0);
    await screenshot('batch-planning-ready');
    await drawer.getByRole('button', { name: '打开商品', exact: true }).first().click();
    await drawer.waitFor({ state: 'hidden' });
    c.equal(await c.page.getByRole('dialog', { name: '套图批量创作', exact: true }).count(), 0);
    await home();
    await c.page.getByRole('button', { name: '套图批量创作', exact: true }).click();
    await drawer.getByRole('button', { name: '生成已就绪商品', exact: true }).click();
    await c.page.getByRole('dialog', { name: '生成已就绪商品？', exact: true }).getByRole('button', { name: '确认生成', exact: true }).click();
    const generating = await poll(async () => c.invoke('getSuitePlanningBatch', { batchId: batch.id }), value => value.entries.every(entry => entry.generationJobIds.length === 4), { label: 'explicit batch image calls' });
    for (const id of generating.entries.flatMap(entry => entry.generationJobIds)) await c.waitJob(id);
    c.equal((await c.invoke('getSuitePlanningBatch', { batchId: batch.id })).entries.reduce((total, entry) => total + entry.generationCompleted, 0), 8);
    await c.stop(); await c.launch();
    await c.page.getByRole('button', { name: '套图批量创作', exact: true }).click();
    await c.page.getByRole('dialog', { name: '套图批量创作', exact: true }).getByText(/生成 4\/4/).first().waitFor();
    await screenshot('batch-completed-reopened');
    const reopened = await c.invoke('getSuitePlanningBatch', { batchId: batch.id });
    c.equal(reopened.entries.reduce((total, entry) => total + entry.generationCompleted, 0), 8);
  } },
];
try { for (const scenario of scenarios) await executeScenario(c, scenario); }
catch (error) { c.result.fatal = c.redact(error.message); }
finally {
  c.result.cleanupErrors = await c.cleanup();
  c.result.rendererErrors = c.state.events.filter(event => event.type === 'pageerror');
  c.result.scope = 'Reference-led planning, suite shot binding, reusable suite extraction and cross-product batch UI only; synthetic local Provider and isolated userData.';
  c.result.finishedAt = new Date().toISOString();
  c.result.integration = !c.result.fatal && !c.result.cleanupErrors.length && !c.result.rendererErrors.length && c.result.scenarios.length === scenarios.length && c.result.scenarios.every(scenario => scenario.status === 'passed') ? 'passed' : 'failed';
  await writeFile(join(c.artifacts, 'result.json'), c.redact(JSON.stringify(c.result, null, 2)));
  console.log(JSON.stringify({ integration: c.result.integration, scenarios: c.result.scenarios.map(scenario => ({ id: scenario.id, status: scenario.status, error: scenario.error })) }));
  if (c.result.integration !== 'passed') process.exitCode = 1;
}
