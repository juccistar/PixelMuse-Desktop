import { Type, type Static } from "@sinclair/typebox";

import { SEGMENTATION_PROTOCOLS } from "./segmentation.js";

// imageApiKind 与 segmentationProtocol 互斥：都不设为推理模型，设 imageApiKind 为生图模型，
// 设 segmentationProtocol 为分割模型（枚举与 SegmentationModelRef.protocol 同源，见 segmentation.ts 注册表）。
export const ModelCapabilities = Type.Object({ supportsVision: Type.Boolean(), supportsThinking: Type.Boolean(), supportsTools: Type.Boolean(), supportsStructuredOutput: Type.Boolean(), imageApiKind: Type.Union([Type.Literal("openai_images"), Type.Literal("gemini"), Type.Literal("custom"), Type.Null()]), segmentationProtocol: Type.Optional(Type.Union(SEGMENTATION_PROTOCOLS.map((protocol) => Type.Literal(protocol)), { description: "Segmentation API protocol declared for this model; mutually exclusive with imageApiKind." })) }, { $id: "#/components/schemas/ModelCapabilities" });
export type ModelCapabilities = Static<typeof ModelCapabilities>;
export const ModelDefinition = Type.Intersect([Type.Object({ id: Type.String({ minLength: 1 }) }), ModelCapabilities], { $id: "#/components/schemas/ModelDefinition" });
export type ModelDefinition = Static<typeof ModelDefinition>;

/** 模型选择始终使用 Provider 与模型的二元引用，不能只保存 Provider ID。 */
export const ModelRef = Type.Object({ providerId: Type.String({ format: 'uuid' }), modelId: Type.String({ minLength: 1 }) }, { $id: '#/components/schemas/ModelRef', additionalProperties: false });
export type ModelRef = Static<typeof ModelRef>;
/** Backend 冻结的模型与凭据版本；仅供执行与 Agent/Provider 端口，不是公开 DTO。 */
export const FrozenModelSelectionSchema = Type.Object({
  ref: ModelRef,
  provider: Type.Object({
    id: Type.String({ format: 'uuid' }), name: Type.String(), baseUrl: Type.String({ minLength: 1 }),
    reasoningProtocol: Type.Union([Type.Literal('openai'), Type.Literal('openai_responses'), Type.Literal('dashscope_qwen')]),
    credentialRevision: Type.String({ minLength: 1 }), sealedCredential: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  definition: ModelDefinition,
}, { additionalProperties: false });
export type FrozenModelSelection = Static<typeof FrozenModelSelectionSchema>;
