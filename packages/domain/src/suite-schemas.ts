import { Type, type Static } from "@sinclair/typebox";
import { EcomSuiteOrigin, StoryboardShotRole, ImageAspectRatio, ImageResolution } from "./enums.js";
import { schemaRef } from "./ref.js";

/** 套图文档的领域结构，供内置目录、导入与反推共用。 */
export const SuiteCategory = Type.Object({ l1: Type.String({ minLength: 1 }), l2: Type.String({ minLength: 1 }), leaf: Type.String({ minLength: 1 }), leafKeywords: Type.Optional(Type.Array(Type.String())) }, { $id: "#/components/schemas/SuiteCategory" });
export type SuiteCategory = Static<typeof SuiteCategory>;

export const SuitePaletteColor = Type.Object({ name: Type.String({ minLength: 1 }), hex: Type.String({ minLength: 1 }) }, { $id: "#/components/schemas/SuitePaletteColor" });
export type SuitePaletteColor = Static<typeof SuitePaletteColor>;

export const SuiteStyleLock = Type.Object({ direction: Type.Optional(Type.String()), palette: Type.Optional(Type.Array(schemaRef(SuitePaletteColor))), temperature: Type.Optional(Type.String()), backgroundSystem: Type.Optional(Type.String()), lightingSystem: Type.Optional(Type.String()), surfaceSystem: Type.Optional(Type.String()), typography: Type.Optional(Type.String()), iconSystem: Type.Optional(Type.String()), presentationRules: Type.Optional(Type.String()), noDrift: Type.Optional(Type.Array(Type.String())), lockText: Type.String({ minLength: 1, description: "整句风格锁文本，规划时按 {style_lock} 注入每条分镜 Prompt。" }) }, { $id: "#/components/schemas/SuiteStyleLock" });
export type SuiteStyleLock = Static<typeof SuiteStyleLock>;

export const EcomSuiteShot = Type.Object({ purpose: Type.Optional(Type.Union([Type.Literal("MAIN"), Type.Literal("SKU"), Type.Literal("DETAIL")])), shotId: Type.String({ minLength: 1, maxLength: 64 }), order: Type.Integer({ minimum: 1 }), shotRole: schemaRef(StoryboardShotRole), displayName: Type.String({ minLength: 1 }), intent: Type.Optional(Type.String()), assetType: Type.Optional(Type.String({ description: "服务端派生为 <suiteId>::<shotId>，上传文件可省略。" })), mode: Type.Optional(Type.Union([Type.Literal("CREATIVE"), Type.Literal("PIXEL_PROTECTED")])), aspectRatio: Type.Optional(schemaRef(ImageAspectRatio)), resolution: Type.Optional(schemaRef(ImageResolution)), camera: Type.Optional(Type.String()), lighting: Type.Optional(Type.String()), background: Type.Optional(Type.String()), props: Type.Optional(Type.String()), productOccupancy: Type.Optional(Type.String()), whitespace: Type.Optional(Type.String()), textZone: Type.Optional(Type.String()), promptTemplate: Type.String({ minLength: 1 }), supportsImageReference: Type.Optional(Type.Boolean({ default: true })) }, { $id: "#/components/schemas/EcomSuiteShot" });
export type EcomSuiteShot = Static<typeof EcomSuiteShot>;

export const EcomSuiteFile = Type.Object({ referenceAssets: Type.Optional(Type.Array(Type.Object({ projectId: Type.String({ format: "uuid" }), assetId: Type.String({ format: "uuid" }) }, { additionalProperties: false }), { maxItems: 6 })), schemaVersion: Type.Optional(Type.Integer({ minimum: 1, default: 1 })), kind: Type.Optional(Type.Literal("ecomgen.suite", { default: "ecomgen.suite" })), id: Type.Optional(Type.String()), name: Type.String({ minLength: 1, maxLength: 60 }), description: Type.Optional(Type.String({ maxLength: 400 })), category: schemaRef(SuiteCategory), productFamily: Type.Optional(Type.String()), keywords: Type.Optional(Type.Array(Type.String())), styleLock: schemaRef(SuiteStyleLock), shots: Type.Array(schemaRef(EcomSuiteShot), { minItems: 1, maxItems: 12 }), provenance: Type.Optional(Type.Object({ sourceKind: Type.Optional(Type.String()), sourceImageCount: Type.Optional(Type.Integer({ minimum: 0 })), detached: Type.Optional(Type.Boolean()), notes: Type.Optional(Type.String()) })) }, { $id: "#/components/schemas/EcomSuiteFile" });
export type EcomSuiteFile = Static<typeof EcomSuiteFile>;

export const EcomSuiteShotSummary = Type.Object({ shotId: Type.String(), order: Type.Integer(), shotRole: schemaRef(StoryboardShotRole), displayName: Type.String() }, { $id: "#/components/schemas/EcomSuiteShotSummary" });
export type EcomSuiteShotSummary = Static<typeof EcomSuiteShotSummary>;

export const EcomSuiteSummary = Type.Object({ id: Type.String(), name: Type.String(), description: Type.Optional(Type.String()), category: schemaRef(SuiteCategory), productFamily: Type.Optional(Type.String()), shotCount: Type.Integer({ minimum: 1 }), shots: Type.Array(schemaRef(EcomSuiteShotSummary)), origin: schemaRef(EcomSuiteOrigin), createdAt: Type.Optional(Type.String({ format: "date-time" })), updatedAt: Type.Optional(Type.String({ format: "date-time" })) }, { $id: "#/components/schemas/EcomSuiteSummary" });
export type EcomSuiteSummary = Static<typeof EcomSuiteSummary>;

export const EcomSuiteDetail = Type.Intersect([schemaRef(EcomSuiteFile), Type.Object({ origin: schemaRef(EcomSuiteOrigin), createdAt: Type.Optional(Type.String({ format: "date-time" })), updatedAt: Type.Optional(Type.String({ format: "date-time" })) })], { $id: "#/components/schemas/EcomSuiteDetail" });
export type EcomSuiteDetail = Static<typeof EcomSuiteDetail>;

/** 目录库存计数独立于文本/分类过滤，来源切换只影响 total/l1Counts。 */
export const EcomSuiteOriginCounts = Type.Object({ builtin: Type.Integer({ minimum: 0 }), user: Type.Integer({ minimum: 0 }) }, { $id: "#/components/schemas/EcomSuiteOriginCounts" });
export type EcomSuiteOriginCounts = Static<typeof EcomSuiteOriginCounts>;
export const EcomSuitesResponse = Type.Object({ items: Type.Array(schemaRef(EcomSuiteSummary)), nextCursor: Type.Union([Type.String(), Type.Null()]), total: Type.Integer({ minimum: 0 }), l1Counts: Type.Record(Type.String(), Type.Integer({ minimum: 0 })), originCounts: schemaRef(EcomSuiteOriginCounts) }, { $id: "#/components/schemas/EcomSuitesResponse" });
export type EcomSuitesResponse = Static<typeof EcomSuitesResponse>;
export const EcomSuiteCategoriesResponse = Type.Object({ l1: Type.Array(Type.String()), l2: Type.Record(Type.String(), Type.Array(Type.String())) }, { $id: "#/components/schemas/EcomSuiteCategoriesResponse" });
export type EcomSuiteCategoriesResponse = Static<typeof EcomSuiteCategoriesResponse>;

