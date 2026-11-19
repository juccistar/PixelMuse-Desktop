import { randomUUID } from "node:crypto";
import { advanceStoryboardRevision } from './versioning.js';
import { assignImageHandles, selectGenerationAssets } from '../execution/visual-assets.js';
import { generationSource, assertVisualGenerationReferences } from '../execution/generation-source.js';
import { compiledUserTemplates } from './projects.js';
import { assertNoImageWork, assertPlanningComplete, assertPlanningItemFresh, currentPlanningItems, hasStoryboardOutput, planningSourceChanged } from '../execution/product-image-planning.js';
import { getProjectImagePlanningState } from '../product-image-planning.js';
import type { JobRecord } from "@ecomgen/core";
import { requestFingerprint } from "@ecomgen/core";
import { getTemplate, isUserTemplateId } from "@ecomgen/ecom-skill";
import { IMAGE_ASPECT_RATIOS, IMAGE_OUTPUT_FORMATS, IMAGE_QUALITIES, IMAGE_RESOLUTIONS } from "@ecomgen/contracts";
import type { ImageAspectRatio, ImageOutputFormat, ImageQuality, ImageResolution, StoryboardMode } from "@ecomgen/contracts";
import { ApiError } from "./support.js";
import { candidatesPerType, clampCandidates, ensureProject, missing, verifyModel } from "./helpers.js";
import { parseBody } from "./support.js";
import { enumValue, readObject, readOptionalText, readText, readTextArray } from "./input-normalizers.js";
import type { Input } from '@ecomgen/contracts';
import { bodyOf, readImageInput, readSingleImageInput, type CommandFlow, type CommandScope } from './support.js';

export function storyboardCommands(ctx: CommandScope) {
const { repository, } = ctx;
return {
getStoryboard: function* (command: Input<'getStoryboard'>): CommandFlow<unknown> {
    const projectId = readText(command.projectId, "projectId");
    ensureProject(repository, projectId);
    return { storyboard: repository.getStoryboard(projectId) ?? null, items: currentPlanningItems(repository.listStoryboardItems(projectId)).map(item => ({ ...item, planningStale: Boolean(item.planningStale || planningSourceChanged(repository, item)) })) };
},
updateStoryboardItem: function* (command: Input<'updateStoryboardItem'>): CommandFlow<unknown> {
    const itemId = readText(command.itemId, "itemId");
    const current = repository.getStoryboardItem(itemId);
    if (!current)
        missing("storyboard item", itemId);
    const body = bodyOf(command, ["itemId"]);
    if (current.planningSuperseded) throw new ApiError('CONFLICT', '历史规划已被替代，请编辑当前规划。');
    if (current.status === "GENERATING") {
        throw new ApiError("CONFLICT", "Generating storyboard items cannot be updated");
    }
    if (current.status === "GENERATED" && (body.assetType !== undefined || body.displayName !== undefined || body.templateVariant !== undefined || body.referencedAssets !== undefined || body.mode !== undefined || body.promptInstruction !== undefined)) {
        throw new ApiError("CONFLICT", "Generated storyboard items only allow generation-setting updates");
    }
    const patch: Record<string, unknown> = {};
    if (body.assetType !== undefined) {
        const templateId = readText(body.assetType, "assetType");
        if (templateId !== current.assetType)
            throw new ApiError("CONFLICT", "Storyboard item image type is immutable");
        if (!current.planningSource && !getTemplate(templateId) && !(isUserTemplateId(templateId) && repository.getUserTemplate(templateId)))
            throw new ApiError("VALIDATION_ERROR", "assetType must be an ecom-details-image template ID");
    }
    if (body.displayName !== undefined)
        patch.displayName = readText(body.displayName, "displayName");
    if (body.templateVariant !== undefined) {
        const template = getTemplate(String(patch.assetType ?? current.assetType));
        const variant = readOptionalText(body.templateVariant) ?? null;
        if (variant && !template?.variants[variant])
            throw new ApiError("VALIDATION_ERROR", "templateVariant is not declared by the selected ecom-details-image template");
        patch.templateVariant = variant;
    }
    if (body.candidateCount !== undefined)
        patch.candidateCount = candidatesPerType(body.candidateCount);
    if (body.imageModel !== undefined) {
        const model = readObject(body.imageModel, "imageModel");
        const providerId = readText(model.providerId, "imageModel.providerId");
        const modelId = readText(model.modelId, "imageModel.modelId");
        verifyModel(repository, providerId, modelId, "image");
        patch.imageProviderId = providerId;
        patch.imageModelId = modelId;
    }
    if (body.imageResolution !== undefined)
        patch.imageResolution = enumValue<ImageResolution>(body.imageResolution, IMAGE_RESOLUTIONS, "imageResolution");
    if (body.imageAspectRatio !== undefined)
        patch.imageAspectRatio = enumValue<ImageAspectRatio>(body.imageAspectRatio, IMAGE_ASPECT_RATIOS, "imageAspectRatio");
    if (body.referencedAssets !== undefined) {
        const ids = readTextArray(body.referencedAssets, "referencedAssets");
        const known = new Set(repository.listAssets(current.projectId).map((asset) => asset.id));
        if (ids.some((id) => !known.has(id)))
            throw new ApiError("VALIDATION_ERROR", "referencedAssets must belong to this project");
        patch.referencedAssets = ids;
    }
    if (body.mode !== undefined)
        patch.mode = enumValue<StoryboardMode>(body.mode, ["CREATIVE", "PIXEL_PROTECTED"], "mode");
    if (body.promptInstruction !== undefined)
        patch.promptInstruction = readText(body.promptInstruction, "promptInstruction");
    const projectAssets = repository.listAssets(current.projectId);
    const skuTruth = current.imagePlanning?.purpose === 'SKU' ? new Set(current.imagePlanning.productAssetIds) : undefined;
    const references = patch.referencedAssets as string[] | undefined ?? current.referencedAssets;
    if (skuTruth && references.some(id => projectAssets.some(asset => asset.id === id && asset.role === 'PRODUCT_TRUTH' && !skuTruth.has(id)))) throw new ApiError('VALIDATION_ERROR', 'SKU分镜只能引用该规格明确选择的商品图。');
    if ((patch.mode ?? current.mode) === 'PIXEL_PROTECTED') {
        const truth = projectAssets.filter(a => a.role === 'PRODUCT_TRUTH' && a.mimeType.startsWith('image/') && (!skuTruth || skuTruth.has(a.id)));
        if (!truth.length || (skuTruth && truth.length !== skuTruth.size)) throw new ApiError('VALIDATION_ERROR', '像素保护需要该规格明确选择的有效商品真值图片。');
        patch.referencedAssets = [...new Set([...references, ...truth.map(a => a.id)])];
    }
    if (current.imagePlanning && current.status !== 'GENERATED') patch.status = 'DRAFT';
    const updated = repository.updateStoryboardItem(itemId, patch);
    advanceStoryboardRevision(ctx,current.projectId);
    return updated as object;
},
deleteStoryboardItem: function* (command: Input<'deleteStoryboardItem'>): CommandFlow<unknown> {
    const itemId = readText(command.itemId, "itemId");
    const current = repository.getStoryboardItem(itemId);
    if (!current)
        missing("storyboard item", itemId);
    if (current.status === "GENERATING" || current.status === "GENERATED") {
        throw new ApiError("CONFLICT", "Generated or generating storyboard items cannot be deleted");
    }
    if (current.imagePlanning) {
        assertNoImageWork(repository, ctx.requestLedger, current.projectId);
        if (current.planningSuperseded || hasStoryboardOutput(repository, current)) throw new ApiError('CONFLICT', '历史画面不能删除。');
        const state = getProjectImagePlanningState(repository, current.projectId);
        repository.saveProjectImagePlanning({ ...state, revision: state.revision + 1, updatedAt: new Date().toISOString(), config: { ...state.config, excludedTargetIds: [...new Set([...(state.config.excludedTargetIds ?? []), current.imagePlanning.targetId])] } });
        repository.updateStoryboardItem(itemId, { planningSuperseded: true });
    } else repository.deleteStoryboardItem(itemId);
    advanceStoryboardRevision(ctx,current.projectId);
    return null;
},
confirmStoryboard: function* (command: Input<'confirmStoryboard'>): CommandFlow<unknown> {
    const projectId = readText(command.projectId, "projectId");
    const storyboard = repository.getStoryboard(projectId);
    if (!storyboard)
        throw new ApiError("CONFLICT", "A draft storyboard must exist before confirmation");
    const body = bodyOf(command, ["projectId"]);
    if (body.version !== storyboard.version) {
        throw new ApiError("CONFLICT", `分镜已被其他修改更新（当前版本 ${storyboard.version}），请刷新后重试`, [{ path: "/version", reason: `expected ${storyboard.version}` }]);
    }
    assertNoImageWork(repository, ctx.requestLedger, projectId);
    assertPlanningComplete(repository, projectId);
    return repository.confirmStoryboard(projectId) as object;
},
createGenerationJobs: function* (command: Input<'createGenerationJobs'>): CommandFlow<unknown> {
    const projectId = readText(command.projectId, "projectId");
    const storyboard = repository.getStoryboard(projectId);
    const body = bodyOf(command, ["projectId"]);
    const productPlanningProject = getProjectImagePlanningState(repository, projectId).revision > 0 || repository.listStoryboardItems(projectId).some(item => item.imagePlanning) || repository.listJobs(projectId).some(job => job.type === 'PLAN' && Boolean(job.input.productImagePlanning));
    const itemIds = readTextArray(body.storyboardItemIds, "storyboardItemIds");
    if (itemIds.length === 0)
        throw new ApiError("VALIDATION_ERROR", "At least one storyboardItemId is required");
    const config = body.generationConfig ?? null;
    const revision = readOptionalText(body.revision);
    const regenerationKey = body.regenerationKey;
    const historicalRegeneration = revision === 'retry' && Boolean(regenerationKey) && itemIds.every(id => {
        const item = repository.getStoryboardItem(id);
        return Boolean(item && item.projectId === projectId && hasStoryboardOutput(repository, item));
    });
    const previousGenerationJobs = regenerationKey ? repository.listJobs(projectId).filter(job => job.type === 'GENERATE') : [];
    const requestedBatchId = readOptionalText(body.generationBatchId);
    const generationBatchId = requestedBatchId ?? (revision === "retry"
        ? repository.listOutputs(projectId).find((output) => itemIds.includes(output.storyboardItemId) && !output.editSessionId)?.generationBatchId ?? randomUUID()
        : randomUUID());
    const overrideResolution = config?.imageResolution === undefined ? undefined : enumValue<ImageResolution>(config.imageResolution, IMAGE_RESOLUTIONS, "generationConfig.imageResolution");
    const overrideAspect = config?.imageAspectRatio === undefined ? undefined : enumValue<ImageAspectRatio>(config.imageAspectRatio, IMAGE_ASPECT_RATIOS, "generationConfig.imageAspectRatio");
    const overrideQuality = config?.quality === undefined ? undefined : enumValue<ImageQuality>(config.quality, IMAGE_QUALITIES, "generationConfig.quality");
    const overrideOutputFormat = config?.outputFormat === undefined ? undefined : enumValue<ImageOutputFormat>(config.outputFormat, IMAGE_OUTPUT_FORMATS, "generationConfig.outputFormat");
    const overrideCandidates = config?.candidateCount === undefined ? undefined : candidatesPerType(config.candidateCount);
    const overrideModel = config?.imageModel;
    const overrideProviderId = overrideModel ? readText(overrideModel.providerId, "generationConfig.imageModel.providerId") : undefined;
    const overrideModelId = overrideModel ? readText(overrideModel.modelId, "generationConfig.imageModel.modelId") : undefined;
    if (overrideProviderId && overrideModelId)
        verifyModel(repository, overrideProviderId, overrideModelId, "image");
    const project = repository.getProject(projectId);
    if (!project)
        missing("project", projectId);
    if (new Set(itemIds).size !== itemIds.length) throw new ApiError('VALIDATION_ERROR','分镜列表不能重复。');
    const assets = repository.listAssets(projectId);
    const handles = assignImageHandles(assets);
    const modelIntent = (providerId: string | null, modelId: string | null) => {
        const provider = providerId ? repository.getProvider(providerId) : undefined;
        return { providerId, modelId, baseUrl: provider?.baseUrl, reasoningProtocol: provider?.reasoningProtocol, model: provider?.models.find(model => model.id === modelId) };
    };
    const plans = itemIds.map((itemId) => {
        const item = repository.getStoryboardItem(itemId);
        if (!item || item.projectId !== projectId)
            throw new ApiError("VALIDATION_ERROR", "Storyboard item does not belong to this project");
        if (item.referencedAssets.some(id => !assets.some(a => a.id === id))) throw new ApiError('VALIDATION_ERROR','分镜引用了缺失或跨项目素材。');
        if (item.imagePlanning?.purpose === 'SKU') {
            const allowed = new Set(item.imagePlanning.productAssetIds);
            if (item.imagePlanning.productAssetIds.some(id => !assets.some(asset => asset.id === id && asset.role === 'PRODUCT_TRUTH' && asset.mimeType.startsWith('image/'))) || item.referencedAssets.some(id => assets.some(asset => asset.id === id && asset.role === 'PRODUCT_TRUTH' && !allowed.has(id)))) throw new ApiError('VALIDATION_ERROR', 'SKU商品图缺失或引用了其他规格商品图。');
        }
        const source = generationSource(item, () => compiledUserTemplates(repository), id => ctx.catalog.resolveShot(id));
        const selectedAssets = source.supportsImageReference ? selectGenerationAssets(assets, item) : [];
        if (item.mode === 'PIXEL_PROTECTED' && !selectedAssets.some(a => a.role === 'PRODUCT_TRUTH')) throw new ApiError('VALIDATION_ERROR','像素保护需要真实商品图及支持图片参考的来源。');
        assertVisualGenerationReferences(item, assets, selectedAssets, handles);
        if (!overrideProviderId || !overrideModelId)
            verifyModel(repository, item.imageProviderId, item.imageModelId, "image");
        const references = selectedAssets.map(asset => ({ id: asset.id, hash: asset.hash, role: asset.role, mimeType: asset.mimeType, originalName: asset.originalName, handle: handles.get(asset.id) }));
        // 只记录业务意图；执行会改写 status、compiledPrompt、updatedAt，不能据此产生新付费任务。
        const intent = {
            assetType: item.assetType, templateVariant: item.templateVariant, mode: item.mode,
            prompt: item.promptInstruction.trim(), references,
            ...(item.imagePlanning ? { imagePlanning: item.imagePlanning } : {}),
            ...(item.planningSource ? { planningSource: item.planningSource } : {}),
            template: source,
            promptRevisionModel: revision && revision !== 'retry' ? modelIntent(project.reasoningProviderId, project.reasoningModelId) : null,
        };
        return { item, intent, candidateCount: overrideCandidates ?? clampCandidates(item.candidateCount) };
    });
    const jobs: JobRecord[] = [];
    const created: JobRecord[] = [];
    let planningValidated = false;
    const writeJobs = (() => ctx.transaction(() => {
        for (const { item, intent, candidateCount } of plans) {
            const effectiveProviderId = overrideProviderId ?? item.imageProviderId;
            const effectiveModelId = overrideModelId ?? item.imageModelId;
            let sharedPromptOwnerId: string | undefined;
            for (let index = 0; index < candidateCount; index++) {
                const input = {
                    revision,
                    ...(revision && revision !== 'retry' ? { generationVersion: 2 } : {}),
                    generationBatchId,
                    candidateIndex: index + 1,
                    imageResolution: overrideResolution ?? item.imageResolution,
                    imageAspectRatio: overrideAspect ?? item.imageAspectRatio,
                    quality: overrideQuality,
                    outputFormat: overrideOutputFormat,
                    ...(regenerationKey ? { regenerationKey } : {})
                };
                // retry 仅是元数据；只有用户显式的新 regenerationKey 才表示再生成一张，重放同键仍去重。
                const { generationBatchId: _generationBatchId, ...fingerprintInput } = { ...input, revision: revision === 'retry' ? undefined : revision };
                const fingerprint = requestFingerprint({ type: "GENERATE", projectId, itemId: item.id, intent, model: modelIntent(effectiveProviderId, effectiveModelId), input: fingerprintInput, idempotencyKey: (command as {
                        idempotencyKey?: string;
                    }).idempotencyKey ?? null });
                // 显式同键也保留本地失败任务；再次提交不能把已收完整回执变成新的付费请求。
                const existing = repository.findJobByFingerprint(projectId, fingerprint) ?? previousGenerationJobs.find(job => job.requestFingerprint === fingerprint);
                if (existing) {
                    if (typeof existing.input.sharedPromptOwnerId === 'string') sharedPromptOwnerId = existing.input.sharedPromptOwnerId;
                    jobs.push(existing);
                    continue;
                }
                // 原任务查询不会发新请求；只有建立新意图时才执行项目屏障和规划资格检查。
                if (productPlanningProject) assertNoImageWork(repository, ctx.requestLedger, projectId, { exceptJobIds: created.map(job => job.id) });
                if (!planningValidated) {
                    if (!storyboard || (storyboard.status !== 'CONFIRMED' && !historicalRegeneration))
                        throw new ApiError('CONFLICT', 'Confirm the storyboard before generation');
                    if (!historicalRegeneration) assertPlanningComplete(repository, projectId);
                    planningValidated = true;
                }
                assertPlanningItemFresh(repository, item, historicalRegeneration);
                if (item.status === 'DRAFT' && !historicalRegeneration) throw new ApiError('CONFLICT', '所选分镜尚未确认。');
                {
                    const previous = (regenerationKey ? previousGenerationJobs : repository.listJobs(projectId).filter(job => job.type === 'GENERATE' && !created.some(owned => owned.id === job.id))).filter(job => job.storyboardItemId === item.id);
                    if ((productPlanningProject || regenerationKey) && previous.some(job => job.status === 'QUEUED' || job.status === 'RUNNING'))
                        throw new ApiError('CONFLICT', '此分镜正在生成，请等待当前任务完成。');
                    if (previous.some(job => job.status === 'UNKNOWN' || ctx.requestLedger.hasUnknown(job.id)))
                        throw new ApiError('EXTERNAL_UNKNOWN', '此分镜的生成任务已中断，请先重试或结束该任务。');
                }
                const id = randomUUID();
                if (revision && revision !== 'retry') sharedPromptOwnerId ??= id;
                const job = repository.createJob({ id, projectId, storyboardItemId: item.id, type: "GENERATE", input: { ...input, ...(sharedPromptOwnerId ? { sharedPromptOwnerId } : {}) }, requestFingerprint: fingerprint, providerId: effectiveProviderId, modelId: effectiveModelId, estimatedCost: { status: "UNKNOWN", unit: "provider-defined" } });
                jobs.push(job);
                created.push(job);
            }
        }
    }));
    writeJobs();
    yield ctx.queue(jobs);
    return { jobs };
}
};
}
