import { describe, expect, it } from 'vitest';
import type { ResponseReceipt } from '@ecomgen/domain';
import { estimateUsageAmount, extractReceiptUsage } from '../../src/runtime/usage-extraction.js';
const receipt = (value: unknown): ResponseReceipt => ({ status: 200, headers: [], bodyBase64: Buffer.from(JSON.stringify(value)).toString('base64') });
const sse = (body: string): ResponseReceipt => ({ status: 200, headers: [['Content-Type', 'text/event-stream; charset=utf-8']], bodyBase64: Buffer.from(body).toString('base64') });
describe('真实回执计量解析', () => {
  it.each([
    [{ usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } }, 10, 3, 2],
    [{ usage: { input_tokens: 11, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } } }, 11, 4, 3],
    [{ usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, cachedContentTokenCount: 2 } }, 12, 8, 2],
    [{ usage: { input_tokens: 0, output_tokens: 0 } }, 0, 0, null],
  ])('JSON明确计数 %#', (body, inputTokens, outputTokens, cachedInputTokens) => {
    expect(extractReceiptUsage(receipt(body))).toEqual({ inputTokens, outputTokens, cachedInputTokens, usageSource: 'PROVIDER' });
  });
  it('Gemini思考输出单独相加并完整计价，不从total倒推', () => {
    const usage = extractReceiptUsage(receipt({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100, thoughtsTokenCount: 900, totalTokenCount: 1100 } }));
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 1000 });
    expect(estimateUsageAmount(usage, { inputPerMillion: 0, outputPerMillion: 10, cachedInputPerMillion: null, perRequest: null })).toBe(0.01);
  });
  it.each([-1, '900', Number.MAX_SAFE_INTEGER])('Gemini思考计数无效或求和溢出时不能部分计价 %s', thoughtsTokenCount => {
    const usage = extractReceiptUsage(receipt({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100, thoughtsTokenCount } }));
    expect(usage.outputTokens).toBeNull();
    expect(estimateUsageAmount(usage, { inputPerMillion: 0, outputPerMillion: 10, cachedInputPerMillion: null, perRequest: null })).toBeNull();
  });
  it('Gemini累计SSE分开补充候选与思考计数，重复末帧不重复相加', () => {
    const metadata = [
      { promptTokenCount: 100, candidatesTokenCount: 25, thoughtsTokenCount: 100 },
      { candidatesTokenCount: 100 },
      { thoughtsTokenCount: 900 },
      { promptTokenCount: 100, candidatesTokenCount: 100, thoughtsTokenCount: 900 },
      { promptTokenCount: 100, candidatesTokenCount: 100, thoughtsTokenCount: 900 },
    ];
    const usage = extractReceiptUsage(sse(metadata.map(usageMetadata => `data: ${JSON.stringify({ usageMetadata })}\n\n`).join('')));
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 1000 });
    const invalid = extractReceiptUsage(sse('data: {"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":100}}\n\ndata: {"usageMetadata":{"thoughtsTokenCount":-1}}\n\n'));
    expect(invalid.outputTokens).toBeNull();
  });
  it.each(['promptTokenCount', 'cachedContentTokenCount'] as const)('Gemini最终明确无效的%s清除旧累计值且不估算', field => {
    const body = [
      { promptTokenCount: 10, candidatesTokenCount: 1, cachedContentTokenCount: 5 },
      { [field]: -1, candidatesTokenCount: 100 },
    ].map(usageMetadata => `data: ${JSON.stringify({ usageMetadata })}\n\n`).join('');
    const usage = extractReceiptUsage(sse(body));
    expect(field === 'promptTokenCount' ? usage.inputTokens : usage.cachedInputTokens).toBeNull();
    expect(usage.outputTokens).toBe(100);
    expect(estimateUsageAmount(usage, { inputPerMillion: 1, outputPerMillion: 2, cachedInputPerMillion: 0.5, perRequest: null })).toBeNull();
  });
  it('缺失、字符串、负数、占位成本和total都不填零或推算', () => {
    for (const body of [{}, { usage: { total_tokens: 100 } }, { usage: { input_tokens: '5', output_tokens: -2, cached_tokens: 0.2 } }, { cost: { input: 0, output: 0 } }]) {
      expect(extractReceiptUsage(receipt(body))).toEqual({ inputTokens: null, outputTokens: null, cachedInputTokens: null, usageSource: 'UNAVAILABLE' });
    }
    expect(extractReceiptUsage({ ...receipt({}), bodyBase64: Buffer.from('{broken').toString('base64') }).usageSource).toBe('UNAVAILABLE');
  });
  it('chat和DashScope累计SSE末帧不重复相加，支持CRLF和多行data', () => {
    const body = 'data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\r\n\r\ndata: broken\r\n\r\ndata: {"usage":\r\ndata: {"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":4}}}\r\n\r\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\r\n\r\ndata: [DONE]\r\n\r\n';
    expect(extractReceiptUsage(sse(body))).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 4, usageSource: 'PROVIDER' });
  });
  it.each([
    { usage: { prompt_tokens: -1, completion_tokens: 100 } },
    { response: { usage: { input_tokens: -1, output_tokens: 100 } } },
    { usage: { prompt_tokens_details: { cached_tokens: -1 }, completion_tokens: 100 } },
  ])('兼容协议的最终无效累计计数不能沿用旧值估算 %#', last => {
    const first = { usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 5 } } };
    const usage = extractReceiptUsage(sse([first, last].map(value => `data: ${JSON.stringify(value)}\n\n`).join('')));
    expect(usage.outputTokens).toBe(100);
    expect(estimateUsageAmount(usage, { inputPerMillion: 1, outputPerMillion: 2, cachedInputPerMillion: 0.5, perRequest: null })).toBeNull();
  });
  it('Responses最终事件嵌套response.usage被提取', () => {
    const body = 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":20,"output_tokens":6,"input_tokens_details":{"cached_tokens":7}}}}\n\n';
    expect(extractReceiptUsage(sse(body))).toEqual({ inputTokens: 20, outputTokens: 6, cachedInputTokens: 7, usageSource: 'PROVIDER' });
  });
  it('SSE支持单独CR换行，未分派的尾帧不制造用量', () => {
    expect(extractReceiptUsage(sse('data: {"usage":{"input_tokens":6,"output_tokens":1}}\r\rdata: [DONE]\r\r'))).toMatchObject({ inputTokens: 6, outputTokens: 1 });
    expect(extractReceiptUsage(sse('data: [DONE]\n\ndata: {"usage":{"input_tokens":999}}')).usageSource).toBe('UNAVAILABLE');
  });
  it('图片回执显式usage可提取，图像数量和URL不可推算Token', () => {
    expect(extractReceiptUsage(receipt({ data: [{ url: 'https://private.invalid' }], usage: { input_tokens: 30, output_tokens: 40 } }))).toMatchObject({ inputTokens: 30, outputTokens: 40 });
    expect(extractReceiptUsage(receipt({ data: [{ b64_json: 'aA==' }], usage: { generated_images: 1 } })).usageSource).toBe('UNAVAILABLE');
  });
});
describe('完整估算和缓存计价', () => {
  const usage = { inputTokens: 1000000, outputTokens: 500000, cachedInputTokens: 250000, usageSource: 'PROVIDER' as const };
  const pricing = { inputPerMillion: 4, outputPerMillion: 8, cachedInputPerMillion: 1, perRequest: 0.5 };
  it('输入总数先扣缓存，分别计价再加明确的每次价格', () => expect(estimateUsageAmount(usage, pricing)).toBe(7.75));
  it('未配置价格为null；全空配置也不生成零价', () => {
    expect(estimateUsageAmount(usage, null)).toBeNull();
    expect(estimateUsageAmount(usage, { inputPerMillion: null, outputPerMillion: null, cachedInputPerMillion: null, perRequest: null })).toBeNull();
  });
  it('缺失用量、缓存或单价时不得输出部分计价总额', () => {
    expect(estimateUsageAmount({ ...usage, outputTokens: null }, pricing)).toBeNull();
    expect(estimateUsageAmount({ ...usage, cachedInputTokens: null }, pricing)).toBeNull();
    expect(estimateUsageAmount(usage, { ...pricing, outputPerMillion: null })).toBeNull();
    expect(estimateUsageAmount(usage, { ...pricing, cachedInputPerMillion: null })).toBeNull();
    expect(estimateUsageAmount({ ...usage, cachedInputTokens: 1000001 }, pricing)).toBeNull();
  });
  it('明确每请求价格无需猜测Token，明确零价格有效', () => {
    const absent = { inputTokens: null, outputTokens: null, cachedInputTokens: null, usageSource: 'UNAVAILABLE' as const };
    expect(estimateUsageAmount(absent, { inputPerMillion: null, outputPerMillion: null, cachedInputPerMillion: null, perRequest: 2 })).toBe(2);
    expect(estimateUsageAmount({ ...usage, inputTokens: 0, outputTokens: 0, cachedInputTokens: null }, pricing)).toBe(0.5);
  });
});
