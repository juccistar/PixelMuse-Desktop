import { afterEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { EcomRepository, openDatabase, SecretBox, type SqliteDatabase } from "../../core/src/index.js";
import { RequestLedger } from "../../backend/src/runtime/request-ledger.js";
import { RuntimeStore, type FrozenJobSnapshot } from "../../backend/src/runtime/state.js";
import { bindExternalRequests, settleRecordedFetch, type RequestEvidenceBinding } from "../../providers/src/request-evidence.js";
import { buildReasoningModel } from "../../providers/src/reasoning-profile.js";
import { probeReasoning } from "../../providers/src/reasoning-probe.js";
import { startFullMockProvider, listingReply, storyboardReply, type FullMockProvider, type FullMockOptions } from "../../../scripts/full-mock-provider.mjs";
import { planStoryboard, planImageEdit, reviseImagePrompt, type PlannerInput } from "./planner.js";
import { writeCopywriting } from "./copywriter.js";
import { writeListingCopy } from "./listing-copywriter.js";
import { planLayerElements } from "./layer-planner.js";
import { forgeSuite } from "./suite-forge.js";
import { createAgent, promptAgent, type AgentWorkflow } from "./runtime.js";
import { createPlanningTools } from "./tools.js";
import { PROMPT_REVISION_SCHEMA } from "./structured-output.js";

const databases: SqliteDatabase[] = [], mocks: FullMockProvider[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const mock of mocks.splice(0)) await mock.close();
  for (const db of databases.splice(0)) db.close();
});
/** 用真实响应字节令 SDK 在终态后结束其观察，模拟提前释放 reader；持久捕获仍读原连接。 */
function observeSettlement(binding: RequestEvidenceBinding, reached: () => void): RequestEvidenceBinding {
  return { ...binding, fetchForRequest(...args) {
    const fetcher = binding.fetchForRequest(...args);
    const observed: typeof fetch = async (...request) => {
      const response = await fetcher(...request);
      const reader = response.body!.getReader(), decoder = new TextDecoder();
      let text = "";
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { controller.close(); reader.releaseLock(); return; }
            text += decoder.decode(chunk.value, { stream: true });
            controller.enqueue(chunk.value);
            if (text.includes("data: [DONE]\n\n") || text.includes('"type":"response.completed"')) {
              controller.close(); await reader.cancel(); reader.releaseLock();
            }
          } catch (error) { controller.error(error); }
        },
        async cancel() { await reader.cancel(); reader.releaseLock(); },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    };
    return Object.assign(observed, { settled: async () => { reached(); await settleRecordedFetch(fetcher); } });
  } };
}
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => resolve = done);
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Server gate timed out")), 2000); })]); }
  finally { clearTimeout(timer); }
}
/** 服务端逐帧推进；等待超时只负责失败收敛，不用于安排事件顺序。 */
async function gatedSse(protocol: "openai" | "openai_responses", text: string, followupText?: string) {
  const arrived = gate<ServerResponse>();
  let posts = 0, activeResponse: ServerResponse | undefined;
  const server = createServer((request, response) => {
    posts++; activeResponse = response;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (posts > 1 && followupText !== undefined) {
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: followupText }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      const emit = (type: string, payload: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      if (protocol === "openai") {
        response.write(`data: ${JSON.stringify({ id: "gated-chat", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
      } else {
        emit("response.created", { response: { id: "gated-response", status: "in_progress", output: [] } });
        emit("response.output_item.added", { output_index: 0, item: { id: "gated-message", type: "message", role: "assistant", content: [] } });
        emit("response.content_part.added", { output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        emit("response.output_text.delta", { output_index: 0, content_index: 0, delta: text });
      }
      response.flushHeaders(); arrived.resolve(response);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing local SSE endpoint");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, arrived: arrived.promise,
    get posts() { return posts; }, get response() { return activeResponse; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
    async terminal() {
      const response = await arrived.promise;
      if (protocol === "openai") response.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      else {
        const item = { id: "gated-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
        for (const [type, payload] of [
          ["response.output_text.done", { output_index: 0, content_index: 0, text }],
          ["response.output_item.done", { output_index: 0, item }],
          ["response.completed", { response: { id: "gated-response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }],
        ] as const) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      }
    },
  };
}
async function fixture(protocol: "openai" | "openai_responses" = "openai", options: FullMockOptions = {}) {
  const mock = await startFullMockProvider(options); mocks.push(mock);
  const db = openDatabase(":memory:"); databases.push(db);
  const repository = new EcomRepository(db), store = new RuntimeStore(db), ledger = new RequestLedger(store, new SecretBox(randomBytes(32)));
  const job = repository.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type: "PLAN", input: {} });
  const snapshot: FrozenJobSnapshot = { version: 1, jobId: job.id, type: job.type, input: {}, effective: { prompt: "frozen" }, createdAt: new Date().toISOString(), resources: [] };
  store.transaction(() => store.create(job.id, snapshot));
  const controller = new AbortController(), scope = ledger.forJob(job.id, controller.signal);
  const model = buildReasoningModel({ providerId: "fake-provider", modelId: "fake-model", baseUrl: mock.baseUrl, protocol, supportsVision: true, supportsThinking: false, supportsStructuredOutput: true });
  const control = (prefix: string) => ({ model, apiKey: "fake-key", external: bindExternalRequests(scope, prefix, { providerId: "fake-provider", modelId: "fake-model" }) });
  const image = { type: "image" as const, data: mock.images.image.toString("base64"), mimeType: "image/png" };
  return { mock, db, ledger, store, jobId: job.id, controller, scope, model, control, image };
}
function planInput(f: Awaited<ReturnType<typeof fixture>>): PlannerInput {
  return { ...f.control("plan"), projectName: "isolated cup", productCategory: null, productDescription: null, verifiedFacts: [], prohibitedClaims: [], brandGuidelines: {}, platformTargets: [], targetMarket: null, copyLanguage: null, promptLanguage: "ENGLISH", defaultMode: "CREATIVE", assets: [], planningMode: "MANUAL", requestedTypes: ["hero-image"] };
}

describe("真实 Pi SDK + 本机 HTTP/SSE + Backend 唯一账本", () => {
  it.each(["openai", "openai_responses"] as const)("%s 分镜正进度发生在服务端 EOF 前，期间唯一账本仍为 IN_FLIGHT", async protocol => {
    const f = await fixture(protocol), progress = gate<number>();
    const sse = await gatedSse(protocol, JSON.stringify({ kind: "ecomgen.suite", shots: [{ shotRole: "hero" }] }));
    const input = { ...f.control("live-forge"), model: { ...f.model, baseUrl: sse.baseUrl }, images: [f.image], onShotProgress: (count: number) => { if (count > 0) progress.resolve(count); } };
    const pending = forgeSuite(input);
    void pending.catch(() => undefined);
    try {
      await bounded(sse.arrived);
      expect(await bounded(progress.promise)).toBe(1);
      expect(f.ledger.summaries(f.jobId)).toEqual([{ requestKey: "live-forge:model:0", state: "IN_FLIGHT", localState: "PENDING" }]);
      await sse.terminal();
      (await sse.arrived).end();
      expect((await bounded(pending)).kind).toBe("ecomgen.suite");
      expect(f.ledger.summaries(f.jobId)[0]?.state).toBe("COMPLETED");
      await sse.close();
      await bounded(forgeSuite(input));
      expect(sse.posts).toBe(1);
    } finally { f.controller.abort(); sse.response?.destroy(); await bounded(pending.catch(() => undefined)); }
  });
  it.each([
    ["agent", "openai"], ["agent", "openai_responses"], ["probe", "openai"], ["probe", "openai_responses"],
  ] as const)("%s/%s 实际 SDK 观察流终态后释放仍等待 EOF，不能提前返回成功", async (kind, protocol) => {
    const f = await fixture(protocol), reached = gate();
    const sse = await gatedSse(protocol, kind === "agent" ? '{"kind":"ecomgen.suite","shots":[{"shotRole":"hero"}]}' : "OK");
    const external = observeSettlement(f.control("terminal").external, () => reached.resolve());
    let returned = false;
    const pending = (kind === "agent"
      ? forgeSuite({ ...f.control("terminal"), external, model: { ...f.model, baseUrl: sse.baseUrl }, images: [f.image] })
      : probeReasoning({ providerId: "fake-provider", modelId: "fake-model", baseUrl: sse.baseUrl, protocol, supportsVision: false, supportsThinking: false, apiKey: "fake-key", external }))
      .then(value => { returned = true; return value; });
    void pending.catch(() => undefined);
    try {
      await bounded(sse.arrived); await sse.terminal();
      await bounded(reached.promise);
      expect(returned).toBe(false);
      expect(f.ledger.summaries(f.jobId)[0]?.state).toBe("IN_FLIGHT");
      expect(f.scope.receipt("terminal:" + (kind === "agent" ? "model:0" : "probe"))).toBeNull();
      (await sse.arrived).end();
      await bounded(pending);
      expect(returned).toBe(true); expect(f.ledger.summaries(f.jobId)[0]?.state).toBe("COMPLETED"); expect(sse.posts).toBe(1);
    } finally { f.controller.abort(); sse.response?.destroy(); await bounded(pending.catch(() => undefined)); }
  });

  it.each([
    ["agent", "truncate"], ["agent", "cancel"], ["agent", "write"],
    ["probe", "truncate"], ["probe", "cancel"], ["probe", "write"],
  ] as const)("%s 终态已观察后 %s 失败仍抛错并保留 UNKNOWN，不能重发", async (kind, failure) => {
    const f = await fixture(), reached = gate();
    const sse = await gatedSse("openai", kind === "agent" ? '{"kind":"ecomgen.suite","shots":[{"shotRole":"hero"}]}' : "OK");
    if (failure === "write") f.db.exec(`CREATE TRIGGER fail_receipt BEFORE UPDATE ON desktop_job_runtime
      WHEN EXISTS (SELECT 1 FROM json_each(json_extract(NEW.payload, '$.requests')) WHERE json_extract(value, '$.state') = 'COMPLETED')
      BEGIN SELECT RAISE(ABORT, 'receipt-write-failed'); END`);
    const run = (prefix = "failed-terminal") => {
      const external = observeSettlement(f.control(prefix).external, () => reached.resolve());
      return kind === "agent"
        ? forgeSuite({ ...f.control(prefix), external, model: { ...f.model, baseUrl: sse.baseUrl }, images: [f.image] })
        : probeReasoning({ providerId: "fake-provider", modelId: "fake-model", baseUrl: sse.baseUrl, protocol: "openai", supportsVision: false, supportsThinking: false, apiKey: "fake-key", external });
    };
    const pending = run(), rejected = expect(pending).rejects.toThrow();
    try {
      await bounded(sse.arrived); await sse.terminal(); await bounded(reached.promise);
      expect(f.ledger.summaries(f.jobId)[0]?.state).toBe("IN_FLIGHT");
      if (failure === "cancel") f.controller.abort(new Error("user-cancelled"));
      else if (failure === "truncate") (await sse.arrived).destroy();
      else (await sse.arrived).end();
      await bounded(rejected);
      expect(f.ledger.summaries(f.jobId)[0]?.state).toBe("UNKNOWN");
      // 用新 scope 排除仅仅由已取消的 signal 阻止重发。
      const retryExternal = bindExternalRequests(f.ledger.forJob(f.jobId, new AbortController().signal), "another-prefix");
      await expect(probeReasoning({ providerId: "fake-provider", modelId: "fake-model", baseUrl: sse.baseUrl, protocol: "openai", supportsVision: false, supportsThinking: false, apiKey: "fake-key", external: retryExternal })).rejects.toThrow();
      expect(sse.posts).toBe(1);
    } finally { f.controller.abort(); sse.response?.destroy(); await bounded(pending.catch(() => undefined)); }
  });

  it("业务 JSON 修复及其付费下一轮在首轮完整 EOF/持久化后才执行", async () => {
    const f = await fixture(), reached = gate();
    const sse = await gatedSse("openai", "{invalid-json", JSON.stringify(storyboardReply()));
    const input = { ...planInput(f), model: { ...f.model, baseUrl: sse.baseUrl }, external: observeSettlement(f.control("plan").external, () => reached.resolve()) };
    const pending = planStoryboard(input);
    void pending.catch(() => undefined);
    try {
      await bounded(sse.arrived); await sse.terminal(); await bounded(reached.promise);
      expect(sse.posts).toBe(1);
      expect(f.ledger.summaries(f.jobId)).toEqual([{ requestKey: "plan:model:0", state: "IN_FLIGHT", localState: "PENDING" }]);
      (await sse.arrived).end();
      expect((await bounded(pending)).items).toHaveLength(1);
      expect(sse.posts).toBe(2);
      expect(f.ledger.summaries(f.jobId)).toEqual([
        { requestKey: "plan:model:0", state: "COMPLETED", localState: "PENDING" },
        { requestKey: "plan:model:1", state: "COMPLETED", localState: "PENDING" },
      ]);
    } finally { f.controller.abort(); sse.response?.destroy(); await bounded(pending.catch(() => undefined)); }
  });

  it("工具终态已观察但 EOF 未到时不执行付费搜索，搜索入口可读取首轮持久回执", async () => {
    const f = await fixture(), reached = gate();
    const sse = await gatedSse("openai", "", JSON.stringify({ prompt: "Finished after durable tool receipt" }));
    const external = observeSettlement(f.control("held-tools").external, () => reached.resolve());
    let receiptAtSearch = false;
    const tools = createPlanningTools({ platformTargets: [], targetMarket: null, copyLanguage: null, productCategory: null }, {
      external, sources: [{ id: "tavily", name: "Fake Tavily", kind: "tavily", baseUrl: f.mock.searchUrls.tavily, apiKey: "fake-search-key" }],
      audit: { onSearchStarted() { receiptAtSearch = f.scope.receipt("held-tools:model:0") !== null; }, onSourceAttempt() {} },
    });
    const agent = createAgent({ ...f.control("held-tools"), external, model: { ...f.model, baseUrl: sse.baseUrl }, workflow: "PLAN", systemPrompt: "Research studio lighting then return JSON with a prompt field.", tools, outputSchema: PROMPT_REVISION_SCHEMA });
    const pending = promptAgent(agent, { external }, "Find studio lighting guidance.");
    void pending.catch(() => undefined);
    try {
      const response = await bounded(sse.arrived);
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "held-research", type: "function", function: { name: "research_visual_direction", arguments: JSON.stringify({ query: "soft studio side lighting" }) } }] }, finish_reason: null }] })}\n\n`);
      response.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
      await bounded(reached.promise);
      expect(sse.posts).toBe(1); expect(f.mock.state.counts.tavily).toBe(0);
      expect(receiptAtSearch).toBe(false);
      expect(f.ledger.summaries(f.jobId)).toEqual([{ requestKey: "held-tools:model:0", state: "IN_FLIGHT", localState: "PENDING" }]);
      response.end();
      await bounded(pending);
      expect(agent.state.errorMessage).toBeUndefined();
      expect(receiptAtSearch).toBe(true);
      expect(f.mock.state.counts.tavily).toBe(1); expect(sse.posts).toBe(2);
      const summary = f.ledger.summaries(f.jobId);
      expect(summary.map(value => value.requestKey.split(":")[1])).toEqual(["model", "research", "model"]);
      expect(summary.every(value => value.state === "COMPLETED")).toBe(true);
    } finally { f.controller.abort(); sse.response?.destroy(); await bounded(pending.catch(() => undefined)); }
  });

  it("另一候选可完成自身回执，不等待同任务尚未 EOF 的观察流", async () => {
    const f = await fixture(), progress = gate();
    const sse = await gatedSse("openai", '{"kind":"ecomgen.suite","shots":[{"shotRole":"hero"}]}');
    const pending = forgeSuite({ ...f.control("slow"), model: { ...f.model, baseUrl: sse.baseUrl }, images: [f.image], onShotProgress: count => { if (count > 0) progress.resolve(); } });
    void pending.catch(() => undefined);
    try {
      await bounded(progress.promise);
      expect(await bounded(reviseImagePrompt({ ...f.control("independent"), prompt: "Preserve", revision: "side light" }))).toContain("Preserve");
      expect(f.ledger.summaries(f.jobId).map(request => request.state)).toEqual(["IN_FLIGHT", "COMPLETED"]);
      await sse.terminal(); (await sse.arrived).end(); await bounded(pending);
    } finally { f.controller.abort(); sse.response?.destroy(); await bounded(pending.catch(() => undefined)); }
  });

  it.each(["openai", "openai_responses"] as const)("%s 全部七个业务入口贯通回执，重建工作流可以离线回放", async protocol => {
    const f = await fixture(protocol);
    const run = async () => {
      expect((await planStoryboard(planInput(f))).items).toHaveLength(1);
      expect(await reviseImagePrompt({ ...f.control("revision"), prompt: "Preserve identity", revision: "Use side light" })).toContain("Preserve");
      expect((await planImageEdit({ ...f.control("edit"), message: "Adjust the scene", annotations: {}, hasEditMask: false, hasCanvasExpansion: false, referenceAssets: [], memorySummary: {}, projectFacts: [], sourceImage: f.image })).operation).toBe("SCENE_ADJUST");
      expect((await writeCopywriting({ ...f.control("copy"), target: "PRODUCT_DESCRIPTION", projectName: "cup", productCategory: null, productDescription: null, verifiedFacts: [], prohibitedClaims: [], platformTargets: [], targetMarket: null, copyLanguage: null, assets: [], referenceImages: [f.image] })).content).toContain("产品名称");
      expect((await writeListingCopy({ ...f.control("listing"), platform: "ETSY", patternName: "floral", category: null, sellingPoints: null, mustIncludeWords: null, bannedWords: null, patternImages: [f.image] })).platform).toBe("ETSY");
      expect(await planLayerElements({ ...f.control("layer"), image: f.image })).toHaveLength(2);
      expect((await forgeSuite({ ...f.control("forge"), images: [f.image] })).kind).toBe("ecomgen.suite");
    };
    await run();
    const kind = protocol === "openai" ? "chat" : "responses";
    expect(f.mock.state.counts[kind]).toBe(7);
    expect(f.ledger.summaries(f.jobId)).toHaveLength(7);
    expect(f.ledger.summaries(f.jobId).every(value => value.state === "COMPLETED")).toBe(true);
    await f.mock.close();
    await run(); expect(f.mock.state.counts[kind]).toBe(7);
  });

  it("规划 JSON 修复是一轮独立请求，恢复后两轮均不重新收费", async () => {
    const f = await fixture("openai", { replyForRequest: request => request.kindCall === 1 ? { text: "{invalid-json" } : { json: storyboardReply() } });
    const input = planInput(f);
    expect((await planStoryboard(input)).items).toHaveLength(1);
    expect(f.ledger.summaries(f.jobId).map(value => value.requestKey)).toEqual(["plan:model:0", "plan:model:1"]);
    await f.mock.close(); expect((await planStoryboard(input)).items).toHaveLength(1); expect(f.mock.state.counts.chat).toBe(2);
  });

  it.each(["copy", "listing"] as const)("%s 压缩保持原业务上限，每轮独立持久回执", async kind => {
    const f = await fixture("openai", { replyForRequest: request => {
      if (kind === "copy") return { json: { content: request.kindCall === 1 ? "long".repeat(1100) : "preserve product identity" } };
      return { json: listingReply("ETSY", { title: request.kindCall === 1 ? "long".repeat(100) : "Botanical Floral Art" }) };
    } });
    const run = kind === "copy"
      ? () => writeCopywriting({ ...f.control(kind), target: "PLANNING_INSTRUCTION", projectName: "cup", productCategory: null, productDescription: null, verifiedFacts: [], prohibitedClaims: [], platformTargets: [], targetMarket: null, copyLanguage: null, assets: [], referenceImages: [] })
      : () => writeListingCopy({ ...f.control(kind), platform: "ETSY", patternName: "floral", category: null, sellingPoints: null, mustIncludeWords: null, bannedWords: null, patternImages: [] });
    await run(); expect(f.mock.state.counts.chat).toBe(2); expect(f.ledger.summaries(f.jobId).map(value => value.requestKey)).toEqual([`${kind}:model:0`, `${kind}:model:1`]);
    await f.mock.close(); await run(); expect(f.mock.state.counts.chat).toBe(2);
  });

  it.each(["openai", "openai_responses"] as const)("%s 工具调用→真实搜索→下一模型轮次共享账本，离线回放整条工具链", async protocol => {
    const f = await fixture(protocol, { replyForRequest: request => request.kindCall === 1
      ? { toolCalls: [{ id: "research-one", name: "research_visual_direction", arguments: { query: "soft studio side lighting" } }] }
      : { json: { prompt: "Finished with source guidance" } } });
    const external = f.control("tools").external;
    const run = async () => {
      const tools = createPlanningTools({ platformTargets: [], targetMarket: null, copyLanguage: null, productCategory: null }, { external, sources: [{ id: "tavily", name: "Fake Tavily", kind: "tavily", baseUrl: f.mock.searchUrls.tavily, apiKey: "fake-search-key" }] });
      const agent = createAgent({ ...f.control("tools"), workflow: "PLAN", systemPrompt: "Use research_visual_direction once then return JSON with a prompt field.", tools, outputSchema: PROMPT_REVISION_SCHEMA });
      await promptAgent(agent, { external }, "Find studio lighting guidance and return the final prompt.");
      expect(agent.state.errorMessage).toBeUndefined();
      expect(agent.state.messages.some(message => message.role === "toolResult")).toBe(true);
    };
    await run();
    const summary = f.ledger.summaries(f.jobId);
    expect(summary.map(value => value.requestKey.split(":")[1])).toEqual(["model", "research", "model"]);
    expect(summary.every(value => value.state === "COMPLETED")).toBe(true); expect(f.mock.state.counts.tavily).toBe(1);
    const encrypted = (f.db.prepare("SELECT payload FROM desktop_job_runtime WHERE job_id=?").get(f.jobId) as { payload: string }).payload;
    expect(encrypted).not.toContain("fake-search-key");
    await f.mock.close(); await run(); expect(f.mock.state.counts.tavily).toBe(1);
  });

  it("搜索来源只有收到完整错误后才切换；每个来源独立回执", async () => {
    const f = await fixture("openai", { faults: [{ kind: "brave", fault: { type: "http", status: 503 } }] });
    const external = f.control("research").external;
    const tool = createPlanningTools({ platformTargets: [], targetMarket: null, copyLanguage: null, productCategory: null }, { external, sources: [
      { id: "brave", name: "Brave", kind: "brave", baseUrl: f.mock.searchUrls.brave, apiKey: "fake" },
      { id: "tavily", name: "Tavily", kind: "tavily", baseUrl: f.mock.searchUrls.tavily, apiKey: "fake" },
    ] }).find(value => value.name === "research_visual_direction")!;
    await tool.execute("same-call-id", { query: "studio photography light" });
    expect(f.mock.state.counts.brave).toBe(1); expect(f.mock.state.counts.tavily).toBe(1);
    expect(f.ledger.summaries(f.jobId)).toHaveLength(2);
    await f.mock.close(); await tool.execute("same-call-id", { query: "studio photography light" });
    expect(f.mock.state.counts.brave).toBe(1); expect(f.mock.state.counts.tavily).toBe(1);
  });

  it("搜索请求断连后不能换来源继续调用，也不能换工具 ID 绕过 UNKNOWN", async () => {
    const f = await fixture("openai", { faults: [{ kind: "tavily", fault: { type: "drop" } }] });
    const tool = createPlanningTools({ platformTargets: [], targetMarket: null, copyLanguage: null, productCategory: null }, { external: f.control("research").external, sources: [
      { id: "tavily", name: "Tavily", kind: "tavily", baseUrl: f.mock.searchUrls.tavily, apiKey: "fake" },
      { id: "brave", name: "Brave", kind: "brave", baseUrl: f.mock.searchUrls.brave, apiKey: "fake" },
    ] }).find(value => value.name === "research_visual_direction")!;
    await expect(tool.execute("call-id", { query: "studio photography light" })).rejects.toThrow();
    await expect(tool.execute("new-call-id", { query: "studio photography light" })).rejects.toThrow();
    expect(f.mock.state.counts.tavily).toBe(1); expect(f.mock.state.counts.brave).toBe(0); expect(f.ledger.hasUnknown(f.jobId)).toBe(true);
  });

  it.each(["openai", "openai_responses"] as const)("%s SDK 收到 429 后不执行隐藏重试，错误回执仍持久保存", async protocol => {
    const f = await fixture(protocol); const kind = protocol === "openai" ? "chat" : "responses";
    f.mock.control.failNext(kind, { type: "http", status: 429 });
    const run = () => reviseImagePrompt({ ...f.control("revision"), prompt: "Preserve", revision: "side light" });
    await expect(run()).rejects.toThrow(); await expect(run()).rejects.toThrow();
    expect(f.mock.state.counts[kind]).toBe(1); expect(f.ledger.summaries(f.jobId)[0]?.state).toBe("COMPLETED");
  });

  it.each(["openai", "openai_responses"] as const)("%s SSE 截断不会进入 JSON 修复或自动重发", async protocol => {
    const f = await fixture(protocol); const kind = protocol === "openai" ? "chat" : "responses";
    f.mock.control.failNext(kind, { type: "truncate-sse" });
    await expect(planStoryboard(planInput(f))).rejects.toThrow(); await expect(planStoryboard(planInput(f))).rejects.toThrow();
    expect(f.mock.state.counts[kind]).toBe(1); expect(f.ledger.summaries(f.jobId)).toEqual([{ requestKey: "plan:model:0", state: "UNKNOWN", localState: "PENDING" }]);
  });

  it.each(["openai", "openai_responses"] as const)("%s 真实 SDK 在途取消会退出流并保留 UNKNOWN", async protocol => {
    const f = await fixture(protocol); const kind = protocol === "openai" ? "chat" : "responses";
    f.mock.control.failNext(kind, { type: "hang" });
    const pending = reviseImagePrompt({ ...f.control("revision"), prompt: "Preserve", revision: "side light" });
    const rejected = expect(pending).rejects.toThrow(); await expect.poll(() => f.mock.state.counts[kind]).toBe(1);
    f.controller.abort(new Error("cancelled-by-user")); await rejected;
    expect(f.ledger.hasUnknown(f.jobId)).toBe(true); expect(f.mock.state.counts[kind]).toBe(1);
  });

  it.each(["openai", "openai_responses"] as const)("%s 推理探测可显式绑定持久账本，streamSimple 保留注入 fetch", async protocol => {
    const f = await fixture(protocol);
    const input = { providerId: "fake-provider", modelId: "fake-model", baseUrl: f.mock.baseUrl, protocol, supportsVision: false, supportsThinking: false, apiKey: "fake-key", external: f.control("probe").external };
    expect((await probeReasoning(input)).text).toBe("OK"); await f.mock.close(); expect((await probeReasoning(input)).text).toBe("OK");
    expect(f.ledger.summaries(f.jobId)).toEqual([{ requestKey: "probe:probe", state: "COMPLETED", localState: "PENDING" }]);
  });

  it("并发 Agent 使用不同任务作用域，回复和请求键不会串任务", async () => {
    const [a, b] = await Promise.all([
      fixture("openai", { replies: { revision: { json: { prompt: "Alpha task image prompt" } } } }),
      fixture("openai_responses", { replies: { revision: { json: { prompt: "Beta task image prompt" } } } }),
    ]);
    const run = (f: typeof a) => reviseImagePrompt({ ...f.control("revision"), prompt: "Preserve", revision: "side light" });
    const values = await Promise.all([run(a), run(b)]); expect(values).toEqual(["Alpha task image prompt", "Beta task image prompt"]);
    expect(Buffer.from(a.scope.receipt("revision:model:0")!.bodyBase64, "base64").toString()).not.toContain("Beta task");
    expect(Buffer.from(b.scope.receipt("revision:model:0")!.bodyBase64, "base64").toString()).not.toContain("Alpha task");
  });

  it.each(["PLAN", "COPYWRITE", "EDIT_PLAN", "PROMPT_REVISION", "LAYER_PLAN", "SUITE_FORGE"] as AgentWorkflow[])("%s 预取消不能创建模型请求", async workflow => {
    const f = await fixture(); f.controller.abort();
    expect(() => createAgent({ ...f.control("workflow"), workflow, systemPrompt: "test", tools: [], outputSchema: PROMPT_REVISION_SCHEMA })).toThrow();
    expect(f.mock.state.total).toBe(0); expect(f.ledger.summaries(f.jobId)).toEqual([]);
  });
});
