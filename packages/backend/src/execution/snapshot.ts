import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { GenerationSnapshot, JobRecord } from '@ecomgen/core';
import { AiRuntimeSettingsSchema, ProductImagePlanningContextSchema, type AiRuntimeSettings, type ProductImagePlanningContext } from '@ecomgen/contracts';
import { readApplicationSettings } from '../settings-store.js';
import type { SqliteDatabase } from '@ecomgen/core';

/** 只承认生成时冻结且符合业务白名单的归属；不读取当前SKU或任意同名字段。 */
export function outputImagePlanning(snapshot: GenerationSnapshot | null | undefined): ProductImagePlanningContext | undefined {
  const value = snapshot?.imagePlanning;
  return Value.Check(ProductImagePlanningContextSchema, value) ? structuredClone(value) : undefined;
}

// 完整生成证据留在 Backend JSON 列；公开Output只投影revision与安全业务归属。
const outputProvenanceSchema = Type.Object({
  version: Type.Literal(1),
  finalPrompt: Type.String({ minLength: 1 }),
  attachments: Type.Array(Type.Object({
    source: Type.Union([Type.Literal('PROJECT_ASSET'), Type.Literal('EDIT_REFERENCE'), Type.Literal('OUTPUT'), Type.Literal('PROVIDER_MASK')]),
    id: Type.Optional(Type.String()),
    role: Type.String(),
    handle: Type.Optional(Type.String()),
    filename: Type.String(),
    mimeType: Type.String(),
    sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  }, { additionalProperties: false })),
  storyboard: Type.Optional(Type.Object({
    assetType: Type.String(), displayName: Type.String(),
    templateVariant: Type.Union([Type.String(), Type.Null()]), mode: Type.String(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

/** 每产物的最终请求提示词与实际附件字节证据，不依赖可变分镜。 */
export type OutputProvenance = Static<typeof outputProvenanceSchema>;
export type OutputGenerationSnapshot = GenerationSnapshot & { provenance: OutputProvenance };

/** 旧产物或不完整证据明确缺失；不能拿最新分镜提示词填补历史。 */
export function outputProvenance(snapshot: GenerationSnapshot | null): OutputProvenance | null {
  const value = (snapshot as Partial<OutputGenerationSnapshot> | null)?.provenance;
  return Value.Check(outputProvenanceSchema, value) ? structuredClone(value) : null;
}
import type { CommandContext, FrozenJobSnapshot } from '../runtime/ports.js';
import type { SuiteDefinition } from '@ecomgen/ecom-suite';

/** 提交事务内收集有效业务输入；执行期禁止用当前配置替换这些值。 */
export interface ExecutionInputs {
  version: 1;
  reads: Record<string, unknown>;
  ai?: AiRuntimeSettings;
  intent: Pick<JobRecord,'providerId'|'modelId'|'projectId'|'storyboardItemId'>;
  suites: SuiteDefinition[];
  pipeline?: { id: string; stepId: string; jobId: string };
  slots?: Array<{ batchId: string; index: number; attempt: number }>;
}
export const executionSnapshotSchema = Type.Object({
  version: Type.Literal(1), jobId: Type.String(), type: Type.String(), createdAt: Type.String(),
  input: Type.Record(Type.String(), Type.Unknown()),
  effective: Type.Object({ execution: Type.Object({ version: Type.Literal(1), reads: Type.Record(Type.String(), Type.Unknown()), ai: Type.Optional(AiRuntimeSettingsSchema), intent: Type.Object({providerId:Type.Union([Type.String(),Type.Null()]),modelId:Type.Union([Type.String(),Type.Null()]),projectId:Type.Union([Type.String(),Type.Null()]),storyboardItemId:Type.Union([Type.String(),Type.Null()])}), suites: Type.Array(Type.Unknown()), pipeline: Type.Optional(Type.Object({ id: Type.String(), stepId: Type.String(), jobId: Type.String() })) }) }, { additionalProperties: true }),
  resources: Type.Array(Type.Unknown()),
});
export function readKey(method: string, args: unknown[]): string { return `${method}:${JSON.stringify(args)}`; }

/** C 在 Job 及伴随行创建后调用，再 scheduler.freeze；不进行文件或网络 I/O。 */
export function createExecutionSnapshot(context: CommandContext, job: JobRecord, resources: FrozenJobSnapshot['resources'] = []): FrozenJobSnapshot {
  const repository = context.repository;
  const reads: Record<string, unknown> = {};
  const capture = (method: string, ...args: unknown[]): any => {
    const value = (repository as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!(...args);
    reads[readKey(method, args)] = value === undefined ? null : structuredClone(value);
    return value;
  };
  capture('listUserTemplates'); capture('listSearchSources');
  for (const provider of repository.listProviders()) capture('getProvider', provider.id);
  const input = job.input;
  if (job.projectId) {
    capture('getProject', job.projectId); capture('listAssets', job.projectId);
    capture('getStoryboard', job.projectId);
    for (const item of capture('listStoryboardItems', job.projectId) ?? []) capture('getStoryboardItem', item.id);
    for (const output of capture('listOutputs', job.projectId) ?? []) capture('getOutput', output.id);
  }
  const turnId = input.editTurnId ?? input.turnId;
  if (typeof turnId === 'string') {
    const turn = capture('getEditTurn', turnId);
    if (turn) {
      capture('getEditSession', turn.sessionId); capture('listEditReferenceAssets', turn.sessionId);
      let output = capture('getOutput', turn.baseOutputId);
      const seen = new Set<string>();
      while (output?.parentOutputId && !seen.has(output.id)) { seen.add(output.id); output = capture('getOutput', output.parentOutputId); }
    }
  }
  if (typeof input.patternId === 'string') capture('getPattern', input.patternId);
  if (job.type === 'MODEL_CAST' && typeof input.modelId === 'string') capture('getModel', input.modelId);
  if (typeof input.draftId === 'string') capture('getPatternDraft', input.draftId);
  if (typeof input.batchId === 'string') {
    const batch = capture('getDraftBatch', input.batchId);
    const parentId = batch?.snapshot?.parentCandidateId ?? batch?.parentCandidateId;
    if (typeof parentId === 'string') capture('getDraftCandidate', parentId);
  }
  if (typeof input.candidateId === 'string') capture('getDraftCandidate', input.candidateId);
  if (typeof input.parentCandidateId === 'string') capture('getDraftCandidate', input.parentCandidateId);
  const layer = repository.getLayerExportByJobId(job.id);
  if (layer) { capture('getOutput', layer.outputId); if (layer.planId) capture('getLayerPlan', layer.planId); }
  const plan = repository.getLayerPlanByJobId(job.id);
  if (plan) capture('getOutput', plan.outputId);
  const pack = repository.getPrintPackByJobId(job.id);
  if (pack) capture('getPattern', pack.patternId);
  const requested = new Set<string>(Array.isArray(input.requestedSuiteShots) ? input.requestedSuiteShots.filter((v): v is string => typeof v === 'string') : []);
  if (job.storyboardItemId) { const item = capture('getStoryboardItem', job.storyboardItemId); if (item) requested.add(item.assetType); }
  const suites = new Map<string, SuiteDefinition>();
  // 只冻结执行会消费的套图，避免每次账本/fencing读取都解析整份目录。
  // 套图锻造仍需全目录检查新ID冲突；手选与生图保留明确引用的完整定义。
  if (job.type === 'SUITE_FORGE') for (const suite of context.catalog.listSuites()) suites.set(suite.id, structuredClone(suite));
  for (const assetType of requested) { const match = context.catalog.resolveShot(assetType); if (match) suites.set(match.suite.id, structuredClone(match.suite)); }
  const step = repository.getPatternPipelineStepByJobId(job.id);
  const slots = repository.listDraftSlotsByJobId(job.id).map(slot => ({ batchId: slot.batchId, index: slot.index, attempt: slot.attempt }));
  if (typeof input.batchId==='string' && Array.isArray(input.slots) && (input.slots.length!==slots.length || input.slots.some(index=>!slots.some(slot=>slot.batchId===input.batchId&&slot.index===index)))) throw new Error('Draft slots must be assigned before freezing');
  const execution: ExecutionInputs = { version: 1, reads, ai: readApplicationSettings((repository as unknown as { db: SqliteDatabase }).db).ai, intent: { providerId:job.providerId,modelId:job.modelId,projectId:job.projectId,storyboardItemId:job.storyboardItemId }, suites: [...suites.values()], slots, ...(step ? { pipeline: { id: step.pipelineId, stepId: step.id, jobId: job.id } } : {}) };
  // JSON roundtrip enforces the runtime's durable JSON boundary and removes undefined optionals.
  return JSON.parse(JSON.stringify({ version: 1, jobId: job.id, type: job.type, createdAt: context.clock(), input: job.input, effective: { execution }, resources })) as FrozenJobSnapshot;
}

export const FROZEN_READS = new Set(['getProject', 'getProvider', 'listAssets', 'getStoryboard', 'listStoryboardItems', 'getStoryboardItem', 'listOutputs', 'getOutput', 'getEditTurn', 'getEditSession', 'listEditReferenceAssets', 'getPattern', 'getModel', 'getPatternDraft', 'getDraftBatch', 'getDraftCandidate', 'getLayerPlan', 'listUserTemplates', 'listSearchSources']);
