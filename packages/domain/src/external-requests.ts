import { Type, type Static } from '@sinclair/typebox';

/** 与网络库无关的外部请求标识；每轮/候选/元素必须使用独立稳定键。 */
export const RequestDescriptorSchema = Type.Object({
  requestKey: Type.String({ minLength: 1, maxLength: 240 }),
  fingerprint: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  purpose: Type.Union(['MODEL', 'IMAGE', 'SEGMENTATION', 'SEARCH', 'POLL'].map(value => Type.Literal(value))),
  model: Type.Optional(Type.Object({ providerId: Type.String({ minLength: 1, maxLength: 128 }), modelId: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false })),
}, { additionalProperties: false });
export type RequestDescriptor = Static<typeof RequestDescriptorSchema>;
/** 原始响应只在 Backend 加密保存，先捕获后解码或下载。 */
export const ResponseReceiptSchema = Type.Object({
  status: Type.Integer({ minimum: 100, maximum: 599 }),
  headers: Type.Array(Type.Tuple([Type.String({ maxLength: 8192 }), Type.String({ maxLength: 65536 })]), { maxItems: 200 }),
  bodyBase64: Type.String({ maxLength: 128 * 1024 * 1024 }),
  providerTaskId: Type.Optional(Type.String({ maxLength: 2048 })),
}, { additionalProperties: false });
export type ResponseReceipt = Static<typeof ResponseReceiptSchema>;
/** F 使用 injected fetch；原始回执捕获覆盖 Agent SSE 和图片 JSON，禁止库内部自动重试。 */
export interface ExternalRequestScope {
  readonly jobId: string;
  readonly signal: AbortSignal;
  /** begin 在发送前同步提交；COMPLETED 返回回执，UNKNOWN/IN_FLIGHT 拒绝重发。 */
  begin(descriptor: RequestDescriptor): { replay: ResponseReceipt | null };
  complete(requestKey: string, receipt: ResponseReceipt): void;
  unknown(requestKey: string): void;
  committed(requestKey: string): void;
  receipt(requestKey: string): ResponseReceipt | null;
  /** 捕获 Response 全部字节后才把可读 Response 返回给调用方；下载使用普通 fetch。 */
  fetch(descriptor: RequestDescriptor, input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** 供真正支持流式观察的传输包装：最后一个 chunk 持久化后才报告完成。 */
  capture(descriptor: RequestDescriptor, response: Response): Promise<Response>;
}
