/// <reference types="node" />

export type MockKind = 'chat' | 'responses' | 'gemini' | 'image-generation' | 'image-edit' | 'models' | 'health' | 'fal' | 'grounded-sam' | 'gitee-sam3' | 'seedream' | 'brave' | 'tavily' | 'searxng' | 'download' | 'unknown';
export type MockWorkflow = 'storyboard' | 'description' | 'planning-copy' | 'revision' | 'edit-plan' | 'layer-plan' | 'listing' | 'suite-forge' | 'probe' | 'unknown';
export interface MockFile { filename: string; mimeType: string; data: Buffer; }
/** 内容仅传入显式回调，永不进入 state/log。回调不得向生产业务写入假成功记录。 */
export interface MockRequestContext {
  kind: MockKind;
  /** 此类请求自启动以来的序号，从 1 开始，包括探测/故障/重复请求。 */
  kindCall: number;
  requestId: number;
  method: string;
  pathname: string;
  query: Record<string, string>;
  json: Record<string, any> | null;
  fields: Record<string, string>;
  files: Record<string, MockFile[]>;
  body: Buffer;
  workflow: MockWorkflow | null;
  payload: Record<string, any>;
  idempotencyKey: string | null;
  /** 请求实际断连或 fixture.close() 时触发；异步回调应尊重此信号。 */
  signal: AbortSignal;
}
export interface MockToolCall { id?: string; name: string; arguments?: Record<string, unknown> | string; }
export interface MockAgentReply {
  /** 原样输出 JSON；便于验证无效业务结果不会被夹具自动修复。 */
  json?: unknown;
  text?: string;
  /** 真实 Pi 工具调用；下一轮 replyForRequest 将看到 role=tool/function_call_output。 */
  toolCalls?: MockToolCall[];
}
export type ReplyValue = MockAgentReply | Record<string, unknown> | string;
export type ReplyFixture = ReplyValue | ((request: MockRequestContext) => ReplyValue | undefined | Promise<ReplyValue | undefined>);
/** http/drop/delay/hang 适用任意 kind 或 *；truncate-sse 仅 chat/responses；
 * empty-mask 仅三种 SAM；download-once 仅 images/fal/seedream；
 * bad-image 适用于生图、分割、Seedream 和 download。不适用的组合立即抛错。 */
export type MockFault =
  | { type: 'http'; status?: number }
  | { type: 'drop' }
  | { type: 'truncate-sse' }
  | { type: 'delay'; ms?: number }
  | { type: 'hang' }
  | { type: 'bad-image' }
  | { type: 'empty-mask' }
  | { type: 'download-once' };
export interface MockFaultRule {
  kind: MockKind | '*';
  /** 首个匹配序号（绝对序号）；之后连续应用 times 次。未设置则下一次匹配。 */
  at?: number;
  times?: number;
  fault: MockFault;
}
export interface FullMockImageOptions {
  /** 默认 48×32，最多 4,000,000 像素；提供 image 时使用其原尺寸。 */
  width?: number;
  height?: number;
  image?: Uint8Array;
  mask?: Uint8Array;
  alpha?: Uint8Array;
  background?: Uint8Array;
}
export interface FullMockImages {
  image: Buffer;
  mask: Buffer;
  alpha: Buffer;
  background: Buffer;
  emptyMask: Buffer;
  width: number;
  height: number;
}
export interface FullMockOptions extends FullMockImageOptions {
  /** Base64 是默认值；Seedream 总是使用本机下载 URL。Gemini 总是 inlineData。 */
  imageMode?: 'base64' | 'url' | 'request';
  /** 默认将分割/编辑样本缩放到内联输入图片尺寸，从不抓取输入 URL。 */
  matchInputSize?: boolean;
  models?: string[];
  /** 优先于 replies；返回 undefined 使用该工作流的 replies 或默认样本。 */
  replyForRequest?: (request: MockRequestContext) => ReplyValue | undefined | Promise<ReplyValue | undefined>;
  replies?: Partial<Record<MockWorkflow, ReplyFixture>>;
  imageForRequest?: (request: MockRequestContext, images: FullMockImages) => Uint8Array | undefined | Promise<Uint8Array | undefined>;
  maskForRequest?: (request: MockRequestContext, images: FullMockImages) => Uint8Array | undefined | Promise<Uint8Array | undefined>;
  layers?: Array<{ name: string; image: Uint8Array; bbox?: [number, number, number, number] }>;
  /** URL 一律替换成当前夹具自己的本地 URL，避免误联网。 */
  searchResults?: Array<{ title: string; description?: string; content?: string }>;
  faults?: MockFaultRule[];
  /** 1..20 MiB，默认 20 MiB，JSON 与 multipart 共同受限。 */
  maxBodyBytes?: number;
  /** 默认 1000，最多 10000。records 为环形窗口；聚合计数不因日志淘汰而清零。 */
  maxRecords?: number;
  /** 默认 1000，最多 10000；达到上限返回 fixture 错误，不淘汰仍可能恢复的回执 URL。 */
  maxDownloads?: number;
  /** 下载缓存总字节上限，默认 128 MiB，最多 256 MiB。 */
  maxDownloadBytes?: number;
}
export interface MockRecord {
  id: number;
  kind: MockKind;
  kindCall: number;
  method: string;
  bodyBytes: number;
  requestHash: string | null;
  /** SHA-256，不保存原始凭据或 Idempotency-Key。 */
  idempotencyKeyHash: string | null;
  status: number | null;
  outcome: 'pending' | 'completed' | 'aborted' | 'server-closed' | 'dropped' | 'truncated';
  fault: MockFault['type'] | null;
  workflow: MockWorkflow | null;
  /** 解析前/解析失败为 null；任何 JSON 属性、表单字段或文件均为 true，不保存名称或内容。 */
  hasParsedInput: boolean | null;
  /** 仅夹具自身的缺少输入校验返回时为 true；注入 HTTP 400/422 不算校验拒绝。 */
  validationRejected: boolean;
}
export interface MockState {
  counts: Record<MockKind, number>;
  records: MockRecord[];
  total: number;
  /** 响应发完的数量，包括可预期 4xx/5xx；不等于业务成功数量。 */
  completed: number;
  /** 服务端观察到的客户端提前断连；不含夹具 close/drop/truncate。 */
  aborted: number;
  serverClosed: number;
  dropped: number;
  hanging: number;
  delayed: number;
  truncated: number;
  downloadFailures: number;
  callbackErrors: number;
  /** SHA-256→次数，最多 maxRecords 个不同键；已有键继续计数。 */
  idempotencyCounts: Record<string, number>;
  /** SHA-256(method+kind+原始 body)→次数；multipart boundary 不同则摘要不同。 */
  requestCounts: Record<string, number>;
  droppedRecords: number;
  active: number;
  closed: boolean;
}
export interface FullMockProvider {
  origin: string;
  /** OpenAI/fal/Grounded/Gitee/Seedream base URL，末尾 /v1。 */
  baseUrl: string;
  /** Gemini native base URL，末尾 /v1beta。 */
  geminiBaseUrl: string;
  searchUrls: Record<'brave' | 'tavily' | 'searxng', string>;
  images: FullMockImages;
  state: MockState;
  control: {
    failNext(kind: MockKind | '*', fault: MockFault): void;
    addFault(rule: MockFaultRule): void;
    clearFaults(): void;
    snapshot(): MockState;
  };
  /** 幂等；关闭挂起 socket、唤醒 delay/回调并释放下载缓存。 */
  close(): Promise<void>;
}
/** 只生成合成图片，不访问旧目录、凭据或真实 Provider。 */
export function createFullMockImages(options?: FullMockImageOptions): Promise<FullMockImages>;
/** 只创建本机协议服务；不启动 Backend/Electron/Redis，不写入业务数据库。 */
export function startFullMockProvider(options?: FullMockOptions): Promise<FullMockProvider>;
export function startFullMockProvider(image: Uint8Array, options?: FullMockOptions): Promise<FullMockProvider>;
export interface StoryboardFixtureOptions {
  items?: Record<string, unknown>[];
  campaignStyleLock?: string;
  assetTypes?: string[];
  suiteShots?: Array<{ assetType: string; shotRole: string; styleLock?: string }>;
  targetImageCount?: number;
  candidateCount?: number;
  referencedAssets?: string[];
  mode?: 'CREATIVE' | 'PIXEL_PROTECTED';
  prompt?: string;
}
export function storyboardReply(options?: StoryboardFixtureOptions): Record<string, unknown>;
export function editPlanReply(variant?: 'clarification' | 'confirmation' | 'no-confirmation', overrides?: Record<string, unknown>): Record<string, unknown>;
export function listingReply(platform?: 'ETSY' | 'AMAZON' | 'TIKTOK_SHOP', overrides?: Record<string, unknown>): Record<string, unknown>;
export function suiteReply(options?: { id?: string; name?: string; shotCount?: number }): Record<string, unknown>;
export function defaultReplyForRequest(request: MockRequestContext): ReplyValue;
