import {resourceUrlFor} from '@ecomgen/contracts';
import { registerEntries, projectResources } from './resources.js';
import { randomUUID } from "node:crypto";
import type { EcomRepository, LibraryItemRecord } from "@ecomgen/core";
import { requestFingerprint } from "@ecomgen/core";
import { compileUserTemplate, resolveTemplatesWithUser } from "@ecomgen/ecom-skill";
import { DEFAULT_CANDIDATES_PER_TYPE, DEFAULT_IMAGE_ASPECT_RATIO, DEFAULT_IMAGE_RESOLUTION, DEFAULT_TARGET_IMAGE_COUNT, IMAGE_ASPECT_RATIOS, IMAGE_RESOLUTIONS, MODEL_AGES, MODEL_BUILDS, MODEL_GENDERS, MODEL_HERITAGES, MODEL_STATURES, PLATFORM_TARGETS } from "@ecomgen/contracts";
import type { CopywritingTarget, ImageAspectRatio, ImageResolution, LibraryItemKind, PlanningMode, PlatformTarget, PromptLanguage, StoryboardMode, TargetMarket } from "@ecomgen/contracts";
import { ApiError } from "./support.js";
import { UUID_PATTERN, assertProjectAssetCapacity, assertProjectAssetHashUnique, candidatesPerType, contentHash, ensureProject, imageDimensions, missing, parseAssetRole, planningImageCount, readSegmentationModel, verifyCopywritingModel, verifyModel, writeThumbnail, } from "./helpers.js";
import { parseBody } from "./support.js";
import { enumArray, enumValue, objectOfStrings, readBoolean, readOptionalText, readOptionalTextArray, readText, readTextArray, } from "./input-normalizers.js";
import { applyModelFields } from "./projectPatch.js";
import { assertNoImageWork, planningSourceChanged } from '../execution/product-image-planning.js';
import { isImagePlanningProject } from '../execution/image-work-barrier.js';
import { resolveRequestedSuiteShots } from "./suites.js";
import type { Input } from '@ecomgen/contracts';
import { bodyOf, readImageInput, readSingleImageInput, type CommandFlow, type CommandScope } from './support.js';
function projectDetail(repository: EcomRepository, id: string): object { const project = repository.getProject(id); if (!project)
    missing("project", id); return { ...project, assets: repository.listAssets(id), storyboard: repository.getStoryboard(id) ?? null, items: repository.listStoryboardItems(id).map(item => ({ ...item, planningStale: Boolean(item.planningStale || planningSourceChanged(repository, item)) })), outputs: repository.listOutputs(id), jobs: repository.listJobs(id) }; }
export function compiledUserTemplates(repository: EcomRepository): ReturnType<typeof compileUserTemplate>[] { return repository.listUserTemplates().map((record) => compileUserTemplate({ id: record.id, name: record.name, prompt: record.prompt, defaultSize: record.defaultSize, supportsImageReference: record.supportsImageReference })); }
function platformTargetsValue(value: unknown): PlatformTarget[] {
    const targets = value === undefined || value === null ? [] : enumArray<PlatformTarget>(value, PLATFORM_TARGETS, "platformTargets");
    if (targets.length > 1)
        throw new ApiError("VALIDATION_ERROR", "platformTargets must contain at most one target");
    return targets;
}
function targetMarketValue(value: unknown): TargetMarket | null {
    if (value === undefined || value === null || value === "")
        return null;
    return enumValue<TargetMarket>(value, ["CHINA_MAINLAND", "HONG_KONG", "MACAU", "TAIWAN", "UNITED_STATES", "UNITED_KINGDOM", "GERMANY", "FRANCE", "ITALY", "SPAIN", "JAPAN", "SOUTH_KOREA"], "targetMarket");
}
function copyLanguageValue(value: unknown): string | null {
    if (value === undefined || value === null || value === "")
        return null;
    const language = readText(value, "copyLanguage");
    if (language.length > 64)
        throw new ApiError("VALIDATION_ERROR", "copyLanguage must contain 1 to 64 characters");
    return language;
}
function promptLanguageValue(value: unknown): PromptLanguage {
    return enumValue<PromptLanguage>(value, ["CHINESE", "ENGLISH"], "promptLanguage");
}
function dateTimeParameter(value: unknown, path: string): string | null {
    if (value === undefined || value === null || value === "")
        return null;
    const text = typeof value === "string" ? value.trim() : "";
    const parsed = text ? Date.parse(text) : Number.NaN;
    if (Number.isNaN(parsed))
        throw new ApiError("VALIDATION_ERROR", `${path} must be an ISO 8601 date-time`);
    return new Date(parsed).toISOString();
}
function modelSpecParameter<T extends string>(value: unknown, allowed: readonly T[], path: string): T | null {
    return value === undefined || value === null || value === "" ? null : enumValue<T>(value, allowed, path);
}
function publicLibraryAsset(item: LibraryItemRecord): Record<string, unknown> {
    const idBody = item.id.slice(item.id.indexOf(":") + 1);
    const url = item.id.startsWith("layer:")
        ? resourceUrlFor({kind:'LAYER_FILE',id:idBody.slice(0,idBody.lastIndexOf(':')),index:Number(idBody.slice(idBody.lastIndexOf(':')+1))})
        : item.id.startsWith("model:")
            ? resourceUrlFor({kind:'PORTRAIT',id:idBody})
            : item.id.startsWith("pattern:")
                ? resourceUrlFor({kind:'PATTERN',id:idBody})
                : item.id.startsWith("pack:")
                    ? resourceUrlFor({kind:'PRINT_PACK_FILE',id:idBody.slice(0,idBody.lastIndexOf(':')),index:Number(idBody.slice(idBody.lastIndexOf(':')+1))})
                    : item.source === "UPLOADED"
                        ? resourceUrlFor({kind:'ASSET',id:idBody})
                        : resourceUrlFor({kind:'OUTPUT',id:idBody});
    return {
        id: item.id,
        source: item.source,
        kind: item.kind,
        name: item.name,
        projectId: item.projectId,
        projectName: item.projectName,
        mimeType: item.mimeType,
        hash: item.hash,
        width: item.width,
        height: item.height,
        url,
        thumbnailUrl: resourceUrlFor({kind:'THUMBNAIL',id:item.hash}),
        createdAt: item.createdAt,
        role: item.role
    };
}
export function projectsCommands(ctx: CommandScope) {
const { repository, storage, catalog: suiteCatalog, } = ctx;
return {
listProjects: function* (command: Input<'listProjects'>): CommandFlow<unknown> {
    const query = typeof command === "object" && command ? command as Record<string, unknown> : {};
    const archivedValue = query.archived;
    const archived = archivedValue === undefined
        ? false
        : archivedValue === true || archivedValue === "true"
            ? true
            : archivedValue === false || archivedValue === "false"
                ? false
                : readBoolean(archivedValue, "archived");
    const projects = repository.listProjects(archived);
    const covers = repository.listProjectCovers(projects.map((project) => project.id));
    for (const project of projects) registerEntries(ctx,projectResources(ctx,project.id));
    return {
        items: projects.map((project) => ({ ...project, cover: covers.get(project.id) ?? { productAssetId: null, coverOutputId: null, previewOutputIds: [], outputCount: 0 } })),
        nextCursor: null
    };
},
createProject: function* (command: Input<'createProject'>): CommandFlow<unknown> {
    const body = bodyOf(command, []);
    const platformTargets = platformTargetsValue(body.platformTargets);
    const reasoningProviderId = readText(body.reasoningProviderId, "reasoningProviderId");
    const imageProviderId = readText(body.imageProviderId, "imageProviderId");
    verifyModel(repository, reasoningProviderId, readText(body.reasoningModelId, "reasoningModelId"), "reasoning");
    verifyModel(repository, imageProviderId, readText(body.imageModelId, "imageModelId"), "image");
    return repository.createProject({
        name: readText(body.name, "name"),
        category: readOptionalText(body.category) ?? null,
        productDescription: readOptionalText(body.productDescription) ?? null,
        verifiedFacts: readOptionalTextArray(body.verifiedFacts) ?? [],
        prohibitedClaims: readOptionalTextArray(body.prohibitedClaims) ?? [],
        brandGuidelines: body.brandGuidelines === undefined ? {} : objectOfStrings(body.brandGuidelines, "brandGuidelines"),
        platformTargets,
        targetMarket: targetMarketValue(body.targetMarket),
        copyLanguage: copyLanguageValue(body.copyLanguage),
        promptLanguage: body.promptLanguage === undefined ? "CHINESE" : promptLanguageValue(body.promptLanguage),
        reasoningProviderId,
        reasoningModelId: readText(body.reasoningModelId, "reasoningModelId"),
        imageProviderId,
        imageModelId: readText(body.imageModelId, "imageModelId"),
        defaultMode: enumValue<StoryboardMode>(body.defaultMode, ["CREATIVE", "PIXEL_PROTECTED"], "defaultMode"),
        imageResolution: body.imageResolution === undefined ? DEFAULT_IMAGE_RESOLUTION : enumValue<ImageResolution>(body.imageResolution, IMAGE_RESOLUTIONS, "imageResolution"),
        imageAspectRatio: body.imageAspectRatio === undefined ? DEFAULT_IMAGE_ASPECT_RATIO : enumValue<ImageAspectRatio>(body.imageAspectRatio, IMAGE_ASPECT_RATIOS, "imageAspectRatio"),
        candidatesPerType: body.candidatesPerType === undefined ? DEFAULT_CANDIDATES_PER_TYPE : candidatesPerType(body.candidatesPerType),
        webResearchEnabled: body.webResearchEnabled === undefined ? false : readBoolean(body.webResearchEnabled, "webResearchEnabled"),
        segmentationModel: body.segmentationModel === undefined || body.segmentationModel === null ? null : readSegmentationModel(repository, body.segmentationModel)
    });
},
getProject: function* (command: Input<'getProject'>): CommandFlow<unknown> { return projectDetail(repository, readText(command.projectId, "projectId")); },
updateProject: function* (command: Input<'updateProject'>): CommandFlow<unknown> {
    const id = readText(command.projectId, "projectId");
    const body = bodyOf(command, ["projectId"]);
    const current = repository.getProject(id);
    if (!current)
        missing("project", id);
    const update: Record<string, unknown> = {};
    if (body.name !== undefined)
        update.name = readText(body.name, "name");
    if (body.category !== undefined)
        update.category = readOptionalText(body.category) ?? null;
    if (body.productDescription !== undefined)
        update.productDescription = readOptionalText(body.productDescription) ?? null;
    if (body.verifiedFacts !== undefined)
        update.verifiedFacts = readTextArray(body.verifiedFacts, "verifiedFacts");
    if (body.prohibitedClaims !== undefined)
        update.prohibitedClaims = readTextArray(body.prohibitedClaims, "prohibitedClaims");
    if (body.brandGuidelines !== undefined)
        update.brandGuidelines = objectOfStrings(body.brandGuidelines, "brandGuidelines");
    if (body.platformTargets !== undefined)
        update.platformTargets = platformTargetsValue(body.platformTargets);
    if (body.targetMarket !== undefined)
        update.targetMarket = targetMarketValue(body.targetMarket);
    if (body.copyLanguage !== undefined)
        update.copyLanguage = copyLanguageValue(body.copyLanguage);
    if (body.promptLanguage !== undefined)
        update.promptLanguage = promptLanguageValue(body.promptLanguage);
    if (body.defaultMode !== undefined)
        update.defaultMode = enumValue<StoryboardMode>(body.defaultMode, ["CREATIVE", "PIXEL_PROTECTED"], "defaultMode");
    if (body.imageResolution !== undefined)
        update.imageResolution = enumValue<ImageResolution>(body.imageResolution, IMAGE_RESOLUTIONS, "imageResolution");
    if (body.imageAspectRatio !== undefined)
        update.imageAspectRatio = enumValue<ImageAspectRatio>(body.imageAspectRatio, IMAGE_ASPECT_RATIOS, "imageAspectRatio");
    if (body.candidatesPerType !== undefined)
        update.candidatesPerType = candidatesPerType(body.candidatesPerType);
    if (body.webResearchEnabled !== undefined)
        update.webResearchEnabled = readBoolean(body.webResearchEnabled, "webResearchEnabled");
    if (body.archived !== undefined)
        update.archivedAt = readBoolean(body.archived, "archived") ? new Date().toISOString() : null;
    if (body.segmentationModel !== undefined)
        update.segmentationModel = body.segmentationModel === null ? null : readSegmentationModel(repository, body.segmentationModel);
    applyModelFields(body, update, (providerId, modelId, kind) => verifyModel(repository, providerId, modelId, kind));
    return repository.updateProject(id, update) as object;
},
listLibraryAssets: function* (command: Input<'listLibraryAssets'>): CommandFlow<unknown> {
    const query = (command ?? {}) as Record<string, unknown>;
    const kind = typeof query.kind === "string" && query.kind ? enumValue<LibraryItemKind>(query.kind, ["PRODUCT", "REFERENCE", "GENERATED", "LAYER", "MODEL", "PATTERN", "PRINT_PACK"], "kind") : null;
    const q = typeof query.q === "string" && query.q.trim() ? query.q.trim() : null;
    const projectId = typeof query.projectId === "string" && query.projectId.trim() ? query.projectId.trim() : null;
    if (projectId && !UUID_PATTERN.test(projectId))
        throw new ApiError("VALIDATION_ERROR", "projectId must be a UUID");
    const createdFrom = dateTimeParameter(query.createdFrom, "createdFrom");
    const createdTo = dateTimeParameter(query.createdTo, "createdTo");
    const modelSpec = {
        gender: modelSpecParameter(query.modelGender, MODEL_GENDERS, "modelGender"),
        age: modelSpecParameter(query.modelAge, MODEL_AGES, "modelAge"),
        heritage: modelSpecParameter(query.modelHeritage, MODEL_HERITAGES, "modelHeritage"),
        stature: modelSpecParameter(query.modelStature, MODEL_STATURES, "modelStature"),
        build: modelSpecParameter(query.modelBuild, MODEL_BUILDS, "modelBuild"),
    };
    const cursor = typeof query.cursor === "string" && query.cursor ? query.cursor : null;
    const limit = typeof query.limit === "number" ? query.limit : 40;
    const page = repository.listLibraryItems({ kind, q, projectId, createdFrom, createdTo, modelSpec, cursor, limit });
    return { items: page.items.map(publicLibraryAsset), nextCursor: page.nextCursor, total: page.total };
},
copyLibraryAssetToProject: function* (command: Input<'copyLibraryAssetToProject'>): CommandFlow<unknown> {
    const projectId = readText(command.projectId, "projectId");
    ensureProject(repository, projectId);
    const body = bodyOf(command, ["projectId"]);
    const source = repository.resolveLibrarySource(body.itemId);
    if (!source)
        missing("library asset", body.itemId);
    const role = parseAssetRole(body.kind ?? body.role ?? source.role ?? "REFERENCE");
    assertProjectAssetCapacity(repository, projectId, role);
    assertProjectAssetHashUnique(repository, projectId, source.hash);
    if (!(yield storage.exists(source.storagePath)))
        throw new ApiError("NOT_FOUND", "Source file is missing");
    const content = yield storage.read(source.storagePath);
    if (contentHash(content) !== source.hash) throw new ApiError('RESOURCE_CHANGED','来源文件与登记 hash 不符。');
    const originalName = source.originalName || "library-asset";
    const stored = yield storage.putAsset(projectId, originalName, content);
    ensureProject(repository,projectId);
    assertProjectAssetCapacity(repository,projectId,role);
    assertProjectAssetHashUnique(repository,projectId,stored.hash);
    return repository.createAsset({ projectId, role, storagePath: stored.path, hash: stored.hash, originalName, mimeType: source.mimeType, width: null, height: null });
},
createPlanningJob: function* (command: Input<'createPlanningJob'>): CommandFlow<unknown> {
    const projectId = readText(command.projectId, "projectId");
    const project = repository.getProject(projectId);
    if (!project)
        missing("project", projectId);
    const body = bodyOf(command, ["projectId"]);
    if (project.defaultMode === "PIXEL_PROTECTED" && !repository.listAssets(projectId).some((asset) => asset.role === "PRODUCT_TRUTH" && asset.mimeType.startsWith("image/"))) {
        throw new ApiError("VALIDATION_ERROR", "PIXEL_PROTECTED planning requires at least one PRODUCT_TRUTH image");
    }
    const requestedTypes = readOptionalTextArray(body.requestedTypes ?? body.imageTypes);
    if (requestedTypes?.length && resolveTemplatesWithUser(requestedTypes, compiledUserTemplates(repository)).length !== requestedTypes.length)
        throw new ApiError("VALIDATION_ERROR", "requestedTypes contains an unknown ecom-details-image template ID or alias");
    const requestedSuiteShots = resolveRequestedSuiteShots(body.requestedSuiteShots, suiteCatalog);
    const planningMode = body.planningMode === undefined ? "AI" : enumValue<PlanningMode>(body.planningMode, ["AI", "MANUAL"], "planningMode");
    if (planningMode === "MANUAL" && !requestedTypes?.length && requestedSuiteShots.length === 0)
        throw new ApiError("VALIDATION_ERROR", "MANUAL planning requires requestedTypes or requestedSuiteShots");
    if (planningMode === "MANUAL" && requestedTypes?.length && requestedSuiteShots.length > 0)
        throw new ApiError("VALIDATION_ERROR", "MANUAL planning accepts requestedTypes or requestedSuiteShots, not both");
    if (planningMode === "MANUAL" && body.targetImageCount !== undefined)
        throw new ApiError("VALIDATION_ERROR", "targetImageCount is only supported for AI planning");
    if (planningMode === "AI" && requestedSuiteShots.length > 0)
        throw new ApiError("VALIDATION_ERROR", "requestedSuiteShots is only supported for MANUAL planning");
    const targetImageCount = planningMode === "AI"
        ? body.targetImageCount === undefined ? DEFAULT_TARGET_IMAGE_COUNT : planningImageCount(body.targetImageCount)
        : undefined;
    const input = {
        planningRevision: project.planningRevision,
        planningMode,
        requestedTypes,
        requestedSuiteShots: requestedSuiteShots.length ? requestedSuiteShots : undefined,
        userInstruction: readOptionalText(body.userInstruction),
        candidatesPerType: body.candidatesPerType === undefined ? undefined : candidatesPerType(body.candidatesPerType),
        targetImageCount,
        imageResolution: body.imageResolution === undefined ? undefined : enumValue<ImageResolution>(body.imageResolution, IMAGE_RESOLUTIONS, "imageResolution"),
        imageAspectRatio: body.imageAspectRatio === undefined ? undefined : enumValue<ImageAspectRatio>(body.imageAspectRatio, IMAGE_ASPECT_RATIOS, "imageAspectRatio"),
        regenerationKey: readOptionalText(body.regenerationKey)
    };
    const fingerprint = requestFingerprint({ type: "PLAN", projectId, input, idempotencyKey: (command as {
            idempotencyKey?: string;
        }).idempotencyKey ?? null });
    const existing = repository.findJobByFingerprint(projectId, fingerprint);
    if (existing)
        return existing;
    // 旧规划仍允许排队期间提交真实变更；未决外部请求和已启用的商品规划继续受屏障保护。
    assertNoImageWork(repository, ctx.requestLedger, projectId, { unknownOnly: !isImagePlanningProject(repository, projectId) });
    verifyModel(repository, project.reasoningProviderId, project.reasoningModelId, "reasoning");
    const job = repository.createJob({ id: randomUUID(), projectId, storyboardItemId: null, type: "PLAN", input, requestFingerprint: fingerprint, providerId: project.reasoningProviderId, modelId: project.reasoningModelId, estimatedCost: { status: "UNKNOWN", unit: "provider-defined" } });
    yield ctx.queue(job);
    return job;
},
listPlanningConfigSnapshots: function* (command: Input<'listPlanningConfigSnapshots'>): CommandFlow<unknown> {
    const projectId = readText(command.projectId, "projectId");
    ensureProject(repository, projectId);
    return repository.listPlanningConfigSnapshots(projectId);
},
applyPlanningConfigSnapshot: function* (command: Input<'applyPlanningConfigSnapshot'>): CommandFlow<unknown> {
    const projectId = readText(command.projectId, "projectId");
    const snapshotId = readText(command.snapshotId, "snapshotId");
    ensureProject(repository, projectId);
    const snapshot = repository.getPlanningConfigSnapshot(snapshotId);
    if (!snapshot || snapshot.projectId !== projectId)
        missing("planning config snapshot", snapshotId);
    const payload = snapshot.payload;
    const project = payload.project;
    verifyModel(repository, project.reasoningProviderId, project.reasoningModelId, "reasoning");
    verifyModel(repository, project.imageProviderId, project.imageModelId, "image");
    const updated = repository.updateProject(projectId, {
        name: project.name, category: project.category, productDescription: project.productDescription,
        verifiedFacts: project.verifiedFacts, prohibitedClaims: project.prohibitedClaims, brandGuidelines: project.brandGuidelines,
        platformTargets: project.platformTargets, targetMarket: project.targetMarket, copyLanguage: project.copyLanguage,
        promptLanguage: project.promptLanguage ?? "CHINESE",
        reasoningProviderId: project.reasoningProviderId, reasoningModelId: project.reasoningModelId,
        imageProviderId: project.imageProviderId, imageModelId: project.imageModelId, defaultMode: project.defaultMode,
        imageResolution: project.imageResolution, imageAspectRatio: project.imageAspectRatio,
        candidatesPerType: project.candidatesPerType, webResearchEnabled: project.webResearchEnabled,
    });
    if (!updated)
        missing("project", projectId);
    return { project: updated, snapshot };
},
createCopywritingJob: function* (command: Input<'createCopywritingJob'>): CommandFlow<unknown> {
    const projectId = readText(command.projectId, "projectId");
    const project = repository.getProject(projectId);
    if (!project)
        missing("project", projectId);
    const productImages = repository.listAssets(projectId).filter((asset) => asset.role === "PRODUCT_TRUTH" && asset.mimeType.startsWith("image/"));
    if (productImages.length === 0)
        throw new ApiError("VALIDATION_ERROR", "AI copywriting requires at least one product image");
    verifyCopywritingModel(repository, project.reasoningProviderId, project.reasoningModelId);
    const body = bodyOf(command, ["projectId"]);
    const input = {
        target: enumValue<CopywritingTarget>(body.target, ["PRODUCT_DESCRIPTION", "PLANNING_INSTRUCTION"], "target"),
        regenerationKey: readText(body.regenerationKey, "regenerationKey"),
    };
    // 检查与建单处于同一同步事务，防止重挂或并发提交绕过页面限制。
    if (input.target === "PLANNING_INSTRUCTION" && repository.listJobs(projectId).some(job =>
        job.type === "COPYWRITE" && job.input.target === "PRODUCT_DESCRIPTION" && (job.status === "QUEUED" || job.status === "RUNNING")))
        throw new ApiError("CONFLICT", "请等待创作目标帮写完成。");
    const fingerprint = requestFingerprint({ type: "COPYWRITE", projectId, input, idempotencyKey: (command as {
            idempotencyKey?: string;
        }).idempotencyKey ?? null });
    const existing = repository.findJobByFingerprint(projectId, fingerprint);
    if (existing)
        return existing;
    const job = repository.createJob({
        id: randomUUID(), projectId, storyboardItemId: null, type: "COPYWRITE", input, requestFingerprint: fingerprint,
        providerId: project.reasoningProviderId, modelId: project.reasoningModelId, estimatedCost: { status: "UNKNOWN", unit: "provider-defined" },
    });
    yield ctx.queue(job);
    return job;
}
};
}
