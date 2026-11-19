import {resourceUrlFor} from '@ecomgen/contracts';
import { compensateDraftJob } from '../execution/index.js';
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { DraftBatchRecord, DraftCandidateRecord, DraftMediaRecord, DraftSlotRecord, JobRecord, PatternDraftRecord } from "@ecomgen/core";
import type { EcomRepository, LocalAssetStore } from "@ecomgen/core";
import { DRAFT_PROMPT_VERSION } from "@ecomgen/ecom-skill";
import { DRAFT_BATCH_OPERATIONS, DRAFT_COMPOSE_TYPES, DRAFT_MEDIA_ROLES, DRAFT_MEDIA_SOURCES, DRAFT_SEAM_BAND_MAX, MAX_DRAFT_INSTRUCTION_LENGTH, MAX_DRAFT_MEDIA_NOTES_LENGTH, MAX_PATTERN_BRIEF_LENGTH, MAX_PATTERN_DRAFT_NAME_LENGTH, PATTERN_DRAFT_CANDIDATES_MAX, PATTERN_DRAFT_ANNOTATIONS_MAX, PATTERN_DRAFT_REFERENCES_MAX, CreateDraftBatchInput, danglingDraftReferenceOrdinals, dispatchedReferenceOrdinals, findDraftReferences } from "@ecomgen/contracts";
import type { CreateDraftBatchResponse, DraftBatch, DraftBatchOperation, DraftCandidate, DraftComposeType, DraftConditions, DraftJobRef, DraftMedia, DraftSlot, FinalizeDraftCandidateResponse, PatternDraft, SegmentationProtocol } from "@ecomgen/contracts";
import { ApiError } from "./support.js";
import { assertTransparentBackground, contentHash, missing, resolveSegmentationModel, verifyModel } from "./helpers.js";
import { parseBody } from "./support.js";
import { enumValue, readObject, readOptionalText, readPatchText, readText } from "./input-normalizers.js";
import { publicPattern } from "./patterns.js";
import type { Input } from '@ecomgen/contracts';
import { bodyOf, readImageInput, readSingleImageInput, type CommandFlow, type CommandScope } from './support.js';
const DRAFT_JOB_BY_OPERATION: Record<DraftBatchOperation, {
    type: "PATTERN_DRAFT_GENERATE" | "PATTERN_DRAFT_EDIT" | "PATTERN_DRAFT_CUTOUT" | "PATTERN_DRAFT_PROCESS";
    kind: string;
}> = {
    GENERATE: { type: "PATTERN_DRAFT_GENERATE", kind: "pattern_draft_generate" },
    EDIT: { type: "PATTERN_DRAFT_EDIT", kind: "pattern_draft_edit" },
    SEAM_EDIT: { type: "PATTERN_DRAFT_EDIT", kind: "pattern_draft_edit" },
    CUTOUT: { type: "PATTERN_DRAFT_CUTOUT", kind: "pattern_draft_cutout" },
    RECOLOR: { type: "PATTERN_DRAFT_PROCESS", kind: "pattern_draft_process" },
};
function defaultDraftName(): string {
    return `未命名草稿 · ${new Date().toISOString().slice(0, 10)}`;
}
function defaultConditions(): DraftConditions {
    return { theme: "", aspectRatio: "1:1", background: "WHITE", candidateCount: 1 };
}
function normalizeConditions(input: DraftConditions): DraftConditions {
    const bounded = (value: string | undefined, max: number, field: string): string => {
        const text = value ?? "";
        if (text.length > max)
            throw new ApiError("VALIDATION_ERROR", `${field} must be at most ${max} characters`);
        return text;
    };
    const candidateCount = Math.round(Number(input.candidateCount));
    if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > PATTERN_DRAFT_CANDIDATES_MAX) {
        throw new ApiError("VALIDATION_ERROR", `conditions.candidateCount must be between 1 and ${PATTERN_DRAFT_CANDIDATES_MAX}`);
    }
    return {
        theme: bounded(input.theme, MAX_PATTERN_BRIEF_LENGTH, "conditions.theme"),
        aspectRatio: input.aspectRatio,
        ...(input.imageResolution ? { imageResolution: input.imageResolution } : {}),
        ...(input.quality ? { quality: input.quality } : {}),
        background: input.background,
        candidateCount,
        ...(input.providerId ? { providerId: input.providerId } : {}),
        ...(input.imageModelId ? { imageModelId: input.imageModelId } : {}),
        ...(input.repeatLayout ? { repeatLayout: input.repeatLayout } : {}),
    };
}
function candidateUrl(draftId: string, candidateId: string): string {
    return resourceUrlFor({kind:'DRAFT_CANDIDATE',id:candidateId});
}
function publicDraft(record: PatternDraftRecord, summary?: {
    count: number;
    latest: DraftCandidateRecord;
}): PatternDraft {
    return {
        id: record.id,
        name: record.name,
        composeType: record.composeType,
        conditions: record.conditions as DraftConditions,
        revision: record.revision,
        selectedCandidateId: record.selectedCandidateId,
        compareCandidateId: record.compareCandidateId,
        archivedAt: record.archivedAt,
        candidateCount: summary?.count ?? 0,
        previewUrl: summary ? thumbnailUrl(summary.latest.fileHash) : null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
}
function draftSummary(repository: EcomRepository, draftId: string): {
    count: number;
    latest: DraftCandidateRecord;
} | undefined {
    return repository.summarizeDraftCandidates([draftId]).get(draftId);
}
function mediaUrl(draftId: string, mediaId: string): string {
    return resourceUrlFor({kind:'DRAFT_MEDIA',id:mediaId});
}
function thumbnailUrl(fileHash: string): string {
    return resourceUrlFor({kind:'THUMBNAIL',id:fileHash});
}
function publicMedia(record: DraftMediaRecord): DraftMedia {
    return {
        id: record.id,
        draftId: record.draftId,
        role: record.role,
        source: record.source,
        sourcePatternId: record.sourcePatternId,
        ordinal: record.ordinal,
        url: mediaUrl(record.draftId, record.id),
        thumbUrl: thumbnailUrl(record.fileHash),
        fileName: record.originalName,
        mimeType: record.mimeType,
        width: record.width,
        height: record.height,
        notes: record.notes,
        createdAt: record.createdAt,
    };
}
function publicCandidate(record: DraftCandidateRecord): DraftCandidate {
    return {
        id: record.id,
        draftId: record.draftId,
        batchId: record.batchId,
        slotIndex: record.slotIndex,
        parentCandidateId: record.parentCandidateId,
        url: candidateUrl(record.draftId, record.id),
        thumbUrl: thumbnailUrl(record.fileHash),
        width: record.width,
        height: record.height,
        mimeType: record.mimeType,
        transform: record.transform,
        hasAlpha: record.hasAlpha,
        tileable: {
            status: record.tileable,
            score: record.tileableScore,
            algorithmVersion: record.tileableCheckedWith,
            horizontal: record.tileableHorizontal,
            vertical: record.tileableVertical,
        },
        createdAt: record.createdAt,
    };
}
function publicJobRef(job: JobRecord): DraftJobRef {
    return { id: job.id, type: job.type, status: job.status, progress: job.progress };
}
function publicBatch(batch: DraftBatchRecord, slots: DraftSlotRecord[], candidates: DraftCandidateRecord[], jobs: ReadonlyMap<string, JobRecord>): DraftBatch {
    const candidateBySlot = new Map(candidates.map((candidate) => [candidate.slotIndex, candidate]));
    const latest = latestSlotJob(slots, jobs);
    const publicSlots: DraftSlot[] = slots.map((slot) => ({
        index: slot.index,
        status: slot.status,
        attempt: slot.attempt,
        jobId: slot.jobId,
        candidateId: candidateBySlot.get(slot.index)?.id ?? null,
        error: slot.error,
        updatedAt: slot.updatedAt,
    }));
    return {
        id: batch.id,
        draftId: batch.draftId,
        operation: batch.operation,
        parentCandidateId: batch.parentCandidateId,
        providerId: batch.providerId,
        imageModelId: batch.imageModelId,
        candidateCount: batch.candidateCount,
        instruction: batch.instruction,
        estimatedCost: latest?.estimatedCost ?? null,
        actualCost: latest?.actualCost ?? null,
        snapshot: batch.snapshot,
        createdAt: batch.createdAt,
        slots: publicSlots,
    };
}
function ensureDraft(repository: EcomRepository, id: string): PatternDraftRecord {
    const draft = repository.getPatternDraft(id);
    if (!draft)
        missing("pattern draft", id);
    return draft;
}
function ensureDraftBatch(repository: EcomRepository, draftId: string, batchId: string): DraftBatchRecord {
    const batch = repository.getDraftBatch(batchId);
    if (!batch || batch.draftId !== draftId)
        missing("draft batch", batchId);
    return batch;
}
function ensureDraftCandidate(repository: EcomRepository, draftId: string, candidateId: string): DraftCandidateRecord {
    const candidate = repository.getDraftCandidate(candidateId);
    if (!candidate || candidate.draftId !== draftId)
        missing("draft candidate", candidateId);
    return candidate;
}
function ensureDraftMedia(repository: EcomRepository, draftId: string, mediaId: string): DraftMediaRecord {
    const media = repository.getDraftMedia(mediaId);
    if (!media || media.draftId !== draftId)
        missing("draft media", mediaId);
    return media;
}
interface DraftReferenceRow {
    media: DraftMediaRecord;
    ordinal: number;
}
function draftReferenceRows(repository: EcomRepository, draft: PatternDraftRecord): DraftReferenceRow[] {
    return repository.listDraftMedia(draft.id).flatMap((media) => {
        if (media.role !== "REFERENCE")
            return [];
        if (media.ordinal === null)
            throw new ApiError("CONFLICT", `参考图 ${media.originalName} 缺少引用编号，请重新上传后再提交`);
        return [{ media, ordinal: media.ordinal }];
    });
}
function* pruneDraftAnnotations(repository: EcomRepository, storage: LocalAssetStore, draftId: string): CommandFlow<void> {
    const annotations = repository.listDraftMedia(draftId).filter((media) => media.role === "ANNOTATION");
    if (!annotations.length)
        return;
    const pendingPaths = new Set<string>();
    for (const batch of repository.listDraftBatches(draftId)) {
        const path = (batch.snapshot as {
            annotation?: {
                storagePath?: string;
            } | null;
        }).annotation?.storagePath;
        if (!path)
            continue;
        const stillNeeded = repository.listDraftSlots(batch.id).some((slot) => slot.status === "QUEUED" || slot.status === "RUNNING" || slot.status === "UNKNOWN" || slot.status === "FAILED");
        if (stillNeeded)
            pendingPaths.add(path);
    }
    for (const media of annotations) {
        if (pendingPaths.has(media.storagePath))
            continue;
        repository.deleteDraftMedia(media.id);
        yield storage.delete(media.storagePath);
    }
}
function resolveDispatchedReferences(rows: DraftReferenceRow[], body: CreateDraftBatchInput, operation: DraftBatchOperation): Array<{
    mediaId: string;
    ordinal: number;
    storagePath: string;
    mimeType: string;
    notes: string | null;
}> {
    const byOrdinal = new Map(rows.map((row) => [row.ordinal, row.media]));
    const ordinals = dispatchedReferenceOrdinals({
        operation,
        instruction: body.instruction,
        availableOrdinals: rows.map((row) => row.ordinal),
    });
    if (ordinals.length > PATTERN_DRAFT_REFERENCES_MAX) {
        const hint = operation === "EDIT" ? "请减少改稿说明里引用的参考图" : "请先删除多余的参考图";
        throw new ApiError("VALIDATION_ERROR", `一次最多下发 ${PATTERN_DRAFT_REFERENCES_MAX} 张参考图，${hint}`);
    }
    return ordinals.map((ordinal) => {
        const media = byOrdinal.get(ordinal);
        if (!media)
            throw new ApiError("VALIDATION_ERROR", `引用的参考图不存在：@图${ordinal}，请从参考图列表里重新选择`);
        return { mediaId: media.id, ordinal, storagePath: media.storagePath, mimeType: media.mimeType, notes: media.notes };
    });
}
function assertReferenceText(text: string | null | undefined, availableOrdinals: readonly number[]): void {
    const dangling = danglingDraftReferenceOrdinals(text ?? "", availableOrdinals);
    if (dangling.length) {
        throw new ApiError("VALIDATION_ERROR", `引用的参考图不存在：${dangling.map((ordinal) => `@图${ordinal}`).join("、")}，请从参考图列表里重新选择`);
    }
}
const REPEATABLE_OPERATIONS = new Set<DraftBatchOperation>(["GENERATE", "EDIT", "SEAM_EDIT"]);
function assertNotesLength(notes: string | null): void {
    if (notes && notes.length > MAX_DRAFT_MEDIA_NOTES_LENGTH)
        throw new ApiError("VALIDATION_ERROR", `notes must be at most ${MAX_DRAFT_MEDIA_NOTES_LENGTH} characters`);
}
function validateOperationInput(body: CreateDraftBatchInput, parentCandidateId: string | null): void {
    if (body.operation !== "GENERATE" && !parentCandidateId)
        throw new ApiError("VALIDATION_ERROR", `${body.operation} 需要指定父候选`);
    if (body.operation === "EDIT" && !body.instruction?.trim())
        throw new ApiError("VALIDATION_ERROR", "改稿需要一句说明");
    if (body.annotationMediaId && body.operation !== "EDIT")
        throw new ApiError("VALIDATION_ERROR", "只有改稿操作接受笔迹，其他操作不会读取它");
    if (body.operation === "SEAM_EDIT" && !body.seam)
        throw new ApiError("VALIDATION_ERROR", "接缝改稿需要指定目标边与带宽");
    if (body.seam && body.seam.band > DRAFT_SEAM_BAND_MAX)
        throw new ApiError("VALIDATION_ERROR", `接缝带宽不能超过 ${DRAFT_SEAM_BAND_MAX}px`);
    if (body.instruction && body.instruction.length > MAX_DRAFT_INSTRUCTION_LENGTH)
        throw new ApiError("VALIDATION_ERROR", `instruction must be at most ${MAX_DRAFT_INSTRUCTION_LENGTH} characters`);
    if (body.operation === "GENERATE" && !body.theme?.trim())
        throw new ApiError("VALIDATION_ERROR", "起稿需要一个创作主题");
    const generative = body.operation !== "RECOLOR";
    if (generative && (!body.providerId || !body.imageModelId))
        throw new ApiError("VALIDATION_ERROR", "生成式操作需要选择模型");
}
function slotJobs(repository: EcomRepository, slots: DraftSlotRecord[]): Map<string, JobRecord> {
    return repository.listJobsByIds(slots.flatMap((slot) => (slot.jobId ? [slot.jobId] : [])));
}
function latestSlotJob(slots: DraftSlotRecord[], jobs: ReadonlyMap<string, JobRecord>): JobRecord | undefined {
    return slots
        .flatMap((slot) => (slot.jobId ? [jobs.get(slot.jobId)] : []))
        .filter((job): job is JobRecord => Boolean(job))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .at(-1);
}
function activeDraftJobs(repository: EcomRepository, draftId: string): JobRecord[] {
    const slots = repository.listDraftBatches(draftId).flatMap((batch) => repository.listDraftSlots(batch.id));
    return [...slotJobs(repository, slots).values()].filter((job) => job.status === "QUEUED" || job.status === "RUNNING");
}
function markDraftSlotsFailed(repository: EcomRepository, batchId: string, indices: number[], jobId: string): void {
    const slots = repository.listDraftSlots(batchId);
    for (const index of indices) {
        const slot = slots.find((entry) => entry.index === index);
        if (slot && slot.jobId === jobId && slot.status === "QUEUED")
            repository.updateDraftSlot(batchId, index, { status: "FAILED", error: { code: "QUEUE_UNAVAILABLE", message: "任务已创建但队列暂不可用，请稍后重试" } });
    }
}
export function patternDraftsCommands(ctx: CommandScope) {
const { repository, storage, } = ctx;
function* submitDraftBatch(draft: PatternDraftRecord, body: CreateDraftBatchInput, parentOverride: string | undefined): CommandFlow<CreateDraftBatchResponse> {
    const operation = enumValue(body.operation, DRAFT_BATCH_OPERATIONS, "operation");
    const parentCandidateId = parentOverride ?? body.parentCandidateId ?? null;
    validateOperationInput(body, parentCandidateId);
    if (parentCandidateId)
        ensureDraftCandidate(repository, draft.id, parentCandidateId);
    const requestedCount = typeof body.candidateCount === "number" && Number.isFinite(body.candidateCount) ? body.candidateCount : 1;
    const candidateCount = REPEATABLE_OPERATIONS.has(operation) ? Math.min(PATTERN_DRAFT_CANDIDATES_MAX, Math.max(1, Math.round(requestedCount))) : 1;
    const generative = operation !== "RECOLOR";
    let segmentation: {
        providerId: string;
        modelId: string;
        protocol: SegmentationProtocol;
    } | null = null;
    if (operation === "CUTOUT") {
        segmentation = resolveSegmentationModel(repository, body.providerId, body.imageModelId, "去底");
    }
    else if (generative) {
        verifyModel(repository, body.providerId ?? null, body.imageModelId ?? null, "image");
        assertTransparentBackground(repository, body.providerId, body.imageModelId, body.background);
    }
    const referenceRows = draftReferenceRows(repository, draft);
    const annotation = body.annotationMediaId ? (() => {
        const media = ensureDraftMedia(repository, draft.id, body.annotationMediaId!);
        if (media.role !== "ANNOTATION")
            throw new ApiError("VALIDATION_ERROR", "改稿的笔迹必须是笔迹类型媒体");
        return { mediaId: media.id, storagePath: media.storagePath, mimeType: media.mimeType };
    })() : null;
    const references = resolveDispatchedReferences(referenceRows, body, operation);
    if (operation === "GENERATE") {
        assertReferenceText(body.theme, referenceRows.map((row) => row.ordinal));
    }
    else if (operation === "SEAM_EDIT" && findDraftReferences(body.instruction ?? "").length) {
        throw new ApiError("VALIDATION_ERROR", "接缝改稿不下发参考图，改稿说明不能引用 @图N");
    }
    const snapshot = {
        operation,
        promptVersion: DRAFT_PROMPT_VERSION,
        providerId: body.providerId ?? null,
        imageModelId: body.imageModelId ?? null,
        candidateCount,
        theme: body.theme ?? null,
        aspectRatio: body.aspectRatio ?? "1:1",
        imageResolution: body.imageResolution ?? null,
        quality: body.quality ?? null,
        background: body.background ?? "WHITE",
        repeatLayout: body.repeatLayout ?? null,
        instruction: body.instruction ?? null,
        recolor: body.recolor ?? null,
        seam: body.seam ?? null,
        references,
        annotation,
        parentCandidateId,
        segmentation,
    };
    const snapshotHash = contentHash(Buffer.from(JSON.stringify(snapshot)));
    const existing = repository.getDraftBatchByClientKey(draft.id, body.clientKey);
    if (existing) {
        if ((existing.snapshot as Record<string, unknown>)._hash !== snapshotHash) {
            throw new ApiError("CONFLICT", "同一提交 key 已用于不同的输入；请更换 key 后重新提交");
        }
        const slots = repository.listDraftSlots(existing.id);
        const jobs = slotJobs(repository, slots);
        const latest = latestSlotJob(slots, jobs);
        return { batch: publicBatch(existing, slots, repository.listDraftCandidatesByBatch(existing.id), jobs), job: latest ? publicJobRef(latest) : null, reused: true };
    }
    const mapping = DRAFT_JOB_BY_OPERATION[operation];
    const stored = repository.createDraftBatch({ draftId: draft.id, operation, parentCandidateId, providerId: segmentation?.providerId ?? body.providerId ?? null, imageModelId: segmentation?.modelId ?? body.imageModelId ?? null, candidateCount, instruction: body.instruction ?? null, snapshot: { ...snapshot, _hash: snapshotHash }, clientKey: body.clientKey });
    const slots = stored.slots.map((slot) => slot.index);
    const job = repository.createJob({
        id: randomUUID(),
        projectId: null,
        storyboardItemId: null,
        type: mapping.type,
        input: { draftId: draft.id, batchId: stored.batch.id, slots, task: "BATCH", snapshotHash },
        requestFingerprint: null,
        providerId: segmentation?.providerId ?? body.providerId ?? null,
        modelId: segmentation?.modelId ?? body.imageModelId ?? null,
        estimatedCost: operation === "RECOLOR" ? null : { status: "UNKNOWN", unit: "provider-defined" },
    });
    repository.assignDraftSlotsToJob(stored.batch.id, slots, job.id, false);
    yield ctx.queue(job);
    const storedSlots = repository.listDraftSlots(stored.batch.id);
    return { batch: publicBatch(stored.batch, storedSlots, repository.listDraftCandidatesByBatch(stored.batch.id), slotJobs(repository, storedSlots)), job: publicJobRef(job), reused: false };
}
return {
listPatternDrafts: function* (command: Input<'listPatternDrafts'>): CommandFlow<unknown> {
    const includeArchived = command.archived === true;
    const drafts = repository.listPatternDrafts(includeArchived);
    const summaries = repository.summarizeDraftCandidates(drafts.map((draft) => draft.id));
    return { items: drafts.map((draft) => publicDraft(draft, summaries.get(draft.id))) };
},
createPatternDraft: function* (command: Input<'createPatternDraft'>): CommandFlow<unknown> {
    const body = bodyOf(command, []);
    const composeType: DraftComposeType = body.composeType ?? "PLACEMENT";
    enumValue(composeType, DRAFT_COMPOSE_TYPES, "composeType");
    const name = body.name === undefined ? defaultDraftName() : readText(body.name, "name");
    if (name.length > MAX_PATTERN_DRAFT_NAME_LENGTH)
        throw new ApiError("VALIDATION_ERROR", `name must be at most ${MAX_PATTERN_DRAFT_NAME_LENGTH} characters`);
    const draft = repository.createPatternDraft({ name, composeType, conditions: defaultConditions() });
    return publicDraft(draft);
},
getPatternDraft: function* (command: Input<'getPatternDraft'>): CommandFlow<unknown> {
    const draft = ensureDraft(repository, readText(command.draftId, "draftId"));
    return publicDraft(draft, draftSummary(repository, draft.id));
},
updatePatternDraft: function* (command: Input<'updatePatternDraft'>): CommandFlow<unknown> {
    const current = ensureDraft(repository, readText(command.draftId, "draftId"));
    const body = bodyOf(command, ["draftId"]);
    const patch: Partial<Pick<PatternDraftRecord, "name" | "conditions" | "selectedCandidateId" | "compareCandidateId" | "archivedAt">> = {};
    if (body.name !== undefined) {
        const name = readText(body.name, "name");
        if (name.length > MAX_PATTERN_DRAFT_NAME_LENGTH)
            throw new ApiError("VALIDATION_ERROR", `name must be at most ${MAX_PATTERN_DRAFT_NAME_LENGTH} characters`);
        patch.name = name;
    }
    if (body.conditions !== undefined)
        patch.conditions = normalizeConditions(body.conditions);
    if (body.selectedCandidateId !== undefined) {
        if (body.selectedCandidateId !== null)
            ensureDraftCandidate(repository, current.id, body.selectedCandidateId);
        patch.selectedCandidateId = body.selectedCandidateId;
    }
    if (body.compareCandidateId !== undefined) {
        if (body.compareCandidateId !== null)
            ensureDraftCandidate(repository, current.id, body.compareCandidateId);
        patch.compareCandidateId = body.compareCandidateId;
    }
    if (body.archived !== undefined)
        patch.archivedAt = body.archived ? new Date().toISOString() : null;
    const result = repository.updatePatternDraft(current.id, patch, body.expectedRevision);
    if (result.status === "missing")
        missing("pattern draft", current.id);
    if (result.status === "conflict")
        throw new ApiError("CONFLICT", `草稿已在别处更新（服务端版本 ${result.draft.revision}）`, [{ path: "expectedRevision", reason: `server revision is ${result.draft.revision}` }]);
    return publicDraft(result.draft, draftSummary(repository, result.draft.id));
},
deletePatternDraft: function* (command: Input<'deletePatternDraft'>): CommandFlow<unknown> {
    const draft = ensureDraft(repository, readText(command.draftId, "draftId"));
    const allJobs = slotJobs(repository, repository.listDraftBatches(draft.id).flatMap(b => repository.listDraftSlots(b.id)));
    if ([...allJobs.values()].some(j => j.status === 'UNKNOWN' || ctx.requestLedger.hasUnknown(j.id))) throw new ApiError('EXTERNAL_UNKNOWN','草稿含结果未知的外部请求。');
    const activeJobs = activeDraftJobs(repository, draft.id);
    if (activeJobs.length) {
        for (const job of activeJobs)
            yield ctx.cancel(job.id);
        throw new ApiError("CONFLICT", "草稿仍有在途任务，已请求取消，请稍后重试删除");
    }
    repository.deletePatternDraft(draft.id);
    yield storage.deleteDraft(draft.id);
    return null;
},
listDraftMedia: function* (command: Input<'listDraftMedia'>): CommandFlow<unknown> {
    const draft = ensureDraft(repository, readText(command.draftId, "draftId"));
    return { items: repository.listDraftMedia(draft.id).map(publicMedia) };
},
createDraftMedia: function* (command: Input<'createDraftMedia'>): CommandFlow<unknown> {
    const draft = ensureDraft(repository, readText(command.draftId, "draftId"));
    const { upload, fields } = yield readImageInput(command, ctx);
    const role = enumValue(fields.role, DRAFT_MEDIA_ROLES, "role");
    const source = fields.source === undefined ? "UPLOAD" : enumValue(fields.source, DRAFT_MEDIA_SOURCES, "source");
    const notes = readOptionalText(fields.notes) ?? null;
    assertNotesLength(notes);
    if (role === "REFERENCE" && repository.countDraftMedia(draft.id, "REFERENCE") >= PATTERN_DRAFT_REFERENCES_MAX) {
        throw new ApiError("VALIDATION_ERROR", `草稿最多保留 ${PATTERN_DRAFT_REFERENCES_MAX} 张参考图`);
    }
    if (role === "ANNOTATION") {
        yield* pruneDraftAnnotations(repository, storage, draft.id);
        if (repository.countDraftMedia(draft.id, "ANNOTATION") >= PATTERN_DRAFT_ANNOTATIONS_MAX) {
            throw new ApiError("VALIDATION_ERROR", `草稿最多保留 ${PATTERN_DRAFT_ANNOTATIONS_MAX} 张改稿笔迹`);
        }
    }
    let content: Buffer;
    let originalName: string;
    let mimeType: string;
    let sourcePatternId: string | null = null;
    if (source === "PATTERN") {
        const patternId = readText(fields.patternId, "patternId");
        const pattern = repository.getPattern(patternId);
        if (!pattern)
            missing("pattern", patternId);
        if (!pattern.storagePath)
            throw new ApiError("CONFLICT", "该花型还没有可用的图稿，无法作为参考");
        sourcePatternId = pattern.id;
        content = yield storage.read(pattern.storagePath);
        originalName = `${pattern.name}.png`;
        mimeType = "image/png";
    }
    else {
        if (!upload)
            throw new ApiError("VALIDATION_ERROR", "需要上传文件或引用已有花型");
        content = upload.buffer;
        originalName = upload.filename;
        mimeType = upload.mimetype;
    }
    const { data: png, info } = yield sharp(content).png().toBuffer({ resolveWithObject: true });
    const stored = yield storage.putDraftMedia(draft.id, role, originalName, png);
    ensureDraft(repository,draft.id);
    const capacity = role === 'REFERENCE' ? PATTERN_DRAFT_REFERENCES_MAX : PATTERN_DRAFT_ANNOTATIONS_MAX;
    if (repository.countDraftMedia(draft.id,role) >= capacity) throw new ApiError('VALIDATION_ERROR',`该类型草稿媒体最多保留 ${capacity} 张。`);
    const media = repository.createDraftMedia({ draftId: draft.id, role, source, sourcePatternId, storagePath: stored.path, fileHash: stored.hash, mimeType: "image/png", width: info.width ?? null, height: info.height ?? null, originalName, notes });
    return publicMedia(media);
},
updateDraftMedia: function* (command: Input<'updateDraftMedia'>): CommandFlow<unknown> {
    const draft = ensureDraft(repository, readText(command.draftId, "draftId"));
    const media = ensureDraftMedia(repository, draft.id, readText(command.mediaId, "mediaId"));
    const body = readObject(command ?? {}, "body");
    const patch: {
        notes?: string | null;
    } = {};
    if (body.notes !== undefined) {
        const notes = readPatchText(body.notes, "notes") ?? null;
        assertNotesLength(notes);
        patch.notes = notes;
    }
    const updated = repository.updateDraftMedia(media.id, patch);
    if (!updated)
        missing("draft media", media.id);
    return publicMedia(updated);
},
deleteDraftMedia: function* (command: Input<'deleteDraftMedia'>): CommandFlow<unknown> {
    const draft = ensureDraft(repository, readText(command.draftId, "draftId"));
    const media = ensureDraftMedia(repository, draft.id, readText(command.mediaId, "mediaId"));
    const referenced = repository.isDraftStoragePathReferenced(draft.id, media.storagePath);
    repository.deleteDraftMedia(media.id);
    if (!referenced)
        yield storage.delete(media.storagePath);
    return null;
},
listDraftBatches: function* (command: Input<'listDraftBatches'>): CommandFlow<unknown> {
    const draft = ensureDraft(repository, readText(command.draftId, "draftId"));
    const batches = repository.listDraftBatches(draft.id).map((batch) => ({ batch, slots: repository.listDraftSlots(batch.id) }));
    const jobs = repository.listJobsByIds(batches.flatMap(({ slots }) => slots.flatMap((slot) => (slot.jobId ? [slot.jobId] : []))));
    const items = batches.map(({ batch, slots }) => publicBatch(batch, slots, repository.listDraftCandidatesByBatch(batch.id), jobs));
    return { items };
},
listDraftCandidates: function* (command: Input<'listDraftCandidates'>): CommandFlow<unknown> {
    const draft = ensureDraft(repository, readText(command.draftId, "draftId"));
    return { items: repository.listDraftCandidates(draft.id).map(publicCandidate) };
},
deleteDraftCandidate: function* (command: Input<'deleteDraftCandidate'>): CommandFlow<unknown> {
    const draft = ensureDraft(repository, readText(command.draftId, "draftId"));
    const candidate = ensureDraftCandidate(repository, draft.id, readText(command.candidateId, "candidateId"));
    const activeSlot = repository.listDraftSlots(candidate.batchId).some((slot) => slot.status === "QUEUED" || slot.status === "RUNNING");
    if (activeSlot)
        throw new ApiError("CONFLICT", "本批仍在生成中，等本批结束后再删除候选");
    const activeParent = repository.listDraftParentBatches(draft.id, candidate.id)
        .some((batchId) => repository.listDraftSlots(batchId).some((slot) => slot.status === "QUEUED" || slot.status === "RUNNING"));
    if (activeParent)
        throw new ApiError("CONFLICT", "该候选正被一轮进行中的改稿使用，等它结束后再删除");
    const storedPath = candidate.storagePath;
    if (!repository.deleteDraftCandidate(candidate.id))
        missing("draft candidate", candidate.id);
    yield storage.delete(storedPath);
    return null;
},
createDraftBatch: function* (command: Input<'createDraftBatch'>): CommandFlow<unknown> {
    const draft = ensureDraft(repository, readText(command.draftId, "draftId"));
    const body = bodyOf(command, ["draftId"]);
    const outcome = yield* submitDraftBatch(draft, body, undefined);
    return outcome;
},
retryFailedDraftBatch: function* (command: Input<'retryFailedDraftBatch'>): CommandFlow<unknown> {
    const draft = ensureDraft(repository, readText(command.draftId, "draftId"));
    const batch = ensureDraftBatch(repository, draft.id, readText(command.batchId, "batchId"));
    const allSlots = repository.listDraftSlots(batch.id);
    const failed = allSlots.filter((slot) => slot.status === "FAILED");
    const allJobs = slotJobs(repository, allSlots);
    if (allSlots.some(s => s.status === 'UNKNOWN') || [...allJobs.values()].some(j => j.status === 'UNKNOWN' || ctx.requestLedger.hasUnknown(j.id))) throw new ApiError('EXTERNAL_UNKNOWN','未知外部结果不能通过失败补偿重发。');
    const activeJob = allSlots
        .map((slot) => (slot.jobId ? allJobs.get(slot.jobId) : undefined))
        .find((job) => job?.status === "QUEUED" || job?.status === "RUNNING");
    // 同一执行器还会继续处理其他槽位；此时不能改变任一冻结槽位的归属或 attempt。
    if (activeJob)
        return { batch: publicBatch(batch, allSlots, repository.listDraftCandidatesByBatch(batch.id), allJobs), job: publicJobRef(activeJob), reused: true };
    if (!failed.length)
        throw new ApiError("CONFLICT", "该批次没有失败槽位");
    const owners = new Map<string, JobRecord>();
    for (const slot of failed) {
        const owner = slot.jobId ? allJobs.get(slot.jobId) : undefined;
        if (!owner || !owner.retryable || !["FAILED", "CANCELLED"].includes(owner.status))
            throw new ApiError("CONFLICT", "失败槽位缺少可安全恢复的原任务，请检查任务状态。");
        owners.set(owner.id, owner);
    }
    // 命令同步事务覆盖全部原任务；其中任何一个不能安全恢复时，整批回滚，不能只补第一组。
    // 成功回执继续原请求；完整明确拒绝的失败槽位才建立独立替代意图，继承原冻结配置。
    const recoveries = [...owners.values()].map(owner => compensateDraftJob(ctx, owner));
    const resumed = recoveries.flatMap(recovery => recovery.jobs);
    const updatedSlots = repository.listDraftSlots(batch.id);
    return { batch: publicBatch(batch, updatedSlots, repository.listDraftCandidatesByBatch(batch.id), slotJobs(repository, updatedSlots)), job: publicJobRef(resumed[0]!), reused: !recoveries.some(recovery => recovery.replaced) };
},
createDraftCandidateEdit: function* (command: Input<'createDraftCandidateEdit'>): CommandFlow<unknown> {
    const draft = ensureDraft(repository, readText(command.draftId, "draftId"));
    const candidate = ensureDraftCandidate(repository, draft.id, readText(command.candidateId, "candidateId"));
    const body = bodyOf(command, ["draftId", "candidateId"]);
    const outcome = yield* submitDraftBatch(draft, body, candidate.id);
    return outcome;
},
checkDraftCandidateTileability: function* (command: Input<'checkDraftCandidateTileability'>): CommandFlow<unknown> {
    const draft = ensureDraft(repository, readText(command.draftId, "draftId"));
    const candidate = ensureDraftCandidate(repository, draft.id, readText(command.candidateId, "candidateId"));
    const job = repository.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type: "PATTERN_DRAFT_PROCESS", input: { draftId: draft.id, candidateId: candidate.id, task: "TILE_CHECK" }, requestFingerprint: null, providerId: null, modelId: null, estimatedCost: null });
    yield ctx.queue(job);
    return publicJobRef(job);
},
finalizeDraftCandidate: function* (command: Input<'finalizeDraftCandidate'>): CommandFlow<unknown> {
    const draft = ensureDraft(repository, readText(command.draftId, "draftId"));
    const candidate = ensureDraftCandidate(repository, draft.id, readText(command.candidateId, "candidateId"));
    const body = bodyOf(command, ["draftId", "candidateId"]);
    const existing = repository.getPatternByDraftCandidateId(candidate.id);
    if (existing)
        return { pattern: publicPattern(existing), reused: true } satisfies FinalizeDraftCandidateResponse;
    const name = body.name === undefined ? `${draft.name} 定稿` : readText(body.name, "name");
    if (name.length > MAX_PATTERN_DRAFT_NAME_LENGTH)
        throw new ApiError("VALIDATION_ERROR", `name must be at most ${MAX_PATTERN_DRAFT_NAME_LENGTH} characters`);
    const bytes = yield storage.read(candidate.storagePath);
    if (!repository.getDraftCandidate(candidate.id))
        throw new ApiError("CONFLICT", "候选已被删除，无法定稿");
    const patternId = randomUUID();
    const stored = yield storage.putPatternArtifact(patternId, "pattern", bytes);
    const committed = repository.getPatternByDraftCandidateId(candidate.id);
    if (committed) return {pattern:publicPattern(committed),reused:true} satisfies FinalizeDraftCandidateResponse;
    if (!repository.getDraftCandidate(candidate.id) || !repository.getPatternDraft(draft.id)) throw new ApiError('CONFLICT','候选或草稿已被删除，无法定稿。');
    const sourceJobId = repository.listDraftSlots(candidate.batchId).find(slot => slot.index === candidate.slotIndex)?.jobId ?? null;
    const pattern = repository.createPattern({
        id: patternId,
        name,
        sourceType: "GENERATED",
        sourceJobId,
        sourceAssetHash: candidate.fileHash,
        parentPatternId: null,
        storagePath: stored.path,
        fileHash: stored.hash,
        width: candidate.width,
        height: candidate.height,
        tags: [],
        sourceDraftCandidateId: candidate.id,
        tileable: candidate.tileable,
        tileableScore: candidate.tileableScore,
        tileableCheckedWith: candidate.tileableCheckedWith,
    });
    repository.setPatternDraftSelectedCandidate(draft.id, candidate.id);
    return { pattern: publicPattern(pattern), reused: false } satisfies FinalizeDraftCandidateResponse;
}
};
}
