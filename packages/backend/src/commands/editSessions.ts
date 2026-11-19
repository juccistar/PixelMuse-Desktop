import {resourceUrlFor} from '@ecomgen/contracts';
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { AssetRecord, EditReferenceAssetRecord, EditSessionRecord, LocalAssetStore, ProjectRecord } from "@ecomgen/core";
import type { EcomRepository } from "@ecomgen/core";
import { requestFingerprint } from "@ecomgen/core";
import { EditGenerationConfigInput, MAX_GENERATION_REFERENCE_IMAGES } from "@ecomgen/contracts";
import type { AssetRole, ImageResolution, ReferencePurpose } from "@ecomgen/contracts";
type ReferenceSelection = NonNullable<ReturnType<EcomRepository['getEditTurn']>>['referenceSelections'][number];
import { ApiError } from "./support.js";
import { assertProjectAssetCapacity, assertProjectAssetHashUnique, clampCandidates, contentHash, ensureProject, missing, parseAssetRole, verifyModel, } from "./helpers.js";
import { parseBody } from "./support.js";
import { enumValue, readJsonObject, readJsonTextArray, readObject, readOptionalText, readText, readTextArray } from "./input-normalizers.js";
import type { Input } from '@ecomgen/contracts';
import { bodyOf, readImageInput, readSingleImageInput, type CommandFlow, type CommandScope } from './support.js';
import { assertProjectImageWorkAllowed } from '../execution/image-work-barrier.js';
import { outputImagePlanning } from '../execution/snapshot.js';
export function publicReferenceAsset(value: AssetRecord | EditReferenceAssetRecord): object {
    const temporary = "sessionId" in value;
    return { id: value.id, source: temporary ? "TEMPORARY" : "PROJECT", purpose: temporary ? value.purpose : defaultPurposeForRole(value.role), role: temporary ? null : value.role, originalName: value.originalName, mimeType: value.mimeType, hash: value.hash, createdAt: value.createdAt, expiresAt: temporary ? value.expiresAt : null, url: temporary ? resourceUrlFor({kind:'EDIT_REFERENCE',id:value.id}) : resourceUrlFor({kind:'ASSET',id:value.id}) };
}
function defaultPurposeForRole(role: AssetRole): ReferencePurpose { return role === "PRODUCT_TRUTH" ? "PRODUCT_APPEARANCE" : role === "PACKAGING" ? "PACKAGING" : role === "STYLE_REFERENCE" ? "STYLE" : "LAYOUT"; }
function roleForReferencePurpose(purpose: ReferencePurpose): AssetRole { return purpose === "PRODUCT_APPEARANCE" ? "PRODUCT_TRUTH" : purpose === "PACKAGING" || purpose === "LABEL" ? "PACKAGING" : purpose === "STYLE" ? "STYLE_REFERENCE" : "LAYOUT_REFERENCE"; }
function editTurnDetails(repository: EcomRepository, turn: NonNullable<ReturnType<EcomRepository['getEditTurn']>>, jobs = repository.listJobs(turn.projectId)) {
    const job = ['UNKNOWN', 'FAILED'].includes(turn.status) ? jobs.filter(job => job.status === turn.status && ['EDIT_PLAN', 'EDIT_GENERATE'].includes(job.type) && (job.input.editTurnId ?? job.input.turnId) === turn.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] : undefined;
    return { ...turn, ...(job ? { recoveryJobId: job.id } : {}) };
}
function editSessionDetails(repository: EcomRepository, session: EditSessionRecord): object {
    const editOutputs = repository.listEditOutputs(session.id);
    const rootIds = new Set(editOutputs.map((output) => output.rootOutputId).filter((id): id is string => Boolean(id)));
    const candidates = [...editOutputs, ...[...rootIds].map((id) => repository.getOutput(id)).filter((output): output is NonNullable<typeof output> => Boolean(output)), repository.getOutput(session.currentOutputId)].filter((output): output is NonNullable<typeof output> => Boolean(output)).filter((output, index, all) => all.findIndex((candidate) => candidate.id === output.id) === index);
    const current = repository.getOutput(session.currentOutputId);
    const byId = new Map(candidates.map((output) => [output.id, output]));
    const relatedIds = new Set<string>();
    let ancestor = current;
    while (ancestor) {
        relatedIds.add(ancestor.id);
        ancestor = ancestor.parentOutputId ? byId.get(ancestor.parentOutputId) : undefined;
    }
    const descendants = [current].filter((output): output is NonNullable<typeof output> => Boolean(output));
    while (descendants.length > 0) {
        const parent = descendants.shift();
        if (!parent)
            continue;
        for (const child of candidates) {
            if (child.parentOutputId !== parent.id || relatedIds.has(child.id))
                continue;
            relatedIds.add(child.id);
            descendants.push(child);
        }
    }
    const versions = candidates.filter((output) => relatedIds.has(output.id)).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const jobs = repository.listJobs(session.projectId);
    return { ...session, memorySummary: effectiveEditMemory(repository, session, session.currentOutputId), turns: repository.listEditTurns(session.id).map(turn => editTurnDetails(repository, turn, jobs)), versions };
}
function effectiveEditMemory(repository: EcomRepository, session: EditSessionRecord, outputId: string): {
    summary?: string;
    constraints?: string[];
    sourceOutputId?: string;
} {
    const scopes = session.memorySummary.scopes ?? {};
    let current = repository.getOutput(outputId);
    while (current) {
        const scoped = scopes[current.id];
        if (scoped)
            return { ...scoped, sourceOutputId: current.id };
        current = current.parentOutputId ? repository.getOutput(current.parentOutputId) : undefined;
    }
    const output = repository.getOutput(outputId);
    return output && !output.parentOutputId
        ? { summary: session.memorySummary.summary, constraints: session.memorySummary.constraints, sourceOutputId: output.id }
        : {};
}
interface EditGenerationConfig {
    reasoningProviderId: string;
    reasoningModelId: string;
    imageProviderId: string;
    imageModelId: string;
    imageResolution: ImageResolution;
    candidateCount: number;
}
export function editGenerationConfigFor(repository: EcomRepository, project: ProjectRecord, annotations: Record<string, unknown>): EditGenerationConfig {
    const raw = annotations.generationConfig;
    if (raw === undefined) {
        if (!project.reasoningProviderId || !project.reasoningModelId || !project.imageProviderId || !project.imageModelId) {
            throw new ApiError("PROVIDER_NOT_CONFIGURED", "请先在项目设置中选择推理与图片模型");
        }
        return { reasoningProviderId: project.reasoningProviderId, reasoningModelId: project.reasoningModelId, imageProviderId: project.imageProviderId, imageModelId: project.imageModelId, imageResolution: project.imageResolution, candidateCount: clampCandidates(project.candidatesPerType) };
    }
    const config = parseBody(EditGenerationConfigInput, raw, { pathPrefix: "annotations.generationConfig" });
    const reasoningProviderId = readText(config.reasoningProviderId, "annotations.generationConfig.reasoningProviderId");
    const reasoningModelId = readText(config.reasoningModelId, "annotations.generationConfig.reasoningModelId");
    const imageProviderId = readText(config.imageProviderId, "annotations.generationConfig.imageProviderId");
    const imageModelId = readText(config.imageModelId, "annotations.generationConfig.imageModelId");
    verifyModel(repository, reasoningProviderId, reasoningModelId, "reasoning");
    verifyModel(repository, imageProviderId, imageModelId, "image");
    return { reasoningProviderId, reasoningModelId, imageProviderId, imageModelId, imageResolution: config.imageResolution === undefined ? project.imageResolution : config.imageResolution, candidateCount: config.candidateCount === undefined ? clampCandidates(project.candidatesPerType) : config.candidateCount };
}
export function parseReferenceSelections(value: string | undefined): ReferenceSelection[] {
    if (!value)
        return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    }
    catch {
        throw new ApiError("VALIDATION_ERROR", "referenceSelections must be valid JSON");
    }
    if (!Array.isArray(parsed))
        throw new ApiError("VALIDATION_ERROR", "referenceSelections must be an array");
    const purposes: ReferencePurpose[] = ["PRODUCT_APPEARANCE", "PACKAGING", "LABEL", "STYLE", "LAYOUT"];
    const seen = new Set<string>();
    const selections = parsed.map((item, index) => {
        const entry = readObject(item, `referenceSelections[${index}]`);
        const id = readText(entry.id, `referenceSelections[${index}].id`);
        const source = enumValue<"PROJECT" | "TEMPORARY">(entry.source, ["PROJECT", "TEMPORARY"], `referenceSelections[${index}].source`);
        const purpose = enumValue<ReferencePurpose>(entry.purpose, purposes, `referenceSelections[${index}].purpose`);
        if (seen.has(`${source}:${id}`))
            throw new ApiError("VALIDATION_ERROR", "referenceSelections cannot contain duplicates");
        seen.add(`${source}:${id}`);
        return { id, source, purpose, order: index };
    });
    return selections;
}
export async function validateMaskDimensions(sourcePath: string, mask: Buffer, storage: LocalAssetStore): Promise<void> {
    const [source, candidate] = await Promise.all([sharp(await storage.read(sourcePath)).metadata(), sharp(mask).metadata()]);
    if (!source.width || !source.height || source.width !== candidate.width || source.height !== candidate.height)
        throw new ApiError("VALIDATION_ERROR", "MASK_DIMENSION_MISMATCH");
}
export function editSessionsCommands(ctx: CommandScope) {
const { repository, storage, events, } = ctx;
return {
createEditSession: function* (command: Input<'createEditSession'>): CommandFlow<unknown> {
    const projectId = readText(command.projectId, "projectId");
    const outputId = readText(command.outputId, "outputId");
    ensureProject(repository, projectId);
    const output = repository.getOutput(outputId);
    if (!output || output.projectId !== projectId)
        missing("output", outputId);
    const existing = repository.getActiveEditSession(projectId, outputId);
    if (existing) {
        const selected = existing.currentOutputId === outputId ? existing : repository.updateEditSession(existing.id, { currentOutputId: outputId });
        if (!selected)
            missing("edit session", existing.id);
        return editSessionDetails(repository, selected);
    }
    return editSessionDetails(repository, repository.createEditSession({ id: randomUUID(), projectId, currentOutputId: outputId, status: "ACTIVE", memorySummary: {} }));
},
getEditSession: function* (command: Input<'getEditSession'>): CommandFlow<unknown> {
    const session = repository.getEditSession(readText(command.sessionId, "sessionId"));
    if (!session)
        missing("edit session", readText(command.sessionId, "sessionId"));
    return editSessionDetails(repository, session);
},
listEditReferenceAssets: function* (command: Input<'listEditReferenceAssets'>): CommandFlow<unknown> {
    const session = repository.getEditSession(readText(command.sessionId, "sessionId"));
    if (!session)
        missing("edit session", readText(command.sessionId, "sessionId"));
    const projectAssets = repository.listAssets(session.projectId).map((asset) => publicReferenceAsset(asset));
    const nowIso = new Date().toISOString();
    const temporaryAssets = repository.listEditReferenceAssets(session.id).filter((asset) => asset.expiresAt > nowIso).map((asset) => publicReferenceAsset(asset));
    const previousTurn = repository.listEditTurns(session.id).at(-1);
    return { items: [...projectAssets, ...temporaryAssets], suggestedSelections: previousTurn?.referenceSelections ?? [] };
},
updateEditSessionMemory: function* (command: Input<'updateEditSessionMemory'>): CommandFlow<unknown> {
    const session = repository.getEditSession(readText(command.sessionId, "sessionId"));
    if (!session)
        missing("edit session", readText(command.sessionId, "sessionId"));
    const body = bodyOf(command, ["sessionId"]);
    const outputId = body.outputId === undefined ? session.currentOutputId : readText(body.outputId, "outputId");
    const output = repository.getOutput(outputId);
    if (!output || output.projectId !== session.projectId || !repository.isOutputInEditSession(session.id, outputId))
        throw new ApiError("VALIDATION_ERROR", "outputId must belong to the edit session");
    const summary = readOptionalText(body.summary) ?? "";
    const constraints = body.constraints === undefined ? (session.memorySummary.scopes?.[outputId]?.constraints ?? session.memorySummary.constraints ?? []) : readTextArray(body.constraints, "constraints");
    const scopes = { ...(session.memorySummary.scopes ?? {}), [outputId]: { summary, constraints } };
    const updated = repository.updateEditSession(session.id, { memorySummary: { ...session.memorySummary, scopes } });
    if (!updated)
        missing("edit session", session.id);
    yield ctx.events.publish({ topic: "editSessions", projectId: session.projectId });
    return editSessionDetails(repository, updated);
},
getEditTurn: function* (command: Input<'getEditTurn'>): CommandFlow<unknown> {
    const turn = repository.getEditTurn(readText(command.turnId, "turnId"));
    if (!turn)
        missing("edit turn", readText(command.turnId, "turnId"));
    return editTurnDetails(repository, turn);
},
approveEditTurn: function* (command: Input<'approveEditTurn'>): CommandFlow<unknown> {
    const turn = repository.getEditTurn(readText(command.turnId, "turnId"));
    if (!turn)
        missing("edit turn", readText(command.turnId, "turnId"));
    const fingerprint = requestFingerprint({ type: "EDIT_GENERATE", projectId: turn.projectId, editTurnId: turn.id, plan: turn.plan });
    const existing = repository.findJobByFingerprint(turn.projectId, fingerprint);
    if (existing)
        return { job: existing, turn: repository.getEditTurn(turn.id) };
    if (turn.status !== "AWAITING_CONFIRMATION" && turn.status !== "PLAN_READY")
        throw new ApiError("CONFLICT", "Edit turn is not ready for generation");
    const project = repository.getProject(turn.projectId);
    if (!project)
        missing("project", turn.projectId);
    const generationConfig = editGenerationConfigFor(repository, project, turn.annotations);
    const source = repository.getOutput(turn.baseOutputId);
    assertProjectImageWorkAllowed(repository, ctx.requestLedger, turn.projectId, { imagePlanning: Boolean(outputImagePlanning(source?.generationSnapshot)) });
    repository.updateEditTurn(turn.id, { status: "GENERATING", error: null });
    const job = repository.createJob({ id: randomUUID(), projectId: turn.projectId, storyboardItemId: null, type: "EDIT_GENERATE", input: { editTurnId: turn.id }, requestFingerprint: fingerprint, providerId: generationConfig.imageProviderId, modelId: generationConfig.imageModelId, estimatedCost: { status: "UNKNOWN", unit: "provider-defined" } });
    yield ctx.queue(job);
    return { job, turn: repository.getEditTurn(turn.id) };
},
selectEditSessionOutput: function* (command: Input<'selectEditSessionOutput'>): CommandFlow<unknown> {
    const session = repository.getEditSession(readText(command.sessionId, "sessionId"));
    if (!session)
        missing("edit session", readText(command.sessionId, "sessionId"));
    const body = bodyOf(command, ["sessionId"]);
    const outputId = readText(body.outputId, "outputId");
    const output = repository.getOutput(outputId);
    if (!output || output.projectId !== session.projectId)
        throw new ApiError("VALIDATION_ERROR", "outputId must belong to this project");
    if (!repository.isOutputInEditSession(session.id, output.id))
        throw new ApiError("VALIDATION_ERROR", "outputId is not part of this edit session");
    const updated = repository.updateEditSession(session.id, { currentOutputId: outputId });
    if (!updated)
        missing("edit session", session.id);
    yield ctx.events.publish({ topic: "editSessions", projectId: session.projectId });
    return editSessionDetails(repository, updated);
}
};
}
