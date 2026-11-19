import { Type, type Static } from '@sinclair/typebox';
import { TileableStatus } from '@ecomgen/domain';
import { ResourceHandleSchema } from './resources.js';
const Id = Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' });
/** 已发布桌面的只读结果；绝不返回原始任务输入或私有响应。 */
export const DesktopHistoryResultSchema = Type.Object({
  assetIds: Type.Array(Id, { maxItems: 256, uniqueItems: true }),
  storyboardId: Type.Optional(Id),
  text: Type.Optional(Type.String({ maxLength: 1048576 })),
  tileability: Type.Optional(Type.Object({ status: TileableStatus, score: Type.Number() }, { additionalProperties: false })),
}, { additionalProperties: false });
/** 历史资源保留原身份；缺失或被修改的文件仍可显示为不可用。 */
export const DesktopHistorySchema = Type.Object({
  sourceVersion: Type.Union([Type.Literal(1), Type.Literal(2)]),
  kind: Type.Union(['EXPORT','PLAN','GENERATE','SEGMENT','LAYER','PATTERN','SUITE','PI_AGENT'].map(kind => Type.Literal(kind))),
  originalStatus: Type.Union(['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','UNKNOWN'].map(status => Type.Literal(status))),
  requestState: Type.Union(['NOT_SENT','IN_FLIGHT','COMPLETED','UNKNOWN'].map(state => Type.Literal(state))),
  executable: Type.Literal(false),
  resultStatus: Type.Union([Type.Literal('NONE'), Type.Literal('AVAILABLE'), Type.Literal('UNAVAILABLE')]),
  result: Type.Union([DesktopHistoryResultSchema, Type.Null()]),
  files: Type.Array(Type.Object({ ...ResourceHandleSchema.properties, available: Type.Boolean() }, { additionalProperties: false }), { maxItems: 257 }),
}, { additionalProperties: false });
export type DesktopHistory = Static<typeof DesktopHistorySchema>;
export type DesktopHistoryResult = Static<typeof DesktopHistoryResultSchema>;
