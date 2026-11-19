import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeContext, executeScenario, poll, sleep } from './e2e-full-harness.mjs';
import { modelCapability, projectInput } from './e2e-full-business.mjs';

// 仅使用隔离 userData、合成图片、本机假 Provider 和真实 Electron/IPC。
const destination = process.env.ECOMGEN_E2E_ARTIFACTS || process.argv[2];
if (!destination) throw Error('Pass a new empty artifacts directory');
const artifacts = resolve(destination);
await mkdir(artifacts, { recursive: true });
if ((await readdir(artifacts)).length) throw Error('Artifacts directory must be empty');
process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
const c = await makeContext();
const data = {};
const stage = index => c.page.getByRole('navigation', { name: '工作阶段' }).getByRole('button').nth(index);
const active = board => board.items.filter(item => !item.planningSuperseded);
const imageCalls = () => (c.mock.state.counts['image-edit'] || 0) + (c.mock.state.counts['image-generation'] || 0);
const jobs = async project => (await c.invoke('listJobs', { projectId: project.id })).items;
const outputs = async project => (await c.invoke('listOutputs', { projectId: project.id })).items;
const newJob = (project, type, previous) => poll(async () => (await jobs(project)).find(job => job.type === type && !previous.has(job.id)), Boolean, { label: `new ${type} job` });
const editor = () => c.page.getByRole('dialog').filter({ has: c.page.getByRole('button', { name: '返回成图', exact: true }) });
async function openProject(project) {
  await c.page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '项目', exact: true }).click();
  await c.page.getByRole('region', { name: '项目画廊' }).getByText(project.name, { exact: true }).click();
}
async function makeProject(name, count) {
  const project = await c.invoke('createProject', projectInput(c, name, { candidatesPerType: 1, defaultMode: 'PIXEL_PROTECTED' }));
  const first = await c.invoke('uploadAsset', { projectId: project.id, kind: 'PRODUCT', role: 'PRODUCT_TRUTH', file: await c.byteFile() });
  const second = await c.invoke('uploadAsset', { projectId: project.id, kind: 'REFERENCE', role: 'STYLE_REFERENCE', file: await c.byteFile(c.reference) });
  const { planning } = await c.invoke('saveProjectImagePlanning', { projectId: project.id, expectedRevision: 0, config: { mainCount: count, detailCount: 0, skuImagesPerGroup: 1, shareImages: false }, skus: [], imageGroups: [] });
  const job = await c.invoke('createProductImagePlanningJob', { projectId: project.id, expectedRevision: planning.revision });
  await c.waitJob(job.id);
  const board = await c.invoke('getStoryboard', { projectId: project.id });
  c.equal(active(board).length, count, 'synthetic project has expected planning targets');
  const item = active(board)[0];
  await c.invoke('updateStoryboardItem', { itemId: item.id, referencedAssets: [first.id, second.id] });
  return { project, first, second, board: await c.invoke('getStoryboard', { projectId: project.id }) };
}
async function capture(name) {
  await c.page.evaluate(async () => { await document.fonts.ready; });
  const png = await c.app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('file:'));
    if (!window?.isVisible()) throw Error('Test window is not visible');
    return (await window.webContents.capturePage()).toPNG().toString('base64');
  });
  const path = join(artifacts, `${name}.png`);
  await writeFile(path, Buffer.from(png, 'base64'));
  c.current.evidence.push(path);
}
async function drawMask(dialog) {
  await poll(() => dialog.getByRole('textbox', { name: '修改要求' }).isEnabled(), Boolean, { label: 'editor session ready before drawing' });
  await poll(() => dialog.getByRole('img', { name: '待编辑图片', exact: true }).evaluate(image => {
    const canvas = image.parentElement.querySelector('canvas');
    return image.complete && image.naturalWidth > 0 && canvas?.width === image.naturalWidth && canvas?.height === image.naturalHeight;
  }), Boolean, { label: 'decoded image and initialized canvas before drawing' });
  await dialog.getByRole('button', { name: '框选可编辑区域', exact: true }).click();
  const canvas = dialog.locator('canvas[data-tool="rect"]');
  await poll(() => canvas.boundingBox(), box => Boolean(box && box.width > 30 && box.height > 30), { label: 'editor canvas dimensions' });
  const box = await canvas.boundingBox();
  await c.page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await c.page.mouse.down();
  await c.page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.65, { steps: 8 });
  await c.page.mouse.up();
  await poll(() => canvas.evaluate(node => node.getContext('2d').getImageData(0, 0, node.width, node.height).data.some((value, index) => index % 4 === 3 && value > 0)), Boolean, { label: 'drawn selection is visible on canvas' });
  c.check(true, 'drawn selection has actual overlay pixels');
}
const scenarios = [
  { id: 'reference-preview-and-delete', title: 'Card and inspector preview preserves selection; batch deletion removes only selected targets', run: async () => {
    data.deletion = await makeProject('参考预览与删除专项', 3);
    await openProject(data.deletion.project); await stage(1).click();
    const ids = active(data.deletion.board).map(item => item.id);
    const card = c.page.locator(`[data-storyboard-item-id="${ids[0]}"]`);
    const check = card.getByRole('checkbox');
    c.equal(await check.getAttribute('aria-checked'), 'false');
    await card.getByRole('button', { name: /^预览参考素材：/ }).click();
    const preview = c.page.getByRole('dialog', { name: '参考素材预览' });
    await preview.getByRole('img', { name: data.deletion.first.originalName }).waitFor();
    await preview.getByRole('button', { name: '下一张' }).click();
    await preview.getByRole('img', { name: data.deletion.second.originalName }).waitFor();
    await capture('01-card-reference-preview');
    await c.page.keyboard.press('Escape'); await preview.waitFor({ state: 'hidden' });
    c.equal(await check.getAttribute('aria-checked'), 'false', 'card preview never selects target');
    c.equal(await c.page.getByRole('textbox', { name: '生图 Prompt' }).count(), 0, 'card preview does not open inspector');
    await card.getByRole('button', { name: / 分镜$/ }).click();
    const inspector = c.page.getByRole('complementary', { name: '画面检查器' });
    await inspector.getByRole('button', { name: `预览使用素材：${data.deletion.second.originalName}` }).click();
    await preview.getByRole('img', { name: data.deletion.second.originalName }).waitFor();
    await preview.getByRole('button', { name: '上一张' }).click();
    await preview.getByRole('img', { name: data.deletion.first.originalName }).waitFor();
    await capture('02-inspector-reference-preview');
    await c.page.keyboard.press('Escape'); await preview.waitFor({ state: 'hidden' });
    c.equal(await check.getAttribute('aria-checked'), 'false', 'inspector preview never selects target');
    await check.click(); await c.page.locator(`[data-storyboard-item-id="${ids[1]}"]`).getByRole('checkbox').click();
    await c.page.getByRole('button', { name: '删除所选', exact: true }).click();
    c.equal(await c.page.getByRole('dialog', { name: /取消此图片需求/ }).count(), 0, 'batch deletion needs no confirmation');
    const remaining = await poll(() => c.invoke('getStoryboard', { projectId: data.deletion.project.id }), board => active(board).length === 1, { label: 'selected targets deleted' });
    c.equal(active(remaining).map(item => item.id), [ids[2]], 'only unselected target remains');
    await poll(() => c.page.locator('[data-storyboard-item-id]').count(), count => count === 1, { label: 'deleted targets disappear from the window' });
    c.equal(await c.page.locator('[data-storyboard-item-id]').getAttribute('data-storyboard-item-id'), ids[2], 'window preserves the unselected target');
    await capture('03-batch-delete');
  } },
  { id: 'delayed-generation', title: 'Delayed image generation shows animation and produces one result', run: async () => {
    data.main = await makeProject('生成与编辑反馈专项', 1);
    await openProject(data.main.project); await stage(1).click();
    await c.page.getByRole('button', { name: '全选', exact: true }).click();
    const previous = new Set((await jobs(data.main.project)).map(job => job.id));
    const before = imageCalls();
    c.mock.control.failNext('image-edit', { type: 'delay', ms: 9000 });
    await c.page.getByRole('button', { name: '确认并生成', exact: true }).click();
    const job = await newJob(data.main.project, 'GENERATE', previous);
    await stage(2).click();
    const busy = c.page.locator('article').filter({ has: c.page.getByRole('status', { name: '' }) }).filter({ hasText: /生成中|排队中/ }).first();
    await busy.waitFor();
    const spinner = busy.locator('svg[class*="spinning"]');
    await spinner.waitFor();
    c.check(await spinner.evaluate(node => getComputedStyle(node).animationName !== 'none'), 'pending spinner has an actual animation');
    c.check(await spinner.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }), 'pending spinner stays within the visible window');
    c.equal(await busy.getByRole('button', { name: '生成此图' }).count(), 0, 'pending target cannot be submitted again');
    await capture('04-generation-pending');
    await c.waitJob(job.id);
    data.original = (await poll(() => outputs(data.main.project), rows => rows.length === 1, { label: 'generated output' }))[0];
    await c.page.locator(`article[data-output-id="${data.original.id}"]`).waitFor();
    c.equal(imageCalls(), before + 1, 'one generation request');
    c.equal(await busy.count(), 0, 'pending placeholder replaced by output');
    await capture('05-generation-complete');
  } },
  { id: 'invalid-plan-retry', title: 'Immediate version placeholder, invalid plan failure and explicit retry preserve usage', needs: ['delayed-generation'], run: async () => {
    const card = c.page.locator(`article[data-output-id="${data.original.id}"]`);
    await card.hover(); await card.getByRole('button', { name: /^修改这张 / }).click();
    const dialog = editor(); await dialog.waitFor(); await drawMask(dialog);
    await dialog.getByRole('textbox', { name: '修改要求' }).fill('调整框选区域的背景颜色，保留商品。');
    c.state.editOverrides = { operation: 'EDIT_IMAGE', executionMode: 'MASKED_EDIT' };
    c.mock.control.failNext('chat', { type: 'delay', ms: 5000 });
    const beforeJobs = new Set((await jobs(data.main.project)).map(job => job.id));
    const beforeImages = imageCalls();
    await dialog.getByRole('button', { name: '生成计划', exact: true }).click();
    const versions = dialog.getByLabel('版本历史');
    await versions.getByLabel('正在规划', { exact: true }).waitFor();
    c.check(await versions.getByLabel('正在规划').locator('[class*="spinner"]').count() === 1, 'immediate placeholder has spinner');
    c.equal(await dialog.getByRole('button', { name: /生成计划$/ }).isDisabled(), true, 'duplicate edit submission is disabled');
    await capture('06-edit-planning-placeholder');
    const job = await newJob(data.main.project, 'EDIT_PLAN', beforeJobs);
    const failed = await c.waitJob(job.id, 'FAILED');
    c.equal(failed.error?.code, 'EDIT_PLAN_INVALID', 'unsupported provider operation and mode are rejected');
    c.equal(c.observations.filter(row => row.workflow === 'edit-plan').at(-1)?.payload.hasEditMask, true, 'initial edit request carries the actual drawn mask');
    const failure = versions.getByLabel(/^生成失败：/);
    await failure.waitFor();
    const thumbnail = failure.locator('[class*="failedThumbnail"]');
    c.equal(await thumbnail.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(0, 0, 0)', 'failure has black thumbnail');
    c.equal(await thumbnail.locator('[class*="failureIcon"]').textContent(), '!');
    c.check(await thumbnail.locator('[class*="failureIcon"]').evaluate(node => { const [r,g,b] = getComputedStyle(node).backgroundColor.match(/\d+/g).map(Number); return r > g && r > b; }), 'failure icon is red');
    c.equal(imageCalls(), beforeImages, 'invalid plan sends no image request');
    const oldUsage = (await c.invoke('listUsage', { projectId: data.main.project.id, limit: 200 })).items.filter(row => row.jobId === job.id);
    c.check(oldUsage.some(row => row.state === 'COMPLETED'), 'invalid provider reply retains completed usage');
    const beforeRetry = c.mock.state.counts.chat;
    await sleep(1200);
    c.equal(c.mock.state.counts.chat, beforeRetry, 'invalid plan is never automatically resent');
    await capture('07-invalid-edit-plan');
    c.state.editVariant = 'no-confirmation'; c.state.editOverrides = {};
    c.mock.control.failNext('image-edit', { type: 'delay', ms: 9000 });
    await dialog.getByRole('button', { name: '重试任务', exact: true }).click();
    await versions.getByLabel('正在生成', { exact: true }).waitFor();
    c.equal(await versions.getByLabel(/^生成失败：/).count(), 0, 'retry replaces failed state with active generation');
    await capture('08-edit-generation-pending');
    await poll(() => c.invoke('getJob', { jobId: job.id }), row => row.status === 'SUCCEEDED', { label: 'explicit edit plan retry' });
    const edited = await poll(() => outputs(data.main.project), rows => rows.find(row => row.parentOutputId === data.original.id), { label: 'retried edit output' });
    c.check(edited.some(row => row.parentOutputId === data.original.id), 'legal masked retry creates a child output');
    data.editSessionId = edited.find(row => row.parentOutputId === data.original.id).editSessionId;
    c.equal(c.mock.state.counts.chat, beforeRetry + 1, 'one explicit retry sends exactly one new planning request');
    c.equal(c.observations.filter(row => row.workflow === 'edit-plan').at(-1)?.payload.hasEditMask, true, 'explicit retry preserves the frozen mask');
    c.equal(imageCalls(), beforeImages + 1, 'legal retry generates exactly one image');
    const afterUsage = (await c.invoke('listUsage', { projectId: data.main.project.id, limit: 200 })).items;
    c.check(oldUsage.every(old => afterUsage.some(row => row.id === old.id && row.state === old.state && row.inputTokens === old.inputTokens)), 'old usage remains intact after retry');
    c.check(afterUsage.filter(row => row.jobId === job.id).length > oldUsage.length, 'retry adds new planning usage');
    await versions.getByRole('img', { name: 'V2' }).waitFor();
    c.equal(await versions.getByLabel('正在生成', { exact: true }).count(), 0, 'successful image replaces loading tile');
    await capture('09-retried-edit-result');
  } },
  { id: 'masked-clarification', title: 'A legal clarification with a mask never generates an image', needs: ['invalid-plan-retry'], run: async () => {
    const dialog = editor(); await drawMask(dialog);
    await dialog.getByRole('textbox', { name: '修改要求' }).fill('请澄清这片选区需要如何修改。');
    c.state.editVariant = 'clarification';
    c.mock.control.failNext('chat', { type: 'delay', ms: 1500 });
    const beforeJobs = new Set((await jobs(data.main.project)).map(job => job.id));
    const before = imageCalls();
    const session = await c.invoke('getEditSession', { sessionId: data.editSessionId });
    const knownTurns = new Set((await c.invoke('getEditSession', { sessionId: session.id })).turns.map(turn => turn.id));
    await dialog.getByRole('button', { name: '生成计划', exact: true }).click();
    const job = await newJob(data.main.project, 'EDIT_PLAN', beforeJobs);
    await c.waitJob(job.id);
    const turn = await poll(async () => (await c.invoke('getEditSession', { sessionId: session.id })).turns.find(value => !knownTurns.has(value.id)), value => value?.status === 'NEED_INPUT', { label: 'masked clarification' });
    c.equal(turn.plan.executionMode, 'NEED_INPUT');
    await c.invoke('getResource', { ref: { kind: 'EDIT_MASK', id: turn.id } });
    c.equal(imageCalls(), before, 'clarification never generates an image');
    c.check(!(await outputs(data.main.project)).some(row => row.editTurnId === turn.id), 'clarification has no output');
    await dialog.getByLabel('版本历史').getByLabel('需要补充').waitFor();
    await capture('10-masked-clarification');
  } },
];
try {
  await c.launch();
  await c.app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('file:'));
    const area = screen.getPrimaryDisplay().workArea;
    if (window.isMaximized()) window.unmaximize();
    window.setBounds({ x: area.x, y: area.y, width: Math.min(1440, area.width), height: Math.min(960, area.height) });
    window.webContents.setZoomFactor(1); window.show(); window.focus();
  });
  c.state.provider = await c.invoke('createProvider', { name: '规划编辑反馈本机专项', baseUrl: c.mock.baseUrl, apiKey: c.fakeKey, reasoningProtocol: 'openai', models: [modelCapability('mock-reasoner'), modelCapability('mock-image', { imageApiKind: 'openai_images' })] });
  for (const scenario of scenarios) await executeScenario(c, scenario);
} catch (error) { c.result.fatal = c.redact(error.message); }
finally {
  c.result.cleanupErrors = await c.cleanup();
  c.result.rendererErrors = c.state.events.filter(event => event.type === 'pageerror');
  c.result.runtimeHash = c.result.runtimeIdentity?.runtimeHash ?? null;
  c.result.scope = 'Planning and edit feedback only; isolated Electron, SQLite, synthetic images and local mock Provider; no real user data or model-quality claims.';
  c.result.finishedAt = new Date().toISOString();
  c.result.integration = !c.result.fatal && !c.result.cleanupErrors.length && !c.result.rendererErrors.length && c.result.scenarios.length === scenarios.length && c.result.scenarios.every(row => row.status === 'passed') ? 'passed' : 'failed';
  await writeFile(join(artifacts, 'result.json'), c.redact(JSON.stringify(c.result, null, 2)));
  console.log(JSON.stringify({ integration: c.result.integration, runtimeHash: c.result.runtimeHash, scenarios: c.result.scenarios.map(({ id, status, assertions, error }) => ({ id, status, assertions, error })), rendererErrors: c.result.rendererErrors, cleanupErrors: c.result.cleanupErrors, fatal: c.result.fatal }));
  if (c.result.integration !== 'passed') process.exitCode = 1;
}
