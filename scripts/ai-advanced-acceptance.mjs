import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeContext, executeScenario, poll } from './e2e-full-harness.mjs';
import { modelCapability, projectInput } from './e2e-full-business.mjs';
import { requestPayload } from './full-mock-replies.mjs';

// Only the test-owned loopback proxy can be reached by Electron. It forwards to
// one fixed local fixture and retains only synthetic identifiers and parameters.
async function proxyFixture(mock) {
  const upstream = new URL(mock.origin);
  const records = [], sockets = new Set();
  const server = createServer((req, res) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > 20 * 1024 * 1024) req.destroy(); else chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks); let json;
      try { json = JSON.parse(body.toString('utf8')); } catch { json = null; }
      const payload = requestPayload(json);
      const row = { path: req.url?.split('?')[0], projectName: payload.projectName ?? null, target: payload.target ?? null,
        description: payload.productDescription ?? null, maxTokens: json?.max_completion_tokens ?? json?.max_tokens ?? null,
        reasoning: json?.reasoning_effort ?? null, active: true };
      records.push(row);
      const outgoing = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: { ...req.headers, host: upstream.host } }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      outgoing.on('error', () => { if (!res.destroyed) res.destroy(); });
      res.on('close', () => { row.active = false; outgoing.destroy(); });
      outgoing.end(body);
    });
    req.on('error', () => res.destroy());
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, records, close: () => new Promise((ok, fail) => { server.close(error => error ? fail(error) : ok()); for (const socket of sockets) socket.destroy(); }) };
}

const destination = process.env.ECOMGEN_E2E_ARTIFACTS || process.argv[2];
if (!destination) throw Error('Pass a new empty artifacts directory');
const artifacts = resolve(destination);
await mkdir(artifacts, { recursive: true });
if ((await readdir(artifacts)).length) throw Error('Artifacts directory must be empty');
process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
let c, proxy;
const scenarios = [];
const oldAi = { requestTimeoutSeconds: 120, thinkingLevel: 'low', maxOutputTokens: 2048, concurrency: 1 };
const newAi = { requestTimeoutSeconds: 180, thinkingLevel: 'high', maxOutputTokens: 4096, concurrency: 3 };
try {
  c = await makeContext();
  proxy = await proxyFixture(c.mock);
  c.mock.origin = proxy.origin;
  c.mock.baseUrl = `${proxy.origin}/v1`;
  const category = async () => {
    await c.page.getByRole('button', { name: '设置', exact: true }).click();
    await c.page.getByRole('navigation', { name: '设置分类' }).getByRole('link', { name: '模型配置', exact: true }).click();
    await c.page.getByRole('tab', { name: '高级设置', exact: true }).click();
  };
  const setForm = async value => {
    await c.page.getByRole('spinbutton', { name: '推理请求超时（秒）' }).fill(String(value.requestTimeoutSeconds));
    await c.page.getByRole('combobox', { name: '思考强度' }).click();
    await c.page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: ({ low: '低', high: '高' })[value.thinkingLevel] }).click();
    await c.page.getByRole('spinbutton', { name: '最大输出 Token' }).fill(String(value.maxOutputTokens));
    await c.page.getByRole('spinbutton', { name: '同时执行任务数' }).fill(String(value.concurrency));
  };
  const save = async value => {
    await setForm(value); await c.page.getByRole('button', { name: '保存高级设置' }).click();
    await poll(() => c.invoke('getApplicationSettings'), x => JSON.stringify(x.ai) === JSON.stringify(value), { label: 'advanced settings saved' });
  };
  const makeProject = async name => {
    const project = await c.invoke('createProject', projectInput(c, name));
    await c.invoke('uploadAsset', { projectId: project.id, kind: 'PRODUCT', role: 'PRODUCT_TRUTH', file: await c.byteFile() });
    return project;
  };
  const submit = project => c.invoke('createCopywritingJob', { projectId: project.id, target: 'PRODUCT_DESCRIPTION', regenerationKey: randomUUID() });
  const request = name => proxy.records.find(row => row.projectName === name && row.target === 'PRODUCT_DESCRIPTION');
  const openProject = async project => {
    await c.page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '项目', exact: true }).click();
    await c.page.getByRole('region', { name: '项目画廊' }).getByText(project.name, { exact: true }).click();
    await c.page.getByRole('textbox', { name: '商品描述' }).waitFor();
  };
  await c.launch();
  c.state.provider = await c.invoke('createProvider', { name: 'AI 参数本机夹具', baseUrl: c.mock.baseUrl, apiKey: c.fakeKey, reasoningProtocol: 'openai', models: [modelCapability('mock-reasoner', { supportsThinking: true }), modelCapability('mock-image', { imageApiKind: 'openai_images' })] });
  scenarios.push({ id: 'settings', title: 'Advanced settings, dirty tab protection and restart persistence', run: async () => {
    c.result.runtimeVersions = await c.app.evaluate(() => ({ node: process.versions.node, electron: process.versions.electron }));
    const [nodeMajor, nodeMinor] = c.result.runtimeVersions.node.split('.').map(Number);
    c.check(nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 19), 'Electron Node runtime satisfies Pi 1.5 requirement');
    await category(); await save(oldAi); await c.screenshot('advanced-saved');
    await c.page.getByRole('spinbutton', { name: '最大输出 Token' }).fill('3072');
    await c.page.getByRole('tab', { name: '模型列表', exact: true }).click();
    await c.page.getByRole('button', { name: '继续编辑' }).click();
    c.equal(await c.page.getByRole('spinbutton', { name: '最大输出 Token' }).inputValue(), '3072');
    c.equal((await c.invoke('getApplicationSettings')).ai, oldAi);
    await c.page.getByRole('tab', { name: '模型列表', exact: true }).click();
    await c.page.getByRole('button', { name: '放弃修改' }).click();
    await c.page.getByRole('tab', { name: '高级设置', exact: true }).click();
    c.equal(await c.page.getByRole('spinbutton', { name: '最大输出 Token' }).inputValue(), '2048');
    await c.stop(); await c.launch(); await category();
    c.equal((await c.invoke('getApplicationSettings')).ai, oldAi);
    c.equal(await c.page.getByRole('spinbutton', { name: '推理请求超时（秒）' }).inputValue(), '120');
    await c.screenshot('advanced-restarted');
  } });
  scenarios.push({ id: 'snapshot', needs: ['settings'], title: 'Queued task freezes settings and later task sends new settings', run: async () => {
    const first = await makeProject('AI snapshot blocker'); const queued = await makeProject('AI snapshot queued'); const fresh = await makeProject('AI snapshot fresh');
    c.mock.control.failNext('chat', { type: 'delay', ms: 10000 });
    const firstJob = await submit(first);
    await poll(() => c.mock.state.records.find(row => row.kind === 'chat' && row.outcome === 'pending'), Boolean, { label: 'blocking request in flight' });
    const queuedJob = await submit(queued);
    const state = await c.invoke('getJob', { jobId: queuedJob.id });
    c.equal(state.status, 'QUEUED', 'second task is durably queued before settings change');
    await save(newAi);
    const freshJob = await submit(fresh);
    await Promise.all([c.waitJob(firstJob.id), c.waitJob(queuedJob.id), c.waitJob(freshJob.id)]);
    const oldRequest = await poll(() => request(queued.name), Boolean, { label: 'queued request observed' });
    const newRequest = await poll(() => request(fresh.name), Boolean, { label: 'new request observed' });
    c.equal([oldRequest.maxTokens, oldRequest.reasoning], [2048, 'low']);
    c.equal([newRequest.maxTokens, newRequest.reasoning], [4096, 'high']);
    await c.evidence('request-parameters', { queued: { maxTokens: oldRequest.maxTokens, reasoning: oldRequest.reasoning }, fresh: { maxTokens: newRequest.maxTokens, reasoning: newRequest.reasoning } });
    await c.stop(); await c.launch(); c.equal((await c.invoke('getApplicationSettings')).ai, newAi);
  } });
  scenarios.push({ id: 'concurrency', needs: ['snapshot'], title: 'Three independent tasks reach the local provider simultaneously', run: async () => {
    const projects = await Promise.all([1, 2, 3].map(i => makeProject(`AI concurrent ${i}`)));
    c.mock.control.addFault({ kind: 'chat', times: 3, fault: { type: 'delay', ms: 10000 } });
    const jobs = await Promise.all(projects.map(submit));
    await poll(() => proxy.records.filter(row => row.active && projects.some(p => p.name === row.projectName)).length, n => n >= 3, { label: 'three concurrent provider requests' });
    c.check(true, 'three independent requests overlap while delayed by fixture');
    await Promise.all(jobs.map(job => c.waitJob(job.id)));
  } });
  scenarios.push({ id: 'copywriting', needs: ['concurrency'], title: 'Description writing blocks lower action until saved; lower request uses saved description', run: async () => {
    const project = await makeProject('AI copywriting ordering'); await openProject(project);
    const upper = c.page.getByRole('button', { name: 'AI 帮写商品描述' });
    const lower = c.page.getByRole('button', { name: 'AI 帮写补充说明' });
    await poll(() => upper.isEnabled(), Boolean, { label: 'description writing enabled' });
    c.mock.control.failNext('chat', { type: 'delay', ms: 8000 });
    const before = new Set((await c.invoke('listJobs', { projectId: project.id })).items.map(job => job.id));
    await upper.click();
    const upperJob = await poll(async () => (await c.invoke('listJobs', { projectId: project.id })).items.find(job => !before.has(job.id) && job.type === 'COPYWRITE' && job.copywritingTarget === 'PRODUCT_DESCRIPTION'), Boolean, { label: 'public description job' });
    await poll(() => lower.isDisabled(), Boolean, { label: 'lower writing disabled during description job' });
    c.equal(await upper.isDisabled(), true); await c.screenshot('copywriting-blocked');
    await c.waitJob(upperJob.id);
    const result = await c.invoke('getCopywritingResult', { jobId: upperJob.id });
    await poll(() => c.invoke('getProject', { projectId: project.id }), value => value.productDescription === result.content, { label: 'generated description saved' });
    await poll(() => lower.isEnabled(), Boolean, { label: 'lower writing enabled after save' });
    await lower.click();
    const lowerJob = await poll(async () => (await c.invoke('listJobs', { projectId: project.id })).items.find(job => !before.has(job.id) && job.type === 'COPYWRITE' && job.copywritingTarget === 'PLANNING_INSTRUCTION'), Boolean, { label: 'public planning copy job' });
    await c.waitJob(lowerJob.id);
    const lowerRequest = await poll(() => proxy.records.find(row => row.projectName === project.name && row.target === 'PLANNING_INSTRUCTION'), Boolean, { label: 'lower request' });
    c.equal(lowerRequest.description, result.content, 'lower request receives persisted generated description');
    await c.screenshot('copywriting-complete');
  } });
  for (const scenario of scenarios) await executeScenario(c, scenario);
} catch (error) {
  if (c) c.result.fatal = c.redact(error.message); else throw error;
} finally {
  if (c) {
    const errors = await c.cleanup();
    if (proxy) try { await proxy.close(); } catch (error) { errors.push(c.redact(error.message)); }
    try { await readdir(c.fixture); errors.push('Temporary fixture remains'); } catch (error) { if (error.code !== 'ENOENT') errors.push(c.redact(error.message)); }
    c.result.cleanupErrors = errors;
    c.result.rendererErrors = c.state.events.filter(event => event.type === 'pageerror');
    c.result.fixtureCallbackErrors = c.mock.state.callbackErrors;
    c.result.runtimeHash = c.result.runtimeIdentity?.runtimeHash ?? null;
    c.result.scope = 'Isolated Electron and local mock only; no real model quality or installer/upgrade validation.';
    c.result.finishedAt = new Date().toISOString();
    c.result.integration = !c.result.fatal && c.result.runtimeHash && !errors.length && !c.result.rendererErrors.length && !c.result.fixtureCallbackErrors && scenarios.length === 4 && c.result.scenarios.length === 4 && c.result.scenarios.every(row => row.status === 'passed') ? 'passed' : 'failed';
    await writeFile(join(artifacts, 'result.json'), c.redact(JSON.stringify(c.result, null, 2)));
    console.log(JSON.stringify({ integration: c.result.integration, runtimeHash: c.result.runtimeHash, scenarios: c.result.scenarios.map(({ id, status, assertions, error }) => ({ id, status, assertions, error })), rendererErrors: c.result.rendererErrors.length, cleanupErrors: errors, fatal: c.result.fatal }));
    if (c.result.integration !== 'passed') process.exitCode = 1;
  }
}
