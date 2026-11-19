import {resourceUrlFor} from '@ecomgen/contracts';
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { PatternRecord, PrintPackRecord } from "@ecomgen/core";
import type { EcomRepository } from "@ecomgen/core";
import { requestFingerprint, settlePipelineStep } from "@ecomgen/core";
import { defaultPatternName, PATTERN_EXTRACT_PROMPT_VERSION, PATTERN_FORGE_PROMPT_VERSION, PATTERN_LISTING_PROMPT_VERSION, PATTERN_VARIANT_PROMPT_VERSION, presetBelongsToAxis } from "@ecomgen/ecom-skill";
import { MAX_PATTERN_BRIEF_LENGTH, MAX_PATTERN_NAME_LENGTH, MAX_PATTERN_TAG_LENGTH, PATTERN_EXTRACT_BACKGROUNDS, PATTERN_EXTRACT_MODES, PATTERN_TAGS_MAX, IMAGE_RESOLUTIONS, POD_MOCKUP_SCENE_VERSION, POD_PRINT_SPECS, POD_PRINT_SPEC_VERSION, TILEABILITY_ALGORITHM_VERSION, getPodPrintSpec } from "@ecomgen/contracts";
import { ApiError } from "./support.js";
import { assertTransparentBackground, contentHash, ensurePattern, imageDimensions, markDomainRecordFailed, missing, resolveSegmentationModel, reusableFingerprintedJob, verifyCopywritingModel, verifyModel, } from "./helpers.js";
import { parseBody } from "./support.js";
import { enumValue, readOptionalText, readText } from "./input-normalizers.js";
import { readPatternPipelineAnswers, startPatternPipeline, validatePatternPipelineAnswers } from "./patternPipelines.js";
import type { Input } from '@ecomgen/contracts';
import { bodyOf, readImageInput, readSingleImageInput, type CommandFlow, type CommandScope } from './support.js';
export function publicPattern(record: PatternRecord) {
    return {
        id: record.id,
        name: record.name,
        source: record.sourceType,
        tags: record.tags,
        sourceJobId: record.sourceJobId,
        parentPatternId: record.parentPatternId,
        tileable: record.tileable,
        tileableScore: record.tileableScore,
        tileableCheckedWith: record.tileableCheckedWith,
        ...(record.storagePath ? { imageUrl: resourceUrlFor({kind:'PATTERN',id:record.id}) } : {}),
        ...(record.fileHash ? { thumbUrl: resourceUrlFor({kind:'THUMBNAIL',id:record.fileHash}) } : {}),
        width: record.width,
        height: record.height,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
}
function publicPrintPack(record: PrintPackRecord) {
    return {
        id: record.id,
        jobId: record.jobId,
        patternId: record.patternId,
        specId: record.specId,
        specVersion: record.specVersion,
        status: record.status,
        files: (record.files ?? []).map((file, index) => ({ name: file.name, kind: file.kind, hash: file.hash, url: resourceUrlFor({kind:'PRINT_PACK_FILE',id:record.id,index}) })),
        error: record.error,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
}
function optionalBoundedText(value: string | undefined, maxLength: number, field: string): string | undefined {
    if (value && value.length > maxLength)
        throw new ApiError("VALIDATION_ERROR", `${field} must be at most ${maxLength} characters`);
    return value;
}
function parsePatternTags(raw: string | null | undefined): string[] {
    if (!raw)
        return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new ApiError("VALIDATION_ERROR", "tags must be a JSON array of strings");
    }
    if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== "string"))
        throw new ApiError("VALIDATION_ERROR", "tags must be a JSON array of strings");
    const tags = parsed.map((tag) => (tag as string).trim()).filter(Boolean);
    if (tags.length > PATTERN_TAGS_MAX) throw new ApiError('VALIDATION_ERROR',`最多填写 ${PATTERN_TAGS_MAX} 个标签。`);
    if (tags.some((tag) => tag.length > MAX_PATTERN_TAG_LENGTH))
        throw new ApiError("VALIDATION_ERROR", `tag exceeds ${MAX_PATTERN_TAG_LENGTH} characters`);
    return tags;
}
export function patternsCommands(ctx: CommandScope) {
const { repository, storage, } = ctx;
return {
listPatterns: function* (command: Input<'listPatterns'>): CommandFlow<unknown> {
    const items = repository.listPatterns().filter((record) => record.storagePath).map(publicPattern);
    return { items, nextCursor: null };
},
getPattern: function* (command: Input<'getPattern'>): CommandFlow<unknown> {
    const pattern = ensurePattern(repository, readText(command.patternId, "patternId"));
    return publicPattern(pattern);
},
updatePattern: function* (command: Input<'updatePattern'>): CommandFlow<unknown> {
    const current = ensurePattern(repository, readText(command.patternId, "patternId"));
    const body = bodyOf(command, ["patternId"]);
    const patch: {
        name?: string;
        tags?: string[];
    } = {};
    if (body.name !== undefined)
        patch.name = readText(body.name, "name");
    if (body.tags !== undefined)
        patch.tags = body.tags.map((tag) => readText(tag, "tag"));
    const record = repository.updatePattern(current.id, patch) ?? current;
    return publicPattern(record);
},
createPatternExtractJob: function* (command: Input<'createPatternExtractJob'>): CommandFlow<unknown> {
    const { upload, fields } = yield readSingleImageInput(command, "source image", ctx);
    const providerId = readText(fields.providerId, "providerId");
    const modelId = readText(fields.modelId, "modelId");
    const mode = fields.mode === undefined ? "SEGMENT" : enumValue(fields.mode, PATTERN_EXTRACT_MODES, "mode");
    const background = mode === "GENERATE"
        ? (fields.background === undefined ? "TRANSPARENT" : enumValue(fields.background, PATTERN_EXTRACT_BACKGROUNDS, "background"))
        : null;
    const imageResolution = mode === "GENERATE" && fields.imageResolution !== undefined
        ? enumValue(fields.imageResolution, IMAGE_RESOLUTIONS, "imageResolution")
        : null;
    const brief = optionalBoundedText(readOptionalText(fields.brief), MAX_PATTERN_BRIEF_LENGTH, "brief");
    const name = optionalBoundedText(readOptionalText(fields.name), MAX_PATTERN_NAME_LENGTH, "name");
    const tags = parsePatternTags(readOptionalText(fields.tags));
    const idempotencyKey = readOptionalText(fields.idempotencyKey) ?? ((command as {
        idempotencyKey?: string;
    }).idempotencyKey as string | undefined) ?? null;
    const answers = readPatternPipelineAnswers(fields.pipeline);
    if (answers)
        validatePatternPipelineAnswers(repository, answers);
    const protocol = mode === "SEGMENT" ? resolveSegmentationModel(repository, providerId, modelId, "花型提取", readOptionalText(fields.protocol)).protocol : null;
    if (mode === "GENERATE") {
        verifyModel(repository, providerId, modelId, "image");
        assertTransparentBackground(repository, providerId, modelId, background);
    }
    const sourceHash = contentHash(upload.buffer);
    const fingerprint = requestFingerprint({ type: "PATTERN_EXTRACT", mode, background, imageResolution, promptVersion: PATTERN_EXTRACT_PROMPT_VERSION, providerId, modelId, protocol, sourceHash, brief: brief ?? null, name: name ?? null, tags, idempotencyKey });
    const existing = repository.findJobByFingerprint(null, fingerprint);
    if (existing && reusableFingerprintedJob(existing, repository.hasPatternArtifactsByJobId(existing.id)))
        return existing;
    const jobId = randomUUID();
    const patternId = randomUUID();
    const storedSource = yield storage.putPatternSource(patternId, upload.filename, upload.buffer);
    const job = repository.createJob({ id: jobId, projectId: null, storyboardItemId: null, type: "PATTERN_EXTRACT", input: { patternId, sourcePath: storedSource.path, sourceHash: storedSource.hash, name: name ?? null, brief: brief ?? null, tags, mode, protocol, background, imageResolution, segmentationProviderId: mode === "SEGMENT" ? providerId : null, segmentationModelId: mode === "SEGMENT" ? modelId : null, imageProviderId: mode === "GENERATE" ? providerId : null, imageModelId: mode === "GENERATE" ? modelId : null }, requestFingerprint: fingerprint, providerId, modelId, estimatedCost: { status: "UNKNOWN", unit: "provider-defined" } });
    repository.createPattern({ id: patternId, name: name ?? defaultPatternName(brief ?? upload.filename.replace(/\.[^.]+$/, "")), sourceType: "EXTRACTED", sourceJobId: jobId, sourceAssetHash: storedSource.hash, parentPatternId: null, storagePath: null, fileHash: null, width: null, height: null, tags });
    if (answers) {
        yield* startPatternPipeline(ctx, { patternId, patternHash: null, answers, sourceJobId: jobId, idempotencyKey });
    }
    yield ctx.queue(job);
    return job;
},
uploadPattern: function* (command: Input<'uploadPattern'>): CommandFlow<unknown> {
    const { upload, fields } = yield readSingleImageInput(command, "pattern image", ctx);
    const name = optionalBoundedText(readOptionalText(fields.name), MAX_PATTERN_NAME_LENGTH, "name");
    const tags = parsePatternTags(readOptionalText(fields.tags));
    const answers = readPatternPipelineAnswers(fields.pipeline);
    if (answers)
        validatePatternPipelineAnswers(repository, answers);
    const patternId = randomUUID();
    const patternPng = yield sharp(upload.buffer).png().toBuffer();
    const stored = yield storage.putPatternArtifact(patternId, "pattern", patternPng);
    const dimensions = yield imageDimensions(patternPng);
    const record = repository.createPattern({ id: patternId, name: name ?? defaultPatternName(upload.filename.replace(/\.[^.]+$/, "")), sourceType: "UPLOADED", sourceJobId: null, sourceAssetHash: stored.hash, parentPatternId: null, storagePath: stored.path, fileHash: stored.hash, width: dimensions.width, height: dimensions.height, tags });
    if (answers)
        yield* startPatternPipeline(ctx, { patternId: record.id, patternHash: record.fileHash, answers });
    return publicPattern(record);
},
createPatternForgeJob: function* (command: Input<'createPatternForgeJob'>): CommandFlow<unknown> {
    const body = bodyOf(command, []);
    verifyModel(repository, body.providerId, body.imageModelId, "image");
    const background = body.background ?? "WHITE";
    assertTransparentBackground(repository, body.providerId, body.imageModelId, background);
    const candidateCount = body.candidateCount ?? 1;
    const idempotencyKey = body.idempotencyKey ?? ((command as {
        idempotencyKey?: string;
    }).idempotencyKey as string | undefined) ?? null;
    const fingerprint = requestFingerprint({ type: "PATTERN_FORGE", providerId: body.providerId, imageModelId: body.imageModelId, theme: body.theme, style: body.style ?? null, category: body.category ?? null, background, imageResolution: body.imageResolution ?? null, candidateCount, name: body.name ?? null, promptVersion: PATTERN_FORGE_PROMPT_VERSION, idempotencyKey });
    const existing = repository.findJobByFingerprint(null, fingerprint);
    if (existing && reusableFingerprintedJob(existing, repository.hasPatternArtifactsByJobId(existing.id)))
        return existing;
    const job = repository.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type: "PATTERN_FORGE", input: { theme: body.theme, style: body.style ?? null, category: body.category ?? null, background, imageResolution: body.imageResolution ?? null, candidateCount, name: body.name ?? null }, requestFingerprint: fingerprint, providerId: body.providerId, modelId: body.imageModelId, estimatedCost: { status: "UNKNOWN", unit: "provider-defined" } });
    if (body.pipeline)
        yield* startPatternPipeline(ctx, { patternId: null, patternHash: null, answers: body.pipeline, sourceJobId: job.id, idempotencyKey });
    yield ctx.queue(job);
    return job;
},
createPrintPackJob: function* (command: Input<'createPrintPackJob'>): CommandFlow<unknown> {
    const pattern = ensurePattern(repository, readText(command.patternId, "patternId"));
    if (!pattern.storagePath)
        throw new ApiError("CONFLICT", "该花型还没有可用的图稿产物，无法生成规格包");
    const body = bodyOf(command, ["patternId"]);
    const spec = getPodPrintSpec(body.specId);
    if (!spec)
        throw new ApiError("VALIDATION_ERROR", `未知的印刷规格：${body.specId}`);
    const idempotencyKey = body.idempotencyKey ?? ((command as {
        idempotencyKey?: string;
    }).idempotencyKey as string | undefined) ?? null;
    const layout = body.layout ?? "CENTERED";
    const repeatLayout = body.repeatLayout ?? "STRAIGHT";
    if (body.repeatLayout && layout !== "TILE")
        throw new ApiError("VALIDATION_ERROR", "平铺排列仅在满印（TILE）版式下生效");
    const fingerprint = requestFingerprint({ type: "PRINT_PACK", patternId: pattern.id, patternHash: pattern.fileHash, specId: spec.id, layout, repeatLayout, specVersion: POD_PRINT_SPEC_VERSION, idempotencyKey });
    const existing = repository.findJobByFingerprint(null, fingerprint);
    if (existing) {
        const pack = repository.getPrintPackByJobId(existing.id);
        const manifestScene = pack?.manifest && typeof pack.manifest.mockupScene === "string" ? pack.manifest.mockupScene : null;
        const reusable = existing.status === "QUEUED" || existing.status === "RUNNING" || (existing.status === "SUCCEEDED" && manifestScene === POD_MOCKUP_SCENE_VERSION);
        if (reusable)
            return { job: existing, printPack: pack ? publicPrintPack(pack) : null };
    }
    const job = repository.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type: "PRINT_PACK", input: { patternId: pattern.id, specId: spec.id, specVersion: POD_PRINT_SPEC_VERSION, layout, repeatLayout }, requestFingerprint: fingerprint, estimatedCost: { status: "UNKNOWN", unit: "local-storage" } });
    const printPack = repository.createPrintPack({ patternId: pattern.id, jobId: job.id, specId: spec.id, specVersion: POD_PRINT_SPEC_VERSION, status: "QUEUED" });
    yield ctx.queue(job);
    return { job, printPack: publicPrintPack(printPack) };
},
createPatternDeriveJob: function* (command: Input<'createPatternDeriveJob'>): CommandFlow<unknown> {
    const pattern = ensurePattern(repository, readText(command.patternId, "patternId"));
    if (!pattern.storagePath)
        throw new ApiError("CONFLICT", "该花型还没有可用的图稿产物，无法衍生");
    const body = bodyOf(command, ["patternId"]);
    if (body.hueShift === undefined && body.saturationPct === undefined && body.brightnessPct === undefined) {
        throw new ApiError("VALIDATION_ERROR", "改色至少需要提供色相、饱和度或亮度之一");
    }
    const idempotencyKey = body.idempotencyKey ?? ((command as {
        idempotencyKey?: string;
    }).idempotencyKey as string | undefined) ?? null;
    const fingerprint = requestFingerprint({ type: "PATTERN_DERIVE", patternId: pattern.id, patternHash: pattern.fileHash, hueShift: body.hueShift ?? null, saturationPct: body.saturationPct ?? null, brightnessPct: body.brightnessPct ?? null, idempotencyKey });
    const existing = repository.findJobByFingerprint(null, fingerprint);
    if (existing && reusableFingerprintedJob(existing, repository.hasPatternArtifactsByJobId(existing.id)))
        return existing;
    const job = repository.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type: "PATTERN_DERIVE", input: { patternId: pattern.id, hueShift: body.hueShift ?? null, saturationPct: body.saturationPct ?? null, brightnessPct: body.brightnessPct ?? null }, requestFingerprint: fingerprint, estimatedCost: { status: "UNKNOWN", unit: "local-storage" } });
    yield ctx.queue(job);
    return job;
},
createPatternVariantJob: function* (command: Input<'createPatternVariantJob'>): CommandFlow<unknown> {
    const pattern = ensurePattern(repository, readText(command.patternId, "patternId"));
    if (!pattern.storagePath)
        throw new ApiError("CONFLICT", "该花型还没有可用的图稿产物，无法衍生");
    const body = bodyOf(command, ["patternId"]);
    verifyModel(repository, body.providerId, body.imageModelId, "image");
    if (!presetBelongsToAxis(body.axis, body.preset))
        throw new ApiError("VALIDATION_ERROR", `预设 ${body.preset} 不属于轴向 ${body.axis}`);
    const background = body.background ?? "SOURCE";
    assertTransparentBackground(repository, body.providerId, body.imageModelId, background);
    const candidateCount = body.candidateCount ?? 1;
    const idempotencyKey = body.idempotencyKey ?? ((command as {
        idempotencyKey?: string;
    }).idempotencyKey as string | undefined) ?? null;
    const fingerprint = requestFingerprint({ type: "PATTERN_VARIANT", patternId: pattern.id, patternHash: pattern.fileHash, axis: body.axis, preset: body.preset, extra: body.extra ?? null, background, imageResolution: body.imageResolution ?? null, providerId: body.providerId, imageModelId: body.imageModelId, candidateCount, name: body.name ?? null, promptVersion: PATTERN_VARIANT_PROMPT_VERSION, idempotencyKey });
    const existing = repository.findJobByFingerprint(null, fingerprint);
    if (existing && reusableFingerprintedJob(existing, repository.hasPatternArtifactsByJobId(existing.id)))
        return existing;
    const job = repository.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type: "PATTERN_VARIANT", input: { patternId: pattern.id, axis: body.axis, preset: body.preset, extra: body.extra ?? null, background, imageResolution: body.imageResolution ?? null, candidateCount, name: body.name ?? null }, requestFingerprint: fingerprint, providerId: body.providerId, modelId: body.imageModelId, estimatedCost: { status: "UNKNOWN", unit: "provider-defined" } });
    yield ctx.queue(job);
    return job;
},
createPatternTileCheckJob: function* (command: Input<'createPatternTileCheckJob'>): CommandFlow<unknown> {
    const pattern = ensurePattern(repository, readText(command.patternId, "patternId"));
    if (!pattern.storagePath)
        throw new ApiError("CONFLICT", "该花型还没有可用的图稿产物，无法验缝");
    const idempotencyKey = ((command as {
        idempotencyKey?: string;
    }).idempotencyKey as string | undefined) ?? null;
    const fingerprint = requestFingerprint({ type: "PATTERN_TILE_CHECK", patternId: pattern.id, patternHash: pattern.fileHash, algorithmVersion: TILEABILITY_ALGORITHM_VERSION, idempotencyKey });
    const existing = repository.findJobByFingerprint(null, fingerprint);
    if (existing)
        return existing;
    const job = repository.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type: "PATTERN_TILE_CHECK", input: { patternId: pattern.id }, requestFingerprint: fingerprint, estimatedCost: { status: "UNKNOWN", unit: "local-storage" } });
    yield ctx.queue(job);
    return job;
},
listPatternPrintPacks: function* (command: Input<'listPatternPrintPacks'>): CommandFlow<unknown> {
    const pattern = ensurePattern(repository, readText(command.patternId, "patternId"));
    return { items: repository.listPrintPacks(pattern.id).map(publicPrintPack) };
},
getPrintPack: function* (command: Input<'getPrintPack'>): CommandFlow<unknown> {
    const pack = repository.getPrintPack(readText(command.printPackId, "printPackId"));
    if (!pack)
        missing("print pack", readText(command.printPackId, "printPackId"));
    return publicPrintPack(pack);
},
createPatternListingJob: function* (command: Input<'createPatternListingJob'>): CommandFlow<unknown> {
    const pattern = ensurePattern(repository, readText(command.patternId, "patternId"));
    if (!pattern.storagePath)
        throw new ApiError("CONFLICT", "该花型还没有可用的图稿产物，无法生成 Listing 文案");
    const body = bodyOf(command, ["patternId"]);
    verifyCopywritingModel(repository, body.providerId, body.modelId);
    const idempotencyKey = body.idempotencyKey ?? ((command as {
        idempotencyKey?: string;
    }).idempotencyKey as string | undefined) ?? null;
    const fingerprint = requestFingerprint({ type: "COPYWRITE", target: "LISTING", patternId: pattern.id, patternHash: pattern.fileHash, platform: body.platform, sellingPoints: body.sellingPoints ?? null, mustIncludeWords: body.mustIncludeWords ?? null, bannedWords: body.bannedWords ?? null, promptVersion: PATTERN_LISTING_PROMPT_VERSION, providerId: body.providerId, modelId: body.modelId, idempotencyKey });
    const existing = repository.findJobByFingerprint(null, fingerprint);
    if (existing)
        return existing;
    const job = repository.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type: "COPYWRITE", input: { target: "LISTING", patternId: pattern.id, platform: body.platform, sellingPoints: body.sellingPoints ?? null, mustIncludeWords: body.mustIncludeWords ?? null, bannedWords: body.bannedWords ?? null }, requestFingerprint: fingerprint, providerId: body.providerId, modelId: body.modelId, estimatedCost: { status: "UNKNOWN", unit: "provider-defined" } });
    yield ctx.queue(job);
    return job;
},
getPatternListingResult: function* (command: Input<'getPatternListingResult'>): CommandFlow<unknown> {
    const patternId = readText(command.patternId, "patternId");
    const record = repository.getPatternListingResult(readText(command.jobId, "jobId"));
    if (!record || record.patternId !== patternId)
        missing("listing result", readText(command.jobId, "jobId"));
    return record;
},
listPodPrintSpecs: function* (command: Input<'listPodPrintSpecs'>): CommandFlow<unknown> { return ({ specVersion: POD_PRINT_SPEC_VERSION, items: POD_PRINT_SPECS }); }
};
}
