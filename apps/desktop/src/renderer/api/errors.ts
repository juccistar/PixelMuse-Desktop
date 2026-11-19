/** IPC 公开错误只按领域 code 分支；不保留旧网络状态码。 */
export class ApiError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;
  constructor(shape: { code: string; message: string; details?: unknown; requestId?: string }) {
    super(shape.message); this.name = 'ApiError'; this.code = shape.code; this.details = shape.details; this.requestId = shape.requestId;
  }
}
export function isApiError(value: unknown): value is ApiError { return value instanceof ApiError; }
