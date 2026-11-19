import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executeScenario, makeContext, poll, unzip } from './e2e-full-harness.mjs';
import { modelCapability, projectInput } from './e2e-full-business.mjs';

// 使用真实 Electron、隔离 SQLite 和本机假 Provider，只验本轮项目流程。
if (!process.argv[2]) throw Error('Pass a new isolated artifacts directory');
await mkdir(process.argv[2]);
process.env.ECOMGEN_E2E_ARTIFACTS = process.argv[2];
const c = await makeContext();
const data = {};
const stage = index => c.page.getByRole('navigation', { name: '工作阶段' }).getByRole('button').nth(index);
const activeItems = board => board.items.filter(item => !item.planningSuperseded);
const imageCalls = () => (c.mock.state.counts['image-generation'] ?? 0) + (c.mock.state.counts['image-edit'] ?? 0);
const jobs = async () => (await c.invoke('listJobs', { projectId: data.project.id })).items;
async function newJob(type, previous) {
  return poll(async () => (await jobs()).find(job => job.type === type && !previous.has(job.id)), Boolean, { label: `UI submits ${type}` });
}
async function capture(name) {
  await c.page.evaluate(async () => { await document.fonts.ready; await Promise.allSettled(document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished)); });
  const png = await c.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:')).webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(join(c.artifacts, `${name}.png`), Buffer.from(png, 'base64'));
}
async function size(width, height, zoom = 1) {
  await c.app.evaluate(({ BrowserWindow }, input) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:')); if (window.isMaximized()) window.unmaximize(); window.setSize(input.width, input.height); window.webContents.setZoomFactor(input.zoom); }, { width, height, zoom });
  await poll(async () => ({ expected: await c.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:')); return window.getContentSize().map(value => value / window.webContents.getZoomFactor()); }), actual: await c.page.evaluate(() => [innerWidth, innerHeight]) }), value => value.expected.every((number, index) => Math.abs(number - value.actual[index]) <= 2), { label: 'window dimensions' });
}
async function openProject() {
  await c.page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '项目', exact: true }).click();
  await c.page.getByRole('region', { name: '项目画廊' }).getByText(data.project.name, { exact: true }).click();
}
const scenarios = [
  { id: 'preparation', title: 'Preparation renders persisted product/reference inputs and complete configuration', run: async c => {
    await c.launch(); await c.page.emulateMedia({ reducedMotion: 'reduce' }); await size(1536, 1024);
    c.state.provider = await c.invoke('createProvider', { name: '项目流程本机专项', baseUrl: c.mock.baseUrl, apiKey: c.fakeKey, reasoningProtocol: 'openai', models: [modelCapability('mock-reasoner'), modelCapability('mock-image', { imageApiKind: 'openai_images' })] });
    data.project = await c.invoke('createProject', projectInput(c, '项目流程隔离样例', { candidatesPerType: 2, defaultMode: 'PIXEL_PROTECTED' }));
    await openProject(); await stage(0).click();
    data.assets = [];
    for (let index = 0; index < 2; index++) {
      const path = join(c.fixture, `synthetic-product-${index}.png`);
      await c.sharp(c.mock.images.image).modulate({ hue: index * 81 }).png().toFile(path);
      await c.page.getByLabel('上传商品图', { exact: true }).setInputFiles(path);
      data.assets = await poll(async () => (await c.invoke('listAssets', { projectId: data.project.id })).items.filter(asset => asset.role === 'PRODUCT_TRUTH'), assets => assets.length === index + 1, { label: 'product uploaded from file input' });
    }
    await c.page.getByLabel('上传参考图', { exact: true }).setInputFiles(c.reference);
    await poll(async () => (await c.invoke('listAssets', { projectId: data.project.id })).items, assets => assets.some(asset => asset.role === 'STYLE_REFERENCE'), { label: 'style reference upload' });
    const initial = await c.invoke('getProjectImagePlanning', { projectId: data.project.id });
    const skus = data.assets.map((asset, index) => ({ id: randomUUID(), name: `样例规格 ${index + 1}`, code: `LOCAL-${index}`, attributes: [{ name: '颜色', value: `样例色 ${index + 1}` }], productAssetIds: [asset.id], included: true }));
    data.catalog = (await c.invoke('saveProjectImagePlanning', { projectId: data.project.id, expectedRevision: initial.revision, config: { mainCount: 1, detailCount: 1, skuImagesPerGroup: 1, shareImages: false }, skus, imageGroups: [] })).planning;
    c.equal(c.mock.state.total, 0, 'saving preparation does not call models');
    await openProject(); await stage(0).click();
    await c.page.getByRole('button', { name: /AI.*一键规划|一键规划/ }).waitFor();
    await capture('01-preparation');
  } },
  { id: 'planning', title: 'Preparation button plans main/SKU/detail without generating images', needs: ['preparation'], run: async c => {
    const previous = new Set((await jobs()).map(job => job.id));
    await c.page.getByRole('button', { name: /AI.*一键规划|一键规划/ }).click();
    await c.waitJob((await newJob('PLAN', previous)).id);
    data.board = await c.invoke('getStoryboard', { projectId: data.project.id });
    c.equal(activeItems(data.board).length, 4);
    for (const [purpose, expected] of [['MAIN', 1], ['SKU', 2], ['DETAIL', 1]]) c.equal(activeItems(data.board).filter(item => item.imagePlanning?.purpose === purpose).length, expected);
    c.equal(imageCalls(), 0, 'planning is separate from paid image generation');
    await stage(1).click();
    await c.page.getByRole('heading', { name: '图片规划', exact: true }).waitFor();
    await poll(() => c.page.getByRole('button', { name: '重做整套方案', exact: true }).isEnabled(), Boolean, { label: 'planning UI settles after job completion' });
    await c.page.getByRole('button', { name: / 分镜$/ }).first().click();
    await c.page.getByRole('complementary', { name: '画面检查器', exact: true }).getByRole('textbox', { name: '分镜显示名称', exact: true }).waitFor();
    await capture('02-planning');
    await size(1100, 760, 1.3);
    const smallCard = c.page.getByRole('button', { name: / 分镜$/ }).first();
    await smallCard.click();
    const smallInspector = c.page.getByRole('complementary', { name: '画面检查器', exact: true });
    await smallInspector.getByRole('textbox', { name: '分镜显示名称', exact: true }).click();
    c.check(await smallCard.isVisible(), 'planning card remains reachable at 130% zoom');
    await capture('02-planning-small-130'); await size(1536, 1024);
  } },
  { id: 'generation', title: 'Explicit confirmation produces candidates with stable target identity', needs: ['planning'], run: async c => {
    const previous = new Set((await jobs()).map(job => job.id));
    await c.page.getByRole('button', { name: '全选', exact: true }).click();
    await c.page.getByRole('button', { name: /确认并生成/ }).click();
    const submitted = await poll(async () => (await jobs()).filter(job => job.type === 'GENERATE' && !previous.has(job.id)), list => list.length === 8, { label: 'eight candidate generation jobs' });
    for (const job of submitted.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) await c.waitJob(job.id);
    data.outputs = (await c.invoke('listOutputs', { projectId: data.project.id })).items;
    c.equal(data.outputs.length, 8); c.equal(imageCalls(), 8);
    c.check(data.outputs.every(output => output.imagePlanning?.targetId), 'outputs preserve frozen target identity');
    await stage(2).click();
    await c.page.getByRole('button', { name: /^修改这张 / }).first().waitFor();
    await capture('03-results');
  } },
  { id: 'adoption-and-restart', title: 'Adoption and detail order persist across actual application restart', needs: ['generation'], run: async c => {
    const before = c.mock.state.total;
    await c.page.locator('article[data-output-id]').first().hover();
    await c.page.getByRole('button', { name: '采用此图', exact: true }).first().click();
    const adopted = await poll(() => c.invoke('getProjectWorkbench', { projectId: data.project.id }), value => value.adoptions.length === 1, { label: 'UI adoption reaches SQLite' });
    const detail = data.outputs.find(output => output.imagePlanning.purpose === 'DETAIL');
    data.workbench = await c.invoke('saveProjectWorkbench', { projectId: data.project.id, expectedRevision: adopted.revision, adoptions: adopted.adoptions, detailOrder: [detail.imagePlanning.targetId] });
    await c.rejects('saveProjectWorkbench', { projectId: data.project.id, expectedRevision: adopted.revision, adoptions: [], detailOrder: [] }, /采用状态已变化/);
    c.equal(c.mock.state.total, before, 'adoption sends no model requests');
    await c.stop(); await c.launch(); await size(1536, 1024); await openProject();
    c.equal(await c.invoke('getProjectWorkbench', { projectId: data.project.id }), data.workbench);
    await c.page.getByRole('button', { name: /^修改这张 / }).first().waitFor();
    await capture('03-results-reopened');
  } },
  { id: 'single-image-edit', title: 'Edit preview binds inputs, refuses changed confirmation and creates independent versions', needs: ['adoption-and-restart'], run: async c => {
    await c.page.locator('article[data-output-id]').first().hover();
    await c.page.getByRole('button', { name: /^修改这张 / }).first().click();
    const dialog = c.page.getByRole('dialog').filter({ has: c.page.getByRole('heading', { name: '修改这张图片', exact: true }) });
    const requirement = dialog.getByRole('textbox', { name: '修改要求', exact: true });
    await requirement.fill('Keep product geometry and softly brighten the background.');
    const previous = new Set((await jobs()).map(job => job.id));
    const beforeImages = imageCalls();
    await dialog.getByRole('button', { name: '生成计划', exact: true }).click();
    await c.waitJob((await newJob('EDIT_PLAN', previous)).id);
    const confirm = dialog.getByRole('button', { name: '确认修改', exact: true });
    await confirm.waitFor();
    c.equal(imageCalls(), beforeImages, 'preview requires confirmation');
    await capture('04-edit-preview');
    await requirement.fill('A changed requirement must not approve the previous plan.');
    c.equal(await confirm.isDisabled(), true, 'changed input blocks approval of old plan');
    await requirement.fill('Keep product geometry and softly brighten the background.');
    await confirm.click();
    await c.waitJob((await newJob('EDIT_GENERATE', previous)).id);
    await poll(async () => (await c.invoke('listOutputs', { projectId: data.project.id })).items, outputs => outputs.some(output => output.parentOutputId), { label: 'edited independent version' });
    const outputs = (await c.invoke('listOutputs', { projectId: data.project.id })).items;
    c.check(data.outputs.every(output => outputs.some(saved => saved.id === output.id)), 'original candidates remain');
    c.check(outputs.some(output => output.parentOutputId && output.editTurnId), 'new output preserves edit lineage');
    await capture('04-edit-result');
    await dialog.getByRole('button', { name: '返回成图', exact: true }).click();
  } },
  { id: 'export-recovery', title: 'Completed export remains queryable after restart and ZIP bytes save correctly', needs: ['single-image-edit'], run: async c => {
    const before = c.mock.state.total;
    const outputIds = data.workbench.adoptions.map(item => item.outputId);
    const submitted = await c.invoke('createExportJob', { projectId: data.project.id, outputIds, filenamePrefix: 'v2-local-acceptance' });
    await c.waitJob(submitted.job.id);
    await c.stop(); await c.launch(); await size(1536, 1024); await openProject();
    const history = await c.invoke('listProjectExports', { projectId: data.project.id });
    const saved = history.items.find(item => item.id === submitted.export.id);
    c.equal(saved.status, 'SUCCEEDED'); c.equal(saved.outputIds, outputIds); c.check(saved.downloadUrl, 'recovered export has a public resource URL');
    const archive = unzip(await c.save({ kind: 'EXPORT', id: saved.id }, 'zip'));
    c.check(archive.has('manifest.json'), 'saved ZIP includes its manifest');
    c.equal(c.mock.state.total, before, 'export/restart does not call a model');
    await capture('03-export-recovered');
  } },
];
try {
  for (const scenario of scenarios) await executeScenario(c, scenario);
} catch (error) {
  c.result.fatal = c.redact(error.message);
} finally {
  const cleanup = await c.cleanup();
  c.result.scope = 'Project v2 only: real Electron, synthetic local Provider, isolated data; no real model quality or installer testing';
  c.result.cleanupErrors = cleanup;
  c.result.rendererErrors = c.state.events.filter(event => event.type === 'pageerror');
  c.result.finishedAt = new Date().toISOString();
  c.result.integration = !c.result.fatal && !cleanup.length && !c.result.rendererErrors.length && c.result.scenarios.length === scenarios.length && c.result.scenarios.every(row => row.status === 'passed') ? 'passed' : 'failed';
  await writeFile(join(c.artifacts, 'result.json'), c.redact(JSON.stringify(c.result, null, 2)));
  console.log(JSON.stringify({ integration: c.result.integration, passed: c.result.scenarios.filter(row => row.status === 'passed').length, total: scenarios.length, cleanup }));
  if (c.result.integration !== 'passed') process.exitCode = 1;
}
