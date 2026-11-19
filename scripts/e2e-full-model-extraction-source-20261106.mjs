import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, makeContext, executeScenario, sha256 } from './e2e-full-harness.mjs';
import { scenarios } from './e2e-full-registry.mjs';

// Focused actual Source acceptance; independent user data, fixture and artifacts.
assert.ok(!process.env.ECOMGEN_E2E_EXECUTABLE, 'This focused run requires built Source, not a packaged executable');
const artifacts = join(root, '.cache/e2e-full', `model-extraction-source-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(artifacts, { recursive: true });
assert.deepEqual(await readdir(artifacts), []);
process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
const requested = ['provider-multimodel', 'global-models', 'pattern-extract-segment', 'pattern-extract-generate'];
const c = await makeContext();
c.catalog = JSON.parse(await readFile(join(root, 'packages/contracts/command-catalog.json'), 'utf8'));
const originalMask = c.mock.images.mask, originalHash = sha256(originalMask);
try {
  await c.launch();
  await c.page.getByRole('navigation', { name: '全局导航' }).waitFor({ state: 'visible' });
  await c.page.getByRole('link', { name: 'PixelMuse', exact: true }).click();
  await c.screenshot('focused-source-startup');
  for (const id of requested) {
    const scenario = scenarios.find(row => row.id === id);
    assert.ok(scenario, `Missing scenario ${id}`);
    const record = await executeScenario(c, { ...scenario, run: async ctx => { await scenario.run(ctx); await ctx.screenshot('passed'); } });
    if (id === 'global-models' && record.status === 'failed' && c.state.model) {
      const { items: portraits } = await c.invoke('listModelPortraits', { modelId: c.state.model.id });
      const fixtureImage = await c.sharp(c.mock.images.image).modulate({ hue: 140 }).ensureAlpha().raw().toBuffer();
      const actual = [];
      for (const portrait of portraits) {
        const image = await c.imageRef({ kind: 'PORTRAIT', id: portrait.id });
        actual.push({ id: portrait.id, fileHash: sha256(image.bytes), pixelHash: sha256(image.data), equalsSharedEditFixture: image.data.equals(fixtureImage) });
      }
      await c.evidence('model-cast-fixture-diagnostic', { requestedCandidates: 2, imageEditRequests: record.fixtureDelta['image-edit'], sharedEditFixturePixelHash: sha256(fixtureImage), portraits: actual });
    }
  }
  assert.equal(c.mock.images.mask, originalMask);
  assert.equal(sha256(c.mock.images.mask), originalHash);
  const audit = await c.guardAudit();
  await c.evidence('network-audit', audit);
  await c.evidence('fixture-final', c.mock.control.snapshot());
  c.result.globalChecks = { rendererErrors: c.state.events.filter(row => row.type === 'pageerror').length, callbackErrors: c.mock.state.callbackErrors, blockedNetworkAttempts: audit.filter(row => ['blocked', 'blocked-renderer'].includes(row.event)).length, maskRestored: true };
  c.result.integration = c.result.scenarios.every(row => row.status === 'passed') && Object.values(c.result.globalChecks).every(value => value === 0 || value === true) ? 'passed' : 'failed';
} catch (error) {
  c.result.integration = 'failed';
  c.result.error = c.redact(error.message);
} finally {
  const errors = await c.cleanup();
  c.result.cleanup = { status: errors.length ? 'failed' : 'passed', errors, temporaryUserDataRemoved: errors.length === 0 };
  if (errors.length) c.result.integration = 'failed';
  c.result.finishedAt = new Date().toISOString();
  await writeFile(join(artifacts, 'result.json'), c.redact(JSON.stringify(c.result, null, 2)));
  console.log(JSON.stringify({ integration: c.result.integration, scenarios: c.result.scenarios.map(({ id, status, assertions, error }) => ({ id, status, assertions, error })), cleanup: c.result.cleanup, report: join(artifacts, 'result.json') }, null, 2));
  process.exitCode = c.result.integration === 'passed' ? 0 : 1;
}
