import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ECOM_TEMPLATES_HASH } from "@ecomgen/ecom-skill";
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgent, promptAgent, promptVersion, type AgentRuntimeOptions, type ReasoningModel } from "./runtime.js";
import { PROMPT_REVISION_SCHEMA } from "./structured-output.js";

const mocks = vi.hoisted(() => ({ completions: vi.fn(), responses: vi.fn() }));
vi.mock("@earendil-works/pi-ai/api/openai-completions.lazy", () => ({ openAICompletionsApi: () => ({ stream: mocks.completions }) }));
vi.mock("@earendil-works/pi-ai/api/openai-responses.lazy", () => ({ openAIResponsesApi: () => ({ stream: mocks.responses }) }));

const model: ReasoningModel = {
  id: "test-model", name: "test-model", api: "openai-completions", provider: "test",
  baseUrl: "https://example.test/v1", reasoning: false, input: ["text"],
  contextWindow: 1000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function abortedMessage(): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason: "aborted", errorMessage: "aborted", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Agent 高级运行参数", () => {
  const base: AgentRuntimeOptions = { workflow: "COPYWRITE", model: { ...model, reasoning: true }, apiKey: "test", systemPrompt: "test", tools: [], outputSchema: PROMPT_REVISION_SCHEMA };

  it("自动思考按工作流选择，显式强度只作用于支持思考的模型", () => {
    expect(createAgent(base).state.thinkingLevel).toBe("low");
    expect(createAgent({ ...base, workflow: "PLAN", thinkingLevel: "auto" }).state.thinkingLevel).toBe("medium");
    expect(createAgent({ ...base, thinkingLevel: "high" }).state.thinkingLevel).toBe("high");
    expect(createAgent({ ...base, thinkingLevel: "off" }).state.thinkingLevel).toBe("off");
    expect(createAgent({ ...base, model, thinkingLevel: "high" }).state.thinkingLevel).toBe("off");
  });

  it.each(["openai-completions", "openai-responses"] as const)("%s 转发输出、超时和思考参数且禁用重试", async api => {
    const implementation = api === "openai-responses" ? mocks.responses : mocks.completions;
    const stream = createAssistantMessageEventStream();
    implementation.mockReset().mockReturnValue(stream);
    const agent = createAgent({ ...base, model: { ...base.model, api }, timeoutMs: 1234, thinkingLevel: "high", maxOutputTokens: 2048 });
    await agent.streamFunction({ ...base.model, api }, normalizeContext({ messages: [] }), { reasoning: "high" });
    expect(implementation).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ timeoutMs: 1234, maxTokens: 2048, reasoningEffort: "high", maxRetries: 0 }));
  });

  it("有效参数改变提示版本", () => {
    const configured = { ...base, thinkingLevel: "auto" as const, maxOutputTokens: 16_384, timeoutMs: 240_000 };
    const original = promptVersion(configured);
    expect(promptVersion({ ...configured, thinkingLevel: "high" })).not.toBe(original);
    expect(promptVersion({ ...configured, maxOutputTokens: 2048 })).not.toBe(original);
    expect(promptVersion({ ...configured, timeoutMs: 1000 })).not.toBe(original);
    expect(promptVersion({ ...configured, timeoutMs: undefined })).toBe(original);
  });

  it("旧冻结任务保留原提示版本和不设输出上限的流参数", async () => {
    const legacyVersion = createHash("sha256").update(JSON.stringify({ systemPrompt: base.systemPrompt, tools: [], outputSchema: base.outputSchema, skillHash: ECOM_TEMPLATES_HASH, api: base.model.api, provider: base.model.provider })).digest("hex").slice(0, 16);
    expect(promptVersion(base)).toBe(legacyVersion);
    expect(promptVersion({ ...base, timeoutMs: 1234 })).toBe(legacyVersion);
    expect(promptVersion({ ...base, thinkingLevel: "auto", maxOutputTokens: 16_384 })).not.toBe(legacyVersion);
    mocks.completions.mockReset().mockReturnValue(createAssistantMessageEventStream());
    const agent = createAgent(base);
    expect(agent.sessionId).toBe(`ecomgen:standalone:COPYWRITE:${legacyVersion}:${base.model.provider}:${base.model.id}`);
    await agent.streamFunction(base.model, normalizeContext({ messages: [] }), {});
    expect(mocks.completions).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ maxTokens: undefined }));
  });
});

describe("真实 Agent 取消边界", () => {
  it.each(["openai-completions", "openai-responses"] as const)("%s 取消传入 stream 并等待 Agent 内部结束，禁止重发", async (api) => {
    const controller = new AbortController();
    const implementation = api === "openai-responses" ? mocks.responses : mocks.completions;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let streamSignal: AbortSignal | undefined;
    implementation.mockReset().mockImplementation((_model, _context, options) => {
      streamSignal = options.signal;
      expect(options.maxRetries).toBe(0);
      expect(options.timeoutMs).toBe(1234);
      const stream = createAssistantMessageEventStream();
      streamSignal?.addEventListener("abort", () => {
        stream.push({ type: "error", reason: "aborted", error: abortedMessage() });
      }, { once: true });
      started();
      return stream;
    });
    const agent = createAgent({ workflow: "PROMPT_REVISION", model: { ...model, api }, apiKey: "test-key", systemPrompt: "test", tools: [], outputSchema: PROMPT_REVISION_SCHEMA, signal: controller.signal, timeoutMs: 1234 });
    const abort = vi.spyOn(agent, "abort");
    const pending = promptAgent(agent, { signal: controller.signal }, "test");
    const rejected = expect(pending).rejects.toThrow("cancelled-by-user");
    await startedPromise;
    controller.abort(new Error("cancelled-by-user"));
    await rejected;
    expect(streamSignal?.aborted).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.signal).toBeUndefined();
    expect(implementation).toHaveBeenCalledTimes(1);
  });

  it("预先取消的工作流在创建 Agent 前失败，不调用上游", () => {
    const controller = new AbortController();
    controller.abort(new Error("already-cancelled"));
    mocks.completions.mockReset();
    expect(() => createAgent({ workflow: "PROMPT_REVISION", model, apiKey: "test-key", systemPrompt: "test", tools: [], outputSchema: PROMPT_REVISION_SCHEMA, signal: controller.signal })).toThrow("already-cancelled");
    expect(mocks.completions).not.toHaveBeenCalled();
  });
});
