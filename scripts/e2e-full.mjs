import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { root, makeContext, executeScenario, Blocked, sha256 } from './e2e-full-harness.mjs';
import { scenarios, scenarioModules, featureScenarios, completionSummary } from './e2e-full-registry.mjs';

const args = new Set(process.argv.slice(2));
for (const arg of args) if (!['--check', '--list', '--help', '--startup-only'].includes(arg)) throw Error(`Unsupported argument: ${arg}`);
if (args.has('--help')) {
  console.log('node desktop/scripts/e2e-full.mjs [--check | --list | --startup-only]\nDefault: actual Electron acceptance. --startup-only: actual guarded startup, readonly inspection and cleanup; no business scenarios. --check: syntax, coverage plan and driver helper selftests; never application integration.\nECOMGEN_E2E_EXECUTABLE: final EXE (omit for apps/desktop development Electron).\nECOMGEN_E2E_ARTIFACTS: new or empty artifacts directory. Blocked scenarios always prevent completion.');
} else {
  await main();
}

async function main() {
  const catalogFile = join(root, 'packages/contracts/command-catalog.json');
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  const baseline = JSON.parse(await readFile(join(root, 'migration-discovery/original-api-inventory.json'), 'utf8'));
  const jobs = JSON.parse(await readFile(join(root, 'migration-discovery/original-job-inventory.json'), 'utf8'));
  const map = JSON.parse(await readFile(join(root, 'migration-discovery/map-4.json'), 'utf8'));
  const ids = new Set();
  for (const scenario of scenarios) {
    assert.ok(!ids.has(scenario.id), `Duplicate scenario ${scenario.id}`);
    for (const dependency of scenario.needs) assert.ok(ids.has(dependency), `Dependency ${dependency} must run before ${scenario.id}`);
    ids.add(scenario.id);
  }
  assert.equal(baseline.operations.length, 131, 'Review changed original-operation baseline explicitly');
  assert.equal(jobs.kinds.length, 20);
  for (const operation of baseline.operations) assert.ok(catalog.operations.some(row => row.source?.operationId === operation.operationId), `Unmapped original operation ${operation.operationId}`);
  for (const feature of map.report.features) assert.ok(featureScenarios[feature.id]?.every(id => ids.has(id)), `Unassigned baseline family ${feature.id}`);
  if (args.has('--list')) {
    console.log(JSON.stringify(scenarios.map(({ run, ...metadata }) => metadata), null, 2));
    return;
  }
  const artifacts = resolve(process.env.ECOMGEN_E2E_ARTIFACTS || join(root, '.cache/e2e-full', new Date().toISOString().replace(/[:.]/g, '-')));
  await mkdir(artifacts, { recursive: true });
  assert.equal((await readdir(artifacts)).length, 0, 'Use a new/empty ECOMGEN_E2E_ARTIFACTS directory so evidence cannot be overwritten');
  process.env.ECOMGEN_E2E_ARTIFACTS = artifacts;
  const manifest = {
    version: 1, generatedAt: new Date().toISOString(), integration: 'unrun', completion: false,
    command: 'node desktop/scripts/e2e-full.mjs', checkCommand: 'node desktop/scripts/e2e-full.mjs --check',
    artifacts, scope: 'Actual Electron + named IPC + persisted SQLite + local protocol fixture; no HTTP business client',
    nativeDialogs: 'Native saves are test-controlled in the isolated app; HTML uploads use real file inputs. OS dialog rendering is not automated.',
    sources: { catalog: { path: catalogFile, sha256: sha256(await readFile(catalogFile)) }, modules: scenarioModules.map(name => join(root, 'scripts', name)) },
    scenarios: scenarios.map(({ run, ...scenario }) => ({ ...scenario, status: 'blocked', assertions: 0, evidence: [], reason: 'Application integration has not run' })),
    features: map.report.features.map(feature => ({ id: feature.id, behavior: feature.behavior, scenarios: featureScenarios[feature.id], status: 'blocked' })),
    jobTypes: [...jobs.kinds, ...jobs.additionalBranches.map(b => `${b.kind}:${b.target}`)],
    operations: baseline.operations.map(operation => {
      const target = catalog.operations.find(row => row.source?.operationId === operation.operationId);
      return { original: operation.operationId, operation: target.operation, disposition: target.disposition, status: 'blocked', evidence: [] };
    }),
    knownContractBlockers: catalog.operations.filter(row => row.operation === 'createPatternExtractJob' && row.input?.properties?.file?.type !== 'object').map(row => ({ operation: row.operation, reason: 'file still declares legacy multipart string; extraction requires restricted ByteImport IPC', scenarios: ['pattern-extract-segment', 'pattern-extract-generate'] })),
  };
  const acceptedMimes=catalog.operations.find(row=>row.operation==='uploadAsset')?.input?.properties?.file?.properties?.mimeType?.anyOf?.map(row=>row.const)??[];
  const missingFormats=['image/avif','image/tiff'].filter(mime=>!acceptedMimes.includes(mime));
  if(missingFormats.length)manifest.knownContractBlockers.push({operation:'uploadAsset',reason:`Published desktop formats absent from ByteImport MIME schema: ${missingFormats.join(', ')}`,scenarios:['asset-readable-formats']});
  const manifestPath = join(artifacts, 'coverage.json');
  const saveManifest = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await saveManifest();
  if (args.has('--check')) {
    const files = (await readdir(join(root, 'scripts'))).filter(name => /^e2e-full(?:-.*)?\.mjs$/.test(name)).sort();
    const syntax = files.map(file => {
      const check = spawnSync(process.execPath, ['--check', join(root, 'scripts', file)], { encoding: 'utf8', timeout: 15000 });
      return { file: join(root, 'scripts', file), status: check.status === 0 ? 'passed' : 'failed', ...(check.status === 0 ? {} : { error: String(check.error?.message ?? check.stderr).trim() }) };
    });
    const selftest = spawnSync(process.execPath, [join(root, 'scripts/e2e-full-selftest.mjs')], { encoding: 'utf8', timeout: 30000 });
    const selftestEvidence = join(artifacts, 'driver-selftest.tap');
    await writeFile(selftestEvidence, String(selftest.stdout ?? '') + String(selftest.stderr ?? selftest.error?.message ?? ''));
    const source = (await Promise.all([...scenarioModules, 'e2e-full-harness.mjs'].map(name => readFile(join(root, 'scripts', name), 'utf8')))).join('\n');
    const missingAuthoredOperations = catalog.operations.filter(row => row.disposition === 'named IPC command' && !source.includes(`'${row.operation}'`)).map(row => row.operation);
    manifest.checks = { syntax, helperSelftests: { status: selftest.status === 0 ? 'passed' : 'failed', evidence: selftestEvidence }, registryDependencies: 'passed', originalOperationMappings: 131, jobTypes: 20, baselineFeatureAssignments: map.report.features.length, missingAuthoredOperations,
      note: 'Static assignment and parse checks are not application behavior evidence. Every integration scenario remains blocked.' };
    await saveManifest();
    await writeFile(join(root, 'migration-discovery/e2e-full-coverage.json'), JSON.stringify(manifest, null, 2));
    const passed = syntax.every(row => row.status === 'passed') && selftest.status === 0 && missingAuthoredOperations.length === 0;
    console.log(JSON.stringify({ check: passed ? 'passed' : 'failed', integration: 'unrun', completion: false, scenarios: scenarios.length, report: manifestPath, missingAuthoredOperations }, null, 2));
    process.exitCode = passed ? 0 : 1;
    return;
  }

  let ctx;
  let launchError;
  let interrupted = false;
  let interruptCleanup;
  const onInterrupt = () => { interrupted = true; interruptCleanup ??= ctx?.stop().catch(() => {}); };
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
  try {
    ctx = await makeContext(); ctx.catalog = catalog;
    if (interrupted) launchError = 'Acceptance run interrupted';
    else try { await ctx.launch(); } catch (error) { launchError = ctx.redact(error.message); }
    if (args.has('--startup-only') && !launchError) {
      const inspection = await ctx.inspect();
      assert.equal(inspection.integrity, 'ok');
      assert.deepEqual(inspection.foreignKeys, []);
      assert.equal(inspection.counts.providers, 0); assert.equal(inspection.counts.jobs, 0);
      await ctx.page.getByRole('navigation', { name: '全局导航' }).waitFor({ state: 'visible' });
      await ctx.page.getByRole('link', { name: 'PixelMuse', exact: true }).click();
      await ctx.page.getByRole('region', { name: '项目画廊' }).getByText('0 个活跃项目', { exact: true }).waitFor({ state: 'visible' });
      ctx.result.startupProbe = { status: 'passed', ...ctx.startupGuard,
        databaseVersion: inspection.version, integrity: inspection.integrity, providers: inspection.counts.providers, jobs: inspection.counts.jobs };
      await ctx.evidence('startup-probe', ctx.result.startupProbe);
      await ctx.screenshot('startup');
    }
    for (const scenario of args.has('--startup-only') ? [] : scenarios) {
      if (interrupted) { launchError = 'Acceptance run interrupted'; break; }
      const runnable = launchError ? { ...scenario, run: async () => { throw new Blocked(`Application launch prerequisite: ${launchError}`); } } : scenario;
      await executeScenario(ctx, runnable);
    }
    const summary = completionSummary(ctx.result.scenarios, jobs);
    for (const entry of manifest.operations) {
      const matching = ctx.result.scenarios.filter(row => row.status === 'passed' && row.operations[entry.operation]?.resolved > 0);
      if (entry.original === 'noopPatternsPost') {
        const imported = ctx.result.scenarios.find(row => row.id === 'pattern-import' && row.status === 'passed');
        if (imported) matching.push(imported);
      }
      if (entry.original === 'subscribeEvents') {
        const subscribed = ctx.result.scenarios.find(row => row.id === 'events-invalidation' && row.status === 'passed');
        if (subscribed) matching.push(subscribed);
      }
      entry.status = matching.length ? 'passed' : 'blocked';
      entry.evidence = [...new Set(matching.flatMap(row => row.evidence))];
    }
    const operationGaps = manifest.operations.filter(row => row.status !== 'passed').map(row => row.original);
    ctx.result.summary = { ...summary, operationGaps };
    ctx.result.integration = summary.complete && operationGaps.length === 0 ? 'passed' : 'failed';
    manifest.scenarios = ctx.result.scenarios;
    for (const family of manifest.features) {
      const records = family.scenarios.map(id => ctx.result.scenarios.find(row => row.id === id));
      family.status = records.every(row => row?.status === 'passed') ? 'passed' : records.some(row => row?.status === 'failed') ? 'failed' : 'blocked';
      family.evidence = [...new Set(records.flatMap(row => row?.evidence ?? []))];
    }
    await ctx.evidence('fixture-final', ctx.mock.control.snapshot());
    await ctx.evidence('network-audit', await ctx.guardAudit());
    await ctx.evidence('renderer-errors', ctx.state.events);
    ctx.result.globalChecks={rendererErrors:ctx.state.events.filter(event=>event.type==='pageerror').length,fixtureCallbackErrors:ctx.mock.state.callbackErrors};
    if (ctx.result.globalChecks.rendererErrors || ctx.result.globalChecks.fixtureCallbackErrors) {
      ctx.result.integration = 'failed'; await ctx.screenshot('global-failure').catch(()=>{});
    }
  } catch (error) {
    launchError = ctx ? ctx.redact(error.message) : 'Acceptance initialization failed; check installed Playwright/Electron/sharp and filesystem permissions';
    manifest.error = launchError;
    if (ctx) { ctx.result.integration = 'failed'; await ctx.screenshot('fatal-failure').catch(() => {}); }
  } finally {
    await interruptCleanup;
    const cleanupErrors = ctx ? await ctx.cleanup() : [];
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
    if (ctx) {
      for(const scenario of scenarios)if(!ctx.result.scenarios.some(row=>row.id===scenario.id))ctx.result.scenarios.push({id:scenario.id,title:scenario.title,status:'blocked',assertions:0,evidence:[],operations:{},jobs:[],verifiedBranches:[],error:args.has('--startup-only')?'Startup-only probe: business acceptance was not run':'Driver terminated before this scenario could run'});
      manifest.scenarios=ctx.result.scenarios;
      ctx.result.cleanup = { status: cleanupErrors.length ? 'failed' : 'passed', errors: cleanupErrors, temporaryUserDataRemoved: cleanupErrors.length === 0 };
      if (cleanupErrors.length || launchError || ctx.result.runtimeIdentityError || !ctx.result.runtimeIdentity) ctx.result.integration = 'failed';
      if (args.has('--startup-only') && ctx.result.startupProbe?.status === 'passed' && !launchError && !cleanupErrors.length) ctx.result.integration = 'unrun';
      if (launchError) manifest.error = launchError;
      if (args.has('--startup-only')) manifest.startupProbe = ctx.result.startupProbe ??= { status: 'failed', error: launchError };
      ctx.result.finishedAt = new Date().toISOString();
      manifest.runId = ctx.result.runId;
      manifest.runtimeIdentity = ctx.result.runtimeIdentity;
      manifest.integration = ctx.result.integration;
      manifest.completion = ctx.result.integration === 'passed';
      await writeFile(join(artifacts, 'result.json'), ctx.redact(JSON.stringify(ctx.result, null, 2)));
    } else {
      manifest.integration = 'blocked';
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ integration: 'blocked', completion: false, error: launchError, scenarios: manifest.scenarios }, null, 2));
    }
    await saveManifest();
    process.exitCode = args.has('--startup-only') ? (manifest.startupProbe?.status === 'passed' && ctx?.result.cleanup.status === 'passed' && !launchError ? 0 : 1) : (manifest.completion ? 0 : 1);
    console.log(JSON.stringify({ integration: manifest.integration, completion: manifest.completion, report: join(artifacts, 'result.json'), coverage: manifestPath }, null, 2));
  }
}
