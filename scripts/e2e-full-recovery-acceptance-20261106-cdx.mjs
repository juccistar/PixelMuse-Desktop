import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { root, makeContext, executeScenario, sha256 } from './e2e-full-harness.mjs';
import { scenarios } from './e2e-full-registry.mjs';

const ids=['provider-multimodel','project-facts-assets','ipc-path-secret-boundaries','abort-inflight','backend-crash-status'];
const selected=ids.map(id=>{const scenario=scenarios.find(row=>row.id===id);assert.ok(scenario,`Missing existing scenario ${id}`);return scenario;});
const base=join(root,'.cache/e2e-full');await mkdir(base,{recursive:true});
const artifacts=process.env.ECOMGEN_E2E_ARTIFACTS?resolve(process.env.ECOMGEN_E2E_ARTIFACTS):await mkdtemp(join(base,'recovery-acceptance-20261106-cdx-'));
await mkdir(artifacts,{recursive:true});assert.equal((await readdir(artifacts)).length,0,'Fresh artifacts required');
assert.ok(!process.env.ECOMGEN_E2E_EXECUTABLE,'This focused run requires the default development Electron and Backend');
process.env.ECOMGEN_E2E_ARTIFACTS=artifacts;
let c;
try {
  c=await makeContext();
  Object.assign(c.result,{completion:false,scope:'Focused real Electron recovery acceptance, plus repeated abort followed by crash; full acceptance remains incomplete'});
  const sourceFiles=['scripts/e2e-full-recovery.mjs','scripts/e2e-full-harness.mjs','scripts/full-mock-provider.mjs','apps/desktop/out/main/index.js','packages/backend/dist/index.js'];
  await c.evidence('sources',await Promise.all(sourceFiles.map(async file=>({file:join(root,file),sha256:sha256(await readFile(join(root,file)))}))));
  await c.launch();
  await c.page.getByRole('navigation',{name:'全局导航'}).waitFor({state:'visible'});
  await c.screenshot('startup');
  for(const scenario of selected)await executeScenario(c,scenario);
  // Keep the same provider and cumulative counters so both repeated interruptions
  // must observe a fresh hang rather than accepting any of the earlier ones.
  for(const id of ['abort-inflight','backend-crash-status']) {
    const original=selected.find(row=>row.id===id);
    await executeScenario(c,{...original,id:`${id}-repeat`,title:`${original.title} (same-fixture repeat)`});
  }
  await c.evidence('fixture-final',c.mock.control.snapshot());
  await c.evidence('network-audit',await c.guardAudit());
  await c.evidence('renderer-errors',c.state.events);
  c.result.globalChecks={rendererErrors:c.state.events.filter(row=>row.type==='pageerror').length,fixtureCallbackErrors:c.mock.state.callbackErrors};
  c.result.integration=c.result.scenarios.every(row=>row.status==='passed')&&!c.result.globalChecks.rendererErrors&&!c.result.globalChecks.fixtureCallbackErrors?'passed':'failed';
  await c.screenshot('finished');
} catch(error) {
  if(c){c.result.integration='failed';c.result.error=c.redact(error.stack??error.message);}
  else throw error;
} finally {
  if(c) {
    const errors=await c.cleanup();
    c.result.cleanup={status:errors.length?'failed':'passed',errors,temporaryUserDataRemoved:errors.length===0};
    if(errors.length)c.result.integration='failed';
    c.result.completion=false;c.result.finishedAt=new Date().toISOString();
    await writeFile(join(artifacts,'result.json'),c.redact(JSON.stringify(c.result,null,2)));
    console.log(JSON.stringify({integration:c.result.integration,completion:false,scenarios:c.result.scenarios.map(({id,status,assertions,error})=>({id,status,assertions,error})),cleanup:c.result.cleanup,report:join(artifacts,'result.json')},null,2));
    process.exitCode=c.result.integration==='passed'?0:1;
  }
}
