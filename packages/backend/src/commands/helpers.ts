import { createHash } from "node:crypto";
import sharp from "sharp";
import { EcomRepository, LocalAssetStore, type JobRecord, type LibraryItemRecord, type ModelRecord, type PatternPipelineWithSteps, type PatternRecord, } from "@ecomgen/core";
import { ASSET_ROLES, MAX_CANDIDATES_PER_TYPE, MAX_PRODUCT_IMAGE_ASSETS, MAX_REFERENCE_IMAGE_ASSETS, MAX_TARGET_IMAGE_COUNT, MIN_TARGET_IMAGE_COUNT, SEGMENTATION_PROTOCOLS, roleForUserAssetKind, supportsTransparentBackground, } from "@ecomgen/contracts";
import type { AssetRole, JobType, SegmentationProtocol, UserAssetKind } from "@ecomgen/contracts";
import { ApiError } from "./support.js";
import { parseModelRef } from "./projectPatch.js";
import { enumValue } from "./input-normalizers.js";
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function missing(resource: string, id: string): never { throw new ApiError("NOT_FOUND", `${resource} not found: ${id}`); }
export function ensureProject(repository: EcomRepository, id: string): void { if (!repository.getProject(id))
    missing("project", id); }
export function ensureModel(repository: EcomRepository, id: string): ModelRecord { const model = repository.getModel(id); if (!model)
    missing("model", id); return model; }
export function ensurePattern(repository: EcomRepository, id: string): PatternRecord { const pattern = repository.getPattern(id); if (!pattern)
    missing("pattern", id); return pattern; }
export function ensurePatternPipeline(repository: EcomRepository, id: string): PatternPipelineWithSteps { const pipeline = repository.getPatternPipeline(id); if (!pipeline)
    missing("pattern pipeline", id); return pipeline; }
export function verifyModel(repository: EcomRepository, providerId: string | null, modelId: string | null, kind: "reasoning" | "image"): void { if (!providerId || !modelId)
    throw new ApiError("PROVIDER_NOT_CONFIGURED", "请先在项目设置中选择推理与图片模型"); const provider = repository.getProvider(providerId); if (!provider)
    missing("provider", providerId); const model = provider.models.find((candidate) => candidate.id === modelId); if (!model)
    throw new ApiError("VALIDATION_ERROR", `${kind} model is not declared by the selected provider`); if (kind === 'reasoning' && (model.imageApiKind || model.segmentationProtocol)) throw new ApiError('CAPABILITY_UNSUPPORTED','所选模型不是推理模型'); if (kind === "image" && model.imageApiKind !== 'openai_images' && model.imageApiKind !== 'gemini')
    throw new ApiError("CAPABILITY_UNSUPPORTED", "Selected image model has no image API configured"); }
export function verifyCopywritingModel(repository: EcomRepository, providerId: string | null, modelId: string | null): void {
    verifyModel(repository,providerId,modelId,'reasoning');
    if (!providerId || !modelId)
        throw new ApiError("PROVIDER_NOT_CONFIGURED", "请先在项目设置中选择推理与图片模型");
    const provider = repository.getProvider(providerId);
    if (!provider)
        missing("provider", providerId);
    const model = provider.models.find((candidate) => candidate.id === modelId);
    if (!model)
        throw new ApiError("VALIDATION_ERROR", "Configured reasoning model is not declared by its provider");
    if (!model.supportsVision)
        throw new ApiError("CAPABILITY_UNSUPPORTED", "Selected reasoning model must support Vision for AI copywriting");
}
export function resolveSegmentationModel(repository: EcomRepository, providerId: string | null | undefined, modelId: string | null | undefined, purpose: string, requestedProtocol?: string | null): {
    providerId: string;
    modelId: string;
    protocol: SegmentationProtocol;
} {
    if (!providerId || !modelId)
        throw new ApiError("VALIDATION_ERROR", `${purpose}需要选择分割模型`);
    const provider = repository.getProvider(providerId);
    if (!provider)
        missing("provider", providerId);
    const model = provider.models.find((candidate) => candidate.id === modelId);
    if (!model)
        throw new ApiError("VALIDATION_ERROR", "segmentation model is not declared by the selected provider");
    if (!model.segmentationProtocol)
        throw new ApiError("CAPABILITY_UNSUPPORTED", "Selected segmentation model has no segmentation API configured");
    const requested = requestedProtocol ? enumValue(requestedProtocol, [...SEGMENTATION_PROTOCOLS], "protocol") : undefined;
    if (requested && requested !== model.segmentationProtocol)
        throw new ApiError("VALIDATION_ERROR", `protocol must match the model's declared protocol (${model.segmentationProtocol})`);
    if (model.segmentationProtocol === "seedream_layerize")
        throw new ApiError("CAPABILITY_UNSUPPORTED", `${purpose}不支持 Seedream 图层拆分协议，请选择 SAM 类分割模型`);
    return { providerId, modelId, protocol: model.segmentationProtocol };
}
export function assertTransparentBackground(repository: EcomRepository, providerId: string | null | undefined, modelId: string | null | undefined, mode: string | null | undefined): void {
    if (mode !== "TRANSPARENT")
        return;
    const declared = providerId && modelId ? repository.getProvider(providerId)?.models.find((candidate) => candidate.id === modelId) : undefined;
    if (declared && supportsTransparentBackground(declared.id))
        return;
    throw new ApiError("CAPABILITY_UNSUPPORTED", `模型 ${modelId ?? ""} 不支持透明底，请改用 gpt-image-1 / 1.5 / 2 系列，或把底版改成白底`);
}
export function reusableFingerprintedJob(existing: JobRecord, hasProducts: boolean): boolean {
    return existing.status !== "SUCCEEDED" || hasProducts;
}
export function markDomainRecordFailed(repository: EcomRepository, type: JobType, jobId: string): void {
    const error = { code: "QUEUE_UNAVAILABLE", message: "任务已创建但队列暂不可用，请稍后重试" };
    if (type === "LAYER_PLAN") {
        const plan = repository.getLayerPlanByJobId(jobId);
        if (plan)
            repository.updateLayerPlan(plan.id, { status: "FAILED", error });
    }
    if (type === "LAYER_EXPORT") {
        const layerExport = repository.getLayerExportByJobId(jobId);
        if (layerExport)
            repository.updateLayerExport(layerExport.id, { status: "FAILED", error });
    }
    if (type === "PRINT_PACK") {
        const pack = repository.getPrintPackByJobId(jobId);
        if (pack)
            repository.updatePrintPack(pack.id, { status: "FAILED", error });
    }
}
export function contentHash(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }
export async function imageDimensions(content: Buffer): Promise<{
    width: number | null;
    height: number | null;
}> {
    try {
        const metadata = await sharp(content).metadata();
        return { width: metadata.width ?? null, height: metadata.height ?? null };
    }
    catch {
        return { width: null, height: null };
    }
}
export async function renderThumbnail(content: Buffer): Promise<Buffer> {
    return sharp(content).rotate().resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
}
export async function writeThumbnail(storage: LocalAssetStore, hash: string, content: Buffer): Promise<void> {
    try {
        await storage.putThumbnail(hash, await renderThumbnail(content));
    }
    catch {
    }
}
export function mimeForPath(path: string): string { if (path.endsWith(".png"))
    return "image/png"; if (path.endsWith(".jpg") || path.endsWith(".jpeg"))
    return "image/jpeg"; if (path.endsWith(".webp"))
    return "image/webp"; if (path.endsWith(".zip"))
    return "application/zip"; if (path.endsWith(".psd"))
    return "image/vnd.adobe.photoshop"; return "application/octet-stream"; }
export function parseAssetRole(value: unknown): AssetRole {
    if (value === "PRODUCT" || value === "REFERENCE")
        return roleForUserAssetKind(value as UserAssetKind);
    return enumValue<AssetRole>(value, ASSET_ROLES, "role");
}
export function candidatesPerType(value: unknown): number {
    const count = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(count) || count < 1 || count > MAX_CANDIDATES_PER_TYPE)
        throw new ApiError("VALIDATION_ERROR", `candidatesPerType must be an integer between 1 and ${MAX_CANDIDATES_PER_TYPE}`);
    return count;
}
export function planningImageCount(value: unknown): number {
    const count = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(count) || count < MIN_TARGET_IMAGE_COUNT || count > MAX_TARGET_IMAGE_COUNT)
        throw new ApiError("VALIDATION_ERROR", `targetImageCount must be an integer between ${MIN_TARGET_IMAGE_COUNT} and ${MAX_TARGET_IMAGE_COUNT}`);
    return count;
}
export function clampCandidates(value: number): number {
    if (!Number.isFinite(value))
        return 1;
    return Math.min(MAX_CANDIDATES_PER_TYPE, Math.max(1, Math.round(value)));
}
export function readSegmentationModel(repository: EcomRepository, value: unknown): {
    providerId: string;
    modelId: string;
    protocol: SegmentationProtocol;
} {
    const ref = parseModelRef(value, "segmentationModel");
    const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const requested = raw.protocol === undefined || raw.protocol === null ? undefined : enumValue(raw.protocol, [...SEGMENTATION_PROTOCOLS], "segmentationModel.protocol");
    const provider = repository.getProvider(ref.providerId);
    if (!provider)
        missing("provider", ref.providerId);
    const model = provider.models.find((candidate) => candidate.id === ref.modelId);
    if (!model)
        throw new ApiError("VALIDATION_ERROR", "segmentation model is not declared by the selected provider");
    if (!model.segmentationProtocol)
        throw new ApiError("CAPABILITY_UNSUPPORTED", "Selected segmentation model has no segmentation API configured");
    if (requested && requested !== model.segmentationProtocol)
        throw new ApiError("VALIDATION_ERROR", `segmentationModel.protocol must match the model's declared protocol (${model.segmentationProtocol})`);
    return { providerId: ref.providerId, modelId: ref.modelId, protocol: model.segmentationProtocol };
}
export function assertProjectAssetCapacity(repository: Pick<EcomRepository, "listAssets">, projectId: string, role: AssetRole): void {
    const assets = repository.listAssets(projectId).filter((asset) => asset.mimeType.startsWith("image/"));
    const limit = role === "PRODUCT_TRUTH" ? MAX_PRODUCT_IMAGE_ASSETS : MAX_REFERENCE_IMAGE_ASSETS;
    const count = assets.filter((asset) => asset.role === role || (role !== "PRODUCT_TRUTH" && asset.role !== "PRODUCT_TRUTH")).length;
    if (count >= limit) {
        const label = role === "PRODUCT_TRUTH" ? "商品图" : "参考图";
        throw new ApiError("VALIDATION_ERROR", `项目最多上传 ${limit} 张${label}`);
    }
}
export function assertProjectAssetHashUnique(repository: Pick<EcomRepository, "listAssets">, projectId: string, hash: string): void {
    if (repository.listAssets(projectId).some((asset) => asset.hash === hash)) {
        throw new ApiError("VALIDATION_ERROR", "相同图片已上传到项目");
    }
}