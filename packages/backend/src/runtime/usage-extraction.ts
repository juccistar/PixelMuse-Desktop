import type { ResponseReceipt } from '@ecomgen/domain';

/** 只提取协议明示的计量，不从文本、图片数量或 total_tokens 推算。 */
export interface ExtractedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  usageSource: 'PROVIDER' | 'UNAVAILABLE';
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const unavailable = (): ExtractedUsage => ({ inputTokens: null, outputTokens: null, cachedInputTokens: null, usageSource: 'UNAVAILABLE' });

function extract(value: unknown): ExtractedUsage {
  const root = object(value);
  if (!root) return unavailable();
  const response = object(root.response);
  const usage = object(root.usage) ?? object(response?.usage);
  const gemini = object(root.usageMetadata);
  const inputTokens = count(usage?.prompt_tokens) ?? count(usage?.input_tokens) ?? count(gemini?.promptTokenCount);
  const candidates = count(gemini?.candidatesTokenCount);
  const thoughts = gemini && 'thoughtsTokenCount' in gemini ? count(gemini.thoughtsTokenCount) : 0;
  // Gemini 思考输出与候选输出是独立类别；任一明示计数无效或相加溢出时不能部分计价。
  const geminiOutput = candidates !== null && thoughts !== null ? count(candidates + thoughts) : null;
  const outputTokens = count(usage?.completion_tokens) ?? count(usage?.output_tokens) ?? geminiOutput;
  const details = object(usage?.prompt_tokens_details) ?? object(usage?.input_tokens_details);
  const cachedInputTokens = count(details?.cached_tokens) ?? count(usage?.cached_tokens) ?? count(gemini?.cachedContentTokenCount);
  return { inputTokens, outputTokens, cachedInputTokens, usageSource: [inputTokens, outputTokens, cachedInputTokens].some(value => value !== null) ? 'PROVIDER' : 'UNAVAILABLE' };
}

/** SSE 用量是同一请求的累计值；重复最终帧不能相加，损坏的帧不污染其他完整帧。 */
export function extractReceiptUsage(receipt: ResponseReceipt): ExtractedUsage {
  const body = Buffer.from(receipt.bodyBase64, 'base64').toString('utf8');
  const isSse = receipt.headers.some(([key, value]) => key.toLowerCase() === 'content-type' && value.toLowerCase().includes('text/event-stream')) || /^\s*(?:event:|data:)/.test(body);
  if (!isSse) {
    try { return extract(JSON.parse(body)); } catch { return unavailable(); }
  }
  const result = unavailable();
  const geminiMetadata: Record<string, unknown> = {};
  const frames = body.replace(/\r\n?/g, '\n').split('\n\n');
  // SSE 未以空行结束的尾帧不会被适配器分派，不能从这类帧补出用量。
  frames.pop();
  for (const frame of frames) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') continue;
    let usage: ExtractedUsage, metadata: Record<string, unknown> | undefined, declared: Record<string, unknown> | undefined;
    try {
      const value: unknown = JSON.parse(data);
      const frameRoot = object(value);
      declared = object(frameRoot?.usage) ?? object(object(frameRoot?.response)?.usage);
      metadata = object(frameRoot?.usageMetadata);
      if (metadata) {
        // 各类别分别保留最新累计数，再求和；重复帧和分开补充的思考帧都不能重复计数。
        Object.assign(geminiMetadata, metadata);
        usage = extract({ usageMetadata: geminiMetadata });
      } else usage = extract(value);
    } catch { continue; }
    // 部分供应商末帧只补充缓存明细；保留之前已明确返回的计数。
    for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const) if (usage[key] !== null) result[key] = usage[key];
    if (declared) {
      if ('prompt_tokens' in declared || 'input_tokens' in declared) result.inputTokens = usage.inputTokens;
      if ('completion_tokens' in declared || 'output_tokens' in declared) result.outputTokens = usage.outputTokens;
      const details = object(declared.prompt_tokens_details) ?? object(declared.input_tokens_details);
      if ('cached_tokens' in declared || details && 'cached_tokens' in details) result.cachedInputTokens = usage.cachedInputTokens;
    }
    if (metadata) {
      // 明示的累计字段即使无效也替换旧值；不能把旧输入与新输出拼成貌似完整的估算。
      if ('promptTokenCount' in geminiMetadata) result.inputTokens = usage.inputTokens;
      if ('cachedContentTokenCount' in geminiMetadata) result.cachedInputTokens = usage.cachedInputTokens;
      if ('candidatesTokenCount' in geminiMetadata || 'thoughtsTokenCount' in geminiMetadata) result.outputTokens = usage.outputTokens;
    }
    result.usageSource = [result.inputTokens, result.outputTokens, result.cachedInputTokens].some(value => value !== null) ? 'PROVIDER' : 'UNAVAILABLE';
  }
  return result;
}

/** 未提供缓存数量时不可猜测；不完整单价不能形成貌似完整的估算。 */
export function estimateUsageAmount(usage: ExtractedUsage, pricing: {
  inputPerMillion: number | null; outputPerMillion: number | null;
  cachedInputPerMillion: number | null; perRequest: number | null;
} | null): number | null {
  if (!pricing) return null;
  const hasTokenPrice = pricing.inputPerMillion !== null || pricing.outputPerMillion !== null || pricing.cachedInputPerMillion !== null;
  if (!hasTokenPrice) return pricing.perRequest;
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  let amount = pricing.perRequest ?? 0;
  const cached = usage.cachedInputTokens;
  if (cached !== null && cached > usage.inputTokens) return null;
  // 缓存有独立单价时，未知命中量意味着不能计算总额。
  if (pricing.cachedInputPerMillion !== null && cached === null && usage.inputTokens > 0) return null;
  if (usage.inputTokens > 0) {
    if (cached === null) {
      if (pricing.inputPerMillion === null) return null;
      amount += usage.inputTokens * pricing.inputPerMillion / 1e6;
    } else {
      const fresh = usage.inputTokens - cached;
      if (fresh > 0 && pricing.inputPerMillion === null || cached > 0 && pricing.cachedInputPerMillion === null) return null;
      amount += (fresh * (pricing.inputPerMillion ?? 0) + cached * (pricing.cachedInputPerMillion ?? 0)) / 1e6;
    }
  }
  if (usage.outputTokens > 0 && pricing.outputPerMillion === null) return null;
  amount += usage.outputTokens * (pricing.outputPerMillion ?? 0) / 1e6;
  return Number.isFinite(amount) ? amount : null;
}
