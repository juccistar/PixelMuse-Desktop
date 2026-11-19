import { Type, type Static } from '@sinclair/typebox';
import { JobStatus, SuitePlanningBlueprintSchema } from '@ecomgen/domain';
import { HistoryJob } from './business-schemas.js';
import { publicSchema } from './public-schema.js';

const uuid = () => Type.String({ format: 'uuid' });
const object = <T extends Record<string, import('@sinclair/typebox').TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
/** 批次只组织既有项目任务；状态与进度始终从各任务计算。 */
export const SuitePlanningBatchEntrySchema = object({
  projectId: uuid(), projectName: Type.String(),
  planJobId: Type.Optional(uuid()), planStatus: Type.Optional(JobStatus), planProgress: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  generationJobIds: Type.Array(uuid()), generationCompleted: Type.Integer({ minimum: 0 }), generationTotal: Type.Integer({ minimum: 0 }),
  sceneCount: Type.Integer({ minimum: 0 }), candidateCount: Type.Integer({ minimum: 1, maximum: 4 }), ready: Type.Boolean(),
  error: Type.Optional(Type.String()),
});
export const SuitePlanningBatchSchema = object({
  id: uuid(), suiteBlueprint: SuitePlanningBlueprintSchema,
  phase: Type.Union([Type.Literal('PLANNING'), Type.Literal('GENERATION')]),
  entries: Type.Array(SuitePlanningBatchEntrySchema, { minItems: 1, maxItems: 60 }),
  createdAt: Type.String({ format: 'date-time' }), updatedAt: Type.String({ format: 'date-time' }),
});
export type SuitePlanningBatch = Static<typeof SuitePlanningBatchSchema>;
export const suitePlanningOperations = {
  getSuitePlanningBlueprint: { input: object({ suiteId: Type.String({ minLength: 1, maxLength: 160 }) }), output: SuitePlanningBlueprintSchema },
  createSuitePlanningBatch: {
    input: object({ regenerationKey: uuid(), suiteBlueprint: SuitePlanningBlueprintSchema, projectIds: Type.Array(uuid(), { minItems: 1, maxItems: 60, uniqueItems: true }), referenceSourceProjectId: Type.Optional(uuid()), userInstruction: Type.Optional(Type.String({ maxLength: 4000 })) }),
    output: SuitePlanningBatchSchema,
  },
  listSuitePlanningBatches: { input: object({}), output: object({ items: Type.Array(SuitePlanningBatchSchema) }) },
  getSuitePlanningBatch: { input: object({ batchId: uuid() }), output: SuitePlanningBatchSchema },
  generateSuitePlanningBatch: { input: object({ batchId: uuid() }), output: SuitePlanningBatchSchema },
  retrySuitePlanningBatch: { input: object({ batchId: uuid() }), output: SuitePlanningBatchSchema },
  createStoryboardSuiteJob: {
    input: object({ projectId: uuid(), name: Type.String({ minLength: 1, maxLength: 60, pattern: '\\S' }), regenerationKey: uuid() }),
    output: publicSchema(HistoryJob),
  },
} as const;
