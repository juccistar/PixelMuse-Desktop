import { operations, resourceUrlFor, type Operation, type ResourceRef } from '@ecomgen/contracts';
import { ECOM_DETAILS_IMAGE_SOURCE, ECOM_TEMPLATES } from '@ecomgen/ecom-skill';
import type { SqliteDatabase } from '@ecomgen/core';
import type { CommandContext, CommandHandlers } from '../runtime/ports.js';
import { BackendError } from '../validation.js';
import { publicJob } from '../business.js';
import { projectPublic, runCommandFlow, type CommandFlow, type CommandScope } from './support.js';
import { projectsCommands } from './projects.js';
import { storyboardCommands } from './storyboard.js';
import { editSessionsCommands } from './editSessions.js';
import { modelsCommands } from './models.js';
import { patternsCommands } from './patterns.js';
import { patternDraftsCommands } from './patternDrafts.js';
import { patternPipelinesCommands } from './patternPipelines.js';
import { suitesCommands } from './suites.js';
import { suiteForgeCommands } from './suiteForge.js';
import { providersCommands } from './providers.js';
import { searchSourcesCommands } from './searchSources.js';
import { userTemplatesCommands } from './userTemplates.js';
import { projectWorkbenchCommands } from './project-workbench.js';
import { outputsCommands } from './outputs.js';
import { lifecycleCommands } from './lifecycle.js';
import { editTurnCommands } from './edit-turn.js';
import { missing, parseAssetRole, assertProjectAssetCapacity } from './helpers.js';
import { resourceHandle, preparePublicResources } from './resources.js';
import { clearInvalidApplicationDefaults } from './application-settings.js';
import { registerProductImagePlanningCommands } from './product-image-planning.js';
import { registerProductImagePlanningJobCommands } from './product-image-planning-jobs.js';
import { suitePlanningCommands } from './suite-planning.js';

/** 由 Backend owner 绑定运行时、设置与用量连接；此名单无业务缺省分派。 */
export const RUNTIME_OWNED_COMMANDS = ['listPatternListingHistory','listModelCastHistory','getHealth','getJob','cancelJob','retryJob','listJobs','getJobRequests','getJobRecovery','resolveJobInterruptions','recoverJobLocally','getJobActions','getResource','getApplicationSettings','updateApplicationSettings','getModelConfigurationImpact','listModelPricing','setModelPricing','listUsage','getUsageSummary','exportUsage'] as const;
const families = [projectWorkbenchCommands, projectsCommands, storyboardCommands, editSessionsCommands, modelsCommands, patternsCommands, patternDraftsCommands, patternPipelinesCommands, suitesCommands, suiteForgeCommands, providersCommands, searchSourcesCommands, userTemplatesCommands, outputsCommands, lifecycleCommands, editTurnCommands, registerProductImagePlanningJobCommands, suitePlanningCommands];
type FlowHandler = (input: any) => CommandFlow<unknown>;

/** 返回全部领域具名处理器，注入 createBackend 的 integrations.commands。 */
export function registerDomainCommands(context: CommandContext): CommandHandlers {
  const handlers: CommandHandlers = {};
  const scope = { ...context, queue() { throw new BackendError('REGISTRATION_SIDE_EFFECT','注册期间不能创建任务。'); }, cancel: (id: string) => context.scheduler.cancel(id) } as CommandScope;
  for (const family of families) {
    const available = family(scope);
    for (const name of Object.keys(available) as Operation[]) {
      if (Object.hasOwn(handlers, name)) throw new BackendError('DUPLICATE_COMMAND', '业务命令重复注册。');
      (handlers as Record<string, unknown>)[name] = (_ctx: CommandContext, input: unknown) => runCommandFlow(context, name, input, current => {
        const handler = (family(current) as Record<string, FlowHandler>)[name]!;
        if (name !== 'deleteProvider') return handler;
        return function* (value: unknown): CommandFlow<unknown> {
          const result = yield* handler(value);
          clearInvalidApplicationDefaults(current);
          return result;
        };
      });
    }
  }
  Object.assign(handlers, registerProductImagePlanningCommands(context));
  Object.assign(handlers, {
    listEcomDetailsImageTemplates: () => projectPublic(operations.listEcomDetailsImageTemplates.output, { source: ECOM_DETAILS_IMAGE_SOURCE, items: ECOM_TEMPLATES }),
    listAssets: (_ctx: CommandContext, input: { projectId: string }) => {
      if (!context.repository.getProject(input.projectId)) missing('project', input.projectId);
      return projectPublic(operations.listAssets.output, { items: context.repository.listAssets(input.projectId), nextCursor: null });
    },
    updateAsset: (_ctx: CommandContext, input: { assetId: string; kind?: string; role?: string }) => context.transaction(() => {
      const asset = context.repository.getAsset(input.assetId); if (!asset) missing('asset', input.assetId);
      const role = parseAssetRole(input.kind ?? input.role ?? asset.role);
      if (role !== asset.role) assertProjectAssetCapacity(context.repository, asset.projectId, role);
      // 原仓储缺少角色更新方法；使用 owner 已持有的同一连接，保持原 ID 和历史引用。
      const db = (context.repository as unknown as { db: SqliteDatabase }).db;
      db.prepare('UPDATE assets SET role=? WHERE id=?').run(role, asset.id);
      context.events.publish({ topic: 'assets', projectId: asset.projectId });
      return projectPublic(operations.updateAsset.output, context.repository.getAsset(asset.id));
    }),
    listOutputs: (_ctx: CommandContext, input: { projectId: string }) => {
      if (!context.repository.getProject(input.projectId)) missing('project', input.projectId);
      return projectPublic(operations.listOutputs.output, { items: context.repository.listOutputs(input.projectId) });
    },
    getOutput: (_ctx: CommandContext, input: { outputId: string }) => { const output = context.repository.getOutput(input.outputId); if (!output) missing('output', input.outputId); return projectPublic(operations.getOutput.output, output); },
    getCopywritingResult: (_ctx: CommandContext, input: { jobId: string }) => {
      const job = context.repository.getJob(input.jobId); if (!job || job.type !== 'COPYWRITE') missing('copywriting job', input.jobId);
      if (job.status !== 'SUCCEEDED') throw new BackendError('CONFLICT', '文案任务尚未成功。');
      const result = context.repository.getCopywritingResult(job.id); if (!result) missing('copywriting result', job.id); return result;
    },
  });
  const download = (name: Operation, ref: (input: any) => ResourceRef, validate?: (input: any) => void) => {
    (handlers as Record<string, unknown>)[name] = async (_ctx: CommandContext, input: unknown) => { validate?.(input); return resourceHandle(context, ref(input)); };
  };
  download('downloadThumbnail', i => ({ kind: 'THUMBNAIL', id: i.hash }));
  download('downloadAsset', i => ({ kind: 'ASSET', id: i.assetId }));
  download('downloadOutput', i => ({ kind: 'OUTPUT', id: i.outputId }));
  download('downloadExport', i => ({ kind: 'EXPORT', id: i.exportId }));
  download('downloadLayerExport', i => ({ kind: 'LAYER_PSD', id: i.layerExportId }));
  download('downloadLayerExportLayer', i => ({ kind: 'LAYER_FILE', id: i.layerExportId, index: i.layerIndex }));
  download('getPatternFile', i => ({ kind: 'PATTERN', id: i.patternId }));
  download('getPrintPackFile', i => ({ kind: 'PRINT_PACK_FILE', id: i.printPackId, index: i.index }));
  download('downloadDraftCandidateFile', i => ({ kind: 'DRAFT_CANDIDATE', id: i.candidateId }), i => { if (context.repository.getDraftCandidate(i.candidateId)?.draftId !== i.draftId) missing('candidate', i.candidateId); });
  download('downloadDraftMediaFile', i => ({ kind: 'DRAFT_MEDIA', id: i.mediaId }), i => { if (context.repository.getDraftMedia(i.mediaId)?.draftId !== i.draftId) missing('media', i.mediaId); });
  for (const name of Object.keys(operations) as Operation[]) if (!Object.hasOwn(handlers, name) && !(RUNTIME_OWNED_COMMANDS as readonly string[]).includes(name)) throw new BackendError('MISSING_COMMAND', `未注册领域命令：${name}`);
  for (const name of Object.keys(handlers) as Operation[]) {
    const handler = handlers[name] as (ctx:CommandContext,input:unknown)=>unknown;
    (handlers as Record<string,unknown>)[name] = async (ctx:CommandContext,input:unknown) => { const result = await handler(ctx,input); await preparePublicResources(context,result); return result; };
  }
  return handlers;
}
