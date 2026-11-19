import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { startFullMockProvider, editPlanReply, listingReply, storyboardReply, suiteReply } from './full-mock-provider.mjs';

const sharp = createRequire(new URL('../packages/backend/package.json', import.meta.url))('sharp');

/** 定向协议自验：需要当前 providers/agent/domain dist；不启动应用、不访问真实 Provider。 */
export async function runFullMockSelfTest() {
  const providers = await import('../packages/providers/dist/index.js');
  const agent = await import('../packages/agent/dist/index.js');
  const domain = await import('../packages/domain/dist/index.js');
  const connection = mock => ({ baseUrl: mock.baseUrl, apiKey: 'fixture-only-secret-do-not-log' });
  const mock = await startFullMockProvider({ width: 37, height: 23 });
  let checks = 0;
  const verify = (condition, message) => { assert.ok(condition, message); checks++; };
  const until = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Mock observation timeout'); await pause(10); }
  };
  try {
    const openai = new providers.OpenAiCompatibleImageProvider(connection(mock));
    const gemini = new providers.GeminiImageProvider({ ...connection(mock), baseUrl: mock.geminiBaseUrl });
    verify((await openai.probe()).models.includes('mock-image'), 'OpenAI model probe');
    verify((await gemini.probe()).models.includes('gemini-3-pro-image'), 'Gemini model probe');
    const generated = await openai.generate({ model: 'mock-image', prompt: 'fixture', idempotencyKey: 'stable-key' });
    verify((await sharp(generated.image).metadata()).width === 37, 'Legal generated PNG');
    await openai.generate({ model: 'mock-image', prompt: 'fixture', idempotencyKey: 'stable-key' });
    verify(Object.values(mock.state.idempotencyCounts).includes(2), 'Repeated idempotency key counted without raw key');
    verify(Object.values(mock.state.requestCounts).includes(2), 'Repeated request body counted');
    const input = { data: mock.images.image, filename: 'source.png', mimeType: 'image/png' };
    const edited = await openai.editImage({ model: 'gpt-image-1', prompt: 'fixture edit', sourceImage: input, mask: { ...input, data: mock.images.mask } });
    verify((await sharp(edited.image).metadata()).height === 23, 'Multipart OpenAI edit');
    const native = await gemini.generate({ model: 'gemini-3-pro-image', prompt: 'fixture', images: [input] });
    verify((await sharp(native.image).metadata()).width === 37, 'Gemini native inlineData');
    for (const protocol of ['fal', 'grounded_sam', 'gitee_sam3']) {
      const segmenter = providers.createSegmentationProvider(protocol, connection(mock));
      await segmenter.probe();
      const result = await segmenter.segment({ imageUrl: `data:image/png;base64,${mock.images.image.toString('base64')}`, textPrompt: 'product body' });
      verify(result.mask.width === 37 && result.mask.height === 23, `${protocol} non-square dimensions`);
      const expected = await sharp(mock.images.mask).removeAlpha().greyscale().raw().toBuffer();
      const actual = result.mask.mimeType === 'raw/gray8' ? result.mask.data : await sharp(result.mask.data).removeAlpha().greyscale().raw().toBuffer();
      verify(expected.equals(actual), `${protocol} exact foreground / COCO column-major conversion`);
    }
    const fal = providers.createSegmentationProvider('fal', connection(mock));
    verify((await fal.segment({ imageUrl: `data:image/png;base64,${mock.images.image.toString('base64')}`, box: { xMin: 1, yMin: 2, xMax: 20, yMax: 18 } })).score > 0, 'fal box prompt');
    const layers = await new providers.SeedreamLayerizeProvider(connection(mock)).layerize({ imageUrl: `data:image/png;base64,${mock.images.image.toString('base64')}` });
    verify(layers.base !== null && layers.layers.length === 2, 'Seedream complete base + layers');
    const pixels = await sharp(layers.layers[0].png).ensureAlpha().raw().toBuffer();
    verify(pixels[3] === 0 && pixels[(11 * 37 + 18) * 4 + 3] === 255, 'Seedream alpha layer has transparent edge and foreground');
    const suite = suiteReply();
    verify(domain.validateEcomSuiteFile(suite) !== undefined, 'Suite fixture validates');
    const baseInput = {
      apiKey: 'fixture-only-secret-do-not-log', projectName: 'Fixture', productCategory: null, productDescription: null,
      verifiedFacts: [], prohibitedClaims: [], brandGuidelines: {}, platformTargets: ['AMAZON'], targetMarket: null, copyLanguage: 'en',
      promptLanguage: 'ENGLISH', defaultMode: 'CREATIVE', assets: [{ id: 'asset-local', handle: 'P1', role: 'PRODUCT_TRUTH', kind: 'PRODUCT', name: 'fixture', mimeType: 'image/png' }],
      referenceImages: [{ type: 'image', data: mock.images.image.toString('base64'), mimeType: 'image/png' }], timeoutMs: 5000,
    };
    for (const protocol of ['openai', 'openai_responses']) {
      const model = providers.buildReasoningModel({ providerId: 'fixture', modelId: 'mock-reasoner', baseUrl: mock.baseUrl, protocol, supportsVision: true, supportsThinking: false, supportsStructuredOutput: true });
      verify((await providers.probeReasoning({ providerId: 'fixture', modelId: 'mock-reasoner', baseUrl: mock.baseUrl, protocol, supportsVision: false, supportsThinking: false, apiKey: baseInput.apiKey, timeoutMs: 5000 })).text === 'OK', `${protocol} real Pi probe`);
      const manual = await agent.planStoryboard({ ...baseInput, model, planningMode: 'MANUAL', requestedTypes: ['hero-image', 'detail-macro'], candidatesPerType: 2 });
      verify(manual.items.length === 2 && manual.items[1].candidateCount === 2, `${protocol} manual storyboard`);
      const automatic = await agent.planStoryboard({ ...baseInput, model, planningMode: 'AI', targetImageCount: 3 });
      verify(automatic.items.length === 3, `${protocol} AI exact target count`);
      const suitePlan = await agent.planStoryboard({ ...baseInput, model, planningMode: 'MANUAL', requestedSuiteShots: suite.shots.slice(0, 2).map(shot => shot.assetType), suites: [suite] });
      verify(suitePlan.items.length === 2 && suitePlan.items[1].shotRole === suite.shots[1].shotRole, `${protocol} exact suite shot inputs`);
      const copy = await agent.writeCopywriting({ ...baseInput, model, target: 'PRODUCT_DESCRIPTION' });
      verify(copy.content.includes('产品名称'), `${protocol} product description`);
      verify((await agent.writeCopywriting({ ...baseInput, model, target: 'PLANNING_INSTRUCTION' })).content.length > 10, `${protocol} planning copy`);
      verify((await agent.reviseImagePrompt({ model, apiKey: baseInput.apiKey, prompt: 'Preserve product identity', revision: 'soft light' })).length > 100, `${protocol} prompt revision`);
      verify((await agent.planLayerElements({ model, apiKey: baseInput.apiKey, image: baseInput.referenceImages[0] })).length === 2, `${protocol} layer planning`);
      for (const platform of ['ETSY', 'AMAZON', 'TIKTOK_SHOP']) verify((await agent.writeListingCopy({ model, apiKey: baseInput.apiKey, platform, patternName: 'Floral', category: null, sellingPoints: null, mustIncludeWords: null, bannedWords: null, patternImages: baseInput.referenceImages })).platform === platform, `${protocol} ${platform} Listing`);
      const forged = await agent.forgeSuite({ model, apiKey: baseInput.apiKey, images: baseInput.referenceImages });
      verify(domain.validateEcomSuiteFile(forged) !== undefined, `${protocol} suite forge`);
      mock.control.failNext(protocol === 'openai' ? 'chat' : 'responses', { type: 'truncate-sse' });
      await assert.rejects(agent.reviseImagePrompt({ model, apiKey: baseInput.apiKey, prompt: 'Preserve product identity', revision: 'soft light', timeoutMs: 3000 })); checks++;
    }
    await until(() => mock.state.active === 0);
    verify(mock.state.aborted === 0 && mock.state.truncated === 2, 'Injected truncation is distinct from observed client abort');
    for (const [kind, url, init] of [
      ['brave', mock.searchUrls.brave, undefined], ['searxng', mock.searchUrls.searxng, undefined],
      ['tavily', mock.searchUrls.tavily, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"fixture"}' }],
    ]) {
      const body = await (await fetch(url, init)).json();
      const result = (body.web?.results ?? body.results)[0];
      verify(new URL(result.url).origin === mock.origin && mock.state.counts[kind] === 1, `${kind} search localhost URL`);
    }
    mock.control.failNext('models', { type: 'http', status: 503 });
    await assert.rejects(openai.probe()); checks++;
    mock.control.failNext('image-generation', { type: 'http', status: 429 });
    await assert.rejects(openai.generate({ model: 'mock-image', prompt: 'fault' })); checks++;
    mock.control.failNext('image-generation', { type: 'drop' });
    await assert.rejects(openai.generate({ model: 'mock-image', prompt: 'drop' })); checks++;
    mock.control.failNext('fal', { type: 'empty-mask' });
    const empty = await fal.segment({ imageUrl: `data:image/png;base64,${mock.images.image.toString('base64')}`, textPrompt: 'fixture' });
    const emptyRaw = await sharp(empty.mask.data).removeAlpha().greyscale().raw().toBuffer();
    verify(emptyRaw.every(value => value === 0), 'Empty mask is legal all-black PNG');
    mock.control.failNext('image-generation', { type: 'bad-image' });
    const corrupt = await openai.generate({ model: 'mock-image', prompt: 'bad bytes' }).catch(() => null);
    if (corrupt) await assert.rejects(sharp(corrupt.image).metadata()); checks++;
    const abort = new AbortController(), beforeAbort = mock.state.aborted;
    mock.control.failNext('image-generation', { type: 'hang' });
    const hanging = openai.generate({ model: 'mock-image', prompt: 'cancel', signal: abort.signal }).catch(error => error);
    await until(() => mock.state.hanging === 1);
    abort.abort(); await hanging;
    await until(() => mock.state.aborted === beforeAbort + 1);
    verify(mock.state.aborted === beforeAbort + 1, 'Observed actual client disconnect');
    mock.control.failNext('image-generation', { type: 'delay', ms: 100 });
    const started = Date.now(); await openai.generate({ model: 'mock-image', prompt: 'delay' });
    verify(Date.now() - started >= 80, 'Delayed request completes');
    const snapshot = JSON.stringify(mock.control.snapshot());
    verify(!snapshot.includes(baseInput.apiKey) && !snapshot.includes('stable-key') && !snapshot.includes('data:image'), 'Bounded records contain no credentials/body/images');
    await until(() => mock.state.active === 0);
  } finally { await mock.close(); await mock.close(); }
  const urlMock = await startFullMockProvider({ imageMode: 'url' });
  try {
    const provider = new providers.OpenAiCompatibleImageProvider(connection(urlMock));
    verify((await sharp((await provider.generate({ model: 'mock-image', prompt: 'URL' })).image).metadata()).width === 48, 'Image URL mode via real adapter');
    urlMock.control.failNext('image-generation', { type: 'download-once' });
    const paidBefore = urlMock.state.counts['image-generation'];
    const paid = await (await fetch(`${urlMock.baseUrl}/images/generations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"mock-image","prompt":"paid"}' })).json();
    verify(new URL(paid.data[0].url).origin === urlMock.origin, 'Paid response returns same-server URL');
    verify((await fetch(paid.data[0].url)).status === 503, 'One failed GET after complete paid response');
    verify((await fetch(paid.data[0].url)).status === 200 && urlMock.state.counts['image-generation'] === paidBefore + 1, 'Download resumed without new paid POST');
  } finally { await urlMock.close(); }
  const boundedMock = await startFullMockProvider({ maxBodyBytes: 128, maxRecords: 2 });
  try {
    const tooLarge = await fetch(`${boundedMock.baseUrl}/images/generations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock', prompt: 'x'.repeat(256) }) });
    verify(tooLarge.status === 413, 'Bounded body returns explicit 413');
    await fetch(`${boundedMock.baseUrl}/models`); await fetch(`${boundedMock.baseUrl}/health`);
    verify(boundedMock.state.records.length === 2 && boundedMock.state.droppedRecords === 1, 'Bounded record ring');
    assert.throws(() => boundedMock.control.failNext('gemini', { type: 'download-once' })); checks++;
  } finally { await boundedMock.close(); }
  // 显式 replyForRequest 驱动真实 Pi 工具循环，而非伪造研究审计。
  for (const protocol of ['openai', 'openai_responses']) {
    let observedToolResult = false;
    const toolMock = await startFullMockProvider({ replyForRequest: request => {
      if (request.workflow !== 'storyboard') return undefined;
      const entries = request.json.messages ?? request.json.input ?? [];
      const hasTool = entries.some(entry => entry.role === 'tool' || entry.type === 'function_call_output');
      if (!hasTool) return { toolCalls: [{ name: 'research_visual_direction', arguments: { query: 'soft neutral studio lighting' } }] };
      observedToolResult = true;
      return storyboardReply({ assetTypes: ['hero-image'] });
    } });
    try {
      const model = providers.buildReasoningModel({ providerId: 'fixture', modelId: 'mock-reasoner', baseUrl: toolMock.baseUrl, protocol, supportsVision: false, supportsThinking: false, supportsStructuredOutput: true });
      await agent.planStoryboard({ model, apiKey: 'fixture-key', projectName: 'Fixture', productCategory: null, productDescription: null, verifiedFacts: [], prohibitedClaims: [], brandGuidelines: {}, platformTargets: ['AMAZON'], targetMarket: null, copyLanguage: 'en', promptLanguage: 'ENGLISH', defaultMode: 'CREATIVE', assets: [], planningMode: 'AI', targetImageCount: 1, webResearch: { sources: [{ id: 'source', name: 'Fixture', kind: 'brave', baseUrl: toolMock.searchUrls.brave, apiKey: 'fake-search-key' }] }, timeoutMs: 5000 });
      verify(observedToolResult && toolMock.state.counts.brave === 1, `${protocol} actual Pi tool call / search loop`);
    } finally { await toolMock.close(); }
  }
  for (const variant of ['clarification', 'confirmation', 'no-confirmation']) {
    const editMock = await startFullMockProvider({ replies: { 'edit-plan': editPlanReply(variant) } });
    try {
      const model = providers.buildReasoningModel({ providerId: 'fixture', modelId: 'mock-reasoner', baseUrl: editMock.baseUrl, protocol: 'openai', supportsVision: true, supportsThinking: false, supportsStructuredOutput: true });
      const plan = await agent.planImageEdit({ model, apiKey: 'fake', message: 'change scene', annotations: {}, hasEditMask: variant === 'no-confirmation', hasCanvasExpansion: false, referenceAssets: [], memorySummary: {}, projectFacts: [], sourceImage: { type: 'image', data: editMock.images.image.toString('base64'), mimeType: 'image/png' } });
      verify(plan.requiresConfirmation === (variant === 'confirmation'), `Edit ${variant} real validation`);
    } finally { await editMock.close(); }
  }
  const closeMock = await startFullMockProvider({ maxBodyBytes: 1024, faults: [{ kind: 'image-generation', fault: { type: 'hang' } }] });
  const pending = fetch(`${closeMock.baseUrl}/images/generations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"mock","prompt":"hang"}' }).catch(() => undefined);
  await until(() => closeMock.state.hanging === 1);
  const before = Date.now(); await closeMock.close(); await pending;
  verify(Date.now() - before < 1000 && closeMock.state.aborted === 0, 'close tears down hanging sockets without counting client abort');
  return { checks, protocols: ['chat-sse', 'responses-sse', 'pi-tools', 'gemini', 'images', 'fal', 'grounded-sam', 'gitee-rle', 'seedream', 'search'], realProviderCalls: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runFullMockSelfTest()));
}
