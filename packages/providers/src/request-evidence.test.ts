import { afterEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type RequestListener } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EcomRepository, openDatabase, SecretBox, type SqliteDatabase } from "../../core/src/index.js";
import { RequestLedger } from "../../backend/src/runtime/request-ledger.js";
import { RuntimeStore, type FrozenJobSnapshot } from "../../backend/src/runtime/state.js";
import { bindExternalRequests, createRecordedFetch, requestFingerprint, settleRecordedFetch } from "./request-evidence.js";
import { OpenAiCompatibleImageProvider } from "./openai-compatible.js";
import { GeminiImageProvider } from "./gemini.js";
import { FalSegmentationProvider } from "./fal.js";
import { GroundedSamSegmentationProvider } from "./grounded-sam.js";
import { GiteeSam3SegmentationProvider } from "./gitee-sam3.js";
import { SeedreamLayerizeProvider } from "./seedream-layerize.js";

const databases: SqliteDatabase[] = [], servers: Server[] = [], directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const db of databases.splice(0)) { if (db.open) db.close(); }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function fixture(filename = ":memory:", secrets = new SecretBox(randomBytes(32))) {
  const db = openDatabase(filename); databases.push(db);
  const repository = new EcomRepository(db), store = new RuntimeStore(db), ledger = new RequestLedger(store, secrets);
  const add = () => {
    const job = repository.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type: "GENERATE", input: {} });
    const snapshot: FrozenJobSnapshot = { version: 1, jobId: job.id, type: job.type, input: {}, effective: { prompt: "frozen" }, createdAt: new Date().toISOString(), resources: [] };
    store.transaction(() => store.create(job.id, snapshot)); return job.id;
  };
  return { db, ledger, store, secrets, add };
}
async function serve(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local endpoint");
  return `http://127.0.0.1:${address.port}`;
}
const png = Buffer.from("89504e470d0a1a0a", "hex");
const controller = () => new AbortController();

describe("Provider 持久回执与真实本机协议", () => {
  it("下载失败后关闭并重开 SQLite，只回放响应和重试下载，签名 URL 加密保存", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ecomgen-provider-receipt-")); directories.push(directory);
    const filename = join(directory, "isolated.sqlite"); const first = fixture(filename), jobId = first.add();
    let posts = 0, downloads = 0;
    const baseUrl = await serve((request, response) => {
      if (request.method === "POST") { posts++; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ id: "paid-one", data: [{ url: `${baseUrl}/cdn?signature=private-signature` }] })); }
      else { downloads++; if (downloads === 1) { response.writeHead(503); response.end("offline"); } else { response.end(png); } }
    });
    const makeProvider = (f: ReturnType<typeof fixture>) => new OpenAiCompatibleImageProvider({ baseUrl, apiKey: "fake-key", external: bindExternalRequests(f.ledger.forJob(jobId, controller().signal), "candidate:0") });
    await expect(makeProvider(first).generate({ model: "fake-image", prompt: "frozen" })).rejects.toThrow("unreadable");
    expect(first.ledger.summaries(jobId)).toEqual([{ requestKey: "candidate:0:submit", state: "COMPLETED", localState: "PENDING" }]);
    const persisted = (first.db.prepare("SELECT payload FROM desktop_job_runtime WHERE job_id=?").get(jobId) as { payload: string }).payload;
    expect(persisted).not.toContain("private-signature"); expect(persisted).not.toContain(baseUrl);
    first.db.close();
    const restarted = fixture(filename, first.secrets);
    expect((await makeProvider(restarted).generate({ model: "fake-image", prompt: "frozen" })).image).toEqual(png);
    expect({ posts, downloads }).toEqual({ posts: 1, downloads: 2 });
    restarted.store.transaction(() => restarted.ledger.forJob(jobId, controller().signal).committed("candidate:0:submit"));
    expect(restarted.ledger.summaries(jobId)[0]?.localState).toBe("COMMITTED");
  });

  it.each(["openai", "gemini", "fal", "grounded", "gitee", "seedream"] as const)("%s 在业务解析失败前保存原始响应；再次调用不重复 POST", async kind => {
    const f = fixture(), jobId = f.add(); let posts = 0;
    const baseUrl = await serve((_request, response) => { posts++; response.setHeader("content-type", "application/json"); response.end("{broken-response"); });
    const connection = { baseUrl, apiKey: "fake", external: bindExternalRequests(f.ledger.forJob(jobId, controller().signal), "element:0") };
    const run = () => {
      switch (kind) {
        case "openai": return new OpenAiCompatibleImageProvider(connection).generate({ model: "fake", prompt: "frozen" });
        case "gemini": return new GeminiImageProvider(connection).generate({ model: "fake", prompt: "frozen" });
        case "fal": return new FalSegmentationProvider(connection).segment({ imageUrl: "data:image/png;base64,aA==", textPrompt: "cup" });
        case "grounded": return new GroundedSamSegmentationProvider(connection).segment({ imageUrl: "data:image/png;base64,aA==", textPrompt: "cup" });
        case "gitee": return new GiteeSam3SegmentationProvider(connection).segment({ imageUrl: "data:image/png;base64,aA==", textPrompt: "cup" });
        case "seedream": return new SeedreamLayerizeProvider(connection).layerize({ imageUrl: "data:image/png;base64,aA==" });
      }
    };
    await expect(run()).rejects.toThrow(); await expect(run()).rejects.toThrow();
    expect(posts).toBe(1); expect(f.ledger.summaries(jobId)[0]?.state).toBe("COMPLETED");
    expect(Buffer.from(connection.external.scope.receipt("element:0:submit")!.bodyBase64, "base64").toString()).toBe("{broken-response");
  });

  it("同任务不同候选和 SAM 元素使用独立键，不能复用另一输入", async () => {
    const f = fixture(), jobId = f.add(); let posts = 0;
    const baseUrl = await serve((_request, response) => { posts++; response.end(JSON.stringify({ masks: [{ data: png.toString("base64") }] })); });
    const scope = f.ledger.forJob(jobId, controller().signal);
    for (const [key, textPrompt] of [["element:cup", "cup"], ["element:label", "label"]]) {
      const provider = new GroundedSamSegmentationProvider({ baseUrl, apiKey: "fake", external: bindExternalRequests(scope, key!) });
      await provider.segment({ imageUrl: "data:image/png;base64,aA==", textPrompt });
    }
    expect(posts).toBe(2); expect(f.ledger.summaries(jobId).map(value => value.requestKey)).toEqual(["element:cup:submit", "element:label:submit"]);
    const wrong = new GroundedSamSegmentationProvider({ baseUrl, apiKey: "fake", external: bindExternalRequests(scope, "element:cup") });
    await expect(wrong.segment({ imageUrl: "data:image/png;base64,aA==", textPrompt: "different" })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(posts).toBe(2);
  });

  it("完整 Seedream 图层清单在第二层下载失败后仍能回放，无第二次计费", async () => {
    const f = fixture(), jobId = f.add(); let posts = 0, secondLayer = 0;
    const baseUrl = await serve((request, response) => {
      if (request.method === "POST") { posts++; response.end(JSON.stringify({ data: [{ z_index: 0, url: `${baseUrl}/base` }, { z_index: 1, name: "cup", url: `${baseUrl}/layer` }] })); }
      else if (request.url === "/layer" && secondLayer++ === 0) { response.writeHead(503); response.end(); }
      else response.end(png);
    });
    const provider = new SeedreamLayerizeProvider({ baseUrl, apiKey: "fake", external: bindExternalRequests(f.ledger.forJob(jobId, controller().signal), "layerize") });
    const input = { imageUrl: "data:image/png;base64,aA==" };
    await expect(provider.layerize(input)).rejects.toThrow("unreadable");
    expect((await provider.layerize(input)).layers[0]?.name).toBe("cup"); expect(posts).toBe(1);
  });

  it.each([429, 500, 503, 307, 308])("HTTP %s 不重试、不跟随重定向，完整错误响应可以回放", async status => {
    const f = fixture(), jobId = f.add(); let posts = 0;
    const baseUrl = await serve((_request, response) => { posts++; response.writeHead(status, { location: "/redirect" }); response.end("fake error"); });
    const provider = new OpenAiCompatibleImageProvider({ baseUrl, apiKey: "fake", external: bindExternalRequests(f.ledger.forJob(jobId, controller().signal), "candidate") });
    await expect(provider.generate({ model: "fake", prompt: "frozen" })).rejects.toMatchObject({ status });
    await expect(provider.generate({ model: "fake", prompt: "frozen" })).rejects.toMatchObject({ status }); expect(posts).toBe(1);
  });

  it.each(["socket", "sse"])("%s 截断保留 UNKNOWN，原键和新键都不能重发", async kind => {
    const f = fixture(), jobId = f.add(); let posts = 0;
    const baseUrl = await serve((_request, response) => {
      posts++;
      if (kind === "sse") { response.writeHead(200, { "content-type": "text/event-stream" }); response.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'); }
      else { response.writeHead(200, { "content-length": "1000" }); response.write("partial"); setImmediate(() => response.destroy()); }
    });
    const make = (key: string) => createRecordedFetch(f.ledger.forJob(jobId, controller().signal), key, "MODEL");
    await expect(make("model:0")(baseUrl, { method: "POST", body: "frozen" }).then(response => response.text())).rejects.toThrow();
    await expect(make("model:0")(baseUrl, { method: "POST", body: "frozen" })).rejects.toMatchObject({ code: "EXTERNAL_UNKNOWN" });
    await expect(make("model:1")(baseUrl, { method: "POST", body: "frozen" })).rejects.toMatchObject({ code: "EXTERNAL_UNKNOWN" });
    expect(posts).toBe(1); expect(f.ledger.hasUnknown(jobId)).toBe(true);
  });

  it("未以空行结束的 SSE 终态帧不可结算，settlement 和重放均拒绝", async () => {
    const f = fixture(), jobId = f.add(); let posts = 0;
    const baseUrl = await serve((_request, response) => {
      posts++; response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}');
    });
    const recorded = createRecordedFetch(f.ledger.forJob(jobId, controller().signal), "round:0", "MODEL");
    const response = await recorded(baseUrl, { method: "POST" });
    await expect(response.text()).rejects.toThrow("without a terminal event");
    await expect(settleRecordedFetch(recorded)).rejects.toThrow("without a terminal event");
    await expect(recorded(baseUrl, { method: "POST" })).rejects.toMatchObject({ code: "EXTERNAL_UNKNOWN" });
    expect(posts).toBe(1); expect(f.ledger.summaries(jobId)[0]?.state).toBe("UNKNOWN");
  });

  it("取消后才返回的传输响应仍释放流，不会遗留在途请求", async () => {
    const f = fixture(), jobId = f.add(), cancel = controller();
    let release!: (response: Response) => void, entered!: () => void, disposed!: () => void;
    const started = new Promise<void>(resolve => entered = resolve), cancelled = new Promise<void>(resolve => disposed = resolve);
    const transport: typeof fetch = () => { entered(); return new Promise<Response>(resolve => release = resolve); };
    const recorded = createRecordedFetch(f.ledger.forJob(jobId, cancel.signal), "late", "MODEL", undefined, transport);
    const pending = recorded("http://fake.invalid", { method: "POST" });
    const rejected = expect(pending).rejects.toThrow("cancel-late");
    await started; cancel.abort(new Error("cancel-late")); await rejected;
    release(new Response(new ReadableStream<Uint8Array>({ cancel() { disposed(); } })));
    let timer!: ReturnType<typeof setTimeout>;
    try { await Promise.race([cancelled, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Late response was not disposed")), 2000); })]); }
    finally { clearTimeout(timer); }
    await expect(settleRecordedFetch(recorded)).rejects.toThrow("cancel-late");
    expect(f.ledger.summaries(jobId)[0]?.state).toBe("UNKNOWN");
  });

  it("两个并发 SSE 作用域互不混合，完整 SSE 重放不发网络", async () => {
    const f = fixture(), a = f.add(), b = f.add(); let posts = 0;
    const baseUrl = await serve((request, response) => { posts++; response.writeHead(200, { "content-type": "text/event-stream" }); response.write(`data: {"tag":"${request.url}"}\n\n`); setImmediate(() => response.end("data: [DONE]\n\n")); });
    const sa = f.ledger.forJob(a, controller().signal), sb = f.ledger.forJob(b, controller().signal);
    const ra = createRecordedFetch(sa, "round:0", "MODEL"), rb = createRecordedFetch(sb, "round:0", "MODEL");
    const [va, vb] = await Promise.all([ra(baseUrl + "/alpha", { method: "POST" }), rb(baseUrl + "/beta", { method: "POST" })]);
    expect(await va.text()).toContain("alpha"); expect(await vb.text()).toContain("beta");
    expect(await (await ra(baseUrl + "/alpha", { method: "POST" })).text()).not.toContain("beta"); expect(posts).toBe(2);
  });

  it("SSE 在途取消及时收敛 UNKNOWN，即使流忽略 signal", async () => {
    const f = fixture(), jobId = f.add(), cancel = controller(); let cancelled = false;
    let started!: () => void; const ready = new Promise<void>(resolve => started = resolve);
    const transport: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(Buffer.from("data: partial\n\n")); started(); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
    const pending = createRecordedFetch(f.ledger.forJob(jobId, cancel.signal), "round:0", "MODEL", undefined, transport)("http://fake.invalid", { method: "POST" }).then(response => response.text());
    const rejected = expect(pending).rejects.toThrow("user-cancelled"); await ready; cancel.abort(new Error("user-cancelled")); await rejected;
    expect(cancelled).toBe(true); expect(f.ledger.summaries(jobId)[0]?.state).toBe("UNKNOWN");
  });

  it("账本信号取消 CDN 下载时保留已完成响应，不能变成 UNKNOWN", async () => {
    const f = fixture(), jobId = f.add(), cancel = controller(); let started!: () => void; const ready = new Promise<void>(resolve => started = resolve);
    const baseUrl = await serve((request, response) => {
      if (request.method === "POST") response.end(JSON.stringify({ data: [{ url: `${baseUrl}/cdn` }] }));
      else { response.writeHead(200); response.write(png); started(); }
    });
    const provider = new OpenAiCompatibleImageProvider({ baseUrl, apiKey: "fake", external: bindExternalRequests(f.ledger.forJob(jobId, cancel.signal), "candidate") });
    const pending = provider.generate({ model: "fake", prompt: "frozen" }); const rejected = expect(pending).rejects.toThrow();
    await ready; cancel.abort(); await rejected; expect(f.ledger.hasUnknown(jobId)).toBe(false); expect(f.ledger.summaries(jobId)[0]?.state).toBe("COMPLETED");
  });

  it("持久登记失败或预取消时不发送任何请求", async () => {
    const f = fixture(), jobId = f.add(); let calls = 0;
    const network: typeof fetch = async () => { calls++; return new Response("{}"); };
    const cancel = controller(), scope = f.ledger.forJob(jobId, cancel.signal);
    expect(() => f.store.transaction(() => scope.begin({ requestKey: "one", fingerprint: "a".repeat(64), purpose: "MODEL" }))).toThrow();
    const failed = { ...scope, begin() { throw new Error("ledger-write-failed"); } };
    await expect(createRecordedFetch(failed, "failed", "MODEL", undefined, network)("http://fake.invalid")).rejects.toThrow("ledger-write-failed");
    cancel.abort(); await expect(createRecordedFetch(scope, "two", "MODEL", undefined, network)("http://fake.invalid")).rejects.toThrow(); expect(calls).toBe(0);
  });

  it("带参考图的生成及 editImage 均传递显式 watermark，回放保留同一参数", async () => {
    const f = fixture(), jobId = f.add(), scope = f.ledger.forJob(jobId, controller().signal);
    const bodies: string[] = [];
    const baseUrl = await serve((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => { bodies.push(Buffer.concat(chunks).toString()); response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] })); });
    });
    const sourceImage = { data: png, mimeType: "image/png", filename: "source.png" };
    const generate = new OpenAiCompatibleImageProvider({ baseUrl, apiKey: "fake", external: bindExternalRequests(scope, "generate-ref") });
    const edit = new OpenAiCompatibleImageProvider({ baseUrl, apiKey: "fake", external: bindExternalRequests(scope, "edit-ref") });
    const run = async () => {
      await generate.generate({ model: "doubao-seedream-4-0-250828", prompt: "cup", images: [sourceImage], watermark: false });
      await edit.editImage({ model: "doubao-seedream-4-0-250828", prompt: "cup", sourceImage, watermark: false });
    };
    await run(); await run(); expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).toMatch(/name="watermark"\r\n\r\nfalse/);
  });

  it("multipart 指纹忽略随机 boundary，但包含附件字节、文件名和语义 headers", async () => {
    const form = () => { const value = new FormData(); value.set("model", "fake"); value.set("image", new Blob([png], { type: "image/png" }), "image.png"); return value; };
    const a = new Request("http://fake.invalid", { method: "POST", body: form() });
    const b = new Request("http://fake.invalid", { method: "POST", body: form() });
    expect(a.headers.get("content-type")).not.toBe(b.headers.get("content-type"));
    expect(await requestFingerprint(a)).toBe(await requestFingerprint(b));
    expect(await requestFingerprint("http://fake.invalid", { headers: { "openai-project": "one" } })).not.toBe(await requestFingerprint("http://fake.invalid", { headers: { "openai-project": "two" } }));
  });
});
