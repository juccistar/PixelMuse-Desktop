import { createHash } from "node:crypto";
import type { ExternalRequestScope, RequestDescriptor, ResponseReceipt } from "@ecomgen/domain";

/** Backend 注入的持久请求作用域；本包不创建数据库或第二份账本。 */
export interface RequestEvidenceBinding {
  readonly scope: ExternalRequestScope;
  readonly requestKey: string;
  fetchForRequest(key: string, purpose: RequestDescriptor["purpose"], model?: RequestDescriptor["model"]): typeof fetch;
}

/** 每候选/元素/工作流使用稳定前缀；恢复时必须使用原前缀和原输入。 */
export function bindExternalRequests(scope: ExternalRequestScope, requestKey: string, model?: RequestDescriptor["model"]): RequestEvidenceBinding {
  if (!requestKey || requestKey.length > 180) throw new Error("External request prefix must contain 1–180 characters");
  return {
    scope, requestKey,
    fetchForRequest: (key, purpose, selectedModel = model) => createRecordedFetch(scope, `${requestKey}:${key}`, purpose, selectedModel),
  };
}

/** 单个 fetch 实例的回执屏障；不等待其他候选或任务的捕获。 */
export type RecordedRequestFetch = typeof fetch & { settled(): Promise<void> };

/** SDK 可提前识别终态，调用方必须在公布结果或进入下一轮前等待完整持久回执。 */
export async function settleRecordedFetch(fetcher?: typeof fetch): Promise<void> {
  await (fetcher as Partial<RecordedRequestFetch> | undefined)?.settled?.();
}

/** SSE 实时提供观察 token；JSON/图片仍在完整回执落库后交付。 */
export function createRecordedFetch(scope: ExternalRequestScope, requestKey: string, purpose: RequestDescriptor["purpose"], model?: RequestDescriptor["model"], transport: typeof fetch = fetch): RecordedRequestFetch {
  const captures: Promise<void>[] = [];
  const recorded: typeof fetch = (input, init) => {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const completed = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    captures.push(completed);
    // 捕获可早于 SDK 消费失败；保留拒绝给屏障，同时避免未处理的 rejection。
    void completed.catch(() => undefined);
    return (async () => {
      const signal = AbortSignal.any([scope.signal, ...(init?.signal ? [init.signal] : []), ...(input instanceof Request ? [input.signal] : [])]);
      let source: Response | undefined, started = false;
      const fail = (error: unknown) => {
        if (started) try { scope.unknown(requestKey); } catch { /* 旧 attempt 不能越过 Backend fencing。 */ }
        if (source?.body && !source.body.locked) void source.body.cancel(error).catch(() => undefined);
        reject(error);
      };
      try {
        signal.throwIfAborted();
        const descriptor: RequestDescriptor = { requestKey, purpose, ...(model ? { model } : {}), fingerprint: await requestFingerprint(input, init) };
        signal.throwIfAborted();
        const { replay } = scope.begin(descriptor);
        if (replay) { resolve(); return receiptResponse(replay); }
        started = true;
        // 禁止自动跟随 307/308，fetch 可能把同一个付费 POST 再发送到另一个地址。
        const pending = transport(input, { ...init, signal, redirect: "manual" });
        // 不配合取消的传输可能在等待已退出后才返回 Response；仍需释放它的流。
        void pending.then(response => {
          if (signal.aborted && response.body && !response.body.locked) void response.body.cancel(signal.reason).catch(() => undefined);
        }, () => undefined);
        source = await abortable(pending, signal);
        if (source.ok && source.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
          let observing = true;
          const original = source;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              // 捕获独立于 SDK 的读取速度；SDK 见到终态后关闭其观察流也不能跳过 EOF。
              void readReceipt(original, signal, chunk => { if (observing) controller.enqueue(chunk); }).then(receipt => {
                assertTerminalSse(Buffer.from(receipt.bodyBase64, "base64").toString("utf8"));
                signal.throwIfAborted();
                scope.complete(requestKey, receipt);
                resolve();
                if (observing) controller.close();
              }).catch(error => {
                fail(error);
                if (observing) controller.error(error);
              });
            },
            cancel() { observing = false; },
          });
          return new Response(body, { status: source.status, headers: source.headers });
        }
        const receipt = await readReceipt(source, signal);
        signal.throwIfAborted();
        scope.complete(requestKey, receipt);
        resolve();
        return receiptResponse(receipt);
      } catch (error) { fail(error); throw error; }
    })();
  };
  return Object.assign(recorded, { settled: async () => { await Promise.all(captures); } });
}

/** multipart 按字段和真实附件字节计算，排除每次随机生成的 boundary。 */
export async function requestFingerprint(input: string | URL | Request, init?: RequestInit): Promise<string> {
  const hash = createHash("sha256");
  const part = (value: string | Uint8Array) => { hash.update(String(Buffer.byteLength(value))); hash.update(":"); hash.update(value); };
  part(input instanceof Request ? input.url : String(input));
  part((init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase());
  // 凭据只进入摘要，不写日志；SDK 的传输统计不属于冻结的业务输入。
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  for (const [name, value] of headers) {
    if (name.startsWith("x-stainless-") || ["user-agent", "connection", "content-length", "accept-encoding"].includes(name)) continue;
    part(name);
    part(name === "content-type" && value.startsWith("multipart/form-data") ? "multipart/form-data" : value);
  }
  const body = init?.body;
  if (body instanceof FormData) {
    for (const [name, value] of body.entries()) {
      part(name);
      if (typeof value === "string") part(value);
      else { part(value.name); part(value.type); part(new Uint8Array(await value.arrayBuffer())); }
    }
  } else if (body !== undefined && body !== null) {
    if (typeof body === "string") part(body);
    else if (body instanceof URLSearchParams) part(body.toString());
    else if (body instanceof Blob) { part(body.type); part(new Uint8Array(await body.arrayBuffer())); }
    else if (body instanceof ArrayBuffer) part(new Uint8Array(body));
    else if (ArrayBuffer.isView(body)) part(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    else throw new Error("Streaming request bodies require a frozen, replayable body");
  } else if (input instanceof Request) {
    if (input.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await input.clone().formData();
      // 使用同一规范化路径，绝不对 multipart 编码后的随机边界做摘要。
      return requestFingerprint(input.url, { method: input.method, headers, body: form });
    }
    part(new Uint8Array(await input.clone().arrayBuffer()));
  }
  return hash.digest("hex");
}

const MAX_RECEIPT_BYTES = 96 * 1024 * 1024;
async function readReceipt(source: Response, signal: AbortSignal, observe?: (chunk: Uint8Array) => void): Promise<ResponseReceipt> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = source.body?.getReader();
  try {
    signal.throwIfAborted();
    if (reader) while (true) {
      const chunk = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RECEIPT_BYTES) throw new Error("Provider response exceeds receipt capacity");
      chunks.push(chunk.value);
      observe?.(chunk.value);
    }
    return { status: source.status, headers: [...source.headers.entries()], bodyBase64: Buffer.concat(chunks).toString("base64") };
  } catch (error) {
    void reader?.cancel(error).catch(() => undefined);
    throw error;
  } finally { reader?.releaseLock(); }
}

function receiptResponse(receipt: ResponseReceipt): Response {
  return new Response([101, 103, 204, 205, 304].includes(receipt.status) ? null : Buffer.from(receipt.bodyBase64, "base64"), { status: receipt.status, headers: receipt.headers });
}

function assertTerminalSse(text: string): void {
  const frames = text.replace(/\r\n?/g, "\n").split("\n\n");
  // 未以空行结束的尾帧不会被 SSE 分派，不能把其半截终态当作可靠回执。
  frames.pop();
  for (const frame of frames) {
    const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (data.trim() === "[DONE]") return;
    try {
      const value = JSON.parse(data) as { type?: string; choices?: Array<{ finish_reason?: string | null }> };
      if (["response.completed", "response.failed", "response.incomplete", "error"].includes(value.type ?? "")) return;
      if (value.choices?.some(choice => typeof choice.finish_reason === "string" && choice.finish_reason.length > 0)) return;
    } catch { /* 心跳和未完成帧不是终态。 */ }
  }
  throw new Error("Provider SSE ended without a terminal event; external result is unknown");
}

/** 即使第三方传输忽略 signal，取消也必须及时结束捕获。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Request aborted"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** 下载/解码尾阶段也继承任务取消，即使调用方只提供账本绑定。 */
export function evidenceSignal(connection: { external?: RequestEvidenceBinding }, signal?: AbortSignal): AbortSignal | undefined {
  return connection.external ? AbortSignal.any([connection.external.scope.signal, ...(signal ? [signal] : [])]) : signal;
}

/** 付费适配器共用入口；CDN 下载和非计费探测不走该入口。 */
export function providerRequest(connection: { external?: RequestEvidenceBinding }, purpose: RequestDescriptor["purpose"], input: string | URL | Request, init: RequestInit): Promise<Response> {
  return connection.external
    ? connection.external.fetchForRequest("submit", purpose)(input, init)
    : fetch(input, { ...init, redirect: "manual" });
}
