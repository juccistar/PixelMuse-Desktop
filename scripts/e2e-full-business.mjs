import { randomUUID } from 'node:crypto';
import { need, items, poll, sha256 } from './e2e-full-harness.mjs';

export const modelCapability = (id, extra = {}) => ({ id, supportsVision: true, supportsThinking: false, supportsTools: false, supportsStructuredOutput: true, ...extra });
export function projectInput(c, name, extra = {}) {
  const provider = need(c.state.provider, 'Provider setup did not pass');
  return { name, category: 'home', productDescription: 'A synthetic ceramic cup for offline acceptance.', verifiedFacts: ['synthetic ceramic'], prohibitedClaims: ['no medical claims'], brandGuidelines: { accent: '#ff7755', tone: 'calm' }, platformTargets: ['AMAZON'], targetMarket: 'UNITED_STATES', copyLanguage: 'en-US', promptLanguage: 'ENGLISH', reasoningProviderId: provider.id, reasoningModelId: 'mock-reasoner', imageProviderId: provider.id, imageModelId: 'mock-image', defaultMode: 'CREATIVE', imageResolution: '1K', imageAspectRatio: 'AUTO', candidatesPerType: 1, ...extra };
}
export async function plan(c, project, extra = {}) {
  const planningMode = extra.planningMode ?? 'AI';
  const submission = await c.invoke('createPlanningJob', { projectId: project.id, planningMode, ...(planningMode === 'AI' ? { targetImageCount: 1 } : {}), regenerationKey: randomUUID(), ...extra });
  await c.waitJob(submission.id);
  const board = await c.invoke('getStoryboard', { projectId: project.id });
  c.check(board.storyboard && board.items.length > 0, 'persisted storyboard and items');
  return board;
}
export async function generate(c, project, board, extra = {}) {
  await c.invoke('confirmStoryboard', { projectId: project.id, version: board.storyboard.version });
  const request = { projectId: project.id, storyboardItemIds: board.items.map(item => item.id), generationBatchId: randomUUID(), ...extra };
  const submission = await c.invoke('createGenerationJobs', request);
  for (const job of submission.jobs) await c.waitJob(job.id);
  const outputs = items(await c.invoke('listOutputs', { projectId: project.id })).filter(output => submission.jobs.some(job => job.id === output.jobId));
  c.check(outputs.length > 0, 'committed outputs are queryable');
  for (const output of outputs) await c.imageRef({ kind: 'OUTPUT', id: output.id }, { expectedHash: output.hash });
  return { outputs, submission, request };
}
export async function allPages(c, operation, input = {}) {
  const collected = [], cursors = new Set(); let cursor;
  do {
    const page = await c.invoke(operation, { ...input, ...(cursor ? { cursor } : {}) });
    collected.push(...items(page)); cursor = page.nextCursor;
    if (cursor) { c.check(!cursors.has(cursor), 'pagination cursor advances'); cursors.add(cursor); }
  } while (cursor);
  return collected;
}

/** Check parsed inputs and the actual response path; endpoint counts include harmless validation probes. */
export function assertNonExecutingProbeRequests(c, before) {
  const requests = c.mock.state.records.filter(record => record.id > before);
  c.check(requests.length > 0, 'manual probe reaches the local provider');
  c.equal(requests.length, c.mock.state.total - before, 'all manual probe requests remain available for accounting');
  for (const request of requests) {
    c.equal(request.hasParsedInput, false, 'manual probe contains no image, model or other execution input');
    c.equal(request.fault, null, 'manual probe is not a fault-injected response');
    c.equal(request.outcome, 'completed', 'manual probe response completes');
    if (request.method === 'GET') {
      c.check(['models', 'health'].includes(request.kind), 'manual probe only reads model discovery or health');
      c.equal(request.status, 200, 'read-only manual probe succeeds');
    } else {
      c.equal(request.method, 'POST', 'validation probe uses POST');
      c.check(['fal', 'gitee-sam3'].includes(request.kind), 'only adapters with an empty-input validation probe use POST');
      c.equal(request.validationRejected, true, 'empty probe is rejected by input validation');
      c.check([400, 422].includes(request.status), 'empty probe receives a validation error');
    }
  }
}

export const businessScenarios = [
  { id: 'provider-multimodel', title: 'Multiple models, saved/explicit discovery, manual probes and key preservation', run: async c => {
    const models = [modelCapability('mock-reasoner', { supportsTools: true }), modelCapability('mock-image', { imageApiKind: 'openai_images' }), modelCapability('gpt-image-1', { imageApiKind: 'openai_images' }), ...[['sam-3', 'fal'], ['grounded-sam', 'grounded_sam'], ['sam3', 'gitee_sam3'], ['doubao-seedream-5.0-pro-layerize', 'seedream_layerize']].map(([id, segmentationProtocol]) => modelCapability(id, { segmentationProtocol }))];
    // Detect a protocol-name change explicitly instead of inventing a production adapter.
    const p = await c.invoke('createProvider', { name: 'Full offline provider', baseUrl: c.mock.baseUrl, reasoningProtocol: 'openai', apiKey: c.fakeKey, models });
    c.state.provider = p;
    c.equal(p.models.length, models.length, 'all declared model capabilities persist');
    c.check(p.hasApiKey, 'secret exists without returning the key');
    for (const discovery of [{ baseUrl: c.mock.baseUrl, apiKey: c.fakeKey }, { providerId: p.id }]) {
      const found = await c.invoke('discoverProviderModels', discovery);
      c.check(found.models.includes('mock-image') && found.models.includes('mock-reasoner'), 'real local /models discovery');
    }
    const updated = await c.invoke('updateProvider', { providerId: p.id, name: 'Full offline provider retained key' });
    c.check(updated.hasApiKey, 'omitted key preserves encrypted credential');
    for (const [modelId, kind] of [['mock-reasoner', 'reasoning'], ['mock-image', 'image'], ['sam-3', 'segmentation'], ['grounded-sam','segmentation'], ['sam3','segmentation']]) {
      const before = c.mock.state.total;
      const tested = await c.invoke('testProviderConnection', { providerId: p.id, modelId, kind }); c.equal(tested.ok, true, `${kind} probe`);
      assertNonExecutingProbeRequests(c, before);
    }
    await c.rejects('testProviderConnection', { providerId: p.id, modelId: 'not-saved', kind: 'image' });
    await c.rejects('createProvider', { name: 'Invalid overlap', baseUrl: c.mock.baseUrl, reasoningProtocol: 'openai', apiKey: c.fakeKey, models: [modelCapability('invalid', { imageApiKind: 'openai_images', segmentationProtocol: 'fal' })] });
    c.equal(items(await c.invoke('listProviders')).filter(item => item.id === p.id).length, 1);
    await c.evidence('probes', c.mock.control.snapshot());
  } },
  { id: 'search-sources', title: 'Local search source priority, encryption and saved-key edits', run: async c => {
    const sources = [];
    for (const [kind, priority] of [['brave', 5], ['tavily', 20], ['searxng', 30]]) sources.push(await c.invoke('createSearchSource', { name: `Offline ${kind}`, kind, baseUrl: c.mock.searchUrls[kind], apiKey: c.fakeKey, priority, enabled: true }));
    c.state.sources = sources;
    const changed = await c.invoke('updateSearchSource', { sourceId: sources[0].id, name: 'Offline Brave retained', priority: 5 });
    c.check(changed.hasApiKey, 'search secret retained');
    const saved = items(await c.invoke('listSearchSources'));
    c.equal(saved.filter(item => sources.some(source => source.id === item.id)).map(item => item.priority).sort((a,b) => a-b), [5,20,30]);
    const disposable = await c.invoke('createSearchSource', { name: 'Delete search source', kind: 'searxng', baseUrl: c.mock.searchUrls.searxng, priority: 99 });
    await c.invoke('deleteSearchSource', { sourceId: disposable.id });
    c.check(!items(await c.invoke('listSearchSources')).some(item => item.id === disposable.id));
  } },
  { id: 'project-facts-assets', title: 'Full business facts, normalized languages, roles and byte imports', run: async c => {
    const p = await c.invoke('createProject', projectInput(c, 'Full acceptance cup'));
    c.state.project = p;
    c.equal(p.verifiedFacts, ['synthetic ceramic']); c.equal(p.prohibitedClaims, ['no medical claims']); c.equal(p.platformTargets, ['AMAZON']); c.equal(p.copyLanguage, 'en-US'); c.equal(p.promptLanguage, 'ENGLISH');
    const revision = p.planningRevision;
    const changed = await c.invoke('updateProject', { projectId: p.id, productDescription: 'Synthetic ceramic cup, updated facts.', targetMarket: 'GERMANY', copyLanguage: 'de-DE', promptLanguage: 'CHINESE' });
    c.equal(changed.targetMarket, 'GERMANY'); c.equal(changed.copyLanguage, 'de-DE');
    if (revision !== undefined) c.check(changed.planningRevision > revision, 'planning facts advance revision');
    await c.invoke('updateProject', { projectId: p.id, targetMarket: 'UNITED_STATES', copyLanguage: 'en-US', promptLanguage: 'ENGLISH' });
    await c.rejects('updateProject', { projectId: p.id, promptLanguage: 'invalid' });
    const asset = await c.invoke('uploadAsset', { projectId: p.id, file: await c.byteFile(), role: 'PRODUCT_TRUTH', kind: 'PRODUCT' });
    const ref = await c.invoke('uploadAsset', { projectId: p.id, file: await c.byteFile(c.reference), role: 'STYLE_REFERENCE', kind: 'REFERENCE' });
    c.state.asset = asset; c.state.referenceAsset = ref;
    await c.invoke('updateAsset', { assetId: ref.id, role: 'LAYOUT_REFERENCE' });
    c.equal(items(await c.invoke('listAssets', { projectId: p.id })).find(item => item.id === ref.id).role, 'LAYOUT_REFERENCE');
    await c.invoke('updateAsset', { assetId: ref.id, role: 'STYLE_REFERENCE' });
    await c.imageRef({ kind: 'ASSET', id: asset.id });
    await c.rejects('uploadAsset', { projectId: p.id, file: await c.byteFile(), role: 'PRODUCT_TRUTH' }, /^相同图片已上传到项目$/);
    await c.rejects('uploadAsset', { projectId: p.id, file: { name: '../escape.png', mimeType: 'image/png', base64: 'AAAA' } });
  } },
  { id: 'project-lifecycle', title: 'Archive, restore and delete isolate project files', run: async c => {
    const source = need(c.state.project, 'Project setup unavailable');
    const p = await c.invoke('createProject', projectInput(c, 'Lifecycle disposable'));
    const asset = await c.invoke('uploadAsset', { projectId: p.id, file: await c.byteFile(), role: 'PRODUCT_TRUTH' });
    await c.rejects('deleteProject', { projectId: p.id });
    await c.invoke('updateProject', { projectId: p.id, archived: true });
    c.check(!(await allPages(c, 'listProjects')).some(item => item.id === p.id), 'archived excluded from active list');
    c.check((await allPages(c, 'listProjects', { archived: true })).some(item => item.id === p.id));
    await c.invoke('updateProject', { projectId: p.id, archived: false });
    c.check((await allPages(c, 'listProjects')).some(item => item.id === p.id));
    await c.invoke('updateProject', { projectId: p.id, archived: true });
    await c.invoke('deleteProject', { projectId: p.id });
    await c.rejects('getProject', { projectId: p.id });
    await c.rejects('getResource', { ref: { kind: 'ASSET', id: asset.id } });
    c.equal((await c.invoke('getProject', { projectId: source.id })).id, source.id, 'other project preserved');
    await c.imageRef({ kind: 'ASSET', id: c.state.asset.id });
  } },
  { id: 'library-copy-filters', title: 'Library source/type/search/date filters, paging and independent copy', run: async c => {
    const p = need(c.state.project, 'Source project unavailable');
    const lib = await allPages(c, 'listLibraryAssets', { projectId: p.id, kind: 'PRODUCT', limit: 1 });
    const item = need(lib.find(item => item.id === `asset:${c.state.asset.id}`), 'Imported product is absent from library');
    const target = await c.invoke('createProject', projectInput(c, 'Library independent target'));
    c.state.libraryProject = target;
    const copy = await c.invoke('copyLibraryAssetToProject', { projectId: target.id, itemId: item.id, role: 'PRODUCT_TRUTH' });
    c.check(copy.id !== c.state.asset.id); await c.imageRef({ kind: 'ASSET', id: copy.id });
    c.equal((await allPages(c, 'listLibraryAssets', { q: '%_literal_no_match' })).length, 0, 'LIKE wildcard is literal');
    c.check((await allPages(c, 'listLibraryAssets', { createdFrom: '2026-01-01', createdTo: '2099-01-01' })).length > 0);
    await c.rejects('copyLibraryAssetToProject', { projectId: target.id, itemId: item.id });
    const disposable = await c.invoke('uploadAsset', { projectId: target.id, file: await c.byteFile(c.reference), role: 'STYLE_REFERENCE' });
    await c.invoke('deleteAsset', { assetId: disposable.id });
    c.check(!items(await c.invoke('listAssets', { projectId: target.id })).some(row => row.id === disposable.id));
    const origin=await c.invoke('createProject',projectInput(c,'Disposable copy source'));
    const original=await c.invoke('uploadAsset',{projectId:origin.id,file:await c.byteFile(c.reference),kind:'REFERENCE',role:'STYLE_REFERENCE'});
    const sourceItem=need((await allPages(c,'listLibraryAssets',{projectId:origin.id})).find(item=>item.id===`asset:${original.id}`),'Copy source absent from library');
    const independent=await c.invoke('copyLibraryAssetToProject',{projectId:target.id,itemId:sourceItem.id,kind:'REFERENCE',role:'STYLE_REFERENCE'});
    c.check(independent.id!==original.id);const independentHash=sha256(await c.save({kind:'ASSET',id:independent.id}));
    await c.invoke('updateProject',{projectId:origin.id,archived:true});await c.invoke('deleteProject',{projectId:origin.id});
    c.equal(sha256(await c.save({kind:'ASSET',id:independent.id})),independentHash,'copied file survives deletion of its original project');
  } },
  { id: 'custom-templates', title: 'Custom template CRUD, persistence and unknown-template rejection', run: async c => {
    const template = await c.invoke('createUserTemplate', { name: 'Full acceptance template', prompt: 'Preserve product identity. e2e-full-custom-marker, soft daylight, no text.', defaultSize: '1024x1024', supportsImageReference: true });
    c.state.template = template;
    const updated = await c.invoke('updateUserTemplate', { templateId: template.id, name: 'Full acceptance custom scene' });
    c.equal(updated.createdAt, template.createdAt); c.equal(updated.prompt, template.prompt);
    c.check(items(await c.invoke('listUserTemplates')).some(item => item.id === template.id));
    const disposable = await c.invoke('createUserTemplate', { name: 'Delete template', prompt: 'Preserve exact product identity.' });
    await c.invoke('deleteUserTemplate', { templateId: disposable.id });
    const p = await c.invoke('createProject', projectInput(c, 'Custom creative without truth'));
    await c.rejects('createPlanningJob', { projectId: p.id, planningMode: 'MANUAL', requestedTypes: [disposable.id] });
    await c.rejects('createPlanningJob', { projectId: p.id, planningMode: 'MANUAL', requestedTypes: ['unknown-template'] });
    const board = await plan(c, p, { planningMode: 'MANUAL', requestedTypes: [template.id] });
    c.equal(board.items[0].assetType, template.id);
    c.check(c.observations.some(row => row.workflow === 'storyboard' && row.markers['e2e-full-custom-marker']), 'custom prompt reached real planner');
    await generate(c, p, board);
    c.check(c.observations.some(row=>['image-generation','image-edit'].includes(row.kind)&&row.markers['e2e-full-custom-marker']),'custom template marker reached actual image adapter prompt');
  } },
  { id: 'creative-ai-manual', title: 'AI and MANUAL planning/generation work without product truth', jobTypes: ['PLAN','GENERATE'], run: async c => {
    const p = await c.invoke('createProject', projectInput(c, 'Creative without any images'));
    c.equal(items(await c.invoke('listAssets', { projectId: p.id })).length, 0);
    for (const config of [{ planningMode: 'AI', targetImageCount: 2 }, { planningMode: 'MANUAL', requestedTypes: ['hero-image'], candidatesPerType: 1 }]) {
      const board = await plan(c, p, config); c.check(board.items.every(item => item.mode === 'CREATIVE'));
      await generate(c, p, board);
    }
    c.state.creativeProject = p;
  } },
  { id: 'protected-truth', title: 'Protected planning rejects references as truth and accepts project product truth', jobTypes: ['PLAN'], run: async c => {
    const p = await c.invoke('createProject', projectInput(c, 'Protected truth', { defaultMode: 'PIXEL_PROTECTED' }));
    await c.invoke('uploadAsset', { projectId: p.id, file: await c.byteFile(c.reference), role: 'STYLE_REFERENCE' });
    const before = c.mock.state.total;
    await c.rejects('createPlanningJob', { projectId: p.id, planningMode: 'AI', targetImageCount: 1 }, /^PIXEL_PROTECTED planning requires at least one PRODUCT_TRUTH image$/);
    c.equal(c.mock.state.total, before, 'missing truth rejected before provider');
    const truth = await c.invoke('uploadAsset', { projectId: p.id, file: await c.byteFile(), role: 'PRODUCT_TRUTH' });
    c.check(truth.id,'real product truth was imported');
    c.state.storyboardOptions = { mode: 'PIXEL_PROTECTED', targetImageCount: 1 };
    try { const board = await plan(c, p); c.equal(board.items[0].mode, 'PIXEL_PROTECTED'); await generate(c, p, board); }
    finally { c.state.storyboardOptions = {}; }
  } },
  { id: 'storyboard-candidates', title: 'Storyboard edits, CAS confirmation, multiple candidates/batches and dedupe', jobTypes: ['PLAN','GENERATE'], run: async c => {
    const p = need(c.state.project, 'Project unavailable');
    const board = await plan(c, p, { candidatesPerType: 2 });
    const edited = await c.invoke('updateStoryboardItem', { itemId: board.items[0].id, displayName: 'Full acceptance hero', candidateCount: 2, promptInstruction: board.items[0].promptInstruction + ' Soft amber rim light.' });
    c.equal(edited.displayName, 'Full acceptance hero'); c.equal(edited.candidateCount, 2);
    const currentBoard = await c.invoke('getStoryboard', { projectId: p.id });
    c.check(currentBoard.storyboard.version > board.storyboard.version, 'editing advances the confirmation version');
    await c.rejects('confirmStoryboard', { projectId: p.id, version: board.storyboard.version });
    const generated = await generate(c, p, currentBoard);
    c.equal(generated.outputs.length, 2, 'two real candidates');
    c.equal(new Set(generated.outputs.map(item => item.id)).size, 2, 'stable unique IDs');
    c.equal(new Set(generated.outputs.map(item => item.candidateIndex)).size, 2, 'stable candidate ordinals');
    const before = c.mock.state.counts['image-generation'] + c.mock.state.counts['image-edit'];
    const duplicate = await c.invoke('createGenerationJobs', generated.request);
    c.equal(duplicate.jobs.map(item => item.id), generated.submission.jobs.map(item => item.id));
    c.equal(c.mock.state.counts['image-generation'] + c.mock.state.counts['image-edit'], before, 'dedupe sends no paid POST');
    await c.rejects('updateStoryboardItem', { itemId: edited.id, promptInstruction: 'overwrite generated immutable prompt' });
    const again = await generate(c, p, currentBoard, { revision: 'new explicit revision' });
    c.check(again.outputs.every(item => !generated.outputs.some(old => old.id === item.id)), 'new batch has independent stable outputs');
    c.state.board = currentBoard; c.state.outputs = generated.outputs;
    c.equal((await c.invoke('getOutput', { outputId: generated.outputs[0].id })).hash, generated.outputs[0].hash);
    await c.evidence('outputs', generated.outputs);
  } },
  { id: 'planning-history', title: 'Planning configuration history retains 20 source-deduplicated snapshots and applies one', jobTypes: ['PLAN'], run: async c => {
    const p = await c.invoke('createProject', projectInput(c, 'History boundary'));
    const jobIds = [];
    // 20 is the original domain retention limit, not an arbitrary test truncation.
    for (let i = 0; i < 21; i++) {
      const submission = await c.invoke('createPlanningJob', { projectId: p.id, planningMode: 'AI', targetImageCount: 1, userInstruction: `history configuration ${i}`, regenerationKey: `history-${i}` });
      await c.waitJob(submission.id); jobIds.push(submission.id);
    }
    const snapshots = await c.invoke('listPlanningConfigSnapshots', { projectId: p.id });
    c.equal(snapshots.length, 20); c.equal(new Set(snapshots.map(item => item.sourceJobId)).size, 20);
    c.check(!snapshots.some(item => item.sourceJobId === jobIds[0]));
    const applied = await c.invoke('applyPlanningConfigSnapshot', { projectId: p.id, snapshotId: snapshots[19].id });
    c.equal(applied.snapshot.id, snapshots[19].id); c.equal(applied.project.id, p.id);
    await c.evidence('snapshots', snapshots);
  } },
  { id: 'copywriting-records', title: 'Description and planning copy remain job-scoped until explicit adoption', jobTypes: ['COPYWRITE'], run: async c => {
    const p = need(c.state.project, 'Project unavailable');
    const before = await c.invoke('getProject', { projectId: p.id });
    c.state.copyResults = [];
    for (const target of ['PRODUCT_DESCRIPTION', 'PLANNING_INSTRUCTION']) {
      const request = { projectId: p.id, target, regenerationKey: `copy-${target}` };
      const job = await c.invoke('createCopywritingJob', request); await c.waitJob(job.id);
      const result = await c.invoke('getCopywritingResult', { jobId: job.id });
      c.equal(result.target, target); c.check(result.content.length > 10);
      const duplicate = await c.invoke('createCopywritingJob', request); c.equal(duplicate.id, job.id);
      c.state.copyResults.push(result);
    }
    c.equal((await c.invoke('getProject', { projectId: p.id })).productDescription, before.productDescription, 'late background result does not adopt itself');
    c.check(c.observations.some(item => item.workflow === 'description' && item.markers.PRODUCT_TRUTH && item.markers.STYLE_REFERENCE), 'actual role-aware visual request');
    await c.evidence('independent-copy-results', c.state.copyResults);
  } },
  { id: 'suite-forge', title: 'Global multi-image forge, editable commit, imported/builtin suite selection and planning', jobTypes: ['SUITE_FORGE','PLAN'], run: async c => {
    const provider = need(c.state.provider, 'Provider unavailable');
    const request = { providerId: provider.id, modelId: 'mock-reasoner', files: [await c.byteFile(), await c.byteFile(c.reference)], targetShotCount: 5, name: 'Full acceptance suite', idempotencyKey: 'suite-forge-full' };
    const job = await c.invoke('createSuiteForgeJob', request); await c.waitJob(job.id);
    c.equal(job.projectId, null, 'global forge does not belong to project');
    const result = await c.invoke('getSuiteForgeResult', { jobId: job.id }); c.equal(result.status, 'DRAFT'); c.equal(result.suite.shots.length, 5);
    c.equal((await c.invoke('createSuiteForgeJob', request)).id, job.id);
    const committed = await c.invoke('commitSuiteForgeResult', { jobId: job.id, ...result.suite, name: 'Full acceptance suite edited' });
    c.equal(committed.status, 'COMMITTED'); c.equal(committed.suite.name, 'Full acceptance suite edited');
    c.check(items(await c.invoke('listSuiteForgeJobResults')).some(item => item.jobId === job.id && item.draft.suiteId === committed.suiteId));
    const suites = await allPages(c, 'listSuites', { ids: committed.suiteId }); c.check(suites.some(item => item.id === committed.suiteId));
    c.state.suite = await c.invoke('getSuite', { suiteId: committed.suiteId });
    const builtin = (await allPages(c, 'listSuites', { origin: 'builtin' }))[0]; need(builtin, 'No built-in suite');
    await c.invoke('listSuiteCategories'); await c.invoke('refreshSuites');
    for (const suiteId of [builtin.id, committed.suiteId]) {
      const detail = await c.invoke('getSuite', { suiteId });
      const suite = detail.suite ?? detail;
      const p = await c.invoke('createProject', projectInput(c, `Suite ${suiteId}`));
      const board = await plan(c, p, { planningMode: 'MANUAL', requestedSuiteShots: suite.shots.map(shot => `${suiteId}::${shot.shotId}`) });
      c.equal(board.items.length, suite.shots.length);
    }
  } },
];
