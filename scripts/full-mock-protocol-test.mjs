import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { startFullMockProvider, createFullMockImages, editPlanReply, listingReply, suiteReply } from './full-mock-provider.mjs';

const sharp = createRequire(new URL('../packages/backend/package.json', import.meta.url))('sharp');

/** 不依赖正在重建的业务 dist，只通过真实本机 HTTP 验证夹具协议和生命周期。 */
export async function runFullMockProtocolTest() {
  let checks = 0;
  const check = (value, label) => { assert.ok(value, label); checks++; };
  const until = async predicate => { const end = Date.now() + 2000; while (!predicate()) { if (Date.now() > end) throw new Error('Observation timeout'); await pause(5); } };
  const mock = await startFullMockProvider({ width: 37, height: 23, maxRecords: 50, maxBodyBytes: 4096 });
  const post = (path, body, init = {}) => fetch(`${mock.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret-not-logged', 'idempotency-key': 'stable-test-key' }, body: JSON.stringify(body), ...init });
  try {
    check((await (await fetch(`${mock.baseUrl}/models`)).json()).data.length >= 3, 'models');
    check((await fetch(`${mock.baseUrl}/health`)).status === 200, 'health');
    for (const path of ['/chat/completions', '/responses']) {
      const body = { model: 'mock-reasoner', stream: true, messages: [{ role: 'user', content: 'Reply with exactly OK.' }], input: [{ role: 'user', content: 'Reply with exactly OK.' }] };
      const response = await post(path, body), text = await response.text();
      check(response.headers.get('content-type') === 'text/event-stream', `${path} SSE MIME`);
      check(text.includes('OK') && text.includes(path.includes('responses') ? 'response.completed' : '[DONE]'), `${path} complete terminal event`);
      mock.control.failNext(path.includes('responses') ? 'responses' : 'chat', { type: 'truncate-sse' });
      await assert.rejects(async () => (await post(path, body)).text()); checks++;
    }
    check(mock.state.truncated === 2 && mock.state.aborted === 0, 'truncation distinct from client cancellation');
    const generated = await (await post('/images/generations', { model: 'mock-image', prompt: 'fixture' })).json();
    check((await sharp(Buffer.from(generated.data[0].b64_json, 'base64')).metadata()).width === 37, 'base64 legal PNG');
    const form = new FormData(); form.set('model', 'mock-image'); form.set('prompt', 'edit fixture'); form.set('image', new Blob([mock.images.image], { type: 'image/png' }), 'source.png');
    check((await (await fetch(`${mock.baseUrl}/images/edits`, { method: 'POST', body: form })).json()).data.length === 1, 'multipart edit');
    const native = await (await post('/models/gemini-3-pro-image:generateContent', { contents: [{ role: 'user', parts: [{ text: 'fixture' }] }] })).json();
    check((await sharp(Buffer.from(native.candidates[0].content.parts[0].inlineData.data, 'base64')).metadata()).height === 23, 'Gemini native image');
    const alternate = await createFullMockImages({ width: 19, height: 11 });
    const nativeEdit = await (await post('/models/gemini-3-pro-image:generateContent', { contents: [{ role: 'user', parts: [{ text: 'fixture' }, { inlineData: { mimeType: 'image/png', data: alternate.image.toString('base64') } }] }] })).json();
    check((await sharp(Buffer.from(nativeEdit.candidates[0].content.parts[0].inlineData.data, 'base64')).metadata()).width === 19, 'Gemini edit follows supplied image dimensions');
    const imageUri = `data:image/png;base64,${mock.images.image.toString('base64')}`;
    check((await post('/fal-ai/sam-3/image', {})).status === 400, 'fal nonbillable probe');
    const fal = await (await post('/fal-ai/sam-3/image', { image_url: imageUri, box_prompts: [{ x_min: 2, y_min: 1, x_max: 20, y_max: 18 }] })).json();
    check(fal.masks[0].width === 37 && fal.masks[0].height === 23, 'fal non-square mask');
    const grounded = await (await post('/', { image: { data: mock.images.image.toString('base64') }, text_prompt: 'product' })).json();
    check((await sharp(Buffer.from(grounded.masks[0].data, 'base64')).metadata()).width === 37, 'Grounded mask');
    const giteeForm = new FormData(); giteeForm.set('model', 'sam3'); giteeForm.set('prompt', 'product'); giteeForm.set('image', new Blob([mock.images.image], { type: 'image/png' }), 'source.png');
    const gitee = await (await fetch(`${mock.baseUrl}/images/segmentation`, { method: 'POST', body: giteeForm })).json();
    const rle = gitee.segments[0].mask;
    check(rle.size[0] === 37 && rle.size[1] === 23, 'Gitee [width,height]');
    const encoded = gunzipSync(Buffer.from(rle.counts, 'base64')), runs = [];
    for (let p = 0; p < encoded.length;) {
      let run = 0, shift = 0, code;
      do { code = encoded[p++] - 48; run |= (code & 31) << (5 * shift++); } while (code & 32);
      if (code & 16) run |= -1 << (5 * shift);
      if (runs.length > 2) run += runs[runs.length - 2];
      runs.push(run);
    }
    const decoded = Buffer.alloc(37 * 23); let position = 0;
    for (const [i, length] of runs.entries()) for (let n = 0; n < length; n++, position++) decoded[(position % 23) * 37 + Math.floor(position / 23)] = i % 2 ? 255 : 0;
    const gray = await sharp(mock.images.mask).greyscale().removeAlpha().raw().toBuffer();
    check(decoded.equals(gray), 'Gzip COCO signed runs and column-major exact pixel match');
    const seedream = await (await post('/images/generations', { model: 'doubao-seedream-5.0-pro-layerize', layer_decomposition: true, image: imageUri })).json();
    check(seedream.data.length === 3 && seedream.data.every(item => new URL(item.url).origin === mock.origin), 'Seedream complete localhost decomposition');
    const foreground = Buffer.from(await (await fetch(seedream.data[1].url)).arrayBuffer());
    const pixels = await sharp(foreground).ensureAlpha().raw().toBuffer();
    check(pixels[3] === 0 && pixels[(11 * 37 + 18) * 4 + 3] === 255, 'Real layer alpha');
    check(mock.state.counts.seedream === 1 && mock.state.counts['image-generation'] === 1, 'Separate Seedream / ordinary image counts');
    mock.control.failNext('image-generation', { type: 'download-once' });
    const paid = await (await post('/images/generations', { model: 'mock-image', prompt: 'paid' })).json();
    const count = mock.state.counts['image-generation'];
    check((await fetch(paid.data[0].url)).status === 503, 'Complete paid response, one failed download');
    check((await fetch(paid.data[0].url)).status === 200 && mock.state.counts['image-generation'] === count, 'GET retry without paid POST');
    for (const kind of ['fal', 'grounded-sam', 'gitee-sam3']) {
      mock.control.failNext(kind, { type: 'empty-mask' });
      if (kind === 'gitee-sam3') {
        const result = await (await fetch(`${mock.baseUrl}/images/segmentation`, { method: 'POST', body: giteeForm })).json();
        check(result.segments[0].mask.size[0] === 37, 'Empty Gitee still legal RLE');
      } else {
        const result = kind === 'fal' ? await (await post('/fal-ai/sam-3/image', { image_url: imageUri })).json() : await (await post('/', { image: { data: mock.images.image.toString('base64') } })).json();
        const b64 = kind === 'fal' ? result.masks[0].url.split(',')[1] : result.masks[0].data;
        const raw = await sharp(Buffer.from(b64, 'base64')).removeAlpha().greyscale().raw().toBuffer();
        check(raw.every(value => value === 0), `${kind} valid empty mask`);
      }
    }
    for (const kind of ['brave', 'tavily', 'searxng']) {
      const response = await fetch(mock.searchUrls[kind], kind === 'tavily' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"studio"}' } : undefined);
      const body = await response.json();
      check(new URL((body.web?.results ?? body.results)[0].url).origin === mock.origin, `${kind} local search result`);
    }
    mock.control.failNext('image-generation', { type: 'bad-image' });
    const bad = await (await post('/images/generations', { model: 'mock-image', prompt: 'bad bytes' })).json();
    await assert.rejects(sharp(Buffer.from(bad.data[0].b64_json, 'base64')).metadata()); checks++;
    mock.control.failNext('models', { type: 'http', status: 503 }); check((await fetch(`${mock.baseUrl}/models`)).status === 503, '5xx fault');
    mock.control.failNext('models', { type: 'http', status: 401 }); check((await fetch(`${mock.baseUrl}/models`)).status === 401, '4xx fault');
    mock.control.failNext('models', { type: 'drop' }); await assert.rejects(fetch(`${mock.baseUrl}/models`)); checks++;
    mock.control.failNext('models', { type: 'delay', ms: 70 }); const started = Date.now(); await fetch(`${mock.baseUrl}/models`); check(Date.now() - started >= 55, 'delayed request');
    const abort = new AbortController(); mock.control.failNext('models', { type: 'hang' });
    const hanging = fetch(`${mock.baseUrl}/models`, { signal: abort.signal }).catch(() => undefined);
    await until(() => mock.state.hanging === 1); abort.abort(); await hanging; await until(() => mock.state.aborted === 1);
    check(mock.state.aborted === 1, 'Observed client abort');
    check((await post('/images/generations', { model: 'mock', prompt: 'x'.repeat(5000) })).status === 413, 'body limit');
    check(!JSON.stringify(mock.state).includes('secret-not-logged') && !JSON.stringify(mock.state).includes('stable-test-key'), 'No credential or raw idempotency key in state');
    check(Object.values(mock.state.idempotencyCounts).some(value => value > 1), 'Repeated key counts');
    check(mock.state.callbackErrors === 0, 'No unexpected fixture errors');
    for (let i = 0; i < 55; i++) await fetch(`${mock.baseUrl}/health`);
    check(mock.state.records.length === 50 && mock.state.droppedRecords > 0, 'Bounded log ring');
    const closePending = fetch(`${mock.baseUrl}/models`).catch(() => undefined);
    await closePending;
  } finally { await mock.close(); }
  const callbackMock = await startFullMockProvider({ replyForRequest: async context => { await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true })); return { text: 'late' }; } });
  const pending = fetch(`${callbackMock.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"mock","messages":[]}' }).catch(() => undefined);
  await until(() => callbackMock.state.counts.chat === 1); await pause(5);
  const closing = Date.now(); await callbackMock.close(); await pending; await callbackMock.close();
  check(Date.now() - closing < 1000 && callbackMock.state.aborted === 0, 'close aborts callback and sockets without client-abort count');
  const hangMock = await startFullMockProvider({ faults: [{ kind: 'models', fault: { type: 'hang' } }] });
  const hangingClose = fetch(`${hangMock.baseUrl}/models`).catch(() => undefined);
  await until(() => hangMock.state.hanging === 1);
  await hangMock.close(); await hangingClose;
  await until(() => hangMock.state.serverClosed === 1);
  check(hangMock.state.aborted === 0, 'close cancels hanging socket without counting client abort');
  check(editPlanReply('clarification').executionMode === 'NEED_INPUT' && !editPlanReply('no-confirmation').requiresConfirmation && editPlanReply('confirmation').requiresConfirmation, 'Three explicit edit variants');
  for (const platform of ['ETSY', 'AMAZON', 'TIKTOK_SHOP']) check(listingReply(platform).title.length >= 25 && listingReply(platform).title.length <= 75, `${platform} listing length`);
  check(suiteReply().shots.length === 5, 'Complete suite fixture');
  return { checks, realProviderCalls: 0, mode: 'isolated-http-protocol' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await runFullMockProtocolTest()));
