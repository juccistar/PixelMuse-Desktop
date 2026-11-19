import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  startFullMockProvider, storyboardReply,
  type FullMockOptions, type FullMockProvider, type MockKind,
} from '../../../scripts/full-mock-provider.mjs';
// 显式使用当前产物，避免测试工具把共享包的源码隐式构建成另一个版本。
import {
  OpenAiCompatibleImageProvider, GeminiImageProvider, SeedreamLayerizeProvider,
  createSegmentationProvider, buildReasoningModel, probeReasoning,
} from '../../providers/dist/index.js';
import { planStoryboard, reviseImagePrompt } from '../../agent/dist/index.js';

const servers: FullMockProvider[] = [];
const origins = new Set<string>();
const realFetch = globalThis.fetch;
const key = 'local-protocol-fixture-key';
const width = 37, height = 23;

beforeEach(() => {
  // 仍走真实 fetch/SDK/适配器；这个边界只拒绝未由当前测试创建的网络地址。
  vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!origins.has(url.origin)) throw new Error(`Unexpected non-fixture network origin: ${url.origin}`);
    return realFetch(input, init);
  }) as typeof fetch);
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  origins.clear();
  vi.unstubAllGlobals();
});
async function fixture(options: FullMockOptions = {}) {
  const server = await startFullMockProvider({ width, height, ...options });
  servers.push(server); origins.add(server.origin);
  return server;
}
const connection = (server: FullMockProvider) => ({ baseUrl: server.baseUrl, apiKey: key, requestTimeoutMs: 3000 });
const dataUri = (data: Buffer) => `data:image/png;base64,${data.toString('base64')}`;
const imageInput = (data: Buffer) => ({ data, filename: 'synthetic.png', mimeType: 'image/png' });
const rgba = (data: Buffer) => sharp(data).ensureAlpha().raw().toBuffer();
async function idle(server: FullMockProvider) {
  await vi.waitFor(() => expect(server.state.active).toBe(0), { timeout: 3000, interval: 10 });
}
function model(server: FullMockProvider, protocol: 'openai' | 'openai_responses') {
  return buildReasoningModel({ providerId: 'local-fixture', modelId: 'mock-reasoner', baseUrl: server.baseUrl,
    protocol, supportsVision: true, supportsThinking: false, supportsStructuredOutput: true });
}
const revision = { apiKey: key, prompt: 'Preserve the real product identity.', revision: 'Use soft light.', timeoutMs: 3000 };

// 各用例比较实际适配器解码后的业务值；计数来自真实 localhost HTTP 边界。
describe('full mock fixture with current built desktop adapters', () => {
  it.each(['base64', 'url'] as const)('decodes OpenAI %s generations and multipart edits without another paid POST', async imageMode => {
    const server = await fixture({ imageMode });
    const provider = new OpenAiCompatibleImageProvider(connection(server));
    expect((await provider.probe()).models).toContain('mock-image');
    const generated = await provider.generate({ model: 'mock-image', prompt: 'Synthetic generation', idempotencyKey: 'fixture-generation' });
    const edited = await provider.editImage({ model: 'gpt-image-1', prompt: 'Synthetic edit', sourceImage: imageInput(server.images.image), mask: imageInput(server.images.mask) });
    expect(generated.mimeType).toBe('image/png');
    expect(await rgba(generated.image)).toEqual(await rgba(server.images.image));
    expect(await rgba(edited.image)).toEqual(await rgba(server.images.image));
    expect(generated.providerTaskId).toBeTruthy();
    await idle(server);
    expect(server.state.counts).toMatchObject({ models: 1, 'image-generation': 1, 'image-edit': 1, download: imageMode === 'url' ? 2 : 0 });
    expect(server.state.records.every(record => record.outcome === 'completed' && record.status === 200)).toBe(true);
  });

  it('decodes native Gemini inline images and uses its model discovery endpoint', async () => {
    const server = await fixture();
    const provider = new GeminiImageProvider({ ...connection(server), baseUrl: server.geminiBaseUrl });
    expect((await provider.probe()).models).toContain('gemini-3-pro-image');
    const result = await provider.generate({ model: 'gemini-3-pro-image', prompt: 'Synthetic native image', images: [imageInput(server.images.image)] });
    expect(result.mimeType).toBe('image/png');
    expect(await rgba(result.image)).toEqual(await rgba(server.images.image));
    expect(server.state.counts).toMatchObject({ gemini: 1, models: 1, 'image-generation': 0, download: 0 });
  });

  it.each(['fal', 'grounded_sam', 'gitee_sam3'] as const)('preserves every asymmetric mask pixel through real %s decoding', async protocol => {
    // 独立的稀疏图案包含长短游程、边缘和孤立点，不能由宽高相等或中心矩形掩盖转置。
    const expected = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if ((x === 0 && y < 3) || (x >= 4 && x < 11 && y >= 2 && y < 19) || (x === 31 && y === 21) || (x > 24 && y > 15 && (x + y) % 3 === 0)) expected[y * width + x] = 255;
    }
    const mask = await sharp(expected, { raw: { width, height, channels: 1 } }).png().toBuffer();
    const server = await fixture({ mask });
    const provider = createSegmentationProvider(protocol, connection(server));
    await provider.probe();
    const result = await provider.segment({ imageUrl: dataUri(server.images.image), textPrompt: 'synthetic foreground' });
    expect(result.mask).toMatchObject({ width, height });
    const actual = result.mask.mimeType === 'raw/gray8' ? result.mask.data : await sharp(result.mask.data).removeAlpha().greyscale().raw().toBuffer();
    expect(actual).toEqual(expected);
    expect(result.score).toBeGreaterThan(0);
    const kind: MockKind = protocol === 'grounded_sam' ? 'grounded-sam' : protocol === 'gitee_sam3' ? 'gitee-sam3' : 'fal';
    // Grounded SAM 使用 GET health；fal/Gitee 使用不创建任务的参数校验探测。
    expect(server.state.counts[kind]).toBe(protocol === 'grounded_sam' ? 1 : 2);
    expect(server.state.counts.health).toBe(protocol === 'grounded_sam' ? 1 : 0);
    expect(server.state.callbackErrors).toBe(0);
  });

  it('accepts fal box prompts and returns an exact valid empty mask when requested', async () => {
    const server = await fixture();
    const provider = createSegmentationProvider('fal', connection(server));
    const result = await provider.segment({ imageUrl: dataUri(server.images.image), box: { xMin: 1, yMin: 2, xMax: 20, yMax: 18 } });
    expect(await sharp(result.mask.data).removeAlpha().greyscale().raw().toBuffer()).toEqual(await sharp(server.images.mask).removeAlpha().greyscale().raw().toBuffer());
    server.control.failNext('fal', { type: 'empty-mask' });
    const empty = await provider.segment({ imageUrl: dataUri(server.images.image), textPrompt: 'no foreground' });
    expect(await sharp(empty.mask.data).removeAlpha().greyscale().raw().toBuffer()).toEqual(Buffer.alloc(width * height));
    expect(server.state.counts.fal).toBe(2);
  });

  it('parses Seedream base, custom transparent layers, ordering and normalized boxes from downloaded PNGs', async () => {
    const layer = await sharp({ create: { width, height, channels: 4, background: { r: 70, g: 110, b: 160, alpha: 0 } } })
      .composite([{ input: await sharp({ create: { width: 7, height: 5, channels: 4, background: '#e45b32' } }).png().toBuffer(), left: 3, top: 8 }]).png().toBuffer();
    const server = await fixture({ layers: [{ name: 'Asymmetric subject', image: layer, bbox: [100, 200, 600, 900] }] });
    const result = await new SeedreamLayerizeProvider(connection(server)).layerize({ imageUrl: dataUri(server.images.image) });
    expect(result.base?.mimeType).toBe('image/png');
    expect(await rgba(result.base!.data)).toEqual(await rgba(server.images.background));
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]).toMatchObject({ zIndex: 1, name: 'Asymmetric subject', bbox: { x: 0.1, y: 0.2, width: 0.5, height: 0.7 } });
    expect(await rgba(result.layers[0]!.png)).toEqual(await rgba(layer));
    expect(result.providerTaskId).toBeNull();
    expect(server.state.counts).toMatchObject({ seedream: 1, 'image-generation': 0, download: 2 });
  });

  it('distinguishes a completed paid image receipt followed by failed download from a failed paid POST', async () => {
    const server = await fixture({ imageMode: 'url' });
    const provider = new OpenAiCompatibleImageProvider(connection(server));
    server.control.failNext('image-generation', { type: 'download-once' });
    await expect(provider.generate({ model: 'mock-image', prompt: 'Download failure', idempotencyKey: 'paid-once' })).rejects.toMatchObject({ status: 503 });
    await idle(server);
    expect(server.state.counts).toMatchObject({ 'image-generation': 1, download: 1 });
    expect(server.state.records.map(({ kind, status, outcome }) => ({ kind, status, outcome }))).toEqual([
      { kind: 'image-generation', status: 200, outcome: 'completed' },
      { kind: 'download', status: 503, outcome: 'completed' },
    ]);
    expect(server.state).toMatchObject({ downloadFailures: 1, completed: 2, aborted: 0, truncated: 0 });
    server.control.failNext('image-generation', { type: 'http', status: 429 });
    await expect(provider.generate({ model: 'mock-image', prompt: 'Rejected POST' })).rejects.toMatchObject({ status: 429 });
    expect(server.state.counts).toMatchObject({ 'image-generation': 2, download: 1 });
    expect(server.state.records[2]).toMatchObject({ kind: 'image-generation', status: 429, outcome: 'completed' });
  });

  it('records a real client abort separately from a server-dropped image request, without retries', async () => {
    const server = await fixture();
    const provider = new OpenAiCompatibleImageProvider(connection(server));
    server.control.failNext('image-generation', { type: 'hang' });
    const abort = new AbortController();
    // 立即挂接 rejection 处理器，取消不产生未处理拒绝。
    const pending = provider.generate({ model: 'mock-image', prompt: 'Cancel me', signal: abort.signal }).then(() => null, error => error);
    await vi.waitFor(() => expect(server.state.hanging).toBe(1), { interval: 10 });
    abort.abort();
    expect(await pending).toBeInstanceOf(Error);
    await idle(server);
    expect(server.state).toMatchObject({ aborted: 1, dropped: 0, completed: 0, truncated: 0 });
    expect(server.state.counts['image-generation']).toBe(1);
    server.control.failNext('image-generation', { type: 'drop' });
    await expect(provider.generate({ model: 'mock-image', prompt: 'Drop me' })).rejects.toThrow();
    await idle(server);
    expect(server.state).toMatchObject({ aborted: 1, dropped: 1, completed: 0 });
    expect(server.state.records.map(record => record.outcome)).toEqual(['aborted', 'dropped']);
    expect(server.state.counts['image-generation']).toBe(2);
  });
});

for (const protocol of ['openai', 'openai_responses'] as const) {
  const kind = protocol === 'openai' ? 'chat' : 'responses';
  describe(`real Pi runtime over ${protocol}`, () => {
    it('accepts complete streamed structured output and a real model probe', async () => {
      const text = 'Preserve exact product details. Use soft studio light. 保留商品真实细节。';
      const server = await fixture({ replies: { revision: { json: { prompt: text } } } });
      const reasoningModel = model(server, protocol);
      expect((await probeReasoning({ providerId: 'local-fixture', modelId: 'mock-reasoner', protocol, baseUrl: server.baseUrl, supportsVision: false, supportsThinking: false, apiKey: key, timeoutMs: 3000 })).text).toBe('OK');
      expect(await reviseImagePrompt({ ...revision, model: reasoningModel })).toBe(text);
      await idle(server);
      expect(server.state.counts[kind]).toBe(2);
      expect(server.state).toMatchObject({ completed: 2, truncated: 0, aborted: 0 });
      expect(server.state.records.map(record => record.workflow)).toEqual(['probe', 'revision']);
    });

    it.each(['brave', 'tavily', 'searxng'] as const)('executes a model tool call, real %s search and a second model turn', async source => {
      const server = await fixture({ replyForRequest: context => {
        if (context.workflow !== 'storyboard') return undefined;
        const entries = context.json?.messages ?? context.json?.input ?? [];
        const toolResult = entries.find((entry: { role?: string; type?: string }) => entry.role === 'tool' || entry.type === 'function_call_output');
        if (!toolResult) return { toolCalls: [{ name: 'research_visual_direction', arguments: { query: 'soft neutral lighting' } }] };
        // 第二轮确实含搜索工具的结果，不能仅凭第二次调用就返回成功。
        expect(JSON.stringify(toolResult)).toContain(server.origin);
        expect(JSON.stringify(toolResult)).toContain('Neutral studio lighting reference');
        return storyboardReply({ assetTypes: ['hero-image'], referencedAssets: ['P1'] });
      } });
      const result = await planStoryboard({ model: model(server, protocol), apiKey: key, projectName: 'Synthetic fixture',
        productCategory: null, productDescription: null, verifiedFacts: [], prohibitedClaims: [], brandGuidelines: {},
        platformTargets: ['AMAZON'], targetMarket: null, copyLanguage: 'en', promptLanguage: 'ENGLISH', defaultMode: 'CREATIVE',
        assets: [{ id: 'asset-fixture', handle: 'P1', role: 'PRODUCT_TRUTH', kind: 'PRODUCT', name: 'Synthetic item', mimeType: 'image/png' }],
        planningMode: 'MANUAL', requestedTypes: ['hero-image'],
        webResearch: { sources: [{ id: 'local-search', name: 'Local fixture', kind: source, baseUrl: server.searchUrls[source], apiKey: 'local-search-key' }] }, timeoutMs: 5000 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ assetType: 'hero-image', referencedAssets: ['asset-fixture'] });
      expect(result.items[0]!.promptInstruction).toContain('Preserve the exact product identity');
      await idle(server);
      expect(server.state.counts[kind]).toBe(2);
      expect(server.state.counts[source]).toBe(1);
      expect(server.state.total).toBe(3);
      expect(server.state.callbackErrors).toBe(0);
    });

    it('rejects a truncated stream after one HTTP request and can distinguish the next complete response', async () => {
      const server = await fixture();
      server.control.failNext(kind, { type: 'truncate-sse' });
      await expect(reviseImagePrompt({ ...revision, model: model(server, protocol) })).rejects.toThrow();
      await idle(server);
      expect(server.state.counts[kind]).toBe(1);
      expect(server.state).toMatchObject({ truncated: 1, completed: 0, aborted: 0 });
      expect(server.state.records[0]).toMatchObject({ outcome: 'truncated', status: 200 });
      expect((await reviseImagePrompt({ ...revision, model: model(server, protocol) })).length).toBeGreaterThan(50);
      await idle(server);
      expect(server.state.counts[kind]).toBe(2);
      expect(server.state).toMatchObject({ truncated: 1, completed: 1, aborted: 0 });
    });

    it('propagates caller cancellation through Pi to the actual hanging HTTP connection', async () => {
      const server = await fixture();
      server.control.failNext(kind, { type: 'hang' });
      const abort = new AbortController();
      const pending = reviseImagePrompt({ ...revision, model: model(server, protocol), signal: abort.signal }).then(() => null, error => error);
      await vi.waitFor(() => expect(server.state.hanging).toBe(1), { interval: 10 });
      abort.abort();
      expect(await pending).toBeInstanceOf(Error);
      await idle(server);
      expect(server.state.counts[kind]).toBe(1);
      expect(server.state).toMatchObject({ aborted: 1, truncated: 0, completed: 0 });
      expect(server.state.records[0]).toMatchObject({ outcome: 'aborted', fault: 'hang' });
    });
  });
}
