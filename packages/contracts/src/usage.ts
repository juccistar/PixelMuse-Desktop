import { Type, type Static } from '@sinclair/typebox';
const object = { additionalProperties: false } as const;
const Text = Type.String({ minLength: 1, maxLength: 512 });
const DateTime = Type.String({ format: 'date-time' });
const nullable = <T extends import('@sinclair/typebox').TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Currency = Type.Union([Type.Literal('USD'), Type.Literal('CNY')]);
const State = Type.Union([Type.Literal('IN_FLIGHT'), Type.Literal('COMPLETED'), Type.Literal('UNKNOWN')]);
const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Rate = nullable(Type.Number({ minimum: 0, maximum: 1_000_000_000 }));
/** 用户明确配置的单价；缺失值不能按零处理。 */
export const ModelPricingSchema = Type.Object({ providerId: Text, modelId: Text, currency: Currency, inputPerMillion: Rate, outputPerMillion: Rate, cachedInputPerMillion: Rate, perRequest: Rate, updatedAt: DateTime }, object);
export type ModelPricing = Static<typeof ModelPricingSchema>;
/** 仅包含可公开的请求与用量快照，不包含请求体、端点或凭据。 */
export const UsageEntrySchema = Type.Object({
  id: Text, jobId: Text, requestKey: Text,
  projectId: nullable(Text), projectName: nullable(Type.String({ maxLength: 1000 })),
  providerId: nullable(Text), providerName: nullable(Type.String({ maxLength: 1000 })), modelId: nullable(Text), purpose: Text,
  state: State, httpStatus: nullable(Type.Integer({ minimum: 100, maximum: 599 })), startedAt: DateTime, completedAt: nullable(DateTime),
  inputTokens: nullable(Count), outputTokens: nullable(Count), cachedInputTokens: nullable(Count),
  usageSource: Type.Union([Type.Literal('PROVIDER'), Type.Literal('UNAVAILABLE')]),
  estimatedAmount: nullable(Type.Number({ minimum: 0 })), currency: nullable(Currency), pricingSnapshot: nullable(ModelPricingSchema),
}, object);
export type UsageEntry = Static<typeof UsageEntrySchema>;
/** 所有统计、明细及导出使用同一筛选口径。 */
export const UsageFilterSchema = Type.Object({ from: Type.Optional(DateTime), to: Type.Optional(DateTime), providerId: Type.Optional(Text), modelId: Type.Optional(Text), projectId: Type.Optional(Text), purpose: Type.Optional(Text), state: Type.Optional(State) }, object);
export type UsageFilter = Static<typeof UsageFilterSchema>;
export const UsageSummarySchema = Type.Object({
  requestCount: Count, completedCount: Count, failedResponseCount: Count, unknownCount: Count, inFlightCount: Count, withUsageCount: Count,
  inputTokens: nullable(Count), outputTokens: nullable(Count), cachedInputTokens: nullable(Count),
  amounts: Type.Array(Type.Object({ currency: Currency, estimatedAmount: Type.Number({ minimum: 0 }), pricedRequests: Count }, object)),
  taskCount: Count, outputCount: Count, historyNote: Type.String(),
}, object);
export type UsageSummary = Static<typeof UsageSummarySchema>;
/** CSV 导出有界，保存由独立原生能力完成。 */
export const usageOperations = {
  listModelPricing: { input: Type.Object({}, object), output: Type.Object({ items: Type.Array(ModelPricingSchema) }, object) },
  setModelPricing: { input: Type.Omit(ModelPricingSchema, ['updatedAt'], object), output: ModelPricingSchema },
  listUsage: { input: Type.Object({ ...UsageFilterSchema.properties, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })) }, object), output: Type.Object({ items: Type.Array(UsageEntrySchema), total: Count }, object) },
  getUsageSummary: { input: UsageFilterSchema, output: UsageSummarySchema },
  exportUsage: { input: UsageFilterSchema, output: Type.Object({ name: Type.String({ minLength: 1, maxLength: 160 }), mimeType: Type.Literal('text/csv'), base64: Type.String({ maxLength: 16 * 1024 * 1024, pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' }) }, object) },
} as const;
