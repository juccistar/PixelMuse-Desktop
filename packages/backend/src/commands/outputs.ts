import {resourceUrlFor} from '@ecomgen/contracts';
import { randomUUID } from "node:crypto";
import type { LayerExportRecord, LayerPlanRecord } from "@ecomgen/core";
import { requestFingerprint } from "@ecomgen/core";
import { SEGMENTATION_PROTOCOL_CAPABILITIES } from "@ecomgen/contracts";
import { ApiError } from "./support.js";
import { ensureProject, markDomainRecordFailed, missing, readSegmentationModel, verifyCopywritingModel } from "./helpers.js";
import { parseBody } from "./support.js";
import type { Input } from '@ecomgen/contracts';
import { readText } from './input-normalizers.js';
import { bodyOf, readImageInput, readSingleImageInput, type CommandFlow, type CommandScope } from './support.js';
function publicLayerPlan(plan: LayerPlanRecord): object { return { ...plan, error: plan.error ?? undefined }; }
function publicLayerExport(record: LayerExportRecord): object {
    return {
        ...record,
        psdStoragePath: record.psdStoragePath ?? undefined,
        psdDownloadUrl: record.psdStoragePath ? resourceUrlFor({kind:'LAYER_PSD',id:record.id}) : null,
        layerFiles: record.layerFiles?.map((file, index) => ({ name: file.name, kind: file.kind, downloadUrl: resourceUrlFor({kind:'LAYER_FILE',id:record.id,index}) })) ?? null,
        error: record.error ?? undefined,
    };
}
export function outputsCommands(ctx: CommandScope) {
const { repository, } = ctx;
return {
createExportJob: function* (command: Input<'createExportJob'>): CommandFlow<unknown> {
    const projectId = readText(command.projectId, "projectId");
    ensureProject(repository, projectId);
    const body = bodyOf(command, ["projectId"]);
    if (body.outputIds?.some(id => repository.getOutput(id)?.projectId !== projectId)) throw new ApiError('VALIDATION_ERROR','导出图片必须属于此项目。');
    if (body.outputIds && (!body.outputIds.length || new Set(body.outputIds).size !== body.outputIds.length)) throw new ApiError('VALIDATION_ERROR','导出图片列表为空或重复。');
    if (!repository.listOutputs(projectId).length) throw new ApiError('CONFLICT','没有可导出的图片。');
    // 全量导出也冻结确切输出，历史记录不能随项目后续新增图片变化。
    const input = { outputIds: body.outputIds, exportedOutputIds: body.outputIds ?? repository.listOutputs(projectId).map(output => output.id), filenamePrefix: body.filenamePrefix, longImage: body.longImage ?? null };
    const fingerprint = requestFingerprint({ type: "EXPORT", projectId, input, idempotencyKey: (command as {
            idempotencyKey?: string;
        }).idempotencyKey ?? null });
    const existing = repository.findJobByFingerprint(projectId, fingerprint);
    if (existing) {
        const exportRecord = repository.getExportByJobId(existing.id);
        return { job: existing, export: exportRecord ?? null };
    }
    const job = repository.createJob({ id: randomUUID(), projectId, storyboardItemId: null, type: "EXPORT", input, requestFingerprint: fingerprint, estimatedCost: { status: "UNKNOWN", unit: "local-storage" } });
    const exportRecord = repository.createExport({ projectId, jobId: job.id, status: "QUEUED", storagePath: null });
    yield ctx.queue(job);
    return { job, export: exportRecord };
},
getExport: function* (command: Input<'getExport'>): CommandFlow<unknown> {
    const result = repository.getExport(readText(command.exportId, "exportId"));
    if (!result)
        missing("export", readText(command.exportId, "exportId"));
    return result;
},
getLayerPlan: function* (command: Input<'getLayerPlan'>): CommandFlow<unknown> {
    const output = repository.getOutput(readText(command.outputId, "outputId"));
    if (!output)
        missing("output", readText(command.outputId, "outputId"));
    const plan = repository.getLayerPlanByOutput(output.id);
    if (!plan)
        missing("layer plan", output.id);
    return publicLayerPlan(plan);
},
createLayerPlan: function* (command: Input<'createLayerPlan'>): CommandFlow<unknown> {
    const output = repository.getOutput(readText(command.outputId, "outputId"));
    if (!output)
        missing("output", readText(command.outputId, "outputId"));
    const project = repository.getProject(output.projectId);
    if (!project)
        missing("project", output.projectId);
    const body = bodyOf(command, ["outputId"]);
    verifyCopywritingModel(repository,project.reasoningProviderId,project.reasoningModelId);
    const existing = repository.getLayerPlanByOutput(output.id);
    const existingJob = existing ? repository.getJob(existing.jobId) : undefined;
    const sameReasoningModel = existingJob?.providerId === project.reasoningProviderId && existingJob?.modelId === project.reasoningModelId;
    if (existing && existing.status === "SUCCEEDED" && existing.outputHash === output.hash && sameReasoningModel && !body.regenerationKey)
        return publicLayerPlan(existing);
    const input = { outputId: output.id, outputHash: output.hash, regenerationKey: body.regenerationKey ?? null, reasoningProviderId: project.reasoningProviderId ?? null, reasoningModelId: project.reasoningModelId ?? null };
    const fingerprint = requestFingerprint({ type: "LAYER_PLAN", projectId: output.projectId, input, idempotencyKey: (command as {
            idempotencyKey?: string;
        }).idempotencyKey ?? null });
    const duplicate = repository.findJobByFingerprint(output.projectId, fingerprint);
    if (duplicate) {
        const duplicatePlan = repository.getLayerPlanByJobId(duplicate.id);
        if (duplicatePlan)
            return publicLayerPlan(duplicatePlan);
    }
    const job = repository.createJob({ id: randomUUID(), projectId: output.projectId, storyboardItemId: null, type: "LAYER_PLAN", input, requestFingerprint: fingerprint, providerId: project.reasoningProviderId, modelId: project.reasoningModelId, estimatedCost: { status: "UNKNOWN", unit: "provider-defined" } });
    const plan = repository.createLayerPlan({ projectId: output.projectId, outputId: output.id, jobId: job.id, outputHash: output.hash, status: "QUEUED", elements: [], error: null });
    yield ctx.queue(job);
    return publicLayerPlan(plan);
},
getLayerExport: function* (command: Input<'getLayerExport'>): CommandFlow<unknown> {
    const output = repository.getOutput(readText(command.outputId, "outputId"));
    if (!output)
        missing("output", readText(command.outputId, "outputId"));
    const layerExport = repository.getLayerExportByOutput(output.id);
    if (!layerExport)
        missing("layer export", output.id);
    return publicLayerExport(layerExport);
},
listLayerExports: function* (command: Input<'listLayerExports'>): CommandFlow<unknown> {
    const output = repository.getOutput(readText(command.outputId, "outputId"));
    if (!output)
        missing("output", readText(command.outputId, "outputId"));
    return { exports: repository.listLayerExportsByOutput(output.id).map(publicLayerExport) };
},
createLayerExport: function* (command: Input<'createLayerExport'>): CommandFlow<unknown> {
    const output = repository.getOutput(readText(command.outputId, "outputId"));
    if (!output)
        missing("output", readText(command.outputId, "outputId"));
    const project = repository.getProject(output.projectId);
    if (!project)
        missing("project", output.projectId);
    if (!project.segmentationModel)
        throw new ApiError("PROVIDER_NOT_CONFIGURED", "请先在项目设置中选择分割模型");
    const body = bodyOf(command, ["outputId"]);
    const includeBackground = body.includeBackground ?? true;
    const plan = repository.getLayerPlanByOutput(output.id);
    const succeededPlan = plan?.status === "SUCCEEDED" ? plan : null;
    const planId = succeededPlan?.id ?? null;
    if (body.elements.some((element) => element.source === "auto") && body.planId !== planId)
        throw new ApiError("CONFLICT", "识别方案已更新，请重新选择图层元素后再导出");
    if (succeededPlan && succeededPlan.outputHash !== output.hash && body.elements.some(e => e.source === 'auto')) throw new ApiError('CONFLICT','识别方案源图已变更。');
    if (new Set(body.elements.map(e => e.id)).size !== body.elements.length) throw new ApiError('VALIDATION_ERROR','图层元素 ID 不能重复。');
    const planElementIds = new Set(succeededPlan?.elements.map((element) => element.id) ?? []);
    for (const element of body.elements) {
        if (element.bbox && (element.bbox.x + element.bbox.width > 1 || element.bbox.y + element.bbox.height > 1)) throw new ApiError('VALIDATION_ERROR','图层坐标超出图片边界。');
        if (element.source === "manual" && !element.bbox)
            throw new ApiError("VALIDATION_ERROR", `手动元素「${element.name}」缺少画框坐标`);
        if (element.source === "auto" && !planElementIds.has(element.id))
            throw new ApiError("CONFLICT", `元素「${element.name}」不在识别结果中，请先完成图层识别再导出`);
    }
    const segmentation = readSegmentationModel(repository, { providerId: project.segmentationModel.providerId, modelId: project.segmentationModel.modelId });
    const maxLayerElements = SEGMENTATION_PROTOCOL_CAPABILITIES[segmentation.protocol].maxElements;
    if (body.elements.length > maxLayerElements)
        throw new ApiError("VALIDATION_ERROR", `当前分割模型单次最多支持 ${maxLayerElements} 个图层元素，请减少元素后重试`);
    const promptEnById = new Map(succeededPlan?.elements.filter((element) => element.promptEn).map((element) => [element.id, element.promptEn]) ?? []);
    const elements = body.elements.map((element) => (element.source === "auto" && promptEnById.has(element.id) ? { ...element, promptEn: promptEnById.get(element.id) } : element));
    const input = { outputId: output.id, planId, outputHash: output.hash, elements, includeBackground, segmentationProviderId: segmentation.providerId, segmentationModelId: segmentation.modelId, segmentationProtocol: segmentation.protocol };
    const fingerprint = requestFingerprint({ type: "LAYER_EXPORT", projectId: output.projectId, input, idempotencyKey: (command as {
            idempotencyKey?: string;
        }).idempotencyKey ?? null });
    const duplicate = repository.findJobByFingerprint(output.projectId, fingerprint);
    if (duplicate) {
        const duplicateExport = repository.getLayerExportByJobId(duplicate.id);
        if (duplicateExport)
            return { job: duplicate, layerExport: publicLayerExport(duplicateExport) };
    }
    const job = repository.createJob({ id: randomUUID(), projectId: output.projectId, storyboardItemId: null, type: "LAYER_EXPORT", input, requestFingerprint: fingerprint, providerId: project.segmentationModel.providerId, modelId: project.segmentationModel.modelId, estimatedCost: { status: "UNKNOWN", unit: "provider-defined" } });
    const layerExport = repository.createLayerExport({ projectId: output.projectId, outputId: output.id, jobId: job.id, planId, status: "QUEUED", includeBackground, psdStoragePath: null, layerFiles: null, error: null });
    yield ctx.queue(job);
    return { job, layerExport: publicLayerExport(layerExport) };
}
};
}
