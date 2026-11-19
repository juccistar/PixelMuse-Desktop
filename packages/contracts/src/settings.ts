import { Type, type Static } from '@sinclair/typebox';
import { ImageAspectRatio, ImageResolution, PromptLanguage, SEGMENTATION_PROTOCOLS } from '@ecomgen/domain';

const object = { additionalProperties: false } as const;
const Id = Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' });
const ModelId = Type.String({ minLength: 1, maxLength: 512 });
const ModelReference = Type.Object({ providerId: Id, modelId: ModelId }, object);
const SegmentationReference = Type.Object({ ...ModelReference.properties, protocol: Type.Union(SEGMENTATION_PROTOCOLS.map(value => Type.Literal(value))) }, object);
/** 可恢复的业务路由；禁止 URL、查询串、设置页和任意路径。 */
export const WorkspaceRouteSchema = Type.String({ maxLength: 240, pattern: '^/(?:library|suite-forge|models|patterns(?:/[A-Za-z0-9][A-Za-z0-9_-]*)?|pattern-drafts(?:/[A-Za-z0-9][A-Za-z0-9_-]*)?|projects/[A-Za-z0-9][A-Za-z0-9_-]*)?$' });
/** 新项目与尚未配置工作台的初始值，不覆写现有项目或冻结任务。 */
export const ApplicationDefaultsSchema = Type.Object({
  reasoningModel: Type.Union([ModelReference, Type.Null()]),
  imageModel: Type.Union([ModelReference, Type.Null()]),
  segmentationModel: Type.Union([SegmentationReference, Type.Null()]),
  promptLanguage: PromptLanguage,
  copyLanguage: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  imageResolution: ImageResolution,
  imageAspectRatio: ImageAspectRatio,
  candidatesPerType: Type.Integer({ minimum: 1, maximum: 4 }),
  webResearchEnabled: Type.Boolean(),
}, object);
/** 新任务使用的模型运行参数及队列并发上限。 */
export const AiRuntimeSettingsSchema = Type.Object({
  requestTimeoutSeconds: Type.Integer({ minimum: 30, maximum: 1800 }),
  thinkingLevel: Type.Union([Type.Literal('auto'), Type.Literal('off'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
  maxOutputTokens: Type.Integer({ minimum: 512, maximum: 65536 }),
  concurrency: Type.Integer({ minimum: 1, maximum: 16 }),
}, object);
export type AiRuntimeSettings = Static<typeof AiRuntimeSettingsSchema>;
export const DEFAULT_AI_RUNTIME_SETTINGS: AiRuntimeSettings = { requestTimeoutSeconds: 240, thinkingLevel: 'auto', maxOutputTokens: 16384, concurrency: 2 };
/** 应用级设置的完整持久化结构。 */
export const ApplicationSettingsSchema = Type.Object({
  startupPage: Type.Union([Type.Literal('projects'), Type.Literal('last')]),
  interfaceScale: Type.Number({ minimum: 0.8, maximum: 1.3 }),
  taskNotifications: Type.Boolean(),
  lastWorkspaceRoute: Type.Union([WorkspaceRouteSchema, Type.Null()]),
  defaults: ApplicationDefaultsSchema,
  ai: AiRuntimeSettingsSchema,
}, object);
export type ApplicationSettings = Static<typeof ApplicationSettingsSchema>;
export type ApplicationDefaults = Static<typeof ApplicationDefaultsSchema>;
/** 与现有创作业务相同的出厂默认值。 */
export const DEFAULT_APPLICATION_SETTINGS: ApplicationSettings = {
  startupPage: 'projects', interfaceScale: 1, taskNotifications: false, lastWorkspaceRoute: null,
  ai: { ...DEFAULT_AI_RUNTIME_SETTINGS },
  defaults: { reasoningModel: null, imageModel: null, segmentationModel: null, promptLanguage: 'CHINESE', copyLanguage: null, imageResolution: '1K', imageAspectRatio: 'AUTO', candidatesPerType: 1, webResearchEnabled: false },
};
export const applicationSettingsOperations = {
  getApplicationSettings: { input: Type.Object({}, object), output: ApplicationSettingsSchema },
  updateApplicationSettings: { input: Type.Partial(ApplicationSettingsSchema, object), output: ApplicationSettingsSchema },
  getModelConfigurationImpact: {
    input: Type.Object({ providerId: Id, modelId: Type.Optional(ModelId) }, object),
    output: Type.Object({ projectCount: Type.Integer({ minimum: 0 }), activeJobCount: Type.Integer({ minimum: 0 }), defaultRoles: Type.Array(Type.String()) }, object),
  },
} as const;
