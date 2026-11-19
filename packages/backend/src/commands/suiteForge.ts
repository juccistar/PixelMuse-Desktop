import { randomUUID } from "node:crypto";
import type { EcomRepository, SuiteForgeResultRecord } from "@ecomgen/core";
import { requestFingerprint } from "@ecomgen/core";
import type { SuiteDocumentInput } from "@ecomgen/ecom-suite";
import { MAX_SUITE_FORGE_INSTRUCTION_LENGTH, MAX_SUITE_FORGE_NAME_LENGTH, MAX_SUITE_FORGE_SHOTS, MAX_SUITE_FORGE_SOURCES, MIN_SUITE_FORGE_SHOTS } from "@ecomgen/contracts";
import { ApiError } from "./support.js";
import { contentHash, imageDimensions, missing } from "./helpers.js";
import { parseBody } from "./support.js";
import { readOptionalText, readText } from "./input-normalizers.js";
import { suiteIdForImport, assertValidSuiteDocument } from "./suites.js";
import type { Input } from '@ecomgen/contracts';
import { bodyOf, readImageInput, readSingleImageInput, type CommandFlow, type CommandScope } from './support.js';
const SUITE_FORGE_LIST_DEFAULT = 20;
const SUITE_FORGE_LIST_MAX = 50;
function publicSuiteForgeResult(record: SuiteForgeResultRecord): object { return { jobId: record.jobId, status: record.status, suite: record.payload, suiteId: record.suiteId ?? null, createdAt: record.createdAt, updatedAt: record.updatedAt }; }
function suiteForgeListLimit(query: unknown): number {
    const raw = (query as Record<string, unknown> | null | undefined)?.limit;
    const text = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
    if (typeof raw === "number") return raw;
    if (text === undefined)
        return SUITE_FORGE_LIST_DEFAULT;
    const parsed = Number.parseInt(text, 10);
    if (!Number.isFinite(parsed))
        throw new ApiError("VALIDATION_ERROR", "limit must be an integer");
    return Math.min(Math.max(parsed, 1), SUITE_FORGE_LIST_MAX);
}
export function suiteForgeHints(fields: Record<string, string>): Record<string, unknown> {
    const hints: Record<string, unknown> = {};
    const name = readOptionalText(fields.name);
    if (name)
        hints.name = boundedText(name, MAX_SUITE_FORGE_NAME_LENGTH, "name");
    const l1 = readOptionalText(fields.l1);
    if (l1)
        hints.l1 = l1;
    const l2 = readOptionalText(fields.l2);
    if (l2)
        hints.l2 = l2;
    const leaf = readOptionalText(fields.leaf);
    if (leaf)
        hints.leaf = leaf;
    const productFamily = readOptionalText(fields.productFamily);
    if (productFamily)
        hints.productFamily = productFamily;
    const targetShotCount = readOptionalText(fields.targetShotCount);
    if (targetShotCount) {
        const count = Number(targetShotCount);
        if (!Number.isInteger(count) || count < MIN_SUITE_FORGE_SHOTS || count > MAX_SUITE_FORGE_SHOTS)
            throw new ApiError("VALIDATION_ERROR", `targetShotCount must be an integer between ${MIN_SUITE_FORGE_SHOTS} and ${MAX_SUITE_FORGE_SHOTS}`);
        hints.targetShotCount = count;
    }
    const userInstruction = readOptionalText(fields.userInstruction);
    if (userInstruction)
        hints.userInstruction = boundedText(userInstruction, MAX_SUITE_FORGE_INSTRUCTION_LENGTH, "userInstruction");
    return hints;
}
function boundedText(value: string, maxLength: number, field: string): string {
    if (value.length > maxLength)
        throw new ApiError("VALIDATION_ERROR", `${field} must be at most ${maxLength} characters`);
    return value;
}
export function verifyVisionModel(repository: EcomRepository, providerId: string, modelId: string): void {
    const provider = repository.getProvider(providerId);
    if (!provider)
        missing("provider", providerId);
    const model = provider.models.find((candidate) => candidate.id === modelId);
    if (!model)
        throw new ApiError("VALIDATION_ERROR", "Selected reasoning model is not declared by its provider");
    if (!model.supportsVision)
        throw new ApiError("CAPABILITY_UNSUPPORTED", "Selected reasoning model must support Vision for suite forging");
}
export function suiteForgeCommands(ctx: CommandScope) {
const { repository, storage, catalog: suiteCatalog, } = ctx;
return {
listSuiteForgeJobResults: function* (command: Input<'listSuiteForgeJobResults'>): CommandFlow<unknown> {
    const items = repository.listJobsByType("SUITE_FORGE", suiteForgeListLimit(command)).map((job) => {
        const draft = repository.getSuiteForgeResult(job.id);
        return {
            jobId: job.id,
            status: job.status,
            progress: job.progress,
            cancelRequested: job.cancelRequested,
            error: job.error,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            draft: draft
                ? { name: draft.payload.name, l1: draft.payload.category.l1, l2: draft.payload.category.l2, leaf: draft.payload.category.leaf, shotCount: draft.payload.shots.length, suiteId: draft.suiteId }
                : null
        };
    });
    return { items };
},
getSuiteForgeResult: function* (command: Input<'getSuiteForgeResult'>): CommandFlow<unknown> {
    const jobId = readText(command.jobId, "jobId");
    const record = repository.getSuiteForgeResult(jobId);
    if (!record)
        missing("suite forge result", jobId);
    return publicSuiteForgeResult(record);
},
commitSuiteForgeResult: function* (command: Input<'commitSuiteForgeResult'>): CommandFlow<unknown> {
    const jobId = readText(command.jobId, "jobId");
    const record = repository.getSuiteForgeResult(jobId);
    if (!record)
        missing("suite forge result", jobId);
    if (record.status === "COMMITTED" && record.suiteId)
        return publicSuiteForgeResult(record);
    const body = bodyOf(command, ["jobId"]);
    const requested = typeof body.id === "string" && body.id ? body.id : record.payload.id;
    const id = requested && requested.startsWith("custom-suite-") && !suiteCatalog.getSuite(requested) ? requested : suiteIdForImport(undefined, suiteCatalog);
    const edited = { ...body, id } as unknown as SuiteDocumentInput;
    assertValidSuiteDocument(edited);
    repository.saveSuiteForgeResult({ jobId, payload: edited });
    const saved = repository.saveUserSuite({ id, name: edited.name, l1: edited.category.l1, l2: edited.category.l2, leaf: edited.category.leaf, productFamily: edited.productFamily ?? null, payload: edited });
    suiteCatalog.upsertUserSuite(saved);
    const committed = repository.commitSuiteForgeResult(jobId, id) ?? record;
    return publicSuiteForgeResult(committed);
}
};
}
