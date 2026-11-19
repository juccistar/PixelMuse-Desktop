import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeContext, executeScenario, root, sha256 } from './e2e-full-harness.mjs';
import { businessScenarios } from './e2e-full-business.mjs';
import { editLayerScenarios, verifyLayers } from './e2e-full-edit-layers.mjs';
import { additionalScenarios } from './e2e-full-additional.mjs';

const focusedScenarios = [
  { id: 'seedream-missing-element-regression', title: 'An unrelated semantic element fails after one completed Seedream request', run: async c => {
    const output = c.state.outputs[0];
    await c.invoke('updateProject', { projectId: c.state.project.id, segmentationModel: { providerId: c.state.provider.id, modelId: 'doubao-seedream-5.0-pro-layerize', protocol: 'seedream_layerize' } });
    const before = c.mock.state.total;
    const queued = await c.invoke('createLayerExport', { outputId: output.id, elements: [{ id: 'unmatched-synthetic-element', name: 'Synthetic product body', source: 'prompt' }], includeBackground: true });
    await c.waitJob(queued.job.id, 'FAILED');
    const record = await c.invoke('getLayerExport', { outputId: output.id });
    c.equal(record.status, 'FAILED');
    c.equal(record.error, { code: 'TASK_ERROR', message: '任务未完成，请查看任务状态。' }, 'public failed-job projection stays sanitized');
    c.check(!record.layerFiles?.length, 'missing requested element cannot publish a partial layer export');
    const requests = c.mock.state.records.filter(request => request.id > before);
    const posts = requests.filter(request => request.kind === 'seedream');
    c.equal(posts.length, 1, 'semantic mismatch does not resend the completed request');
    c.equal(posts[0].status, 200); c.equal(posts[0].outcome, 'completed');
    c.equal(requests.filter(request => request.kind === 'download' && request.status === 200 && request.outcome === 'completed').length, 3);
    await c.evidence('unmatched-element', { record, requests });
  } },
  ...['fal', 'seedream_layerize'].map(protocol => ({ id: `layer-soft-alpha-${protocol}`, title: `${protocol} preserves actual soft alpha, source RGB and editable PSD pixels`, run: async c => {
    const output = c.state.outputs[0];
    const { width, height } = c.mock.images;
    const raw = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (x >= width / 4 && x < width * 3 / 4 && y >= height / 4 && y < height * 3 / 4) {
        raw[y * width + x] = x < width / 4 + 3 || x >= width * 3 / 4 - 3 || y < height / 4 + 3 || y >= height * 3 / 4 - 3 ? 128 : 255;
      }
    }
    c.check([0, 128, 255].every(value => raw.includes(value)), 'soft fixture includes transparent, soft and opaque pixels');
    const mask = await c.sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();
    const oldMask = c.mock.images.mask, oldAlpha = c.mock.images.alpha;
    try {
      c.mock.images.mask = mask;
      const rgba = await c.sharp(c.mock.images.image).ensureAlpha().raw().toBuffer();
      for (let index = 0; index < raw.length; index++) rgba[index * 4 + 3] = raw[index];
      c.mock.images.alpha = await c.sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
      const actualAlpha = await c.sharp(c.mock.images.alpha).extractChannel('alpha').raw().toBuffer();
      c.equal(actualAlpha, raw, 'Seedream fixture actually encodes every intended alpha pixel');
      await c.invoke('updateProject', { projectId: c.state.project.id, segmentationModel: { providerId: c.state.provider.id, modelId: protocol === 'fal' ? 'sam-3' : 'doubao-seedream-5.0-pro-layerize', protocol } });
      const name = protocol === 'fal' ? 'Soft synthetic product' : '商品主体';
      const queued = await c.invoke('createLayerExport', { outputId: output.id, elements: [{ id: `soft-${protocol}`, name, source: 'prompt' }], includeBackground: true });
      await c.waitJob(queued.job.id);
      const record = await c.invoke('getLayerExport', { outputId: output.id });
      await verifyLayers(c, record, { names: [name], sourceOutput: output, pixelExact: protocol === 'fal', maskBytes: mask });
    } finally {
      c.mock.images.mask = oldMask; c.mock.images.alpha = oldAlpha;
    }
  } })),
];

const selected = new Set(process.argv.slice(2));
const defaults = ['edit-memory-references','edit-confirmation','edit-need-input','edit-mask-protection','edit-outpaint','reference-promotion','seedream-missing-element-regression','layer-auto-manual-sam','layer-grounded_sam','layer-gitee_sam3','layer-seedream_layerize','layer-soft-alpha-fal','layer-soft-alpha-seedream_layerize','export-zip-long-image'];
const artifacts = resolve(process.env.ECOMGEN_E2E_ARTIFACTS || join(root, '.cache/e2e-full', `layer-edit-focused-cdx-${new Date().toISOString().replace(/[:.]/g, '-')}`));
await mkdir(artifacts, { recursive: true });
assert.equal((await readdir(artifacts)).length, 0, 'Use a new empty focused artifacts directory');
process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
const c = await makeContext();
c.result.scope = 'Focused guarded edit/layer regression; full 64-scenario and packaged acceptance remain unrun';
c.result.completion = false;
c.result.loadedFiles = await Promise.all([
  'scripts/e2e-full-edit-layers.mjs', 'scripts/e2e-full-harness.mjs', 'scripts/full-mock-provider.mjs',
  'packages/backend/dist/execution/job-layers.js', 'packages/backend/dist/execution/seedream-layerize.js',
].map(async file => ({ path: join(root, file), sha256: sha256(await readFile(join(root, file))) })));
try {
  await c.launch();
  await c.screenshot('focused-startup');
  for (const id of ['provider-multimodel','project-facts-assets','storyboard-candidates']) {
    const record = await executeScenario(c, businessScenarios.find(s => s.id === id));
    assert.equal(record.status, 'passed', `${id} prerequisite`);
  }
  const scenarios = [...editLayerScenarios, ...additionalScenarios, ...focusedScenarios];
  for (const id of selected.size ? selected : defaults) {
    const scenario = scenarios.find(s => s.id === id);
    assert.ok(scenario, `Known focused scenario ${id}`);
    const record = await executeScenario(c, scenario);
    if (record.status !== 'passed' && id.startsWith('layer-')) {
      await c.evidence(`${id}-persisted-failure`, {
        layerExport: await c.invoke('getLayerExport', { outputId: c.state.outputs[0].id }),
        jobs: await c.invoke('listJobs', { projectId: c.state.project.id }),
        fixture: c.mock.control.snapshot(),
      });
    }
  }
  const inspection = await c.inspect();
  assert.equal(inspection.integrity, 'ok'); assert.deepEqual(inspection.foreignKeys, []);
  await c.evidence('database-integrity', inspection);
  await c.screenshot('focused-complete');
  c.result.fixture = c.mock.control.snapshot();
  c.result.guardAudit = await c.guardAudit();
  c.result.rendererErrors = c.state.events.filter(e => e.type === 'pageerror');
  assert.equal(c.result.rendererErrors.length, 0, 'No renderer errors');
  assert.equal(c.result.fixture.callbackErrors, 0, 'No fixture callback errors');
  c.result.integration = c.result.scenarios.every(s => s.status === 'passed') ? 'passed' : 'failed';
} catch (error) {
  c.result.integration = 'failed'; c.result.error = c.redact(error.stack ?? error.message);
} finally {
  const errors = await c.cleanup();
  c.result.cleanup = { status: errors.length ? 'failed' : 'passed', errors, temporaryUserDataRemoved: errors.length === 0 };
  if (errors.length) c.result.integration = 'failed';
  c.result.finishedAt = new Date().toISOString();
  await writeFile(join(c.artifacts, 'result.json'), c.redact(JSON.stringify(c.result, null, 2)));
}
console.log(JSON.stringify({ integration: c.result.integration, completion: false, scenarios: c.result.scenarios.map(s => ({ id: s.id, status: s.status, assertions: s.assertions, error: s.error })), cleanup: c.result.cleanup, report: join(c.artifacts, 'result.json') }, null, 2));
process.exitCode = c.result.integration === 'passed' ? 0 : 1;
