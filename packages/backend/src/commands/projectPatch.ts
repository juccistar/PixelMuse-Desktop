import { ApiError } from "./support.js";
export interface ModelRef {
    providerId: string;
    modelId: string;
}
export type VerifyModel = (providerId: string, modelId: string, kind: "reasoning" | "image") => void;
export function parseModelRef(value: unknown, path: string): ModelRef {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ApiError("VALIDATION_ERROR", `${path} must be an object`);
    }
    const record = value as Record<string, unknown>;
    const { providerId, modelId } = record;
    if (typeof providerId !== "string" || !providerId.trim() || typeof modelId !== "string" || !modelId.trim()) {
        throw new ApiError("VALIDATION_ERROR", `${path} must contain non-empty providerId and modelId`);
    }
    return { providerId: providerId.trim(), modelId: modelId.trim() };
}
export function applyModelFields(body: Record<string, unknown>, update: Record<string, unknown>, verify: VerifyModel): void {
    if (body.reasoningModel !== undefined) {
        const ref = parseModelRef(body.reasoningModel, "reasoningModel");
        verify(ref.providerId, ref.modelId, "reasoning");
        update.reasoningProviderId = ref.providerId;
        update.reasoningModelId = ref.modelId;
    }
    if (body.imageModel !== undefined) {
        const ref = parseModelRef(body.imageModel, "imageModel");
        verify(ref.providerId, ref.modelId, "image");
        update.imageProviderId = ref.providerId;
        update.imageModelId = ref.modelId;
    }
}