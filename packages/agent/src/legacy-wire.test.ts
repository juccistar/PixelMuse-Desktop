import { describe, expect, it } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createAgent, type AgentRequestEvidence, type ReasoningModel } from "./runtime.js";
import { PROMPT_REVISION_SCHEMA } from "./structured-output.js";

describe("旧任务的 SDK 请求", () => {
  it.each(["openai-completions", "openai-responses"] as const)("%s 保留旧缓存身份且不添加输出上限", async api => {
    const model: ReasoningModel = {
      id: "test-model", name: "test-model", api, provider: "openai", baseUrl: "https://api.openai.com/v1",
      reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    let body: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      const text = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : "";
      body = JSON.parse(text) as Record<string, unknown>;
      return new Response(JSON.stringify({ error: { message: "fixture" } }), { status: 400, headers: { "content-type": "application/json" } });
    };
    const external = { scope: { jobId: "old-job", signal: new AbortController().signal }, requestKey: "old", fetchForRequest: () => fetcher } as unknown as AgentRequestEvidence;
    const agent = createAgent({ workflow: "COPYWRITE", model, apiKey: "fixture", systemPrompt: "test", tools: [], outputSchema: PROMPT_REVISION_SCHEMA, external });
    const stream = await agent.streamFunction(model, normalizeContext({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }] }), { apiKey: "fixture", sessionId: agent.sessionId });
    for await (const _event of stream) { /* 消费 SDK 错误终态，不发出网络请求。 */ }
    expect(body).toBeDefined();
    expect(body?.prompt_cache_key).toBe(agent.sessionId);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body).not.toHaveProperty("max_output_tokens");
  });
});
