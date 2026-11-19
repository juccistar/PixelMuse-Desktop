import {resourceUrlFor} from '@ecomgen/contracts';
import { randomUUID } from "node:crypto";
import type { ModelPortraitRecord, ModelRecord } from "@ecomgen/core";
import { requestFingerprint } from "@ecomgen/core";
import { findModelSpecConflicts } from "@ecomgen/ecom-skill";
import type { ModelSpec } from "@ecomgen/contracts";
import { ApiError } from "./support.js";
import { ensureModel, missing, reusableFingerprintedJob, verifyModel } from "./helpers.js";
import { parseBody } from "./support.js";
import { readPatchText, readText } from "./input-normalizers.js";
import type { Input } from '@ecomgen/contracts';
import { bodyOf, readImageInput, readSingleImageInput, type CommandFlow, type CommandScope } from './support.js';
export function assertModelSpecCoherent(spec: ModelSpec): void {
    const conflicts = findModelSpecConflicts(spec);
    if (conflicts.length === 0)
        return;
    throw new ApiError("VALIDATION_ERROR", `模特规格存在互斥组合：${conflicts.map((conflict) => conflict.reason).join("；")}`, conflicts.map((conflict) => ({ path: `/spec/${conflict.field}`, reason: conflict.reason })));
}
function publicModelPortrait(portrait: ModelPortraitRecord) {
    return {
        id: portrait.id,
        modelId: portrait.modelId,
        url: resourceUrlFor({kind:'PORTRAIT',id:portrait.id}),
        width: portrait.width,
        height: portrait.height,
        providerId: portrait.providerId,
        imageModelId: portrait.imageModelId,
        aspectRatio: portrait.aspectRatio,
        selected: portrait.selected,
        createdAt: portrait.createdAt,
    };
}
export function publicModel(record: ModelRecord, portraits: ReadonlyArray<ModelPortraitRecord>) {
    const selected = portraits.find((portrait) => portrait.selected) ?? null;
    return {
        id: record.id,
        name: record.name,
        spec: record.spec,
        notes: record.notes,
        hasReferenceFace: record.referenceFacePath !== null,
        ...(record.referenceFacePath ? { referenceFaceUrl: resourceUrlFor({kind:'MODEL_FACE',id:`${record.id}-${record.referenceFaceHash}`}) } : {}),
        selectedPortrait: selected ? publicModelPortrait(selected) : null,
        portraitCount: portraits.length,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
}
export function modelsCommands(ctx: CommandScope) {
const { repository, storage, } = ctx;
return {
listModels: function* (command: Input<'listModels'>): CommandFlow<unknown> {
    const portraitsByModel = new Map<string, ModelPortraitRecord[]>();
    for (const portrait of repository.listAllModelPortraits()) {
        const bucket = portraitsByModel.get(portrait.modelId);
        if (bucket)
            bucket.push(portrait);
        else
            portraitsByModel.set(portrait.modelId, [portrait]);
    }
    return { items: repository.listModels().map((record) => publicModel(record, portraitsByModel.get(record.id) ?? [])), nextCursor: null };
},
createModel: function* (command: Input<'createModel'>): CommandFlow<unknown> {
    const body = bodyOf(command, []);
    assertModelSpecCoherent(body.spec);
    const record = repository.createModel({ name: readText(body.name, "name"), spec: body.spec, notes: body.notes ?? "" });
    return publicModel(record, []);
},
getModel: function* (command: Input<'getModel'>): CommandFlow<unknown> {
    const record = ensureModel(repository, readText(command.modelId, "modelId"));
    return publicModel(record, repository.listModelPortraits(record.id));
},
updateModel: function* (command: Input<'updateModel'>): CommandFlow<unknown> {
    const current = ensureModel(repository, readText(command.modelId, "modelId"));
    const body = bodyOf(command, ["modelId"]);
    if (body.spec)
        assertModelSpecCoherent(body.spec);
    const patch: {
        name?: string;
        spec?: ModelSpec;
        notes?: string;
    } = {};
    if (body.name !== undefined)
        patch.name = readText(body.name, "name");
    if (body.spec !== undefined)
        patch.spec = body.spec;
    if (body.notes !== undefined)
        patch.notes = readPatchText(body.notes, "notes");
    const record = repository.updateModel(current.id, patch) ?? current;
    return publicModel(record, repository.listModelPortraits(record.id));
},
createModelCastJob: function* (command: Input<'createModelCastJob'>): CommandFlow<unknown> {
    const model = ensureModel(repository, readText(command.modelId, "modelId"));
    const body = bodyOf(command, ["modelId"]);
    verifyModel(repository, body.providerId, body.imageModelId, "image");
    const candidateCount = body.candidateCount ?? 1;
    const idempotencyKey = ((command as {
        idempotencyKey?: string;
    }).idempotencyKey as string | undefined) ?? null;
    const fingerprint = requestFingerprint({ type: "MODEL_CAST", modelId: model.id, spec: model.spec, notes: model.notes, referenceFaceHash: model.referenceFaceHash, providerId: body.providerId, imageModelId: body.imageModelId, aspectRatio: body.aspectRatio, imageResolution: body.imageResolution ?? null, quality: body.quality ?? null, outputFormat: body.outputFormat ?? null, candidateCount, idempotencyKey });
    const existing = repository.findJobByFingerprint(null, fingerprint);
    if (existing && reusableFingerprintedJob(existing, repository.listModelPortraitsByJobId(existing.id).length > 0))
        return existing;
    const job = repository.createJob({ id: randomUUID(), projectId: null, storyboardItemId: null, type: "MODEL_CAST", input: { modelId: model.id, aspectRatio: body.aspectRatio, imageResolution: body.imageResolution ?? null, quality: body.quality ?? null, outputFormat: body.outputFormat ?? null, candidateCount, spec: model.spec, notes: model.notes, referenceFacePath: model.referenceFacePath }, requestFingerprint: fingerprint, providerId: body.providerId, modelId: body.imageModelId, estimatedCost: { status: "UNKNOWN", unit: "provider-defined" } });
    yield ctx.queue(job);
    return job;
},
listModelPortraits: function* (command: Input<'listModelPortraits'>): CommandFlow<unknown> {
    const model = ensureModel(repository, readText(command.modelId, "modelId"));
    return { items: repository.listModelPortraits(model.id).map(publicModelPortrait) };
},
selectModelPortrait: function* (command: Input<'selectModelPortrait'>): CommandFlow<unknown> {
    const id = readText(command.portraitId, "portraitId");
    const portrait = repository.getModelPortrait(id);
    if (!portrait)
        missing("model portrait", id);
    repository.selectModelPortrait(portrait.modelId, id);
    const model = ensureModel(repository, portrait.modelId);
    return publicModel(model, repository.listModelPortraits(model.id));
}
};
}
