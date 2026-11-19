import { Type, type Static } from '@sinclair/typebox';
import { ProjectImagePlanningSchema, ProductImagePlanningConfigSchema, ProjectSkuSchema, SkuImageGroupSchema } from '@ecomgen/domain';
import { HistoryJob } from './business-schemas.js';
import { publicSchema } from './public-schema.js';

export * from '@ecomgen/domain';
/** 项目图片目录的查询、原子保存与规划提交契约。 */
export const GetProjectImagePlanningInputSchema = Type.Object({ projectId: Type.String({ format: 'uuid' }) }, { additionalProperties: false });
export const SaveProjectImagePlanningInputSchema = Type.Object({
  ...GetProjectImagePlanningInputSchema.properties, expectedRevision: Type.Integer({ minimum: 0 }),
  config: ProductImagePlanningConfigSchema, skus: Type.Array(ProjectSkuSchema, { maxItems: 60 }), imageGroups: Type.Array(SkuImageGroupSchema, { maxItems: 60 }),
}, { additionalProperties: false });
export const SaveProjectImagePlanningOutputSchema = Type.Object({ planning: ProjectImagePlanningSchema, staleItemIds: Type.Array(Type.String({ format: 'uuid' })) }, { additionalProperties: false });
export const CreateProductImagePlanningJobInputSchema = Type.Object({
  ...GetProjectImagePlanningInputSchema.properties, expectedRevision: Type.Integer({ minimum: 0 }),
  scope: Type.Optional(Type.Union([Type.Literal('ALL'), Type.Literal('STALE')])), regenerationKey: Type.Optional(Type.String({ format: 'uuid' })),
  userInstruction: Type.Optional(Type.String({ maxLength: 4000 })),
  styleInstruction: Type.Optional(Type.String({ maxLength: 4000 })),
  /** 显式选择共享套图风格图；只复制参考角色，不能成为新商品真值。 */
  referenceSourceProjectId: Type.Optional(Type.String({ format: 'uuid' })),

  planningMode: Type.Optional(Type.Union([Type.Literal('AI'), Type.Literal('MANUAL')])),
  requestedTypes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 96 })),
  requestedSuiteShots: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 96 })),
}, { additionalProperties: false });
export const CreateProductImagePlanningJobOutputSchema = publicSchema(Type.Object({ ...HistoryJob.properties, reused: Type.Boolean() }, { additionalProperties: false }));
/** 查询输出与领域目录使用同一 schema，避免多份手写结构漂移。 */
export const GetProjectImagePlanningOutputSchema = ProjectImagePlanningSchema;
export type GetProjectImagePlanningInput = Static<typeof GetProjectImagePlanningInputSchema>;
export type GetProjectImagePlanningOutput = Static<typeof GetProjectImagePlanningOutputSchema>;
export type SaveProjectImagePlanningInput = Static<typeof SaveProjectImagePlanningInputSchema>;
export type SaveProjectImagePlanningOutput = Static<typeof SaveProjectImagePlanningOutputSchema>;
export type CreateProductImagePlanningJobInput = Static<typeof CreateProductImagePlanningJobInputSchema>;
export type CreateProductImagePlanningJobOutput = Static<typeof CreateProductImagePlanningJobOutputSchema>;
export const productImagePlanningOperations = {
  getProjectImagePlanning: { input: GetProjectImagePlanningInputSchema, output: ProjectImagePlanningSchema },
  saveProjectImagePlanning: { input: SaveProjectImagePlanningInputSchema, output: SaveProjectImagePlanningOutputSchema },
  createProductImagePlanningJob: { input: CreateProductImagePlanningJobInputSchema, output: CreateProductImagePlanningJobOutputSchema },
} as const;
