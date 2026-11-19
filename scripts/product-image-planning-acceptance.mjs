import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appPackage, executeScenario, makeContext, poll, unzip } from './e2e-full-harness.mjs';
import { modelCapability, projectInput } from './e2e-full-business.mjs';

if (!process.argv[2]) throw Error('Pass a new isolated artifacts directory');
await mkdir(process.argv[2]);
process.env.ECOMGEN_E2E_ARTIFACTS = process.argv[2];
const c = await makeContext();
const data = {};
const activeItems = board => board.items.filter(item => !item.planningSuperseded);
const imageCalls = () => (c.mock.state.counts['image-generation'] ?? 0) + (c.mock.state.counts['image-edit'] ?? 0);
const stage = index => c.page.getByRole('navigation', { name: '工作阶段' }).getByRole('button').nth(index);
async function capture(name) {
  await c.page.evaluate(async () => { await document.fonts.ready; await Promise.allSettled(document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished)); });
  const value = await c.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:')).webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(join(c.artifacts, `${name}.png`), Buffer.from(value, 'base64'));
}
async function size(width, height, zoom = 1) {
  await c.app.evaluate(({ BrowserWindow }, input) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:')); if (window.isMaximized()) window.unmaximize(); window.setSize(input.width, input.height); window.setPosition(-4000, -4000); window.setSkipTaskbar(true); window.webContents.setZoomFactor(input.zoom); }, { width, height, zoom });
  await poll(async () => ({ expected: await c.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('file:')); return window.getContentSize().map(value => value / window.webContents.getZoomFactor()); }), actual: await c.page.evaluate(() => [innerWidth, innerHeight]) }), value => value.expected.every((number, index) => Math.abs(number - value.actual[index]) <= 2), { label: 'window/zoom settle' });
}
async function openProject(project) {
  const global = c.page.getByRole('navigation', { name: '全局导航' });
  await global.getByRole('button', { name: '项目', exact: true }).click();
  await c.page.getByRole('region', { name: '项目画廊' }).getByText(project.name, { exact: true }).click();
  await stage(1).click();
}
async function saveCatalog(planning, patch = {}) {
  return c.invoke('saveProjectImagePlanning', { projectId: planning.projectId, expectedRevision: planning.revision, config: planning.config, skus: planning.skus, imageGroups: planning.imageGroups, ...patch });
}
const scenarios = [
  { id: 'sku-setup-and-cas', title: 'Real project catalog persistence, explicit references and stale-save rejection', run: async c => {
    await c.launch();
    c.equal(c.result.runtimeIdentity.version, JSON.parse(await readFile(appPackage, 'utf8')).version);
    await c.page.emulateMedia({ reducedMotion: 'reduce' });
    await size(1440, 960);
    c.state.provider = await c.invoke('createProvider', { name: 'SKU本机专项', baseUrl: c.mock.baseUrl, apiKey: c.fakeKey, reasoningProtocol: 'openai', models: [modelCapability('mock-reasoner'), modelCapability('mock-image', { imageApiKind: 'openai_images' })] });
    data.project = await c.invoke('createProject', projectInput(c, '商品图片规划专项', { candidatesPerType: 2, defaultMode: 'PIXEL_PROTECTED' }));
    data.foreignProject = await c.invoke('createProject', projectInput(c, '引用归属检查'));
    data.assets = [];
    for (let index = 0; index < 3; index++) {
      const bytes = await c.sharp(c.mock.images.image).modulate({ hue: index * 81 }).png().toBuffer();
      data.assets.push(await c.invoke('uploadAsset', { projectId: data.project.id, kind: 'PRODUCT', role: 'PRODUCT_TRUTH', file: { name: `synthetic-variant-${index}.png`, mimeType: 'image/png', base64: bytes.toString('base64') } }));
    }
    data.reference = await c.invoke('uploadAsset', { projectId: data.project.id, kind: 'REFERENCE', role: 'STYLE_REFERENCE', file: await c.byteFile(c.reference) });
    data.foreign = await c.invoke('uploadAsset', { projectId: data.foreignProject.id, kind: 'PRODUCT', role: 'PRODUCT_TRUTH', file: await c.byteFile() });
    const initial = await c.invoke('getProjectImagePlanning', { projectId: data.project.id });
    c.equal(initial.revision, 0); c.equal(initial.skus.length, 0); c.equal(initial.imageGroups.length, 0);
    const colors = ['样例白', '样例黑', '样例绿'];
    const skus = colors.flatMap((color, colorIndex) => ['M', 'L'].map(size => ({ id: randomUUID(), name: `${color} ${size}`, code: `TEST-${colorIndex}-${size}`, attributes: [{ name: '颜色', value: color }, { name: '尺码', value: size }], productAssetIds: [data.assets[colorIndex].id], included: true })));
    const imageGroups = colors.map((color, index) => ({ id: randomUUID(), name: color, skuIds: skus.slice(index * 2, index * 2 + 2).map(sku => sku.id), productAssetIds: [data.assets[index].id] }));
    const result = await saveCatalog(initial, { config: { mainCount: 5, detailCount: 8, skuImagesPerGroup: 1, shareImages: false }, skus, imageGroups });
    data.catalog = result.planning;
    c.equal(data.catalog.skus.length, 6); c.equal(data.catalog.config.shareImages, false);
    await c.rejects('saveProjectImagePlanning', { projectId: data.project.id, expectedRevision: 0, config: data.catalog.config, skus, imageGroups }, /目录|版本|更新|revision|冲突/i);
    c.equal(c.mock.state.total, 0, 'catalog editing sends no model request');
  } },
  { id: 'sku-ownership-and-sharing', title: 'Foreign/style reference rejection, explicit sharing and no-op save', needs: ['sku-setup-and-cas'], run: async c => {
    for (const bad of [data.foreign.id, data.reference.id]) {
      const skus = data.catalog.skus.map((sku, index) => index === 0 ? { ...sku, productAssetIds: [bad] } : sku);
      await c.rejects('saveProjectImagePlanning', { projectId: data.project.id, expectedRevision: data.catalog.revision, config: data.catalog.config, skus, imageGroups: data.catalog.imageGroups }, /素材|归属|真值|商品|参考|PRODUCT_TRUTH/i);
    }
    const before = data.catalog.revision;
    data.catalog = (await saveCatalog(data.catalog, { config: { ...data.catalog.config, shareImages: true } })).planning;
    c.check(data.catalog.revision > before);
    c.equal(data.catalog.imageGroups.length, 3); c.equal(data.catalog.skus.length, 6);
    const again = (await saveCatalog(data.catalog)).planning;
    c.equal(again.revision, data.catalog.revision, 'no-op save keeps revision');
    c.equal(c.mock.state.total, 0, 'sharing changes do not plan or generate');
    await c.stop(); await c.launch();
    const reopened = await c.invoke('getProjectImagePlanning', { projectId: data.project.id });
    c.equal(reopened, data.catalog, 'SKU catalog survives owned app restart');
  } },
  { id: 'planning-ui-and-batches', title: 'Main/SKU/detail counts, actual UI planning and bounded multi-call publication', needs: ['sku-ownership-and-sharing'], run: async c => {
    await size(1440, 960); await openProject(data.project);
    await c.page.getByRole('heading', { name: '图片规划', exact: true }).waitFor();
    await c.page.getByRole('button', { name: '管理 SKU', exact: true }).waitFor();
    const previous = new Set((await c.invoke('listJobs', { projectId: data.project.id })).items.map(job => job.id));
    await c.page.getByRole('button', { name: /生成图片规划|生成规划/ }).click();
    const job = await poll(async () => (await c.invoke('listJobs', { projectId: data.project.id })).items.find(job => job.type === 'PLAN' && !previous.has(job.id)), Boolean, { label: 'UI creates durable product planning job' });
    await c.waitJob(job.id);
    data.board = await c.invoke('getStoryboard', { projectId: data.project.id });
    const items = activeItems(data.board);
    c.equal(items.length, 16);
    for (const [purpose, expected] of [['MAIN', 5], ['SKU', 3], ['DETAIL', 8]]) c.equal(items.filter(item => item.imagePlanning?.purpose === purpose).length, expected);
    for (const item of items.filter(item => item.imagePlanning?.purpose === 'SKU')) { c.equal(item.imagePlanning.skus.length, 2); c.equal(item.imagePlanning.productAssetIds.length, 1); }
    const calls = c.observations.filter(row => row.workflow === 'storyboard');
    c.check(calls.length > 1, '16 scenes use multiple bounded planner calls');
    c.check(calls.every(row => row.payload.targetImageCount >= 1 && row.payload.targetImageCount <= 12));
    c.equal(imageCalls(), 0, 'planning does not generate images');
    await capture('planning-16-scenes');
  } },
  { id: 'sku-drawer-cancel-and-task-exclusion', title: 'Real SKU drawer edit/cancel, task drawer exclusion and saved-data preservation', needs: ['planning-ui-and-batches'], run: async c => {
    await c.page.getByRole('button', { name: '管理 SKU', exact: true }).click();
    const drawer = c.page.getByRole('dialog', { name: /^管理 SKU/ });
    await drawer.waitFor();
    c.equal(await c.page.getByRole('dialog', { name: '任务详情', exact: true }).count(), 0);
    const editableName = drawer.getByRole('textbox', { name: 'SKU 1 名称', exact: true });
    await editableName.fill('临时名称，应丢弃');
    await drawer.getByRole('button', { name: '取消', exact: true }).click();
    const confirmation = c.page.getByRole('alertdialog', { name: '放弃未保存的 SKU 修改？', exact: true });
    await confirmation.getByRole('button', { name: '放弃修改', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
    c.equal((await c.invoke('getProjectImagePlanning', { projectId: data.project.id })).skus[0].name, data.catalog.skus[0].name);
    await c.page.getByRole('region', { name: '执行摘要' }).getByRole('button', { name: '任务详情', exact: true }).click();
    const tasks = c.page.getByRole('dialog', { name: '任务详情', exact: true }); await tasks.waitFor();
    await c.page.getByRole('button', { name: '管理 SKU', exact: true }).click();
    await drawer.waitFor(); await tasks.waitFor({ state: 'hidden' });
    await capture('sku-editor-six-records');
    await drawer.getByRole('button', { name: '取消', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
    c.equal((await c.invoke('getProjectImagePlanning', { projectId: data.project.id })).revision, data.catalog.revision);
    // 经过真实AppShell进入设置，验证确认取消保留草稿、明确放弃才离开。
    await c.page.getByRole('button', { name: '管理 SKU', exact: true }).click();
    await drawer.getByRole('textbox', { name: 'SKU 1 名称', exact: true }).fill('设置导航未保存草稿');
    const settings = c.page.getByRole('complementary', { name: '工作空间侧栏' }).getByRole('button', { name: '设置', exact: true });
    await settings.click();
    const leave = c.page.getByRole('dialog', { name: '放弃未保存的图片规划修改？', exact: true });
    await leave.getByRole('button', { name: '继续编辑', exact: true }).click();
    await leave.waitFor({ state: 'hidden' });
    c.equal(await drawer.getByRole('textbox', { name: 'SKU 1 名称', exact: true }).inputValue(), '设置导航未保存草稿');
    await settings.click();
    await leave.getByRole('button', { name: '放弃修改', exact: true }).click();
    await c.page.getByRole('heading', { name: '常规设置', exact: true }).waitFor();
    await drawer.waitFor({ state: 'hidden' });
    await c.page.getByRole('button', { name: '返回创作页面', exact: true }).click();
    await c.page.getByRole('heading', { name: '图片规划', exact: true }).waitFor();
    c.equal((await c.invoke('getProjectImagePlanning', { projectId: data.project.id })).revision, data.catalog.revision);
    c.equal((await c.invoke('getProjectImagePlanning', { projectId: data.project.id })).skus[0].name, data.catalog.skus[0].name);
  } },
  { id: 'sku-stale-and-targeted-refresh', title: 'SKU change marks one affected target stale and refresh preserves other edits', needs: ['sku-drawer-cancel-and-task-exclusion'], run: async c => {
    const items = activeItems(data.board);
    const main = items.find(item => item.imagePlanning.purpose === 'MAIN');
    const marker = `${main.promptInstruction} Keep the explicit user composition marker.`;
    await c.invoke('updateStoryboardItem', { itemId: main.id, promptInstruction: marker });
    const affectedSku = data.catalog.skus[2].id;
    await c.page.getByRole('button', { name: '管理 SKU', exact: true }).click();
    const drawer = c.page.getByRole('dialog', { name: /^管理 SKU/ });
    await drawer.getByRole('textbox', { name: 'SKU 3 名称', exact: true }).fill('样例黑 M 已修改');
    const requestsBeforeSave = c.mock.state.total;
    await drawer.getByRole('button', { name: '保存修改', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
    data.catalog = await poll(() => c.invoke('getProjectImagePlanning', { projectId: data.project.id }), value => value.skus.some(sku => sku.id === affectedSku && sku.name === '样例黑 M 已修改'), { label: 'SKU drawer actually saves edited name' });
    c.equal(c.mock.state.total, requestsBeforeSave, 'saving SKU does not call models');
    const affected = items.find(item => item.imagePlanning.purpose === 'SKU' && item.imagePlanning.skus.some(sku => sku.id === affectedSku));
    const stale = await c.invoke('getStoryboard', { projectId: data.project.id });
    c.equal(activeItems(stale).filter(item => item.planningStale).map(item => item.id), [affected.id]);
    await c.rejects('confirmStoryboard', { projectId: data.project.id, version: stale.storyboard.version }, /过期|更新|规划|分镜|stale/i);
    const previous = new Set((await c.invoke('listJobs', { projectId: data.project.id })).items.map(job => job.id));
    await c.page.getByRole('button', { name: '更新受影响规划', exact: true }).click();
    const job = await poll(async () => (await c.invoke('listJobs', { projectId: data.project.id })).items.find(job => job.type === 'PLAN' && !previous.has(job.id)), Boolean, { label: 'UI creates affected-only planning job' });
    await c.waitJob(job.id);
    data.board = await c.invoke('getStoryboard', { projectId: data.project.id });
    c.equal(activeItems(data.board).length, 16);
    c.equal(activeItems(data.board).find(item => item.id === main.id).promptInstruction, marker);
    c.check(!activeItems(data.board).some(item => item.planningStale));
  } },
  { id: 'grouped-selection-and-generation', title: 'Visible UI confirms current version and creates all32 real candidate artifacts', needs: ['sku-stale-and-targeted-refresh'], run: async c => {
    await c.page.getByRole('button', { name: /^(全选|全选画面)$/ }).click();
    await c.page.getByRole('button', { name: '确认并生成', exact: true }).click();
    const jobs = await poll(async () => (await c.invoke('listJobs', { projectId: data.project.id })).items.filter(job => job.type === 'GENERATE'), jobs => jobs.length === 32, { label: '32 candidate jobs from16 selected scenes' });
    // 查询倒序返回；按认领顺序等待，避免把最后排队的候选当作单任务运行超时。
    jobs.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    try { for (const job of jobs) await c.waitJob(job.id); }
    catch (error) {
      await c.evidence('generation-progress', { jobs: (await c.invoke('listJobs', { projectId: data.project.id })).items, imageCalls: imageCalls() });
      throw error;
    }
    data.outputs = (await c.invoke('listOutputs', { projectId: data.project.id })).items;
    c.equal(data.outputs.length, 32); c.equal(imageCalls(), 32);
    for (const purpose of ['MAIN', 'SKU', 'DETAIL']) c.check(data.outputs.some(output => output.imagePlanning?.purpose === purpose));
    const skuOutput = data.outputs.find(output => output.imagePlanning?.purpose === 'SKU');
    c.equal(skuOutput.imagePlanning.skus.length, 2); await c.imageRef({ kind: 'OUTPUT', id: skuOutput.id }, { expectedHash: skuOutput.hash });
    await capture('generated-purpose-and-sku');
  } },
  { id: 'immutable-sku-provenance-and-export', title: 'Generated SKU history and ZIP evidence remain frozen after directory rename', needs: ['grouped-selection-and-generation'], run: async c => {
    const output = data.outputs.find(output => output.imagePlanning?.purpose === 'SKU');
    const frozen = structuredClone(output.imagePlanning);
    const chosen = frozen.skus[0].id;
    data.renamedSkuId = chosen;
    data.catalog = (await saveCatalog(data.catalog, { skus: data.catalog.skus.map(sku => sku.id === chosen ? { ...sku, name: '目录新名称不回写旧成图' } : sku) })).planning;
    const current = (await c.invoke('listOutputs', { projectId: data.project.id })).items.find(item => item.id === output.id);
    c.equal(current.imagePlanning, frozen);
    const selected = [output, data.outputs.find(item => item.imagePlanning?.purpose === 'MAIN'), data.outputs.find(item => item.imagePlanning?.purpose === 'DETAIL')];
    const submission = await c.invoke('createExportJob', { projectId: data.project.id, outputIds: selected.map(item => item.id), filenamePrefix: 'sku-provenance' });
    await c.waitJob(submission.job.id);
    const handle = await c.invoke('downloadExport', { exportId: submission.export.id });
    const archive = unzip(await c.save(handle.ref, 'zip'));
    const manifest = JSON.parse(archive.get('manifest.json').toString('utf8'));
    c.equal(manifest.storyboard.map(entry => entry.outputId), selected.map(item => item.id));
    c.equal(manifest.storyboard[0].imagePlanning, frozen);
    c.check(!JSON.stringify(manifest).includes(c.fakeKey));
    c.check(!JSON.stringify(manifest.storyboard[0].imagePlanning).includes('目录新名称不回写旧成图'));
  } },
  { id: 'sku-bulk-create-ui', title: 'Real SKU editor creates six combinations and confirms three explicit shared groups', needs: ['immutable-sku-provenance-and-export'], run: async c => {
    await openProject(data.foreignProject);
    await c.page.getByRole('button', { name: '管理 SKU', exact: true }).click();
    const drawer = c.page.getByRole('dialog', { name: /^管理 SKU/ });
    const requests = c.mock.state.total;
    await drawer.getByRole('button', { name: '按规格批量创建', exact: true }).click();
    await drawer.getByRole('textbox', { name: '组合属性 1 名称', exact: true }).fill('颜色');
    await drawer.getByRole('textbox', { name: '组合属性 1 的值', exact: true }).fill('白,黑,绿');
    await drawer.getByRole('button', { name: '添加组合属性', exact: true }).click();
    await drawer.getByRole('textbox', { name: '组合属性 2 名称', exact: true }).fill('尺码');
    await drawer.getByRole('textbox', { name: '组合属性 2 的值', exact: true }).fill('M,L');
    await drawer.getByRole('button', { name: /^创建\s*6\s*个\s*SKU$/ }).click();
    c.equal(await drawer.getByRole('row', { name: /^SKU [1-6]$/ }).count(), 6);
    await drawer.getByRole('checkbox', { name: '同外观规格共用图片', exact: true }).check();
    c.equal((await c.invoke('getProjectImagePlanning', { projectId: data.foreignProject.id })).skus.length, 0, 'draft does not write automatically');
    await drawer.getByRole('button', { name: '按属性预览分组', exact: true }).click();
    await drawer.getByRole('checkbox', { name: '按属性 颜色 分组', exact: true }).check();
    await drawer.getByRole('button', { name: '预览图片组', exact: true }).click();
    await drawer.getByRole('button', { name: '确认图片分组', exact: true }).click();
    await drawer.getByRole('button', { name: '保存修改', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
    const saved = await c.invoke('getProjectImagePlanning', { projectId: data.foreignProject.id });
    c.equal(saved.skus.length, 6); c.equal(saved.imageGroups.length, 3); c.check(saved.config.shareImages);
    c.check(saved.skus.every(sku => sku.attributes.length === 2));
    c.equal(new Set(saved.imageGroups.flatMap(group => group.skuIds)).size, 6);
    c.equal(c.mock.state.total, requests, 'creating/saving SKU groups sends no model call');
    await openProject(data.project);
  } },
  { id: 'planning-responsive-and-portals', title: 'Real narrow and130-percent layouts keep actions and one-line task status reachable', needs: ['sku-bulk-create-ui'], run: async c => {
    await stage(1).click();
    const global = c.page.getByRole('complementary', { name: '工作空间侧栏' });
    await global.getByRole('button', { name: '收起侧栏', exact: true }).click();
    for (const [width, height, zoom] of [[1000, 740, 1], [1000, 700, 1.3]]) {
      await size(width, height, zoom);
      const summary = await c.page.getByRole('region', { name: '执行摘要' }).evaluate(element => ({ height: element.getBoundingClientRect().height, documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth }));
      c.check(summary.height <= 44); c.check(summary.documentWidth <= summary.viewportWidth + 1);
      await c.page.getByRole('button', { name: '管理 SKU', exact: true }).click();
      const drawer = c.page.getByRole('dialog', { name: /^管理 SKU/ }); await drawer.waitFor();
      await capture(`sku-editor-${width}-${zoom}`);
      const save = await drawer.getByRole('button', { name: '保存修改', exact: true }).boundingBox();
      const viewport = await c.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      c.check(save && save.x >= 0 && save.x + save.width <= viewport.width + 1 && save.y >= 0 && save.y + save.height <= viewport.height + 1, 'SKU save action remains inside the visible viewport');
      await drawer.getByRole('button', { name: '取消', exact: true }).click(); await drawer.waitFor({ state: 'hidden' });
    }
    await size(1440, 960);
    await c.page.getByRole('region', { name: '执行摘要' }).getByRole('button', { name: '任务详情', exact: true }).click();
    await global.getByRole('button', { name: '设置', exact: true }).click();
    await c.page.getByRole('heading', { name: '常规设置', exact: true }).waitFor();
    await c.page.getByRole('dialog', { name: '任务详情', exact: true }).waitFor({ state: 'hidden' });
    c.equal(await c.page.getByRole('dialog', { name: /^管理 SKU/ }).count(), 0);
    await c.page.getByRole('button', { name: '返回创作页面', exact: true }).click();
    await c.page.getByRole('heading', { name: '图片规划', exact: true }).waitFor();
  } },
  { id: 'unknown-does-not-open-a-new-intent', title: 'Unknown generation blocks new-key regeneration and replacement product planning', needs: ['planning-responsive-and-portals'], run: async c => {
    const output = data.outputs.find(item => item.imagePlanning?.purpose === 'SKU' && !item.imagePlanning.skus.some(sku => sku.id === data.renamedSkuId));
    c.mock.control.failNext('image-edit', { type: 'drop' });
    c.mock.control.failNext('image-generation', { type: 'drop' });
    const submission = await c.invoke('createGenerationJobs', { projectId: data.project.id, storyboardItemIds: [output.storyboardItemId], generationBatchId: output.generationBatchId, regenerationKey: randomUUID(), revision: 'retry', generationConfig: { candidateCount: 1 } });
    c.equal(submission.jobs.length, 1);
    await c.waitJob(submission.jobs[0].id, 'UNKNOWN');
    const beforeImages = imageCalls(), beforeModel = c.mock.state.total;
    await c.rejects('createGenerationJobs', { projectId: data.project.id, storyboardItemIds: [output.storyboardItemId], regenerationKey: randomUUID(), revision: 'retry', generationConfig: { candidateCount: 1 } }, /未知|核实|重复|unknown/i);
    await c.rejects('createProductImagePlanningJob', { projectId: data.project.id, expectedRevision: data.catalog.revision, scope: 'ALL', regenerationKey: randomUUID() }, /未知|核实|重复|unknown/i);
    c.equal(imageCalls(), beforeImages); c.equal(c.mock.state.total, beforeModel);
    c.equal((await c.invoke('listOutputs', { projectId: data.project.id })).items.length, 32);
  } },
];
try {
  for (const scenario of scenarios) await executeScenario(c, scenario);
} catch (error) {
  c.result.fatal = c.redact(error.message);
  await c.lifecycleDiagnostics('launch-failed', c.app, error).catch(() => {});
} finally {
  const cleanup = await c.cleanup();
  c.result.scope = 'product-image planning and SKU feature only; synthetic local Provider and isolated temporary data';
  c.result.cleanupErrors = cleanup;
  c.result.rendererErrors = c.state.events.filter(event => event.type === 'pageerror');
  c.result.finishedAt = new Date().toISOString();
  c.result.integration = !c.result.fatal && !cleanup.length && !c.result.rendererErrors.length && c.result.scenarios.length === scenarios.length && c.result.scenarios.every(row => row.status === 'passed') ? 'passed' : 'failed';
  await writeFile(join(c.artifacts, 'result.json'), c.redact(JSON.stringify(c.result, null, 2)));
  console.log(JSON.stringify({ integration: c.result.integration, passed: c.result.scenarios.filter(row => row.status === 'passed').length, total: scenarios.length, cleanup }));
  if (c.result.integration !== 'passed') process.exitCode = 1;
}
