import { normalizeContext } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

import { ProviderError } from "./openai-compatible.js";
import { buildReasoningModel, type ReasoningModelInput } from "./reasoning-profile.js";
import { evidenceSignal, settleRecordedFetch, type RequestEvidenceBinding } from "./request-evidence.js";

export interface ReasoningProbeInput extends ReasoningModelInput {
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 推理探测会执行模型；若在持久任务中运行则使用同一账本。 */
  external?: RequestEvidenceBinding;
}

export interface ReasoningProbeResult {
  latencyMs: number;
  text: string;
}

export async function probeReasoning(input: ReasoningProbeInput): Promise<ReasoningProbeResult> {
  const inheritedSignal = evidenceSignal(input, input.signal);
  const signal = AbortSignal.any([AbortSignal.timeout(input.timeoutMs ?? 60_000), ...(inheritedSignal ? [inheritedSignal] : [])]);
  signal.throwIfAborted();
  const started = Date.now();
  const model = buildReasoningModel(input);
  const fetcher = input.external?.fetchForRequest("probe", "MODEL", { providerId: input.providerId, modelId: input.modelId });
  const options = { signal, timeoutMs: input.timeoutMs ?? 60_000, maxRetries: 0, apiKey: input.apiKey, maxTokens: 512, ...(input.supportsThinking ? { reasoning: "low" as const } : {}), ...(fetcher ? { fetch: fetcher } : {}) };
  const context = normalizeContext({
    systemPrompt: "Reply with exactly OK.",
    messages: [{ role: "user", content: "Reply with exactly OK.", timestamp: Date.now() }],
  });
  const stream = input.protocol === "openai_responses"
    ? openAIResponsesApi().streamSimple(model, context, options)
    : openAICompletionsApi().streamSimple(model, context, options);
  for await (const event of stream) {
    if (event.type === "done" || event.type === "error") {
      await settleRecordedFetch(fetcher);
      signal?.throwIfAborted();
    }
    if (event.type === "error") throw new ProviderError(event.error.errorMessage ?? "Reasoning probe failed", 502);
    if (event.type === "done") {
      const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
      if (!text) throw new ProviderError("Reasoning probe returned no text", 502);
      return { latencyMs: Date.now() - started, text };
    }
  }
  throw new ProviderError("Reasoning probe stream ended without a final message", 502);
}
