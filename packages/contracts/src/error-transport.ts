import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/** 公开错误只携带可展示消息与领域代码，不传递内部异常信息。 */
export const AppErrorSchema = Type.Object({ code: Type.String(), message: Type.String() }, { additionalProperties: false });
export type AppError = Static<typeof AppErrorSchema>;

/** Error 自定义属性不能跨 contextBridge；此标记载荷仅用于命名 IPC 的拒绝消息。 */
export const PublicErrorTransportSchema = Type.Object({
  kind: Type.Literal('ecomgen.public-error'),
  version: Type.Literal(1),
  error: AppErrorSchema,
}, { additionalProperties: false });
export type PublicErrorTransport = Static<typeof PublicErrorTransportSchema>;

/** 只解码完整匹配公开契约的消息，不从堆栈或任意异常文本中提取载荷。 */
export function decodePublicErrorMessage(message: string): AppError | undefined {
  try {
    const value: unknown = JSON.parse(message);
    if (Value.Check(PublicErrorTransportSchema, value)) return value.error;
  } catch { /* 普通基础设施错误保持原消息。 */ }
  return undefined;
}

/** 损坏的内部传输消息不能作为产品提示直接展示。 */
export function publicErrorDisplayMessage(message: string): string {
  return decodePublicErrorMessage(message)?.message
    ?? (message.startsWith('{"kind":"ecomgen.public-error"') ? '本地后台操作失败' : message);
}
