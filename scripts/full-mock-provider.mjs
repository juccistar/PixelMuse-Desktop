import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createFullMockImages, giteeMask, inputDimensions, normalizePng, resizedPng } from './full-mock-images.mjs';
import { defaultReplyForRequest, requestPayload, requestWorkflow } from './full-mock-replies.mjs';
export { createFullMockImages } from './full-mock-images.mjs';
export { defaultReplyForRequest, storyboardReply, editPlanReply, listingReply, suiteReply } from './full-mock-replies.mjs';

const KINDS = ['chat', 'responses', 'gemini', 'image-generation', 'image-edit', 'models', 'health', 'fal', 'grounded-sam', 'gitee-sam3', 'seedream', 'brave', 'tavily', 'searxng', 'download', 'unknown'];
const sha = value => createHash('sha256').update(value).digest('hex');
const MAX_BODY = 20 * 1024 * 1024;
const MAX_REPLY = 4 * 1024 * 1024;

/**
 * 仅监听 127.0.0.1:0 的真实协议夹具；不代理请求、不读写业务数据、不访问上游。
 * API 和各个计数语义见 full-mock-provider.d.mts。未知 Agent 工作流返回明确错误。
 *
 * @example
 * const mock = await startFullMockProvider({
 *   replies: { storyboard: storyboardReply({ assetTypes: ['hero-image'], referencedAssets: ['P1'] }) },
 *   imageMode: 'url',
 * });
 * try {
 *   mock.control.failNext('image-generation', { type: 'download-once' });
 *   // 将 mock.baseUrl 和任意假 key 交给真实 Backend/Provider；首次 GET 503，后续同 URL 成功。
 *   // replyForRequest 可按 context.workflow / context.kindCall 注入完整回复或工具调用。
 * } finally { await mock.close(); }
 */
export async function startFullMockProvider(imageOrOptions = {}, extraOptions = {}) {
  const options = imageOrOptions instanceof Uint8Array ? { ...extraOptions, image: imageOrOptions } : imageOrOptions;
  if (options.imageMode !== undefined && !['base64', 'url', 'request'].includes(options.imageMode)) throw new TypeError('Invalid mock imageMode');
  const maxBodyBytes = bounded(options.maxBodyBytes ?? MAX_BODY, 1, MAX_BODY, 'maxBodyBytes');
  const maxRecords = bounded(options.maxRecords ?? 1000, 1, 10000, 'maxRecords');
  const maxDownloads = bounded(options.maxDownloads ?? 1000, 1, 10000, 'maxDownloads');
  const maxDownloadBytes = bounded(options.maxDownloadBytes ?? 128 * 1024 * 1024, 1, 256 * 1024 * 1024, 'maxDownloadBytes');
  const images = await createFullMockImages(options);
  const counts = Object.fromEntries(KINDS.map(kind => [kind, 0]));
  const state = {
    counts, records: [], total: 0, completed: 0, aborted: 0, serverClosed: 0, dropped: 0,
    hanging: 0, delayed: 0, truncated: 0, downloadFailures: 0, callbackErrors: 0,
    idempotencyCounts: {}, requestCounts: {}, droppedRecords: 0, active: 0, closed: false,
  };
  const sockets = new Set(), activeResponses = new Set(), timers = new Set(), downloads = new Map(), faults = [];
  let origin = '', downloadId = 0, downloadBytes = 0, closed = false, closePromise;
  const control = {
    failNext(kind, fault) { addFault({ kind, fault }); },
    addFault,
    clearFaults() { faults.length = 0; },
    snapshot() { return structuredClone(state); },
  };
  function addFault(rule) {
    if (rule.kind !== '*' && !KINDS.includes(rule.kind)) throw new TypeError('Unknown mock request kind');
    const times = bounded(rule.times ?? 1, 1, 10000, 'fault times');
    if (rule.at !== undefined) bounded(rule.at, 1, Number.MAX_SAFE_INTEGER, 'fault at');
    validateFault(rule.fault, rule.kind);
    faults.push({ ...rule, remaining: times, fault: { ...rule.fault } });
  }
  for (const rule of options.faults ?? []) addFault(rule);

  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    request.on('error', () => {}); // 断连可在 aborted 之后继续触发 ECONNRESET。
    void handle(request, response).catch(() => response.destroy());
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 1000;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  async function handle(request, response) {
    if (closed) { response.destroy(); return; }
    // 不记录 raw URL/query/header/body；客户端可在这些位置携带密钥和大图。
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const kind = classify(request.method, url.pathname, request.headers['content-type']);
    const record = {
      id: ++state.total, kind, kindCall: 0, method: request.method ?? 'GET',
      bodyBytes: 0, requestHash: null, idempotencyKeyHash: null, status: null,
      outcome: 'pending', fault: null, workflow: null,
      hasParsedInput: null, validationRejected: false,
    };
    if (state.records.length >= maxRecords) { state.records.shift(); state.droppedRecords++; }
    state.records.push(record);
    state.active++;
    activeResponses.add(response);
    let finished = false;
    const finish = outcome => {
      if (finished) return;
      finished = true;
      state.active--;
      activeResponses.delete(response);
      record.outcome = outcome;
      if (outcome === 'aborted') state.aborted++;
      if (outcome === 'server-closed') state.serverClosed++;
      if (outcome === 'completed') state.completed++;
    };
    response.once('finish', () => finish('completed'));
    response.once('close', () => finish(closed ? 'server-closed' : record.outcome === 'dropped' ? 'dropped' : record.fault === 'truncate-sse' ? 'truncated' : 'aborted'));
    request.once('aborted', () => finish(closed ? 'server-closed' : 'aborted'));
    function send(status, body, headers = {}) {
      if (response.destroyed || closed) return;
      record.status = status;
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(headers['content-type'] === 'image/png' ? body : JSON.stringify(body));
    }
    try {
      const body = await readBody(request, maxBodyBytes, record);
      if (response.destroyed || closed) return;
      const parsed = parseBody(body, request.headers['content-type']);
      // 保守计入任意 JSON 属性、表单字段或文件；不保存字段名/值，空探测才能证明无执行输入。
      record.hasParsedInput = [parsed.json ?? {}, parsed.fields, parsed.files].some(value => Object.keys(value).length > 0);
      const actualKind = kind === 'image-generation' && (parsed.json?.layer_decomposition === true || parsed.json?.model === 'doubao-seedream-5.0-pro-layerize') ? 'seedream' : kind;
      // 读完有界 body 后再分配类型序号，避免并发 Seedream 暂占普通生图计数。
      record.kind = actualKind;
      record.kindCall = ++counts[actualKind];
      const key = request.headers['idempotency-key'] ?? request.headers['x-goog-request-id'];
      record.idempotencyKeyHash = key ? sha(String(key)) : null;
      record.requestHash = sha(Buffer.concat([Buffer.from(`${request.method} ${actualKind}\n`), body]));
      // Hash 表与日志使用相同上限；重复请求仍累计，满额后不保存新的键。
      countBounded(state.requestCounts, record.requestHash, maxRecords);
      if (record.idempotencyKeyHash) countBounded(state.idempotencyCounts, record.idempotencyKeyHash, maxRecords);
      const workflow = actualKind === 'chat' || actualKind === 'responses' ? requestWorkflow(parsed.json) : null;
      record.workflow = workflow;
      const context = {
        kind: actualKind, kindCall: record.kindCall, requestId: record.id, method: request.method ?? 'GET',
        pathname: url.pathname, query: Object.fromEntries(url.searchParams), json: parsed.json,
        fields: parsed.fields, files: parsed.files, body, workflow, payload: requestPayload(parsed.json),
        idempotencyKey: key ? String(key) : null,
        signal: undefined,
      };
      // 回调可 await signal；close()/断连均会唤醒，不让回调持有在途请求。
      const controller = new AbortController();
      const abortContext = () => controller.abort();
      response.once('close', abortContext);
      response.once('finish', () => response.removeListener('close', abortContext));
      context.signal = controller.signal;
      const rule = faults.find(entry => entry.remaining > 0 && (entry.kind === '*' || entry.kind === actualKind) && (entry.at === undefined || record.kindCall >= entry.at));
      const fault = rule?.fault;
      if (rule) { rule.remaining--; record.fault = fault.type; }
      if (fault?.type === 'http') { send(fault.status ?? 503, { error: { message: 'Injected local mock HTTP fault' } }); return; }
      if (fault?.type === 'drop') { state.dropped++; record.outcome = 'dropped'; response.destroy(); return; }
      if (fault?.type === 'hang') { state.hanging++; return; }
      if (fault?.type === 'delay') {
        state.delayed++;
        await delay(fault.ms ?? 250, response);
        if (response.destroyed || closed) return;
      }
      if (actualKind === 'unknown') { send(404, { error: { message: 'Unknown local mock endpoint' } }); return; }
      if (actualKind === 'health') { send(200, { status: 'ok' }); return; }
      if (actualKind === 'models') {
        const models = options.models ?? ['mock-reasoner', 'mock-image', 'gemini-3-pro-image', 'doubao-seedream-5.0-pro-layerize', 'sam3'];
        send(200, { object: 'list', data: models.map(id => ({ id, object: 'model', created: 1, owned_by: 'local-fixture' })), models: models.map(id => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })) }); return;
      }
      if (actualKind === 'download') {
        const asset = downloads.get(url.pathname);
        if (!asset) { send(404, { error: { message: 'Unknown or expired local mock download' } }); return; }
        if (asset.failures > 0) { asset.failures--; state.downloadFailures++; send(503, { error: { message: 'Injected first download failure' } }); return; }
        send(200, fault?.type === 'bad-image' ? Buffer.from('invalid local mock image') : asset.bytes, { 'content-type': 'image/png' }); return;
      }
      if (['brave', 'tavily', 'searxng'].includes(actualKind)) {
        const results = (options.searchResults ?? [{ title: 'Neutral studio lighting reference', description: 'Soft side lighting and a restrained background for product composition.' }]).slice(0, 20).map((entry, i) => ({
          title: String(entry.title).slice(0, 200), url: `${origin}/full-mock-reference/${i + 1}`,
          description: String(entry.description ?? entry.content ?? '').slice(0, 500), content: String(entry.content ?? entry.description ?? '').slice(0, 500),
        }));
        send(200, actualKind === 'brave' ? { web: { results } } : { results }); return;
      }
      if (actualKind === 'chat' || actualKind === 'responses') {
        let reply;
        if (options.replyForRequest) reply = await cancellable(options.replyForRequest(context), context.signal);
        if (reply === undefined && options.replies && Object.hasOwn(options.replies, workflow)) {
          const fixture = options.replies[workflow];
          reply = typeof fixture === 'function' ? await cancellable(fixture(context), context.signal) : fixture;
        }
        if (reply === undefined) reply = defaultReplyForRequest(context);
        if (response.destroyed || closed) return;
        const normalized = normalizeReply(reply, record.id);
        record.status = 200;
        const truncated = fault?.type === 'truncate-sse';
        if (truncated) state.truncated++;
        if (actualKind === 'chat') streamChat(response, parsed.json, normalized, record.id, truncated);
        else streamResponses(response, parsed.json, normalized, record.id, truncated);
        return;
      }
      if (isProbe(context)) {
        record.validationRejected = true;
        send(actualKind === 'gitee-sam3' ? 422 : 400, { error: { message: 'Required image input missing (local validation probe)' } }); return;
      }
      const dimensions = options.matchInputSize === false ? null : await inputDimensions(context);
      let image = options.imageForRequest ? await cancellable(options.imageForRequest(context, images), context.signal) : images.image;
      if (!image) image = images.image;
      image = await normalizePng(image);
      const width = dimensions?.width ?? images.width, height = dimensions?.height ?? images.height;
      if (dimensions) image = await resizedPng(image, width, height);
      let mask = options.maskForRequest ? await cancellable(options.maskForRequest(context, images), context.signal) : images.mask;
      mask = await normalizePng(mask ?? images.mask, width, height);
      if (fault?.type === 'empty-mask') mask = await resizedPng(images.emptyMask, width, height);
      const badImage = fault?.type === 'bad-image';
      if (badImage) { image = Buffer.from('invalid local mock image'); mask = image; }
      const useUrl = fault?.type === 'download-once' || options.imageMode === 'url' || (options.imageMode === 'request' && (parsed.json?.response_format ?? parsed.fields.response_format) === 'url');
      const ref = bytes => useUrl ? download(bytes, fault?.type === 'download-once' ? 1 : 0) : `data:image/png;base64,${bytes.toString('base64')}`;
      if (actualKind === 'gemini') {
        send(200, { responseId: `mock-gemini-${record.id}`, candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: image.toString('base64') } }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }); return;
      }
      if (actualKind === 'image-generation' || actualKind === 'image-edit') {
        send(200, { id: `mock-image-${record.id}`, created: 1, data: [useUrl ? { url: ref(image) } : { b64_json: image.toString('base64') }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); return;
      }
      if (actualKind === 'seedream') {
        const base = dimensions ? await resizedPng(images.background, width, height) : images.background;
        const layers = options.layers ?? [{ name: '商品主体', image: images.alpha, bbox: [250, 250, 750, 750] }, { name: '局部组件', image: images.alpha, bbox: [250, 250, 750, 750] }];
        if (layers.length > 16) throw new RangeError('Seedream fixture supports at most 16 foreground layers');
        // 拆分协议固定 URL；失败只挂在首个底图 GET，成功 POST 回执完整保留。
        const data = [{ url: download(badImage ? image : base, fault?.type === 'download-once' ? 1 : 0), z_index: 0 }];
        for (const [i, layer] of layers.entries()) data.push({
          url: download(badImage ? image : await normalizePng(layer.image, width, height), 0), z_index: i + 1, name: layer.name,
          bounding_box: { normalized: layer.bbox ?? [0, 0, 1000, 1000], absolute: (layer.bbox ?? [0, 0, 1000, 1000]).map((value, index) => Math.round(value / 1000 * (index % 2 === 0 ? width : height))) },
        });
        send(200, { model: parsed.json.model, data }); return;
      }
      if (actualKind === 'fal') {
        send(200, { request_id: `mock-fal-${record.id}`, masks: [{ url: ref(mask), content_type: 'image/png', width, height }], scores: [0.99], boxes: [[0.5, 0.5, 0.5, 0.5]] }); return;
      }
      if (actualKind === 'grounded-sam') {
        send(200, { request_id: `mock-grounded-${record.id}`, masks: [{ data: mask.toString('base64'), mime_type: 'image/png', width, height, bbox: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, score: 0.99 }] }); return;
      }
      if (actualKind === 'gitee-sam3') {
        const encoded = badImage ? { encoding: 'rle', size: [width, height], counts: 'invalid' } : await giteeMask(mask);
        send(200, { num_segments: 1, segments: [{ id: 1, label: parsed.fields.prompt ?? 'product', confidence: 0.99, bbox: [width / 4, height / 4, width * 3 / 4, height * 3 / 4], mask: encoded }] }); return;
      }
    } catch (error) {
      if (record.kindCall === 0) record.kindCall = ++counts[record.kind];
      if (response.destroyed || closed) return;
      if (error?.mockStatus) send(error.mockStatus, { error: { message: 'Invalid or oversized local mock request' } });
      else { state.callbackErrors++; send(500, { error: { message: 'Local mock fixture error; inspect test configuration' } }); }
    }
  }
  function download(bytes, failures) {
    if (downloads.size >= maxDownloads || downloadBytes + bytes.byteLength > maxDownloadBytes) throw new RangeError('Mock download capacity reached; start a new isolated fixture');
    downloadBytes += bytes.byteLength;
    const path = `/full-mock-download/${++downloadId}.png`;
    downloads.set(path, { bytes, failures });
    return `${origin}${path}`;
  }
  function delay(ms, response) {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); timers.delete(timer); response.removeListener('close', finish); resolve(); };
      const timer = setTimeout(finish, ms);
      timers.add(timer);
      response.once('close', finish);
    });
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, baseUrl: `${origin}/v1`, geminiBaseUrl: `${origin}/v1beta`,
    searchUrls: { brave: `${origin}/search/brave`, tavily: `${origin}/search/tavily`, searxng: `${origin}/search/searxng` },
    images, state, control,
    close() {
      if (closePromise) return closePromise;
      closed = true; state.closed = true;
      // 先销毁连接唤醒 delay/回调的取消信号；不能把本夹具关闭当成客户端取消。
      closePromise = new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        for (const response of activeResponses) response.destroy();
        for (const socket of sockets) socket.destroy();
        for (const timer of timers) clearTimeout(timer);
        timers.clear(); downloads.clear();
      });
      return closePromise;
    },
  };
}

function classify(method, path) {
  if (method === 'GET' && /^\/full-mock-download\/\d+\.png$/.test(path)) return 'download';
  if (method === 'GET' && /\/models\/?$/.test(path)) return 'models';
  if (method === 'GET' && /\/health\/?$/.test(path)) return 'health';
  if (method === 'GET' && /\/(?:search\/brave|res\/v1\/web\/search)\/?$/.test(path)) return 'brave';
  if (method === 'GET' && /\/(?:search\/searxng|search)\/?$/.test(path)) return 'searxng';
  if (method === 'POST' && /\/(?:search\/tavily|tavily\/search)\/?$/.test(path)) return 'tavily';
  if (method !== 'POST') return 'unknown';
  if (path.endsWith('/chat/completions')) return 'chat';
  if (path.endsWith('/responses')) return 'responses';
  if (/\/models\/[^/]+:generateContent$/.test(path)) return 'gemini';
  if (path.endsWith('/images/segmentation')) return 'gitee-sam3';
  if (path.endsWith('/images/generations')) return 'image-generation';
  if (path.endsWith('/images/edits')) return 'image-edit';
  if (/\/fal-ai\/sam-[^/]+\/image$/.test(path)) return 'fal';
  if (['/', '/v1', '/v1/', '/grounded-sam', '/grounded-sam/'].includes(path)) return 'grounded-sam';
  return 'unknown';
}

async function readBody(request, limit, record) {
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > limit) { request.resume(); throw Object.assign(new Error(), { mockStatus: 413 }); }
  const chunks = [];
  // data 事件方式不会在超限时自动 destroy socket，客户端仍可收到明确 413。
  return new Promise((resolve, reject) => {
    const cleanup = () => { request.removeListener('data', onData); request.removeListener('end', onEnd); request.removeListener('error', onError); request.removeListener('aborted', onError); };
    const onError = () => { cleanup(); reject(Object.assign(new Error(), { mockStatus: 400 })); };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onData = chunk => {
      record.bodyBytes += chunk.length;
      if (record.bodyBytes > limit) { cleanup(); request.resume(); reject(Object.assign(new Error(), { mockStatus: 413 })); }
      else chunks.push(chunk);
    };
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onError);
  });
}

function parseBody(bytes, contentType = '') {
  const result = { json: null, fields: Object.create(null), files: Object.create(null) };
  if (!bytes.length) return result;
  if (String(contentType).includes('application/json')) {
    try { result.json = JSON.parse(bytes.toString('utf8')); } catch { throw Object.assign(new Error(), { mockStatus: 400 }); }
    if (!result.json || typeof result.json !== 'object' || Array.isArray(result.json)) throw Object.assign(new Error(), { mockStatus: 400 });
  } else if (String(contentType).includes('multipart/form-data')) {
    const match = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(String(contentType));
    if (!match || (match[1] ?? match[2]).length > 200) throw Object.assign(new Error(), { mockStatus: 400 });
    const boundary = Buffer.from(`--${match[1] ?? match[2]}`);
    let position = bytes.indexOf(boundary), parts = 0;
    while (position >= 0) {
      const start = position + boundary.length;
      if (bytes.subarray(start, start + 2).toString() === '--') break;
      const next = bytes.indexOf(Buffer.concat([Buffer.from('\r\n'), boundary]), start);
      if (next < 0 || ++parts > 64) throw Object.assign(new Error(), { mockStatus: 400 });
      const endHeaders = bytes.indexOf('\r\n\r\n', start);
      if (endHeaders < 0 || endHeaders > next || endHeaders - start > 8192) throw Object.assign(new Error(), { mockStatus: 400 });
      const headers = bytes.subarray(start, endHeaders).toString('utf8');
      const name = /(?:^|;)\s*name="([^"]+)"/im.exec(headers)?.[1];
      const filename = /(?:^|;)\s*filename="([^"]*)"/im.exec(headers)?.[1];
      const value = bytes.subarray(endHeaders + 4, next);
      if (!name || name.length > 200) throw Object.assign(new Error(), { mockStatus: 400 });
      if (filename !== undefined) (result.files[name] ??= []).push({ filename, mimeType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1] ?? 'application/octet-stream', data: value });
      else result.fields[name] = value.toString('utf8');
      position = next + 2;
    }
  } else throw Object.assign(new Error(), { mockStatus: 415 });
  return result;
}

function isProbe(context) {
  const json = context.json ?? {};
  if (context.kind === 'fal') return !json.image_url;
  if (context.kind === 'gitee-sam3') return !context.fields.image && !context.files.image?.length;
  if (context.kind === 'grounded-sam') return !json.image;
  if (context.kind === 'seedream') return !json.image || !json.model;
  if (context.kind === 'image-generation') return !json.model || !json.prompt;
  if (context.kind === 'image-edit') return !context.fields.model || !context.fields.prompt;
  return false;
}

function normalizeReply(reply, requestId) {
  const envelope = typeof reply === 'string' ? { text: reply } : reply && typeof reply === 'object' && ('json' in reply || 'text' in reply || 'toolCalls' in reply) ? reply : { json: reply };
  const text = envelope.text ?? (envelope.json === undefined ? '' : JSON.stringify(envelope.json));
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_REPLY) throw new RangeError('Mock reply exceeds the 4 MiB limit');
  const toolCalls = envelope.toolCalls ?? [];
  if (!Array.isArray(toolCalls) || toolCalls.length > 16) throw new TypeError('Invalid mock tool calls');
  return { text, toolCalls: toolCalls.map((call, index) => {
    if (typeof call.name !== 'string' || call.name.length > 100) throw new TypeError('Invalid mock tool name');
    const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
    if (Buffer.byteLength(args) > MAX_REPLY) throw new RangeError('Mock tool arguments too large');
    return { id: call.id ?? `call_mock_${requestId}_${index + 1}`, name: call.name, arguments: args };
  }) };
}

function streamChat(response, body, reply, id, truncated) {
  const base = { id: `chatcmpl-mock-${id}`, object: 'chat.completion.chunk', created: 1, model: body.model ?? 'mock-reasoner' };
  if (body.stream === false && !truncated) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply.text || null, ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}) }, finish_reason: reply.toolCalls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const write = (delta, finishReason = null, usage) => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) })}\n\n`);
  write({ role: 'assistant', content: '' });
  if (truncated) {
    // 中途销毁传输；单纯 end() 会被部分 Chat SDK 误当成正常 stop。
    response.write('data: {"choices":[{"delta":{"content":"incomplete');
    response.flushHeaders();
    setImmediate(() => response.destroy()); return;
  }
  for (const text of chunks(reply.text)) write({ content: text });
  for (const [index, call] of reply.toolCalls.entries()) write({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] });
  write({}, reply.toolCalls.length ? 'tool_calls' : 'stop', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  response.end('data: [DONE]\n\n');
}

function streamResponses(response, body, reply, id, truncated) {
  const responseId = `resp_mock_${id}`, messageId = `msg_mock_${id}`;
  const message = { id: messageId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply.text, annotations: [], logprobs: [] }] };
  const output = [...(reply.text ? [message] : []), ...reply.toolCalls.map((call, index) => ({ id: `fc_mock_${id}_${index}`, type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments, status: 'completed' }))];
  const final = { id: responseId, object: 'response', created_at: 1, status: 'completed', model: body.model ?? 'mock-reasoner', output, error: null, incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  if (body.stream === false && !truncated) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(final)); return; }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  let sequence = 0;
  const emit = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`);
  emit('response.created', { response: { ...final, status: 'in_progress', output: [], usage: null } });
  if (truncated) { response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"incomplete'); response.flushHeaders(); setImmediate(() => response.destroy()); return; }
  for (const [index, item] of output.entries()) {
    emit('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : { arguments: '' }) } });
    if (item.type === 'message') {
      emit('response.content_part.added', { item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
      for (const text of chunks(reply.text)) emit('response.output_text.delta', { item_id: item.id, output_index: index, content_index: 0, delta: text, logprobs: [] });
      emit('response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text: reply.text, logprobs: [] });
      emit('response.content_part.done', { item_id: item.id, output_index: index, content_index: 0, part: item.content[0] });
    } else {
      emit('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: item.arguments });
      emit('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments });
    }
    emit('response.output_item.done', { output_index: index, item });
  }
  emit('response.completed', { response: final });
  response.end();
}

function* chunks(text) { for (let i = 0; i < text.length; i += 128) yield text.slice(i, i + 128); }
function countBounded(table, key, maximum) { if (Object.hasOwn(table, key)) table[key]++; else if (Object.keys(table).length < maximum) table[key] = 1; }
function bounded(value, min, max, name) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Invalid mock ${name}`); return value; }
function validateFault(fault, kind) {
  if (!fault || !['http', 'drop', 'truncate-sse', 'delay', 'hang', 'bad-image', 'empty-mask', 'download-once'].includes(fault.type)) throw new TypeError('Unknown mock fault');
  const kinds = {
    'truncate-sse': ['chat', 'responses'],
    'bad-image': ['image-generation', 'image-edit', 'gemini', 'fal', 'grounded-sam', 'gitee-sam3', 'seedream', 'download'],
    'empty-mask': ['fal', 'grounded-sam', 'gitee-sam3'],
    'download-once': ['image-generation', 'image-edit', 'fal', 'seedream'],
  }[fault.type];
  if (kinds && !kinds.includes(kind)) throw new TypeError('Mock fault does not apply to this request kind');
  if (fault.type === 'http') bounded(fault.status ?? 503, 400, 599, 'HTTP status');
  if (fault.type === 'delay') bounded(fault.ms ?? 250, 0, 300000, 'delay ms');
}
function cancellable(value, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Mock request disconnected'));
    if (signal.aborted) { reject(new Error('Mock request disconnected')); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
