import type { EcomRepository, PatternPipelineWithSteps } from "@ecomgen/core";
import { nextPipelineStep, pipelineStepPlan, requestFingerprint, resetPipelineStepsFrom, settlePipelineStep, startPipelineStep, } from "@ecomgen/core";
import { PatternPipelineAnswers, PATTERN_PIPELINE_STEPS, POD_PRINT_SPEC_VERSION, getPodPrintSpec } from "@ecomgen/contracts";
import { ApiError } from "./support.js";
import { ensurePattern, ensurePatternPipeline, missing, verifyCopywritingModel } from "./helpers.js";
import { parseBody } from "./support.js";
import { enumValue, readOptionalText, readText } from "./input-normalizers.js";
import type { Input } from '@ecomgen/contracts';
import { bodyOf, readImageInput, readSingleImageInput, type CommandFlow, type CommandScope } from './support.js';
export function* startPatternPipeline(ctx: CommandScope, input: {
    patternId: string | null;
    patternHash: string | null;
    answers: PatternPipelineAnswers;
    sourceJobId?: string;
    idempotencyKey?: string | null;
}): CommandFlow<{
    pipeline: PatternPipelineWithSteps;
    reused: boolean;
}> {
    const { repository } = ctx;
    const spec = validatePatternPipelineAnswers(repository, input.answers);
    const layout = input.answers.layout ?? "CENTERED";
    const repeatLayout = layout === "TILE" ? input.answers.repeatLayout ?? "STRAIGHT" : "STRAIGHT";
    const idempotencyKey = input.idempotencyKey ?? null;
    // 尚无花型的来源任务也必须独立起链；既有花型继续沿用原指纹以保留在途复用。
    const fingerprint = requestFingerprint({ type: "PATTERN_PIPELINE", patternId: input.patternId, patternHash: input.patternHash, ...(input.sourceJobId ? { sourceJobId: input.sourceJobId } : {}), specId: spec.id, specVersion: POD_PRINT_SPEC_VERSION, layout, repeatLayout, listingPlatform: input.answers.listingPlatform, listingProviderId: input.answers.listingProviderId, listingModelId: input.answers.listingModelId, sellingPoints: input.answers.sellingPoints ?? null, bannedWords: input.answers.bannedWords ?? null, idempotencyKey });
    const reusable = repository.findReusablePatternPipeline(fingerprint);
    if (reusable)
        return { pipeline: reusable, reused: true };
    const fromSource = Boolean(input.sourceJobId);
    const pipeline = repository.createPatternPipeline({
        patternId: input.patternId,
        specId: spec.id,
        specVersion: POD_PRINT_SPEC_VERSION,
        layout,
        repeatLayout,
        listingPlatform: input.answers.listingPlatform,
        listingProviderId: input.answers.listingProviderId,
        listingModelId: input.answers.listingModelId,
        listingHints: { sellingPoints: input.answers.sellingPoints ?? null, bannedWords: input.answers.bannedWords ?? null },
        requestFingerprint: fingerprint,
        steps: pipelineStepPlan(fromSource),
    });
    const first = pipeline.steps[0];
    if (!first)
        throw new ApiError("INTERNAL_ERROR", "流水线没有可执行的步骤");
    if (input.sourceJobId) {
        repository.updatePatternPipelineStep(first.id, { status: "QUEUED", jobId: input.sourceJobId });
        const running = repository.updatePatternPipeline(pipeline.id, { status: "RUNNING" }) ?? pipeline;
        return { pipeline: running, reused: false };
    }
    if (!input.patternId)
        throw new ApiError("INTERNAL_ERROR", "流水线缺少花型，无法起跑");
    const started = startPipelineStep(repository, pipeline, first, input.patternId);
    yield ctx.queue(started.job);
    return { pipeline: repository.getPatternPipeline(pipeline.id) ?? pipeline, reused: false };
}
export function validatePatternPipelineAnswers(repository: EcomRepository, answers: PatternPipelineAnswers) {
    const spec = getPodPrintSpec(answers.specId);
    if (!spec)
        throw new ApiError("VALIDATION_ERROR", `未知的印刷规格：${answers.specId}`);
    if (answers.repeatLayout && (answers.layout ?? "CENTERED") !== "TILE") {
        throw new ApiError("VALIDATION_ERROR", "平铺排列仅在满印（TILE）版式下生效");
    }
    verifyCopywritingModel(repository, answers.listingProviderId, answers.listingModelId);
    return spec;
}
export function readPatternPipelineAnswers(raw: string | null | undefined): PatternPipelineAnswers | undefined {
    const text = readOptionalText(raw);
    if (!text)
        return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new ApiError("VALIDATION_ERROR", "pipeline 必须是 JSON 对象");
    }
    return parseBody(PatternPipelineAnswers, parsed);
}
function publicPatternPipeline(record: PatternPipelineWithSteps) {
    return {
        id: record.id,
        patternId: record.patternId,
        specId: record.specId,
        specVersion: record.specVersion,
        layout: record.layout,
        repeatLayout: record.repeatLayout,
        listingPlatform: record.listingPlatform,
        listingProviderId: record.listingProviderId,
        listingModelId: record.listingModelId,
        status: record.status,
        blockReason: record.blockReason,
        steps: record.steps.map((step) => ({ step: step.step, position: step.position, status: step.status, jobId: step.jobId, detail: step.detail, error: step.error })),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
}
export function patternPipelinesCommands(ctx: CommandScope) {
const { repository, } = ctx;
return {
createPatternPipeline: function* (command: Input<'createPatternPipeline'>): CommandFlow<unknown> {
    const pattern = ensurePattern(repository, readText(command.patternId, "patternId"));
    if (!pattern.storagePath)
        throw new ApiError("CONFLICT", "该花型还没有可用的图稿产物，无法成包");
    const body = bodyOf(command, ["patternId"]);
    const { pipeline, reused } = yield* startPatternPipeline(ctx, {
        patternId: pattern.id,
        patternHash: pattern.fileHash,
        answers: body,
        idempotencyKey: body.idempotencyKey ?? ((command as {
            idempotencyKey?: string;
        }).idempotencyKey as string | undefined) ?? null,
    });
    return { ...publicPatternPipeline(pipeline), reused };
},
listPatternPipelines: function* (command: Input<'listPatternPipelines'>): CommandFlow<unknown> {
    const pattern = ensurePattern(repository, readText(command.patternId, "patternId"));
    return { items: repository.listPatternPipelines(pattern.id).map(publicPatternPipeline) };
},
getPatternPipeline: function* (command: Input<'getPatternPipeline'>): CommandFlow<unknown> {
    const pipeline = ensurePatternPipeline(repository, readText(command.pipelineId, "pipelineId"));
    return publicPatternPipeline(pipeline);
},
continuePatternPipeline: function* (command: Input<'continuePatternPipeline'>): CommandFlow<unknown> {
    const pipeline = ensurePatternPipeline(repository, readText(command.pipelineId, "pipelineId"));
    if (pipeline.status !== "AWAITING_INPUT" || pipeline.blockReason !== "SEAM_RISK")
        throw new ApiError("CONFLICT", "该流水线当前不需要裁决");
    const patternId = pipeline.patternId;
    if (!patternId)
        throw new ApiError("CONFLICT", "该流水线还没有花型，无法继续");
    const body = bodyOf(command, ["pipelineId"]);
    const tileCheck = pipeline.steps.find((entry) => entry.step === "TILE_CHECK");
    if (!tileCheck)
        throw new ApiError("CONFLICT", "该流水线没有验缝步骤，无法裁决");
    repository.updatePatternPipeline(pipeline.id, {
        layout: body.resolution === "USE_CENTERED" ? "CENTERED" : "TILE",
        repeatLayout: body.resolution === "USE_MIRROR" ? "MIRROR" : pipeline.repeatLayout,
        status: "RUNNING",
        blockReason: null,
    });
    const updated = repository.getPatternPipeline(pipeline.id) ?? pipeline;
    const next = nextPipelineStep(updated.steps, tileCheck);
    if (!next)
        throw new ApiError("CONFLICT", "验缝之后没有可执行的步骤");
    const started = startPipelineStep(repository, updated, next, patternId);
    yield ctx.queue(started.job);
    return publicPatternPipeline(repository.getPatternPipeline(pipeline.id) ?? pipeline);
},
retryPatternPipelineStep: function* (command: Input<'retryPatternPipelineStep'>): CommandFlow<unknown> {
    const pipeline = ensurePatternPipeline(repository, readText(command.pipelineId, "pipelineId"));
    const patternId = pipeline.patternId;
    if (!patternId)
        throw new ApiError("CONFLICT", "该流水线还没有花型，无法重跑");
    if (pipeline.steps.some(s => s.status === 'UNKNOWN' || (s.jobId && ctx.requestLedger.hasUnknown(s.jobId)))) throw new ApiError('EXTERNAL_UNKNOWN','流水线含结果未知的请求，不能重跑。');
    const stepName = enumValue(readText(command.step, "step"), [...PATTERN_PIPELINE_STEPS], "step");
    const step = pipeline.steps.find((entry) => entry.step === stepName);
    if (!step)
        throw new ApiError("NOT_FOUND", `该流水线没有步骤：${stepName}`);
    if (step.status === "QUEUED" || step.status === "RUNNING")
        throw new ApiError("CONFLICT", "该步骤正在运行，请先取消再重跑");
    if (step.step === "SOURCE")
        throw new ApiError("CONFLICT", "图案获取步骤请从花型墙的来源入口重新发起");
    if (pipeline.status === "AWAITING_INPUT")
        throw new ApiError("CONFLICT", "流水线正等待你的裁决，请先选择「改为居中继续」「换镜像出满印」或「仍出满印」");
    resetPipelineStepsFrom(repository, pipeline.id, step.id);
    const updated = repository.getPatternPipeline(pipeline.id) ?? pipeline;
    const target = updated.steps.find((entry) => entry.id === step.id) ?? step;
    const started = startPipelineStep(repository, updated, target, patternId);
    yield ctx.queue(started.job);
    return publicPatternPipeline(repository.getPatternPipeline(pipeline.id) ?? pipeline);
},
cancelPatternPipeline: function* (command: Input<'cancelPatternPipeline'>): CommandFlow<unknown> {
    const pipeline = ensurePatternPipeline(repository, readText(command.pipelineId, "pipelineId"));
    if (pipeline.status === "SUCCEEDED" || pipeline.status === "CANCELLED")
        return publicPatternPipeline(pipeline);
    if (pipeline.steps.some(s => s.status === 'UNKNOWN' || (s.jobId && repository.getJob(s.jobId)?.status === 'UNKNOWN'))) throw new ApiError('EXTERNAL_UNKNOWN','流水线存在中断任务，请先重试或结束该任务。');
    const active = pipeline.steps.filter(s => s.jobId && (s.status === 'QUEUED' || s.status === 'RUNNING'));
    for (const step of active) ctx.cancel(step.jobId!);
    if (active.length) yield ctx.scheduler.waitForIdle(active.map(s => s.jobId!));
    const latest = ensurePatternPipeline(repository,pipeline.id);
    if (latest.status === 'SUCCEEDED' || latest.steps.some(s => s.status === 'UNKNOWN' || (s.jobId && ctx.requestLedger.hasUnknown(s.jobId)))) return publicPatternPipeline(latest);
    for (const step of latest.steps) {
        if (step.status === "PENDING" || step.status === "QUEUED" || step.status === "RUNNING")
            repository.updatePatternPipelineStep(step.id, { status: "CANCELLED" });
    }
    repository.updatePatternPipeline(pipeline.id, { status: "CANCELLED", blockReason: null });
    return publicPatternPipeline(repository.getPatternPipeline(pipeline.id) ?? pipeline);
}
};
}
