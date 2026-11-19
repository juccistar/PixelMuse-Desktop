import type { StreamFn } from "@earendil-works/pi-agent-core";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { settleRecordedFetch } from "@ecomgen/providers";
import type { AgentRequestEvidence } from "./runtime.js";

const AGENT_TURN_TIMEOUT_MS = 240_000;

/** 为每轮请求设置超时、贯通取消；外部调用未知时禁止自动重发。 */
export function boundedAgentStream(signal?: AbortSignal, timeoutMs = AGENT_TURN_TIMEOUT_MS, external?: AgentRequestEvidence, maxOutputTokens?: number): StreamFn {
  let round = 0;
  const completions = openAICompletionsApi().stream;
  const responses = openAIResponsesApi().stream;
  return (model, context, options) => {
    signal?.throwIfAborted();
    // Agent 的 reasoning 对应完整 stream API 的 reasoningEffort。
    const { reasoning, ...boundedOptions } = options ?? {};
    const inheritedSignal = signal && boundedOptions.signal
      ? AbortSignal.any([signal, boundedOptions.signal])
      : signal ?? boundedOptions.signal;
    // SDK 收到响应头后可能清掉其计时器，持久捕获的计时必须覆盖 SSE 尾部及回执屏障。
    const requestSignal = external
      ? AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(inheritedSignal ? [inheritedSignal] : [])])
      : inheritedSignal;
    requestSignal?.throwIfAborted();
    const fetcher = external?.fetchForRequest(`model:${round++}`, "MODEL", { providerId: model.provider, modelId: model.id });
    const finalOptions = {
      ...boundedOptions,
      ...(reasoning !== undefined ? { reasoningEffort: reasoning } : {}),
      signal: requestSignal,
      timeoutMs,
      maxTokens: maxOutputTokens,
      maxRetries: 0,
      ...(fetcher ? { fetch: fetcher } : {}),
    };
    const source = model.api === "openai-responses"
      ? responses(model, context, finalOptions)
      : completions(model, context, finalOptions);
    if (!fetcher) return source;
    const observed = createAssistantMessageEventStream();
    void (async () => {
      try {
        for await (const event of source) {
          if (event.type === "done" || event.type === "error") {
            try {
              // 只挡住终态：text_delta 可实时观察；工具执行、JSON 修复及付费下一轮必须等 EOF/落库。
              await settleRecordedFetch(fetcher);
              requestSignal?.throwIfAborted();
            } catch (error) {
              const message = event.type === "done" ? event.message : event.error;
              const reason = requestSignal?.aborted ? "aborted" : "error";
              observed.push({ type: "error", reason, error: { ...message, stopReason: reason, errorMessage: error instanceof Error ? error.message : "External request receipt failed" } });
              return;
            }
            observed.push(event);
            return;
          }
          observed.push(event);
        }
        throw new Error("Model stream ended without a terminal event");
      } catch (error) {
        const reason = requestSignal?.aborted ? "aborted" : "error";
        observed.push({ type: "error", reason, error: {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: reason, errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
        } });
      } finally {
        observed.end();
      }
    })();
    return observed;
  };
}
