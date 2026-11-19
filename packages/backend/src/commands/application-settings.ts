import { ApplicationSettingsSchema, applicationSettingsOperations, type ApplicationSettings, type Input } from '@ecomgen/contracts';
import { readApplicationSettings as read } from '../settings-store.js';
import type { EcomRepository, ProjectRecord, SqliteDatabase } from '@ecomgen/core';
import { readKey, type ExecutionInputs } from '../execution/snapshot.js';
import { JobRuntimeSchema, RuntimeStore } from '../runtime/state.js';
import type { CommandContext, CommandHandlers } from '../runtime/ports.js';
import { BackendError, check } from '../validation.js';

type Role = 'reasoningModel' | 'imageModel' | 'segmentationModel';
const roles: readonly Role[] = ['reasoningModel', 'imageModel', 'segmentationModel'];
/** 复用 owner 的唯一连接，不创建第二个设置存储。 */
function database(context: Pick<CommandContext, 'repository'>): SqliteDatabase {
  return (context.repository as unknown as { db: SqliteDatabase }).db;
}
function write(context: CommandContext, db: SqliteDatabase, settings: ApplicationSettings): void {
  db.prepare(`INSERT INTO desktop_application_settings(singleton,settings_json,updated_at) VALUES(1,?,?)
    ON CONFLICT(singleton) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at`).run(JSON.stringify(settings), context.clock());
}
function validReference(repository: EcomRepository, role: Role, ref: NonNullable<ApplicationSettings['defaults'][Role]>): boolean {
  const model = repository.getProvider(ref.providerId)?.models.find(model => model.id === ref.modelId);
  if (!model) return false;
  if (role === 'reasoningModel') return !model.imageApiKind && !model.segmentationProtocol;
  if (role === 'imageModel') return Boolean(model.imageApiKind) && !model.segmentationProtocol;
  return Boolean(model.segmentationProtocol) && !model.imageApiKind && 'protocol' in ref && ref.protocol === model.segmentationProtocol;
}
/** 删除连接或移除/改变模型能力时，同事务清除失效全局默认；历史与项目保持原有语义。 */
export function clearInvalidApplicationDefaults(context: CommandContext, db: SqliteDatabase = database(context)): ApplicationSettings {
  const settings = read(db);
  let changed = false;
  for (const role of roles) {
    const ref = settings.defaults[role];
    if (ref && !validReference(context.repository, role, ref)) { settings.defaults[role] = null; changed = true; }
  }
  if (changed) { write(context, db, settings); context.events.publish({ topic: 'settings' }); }
  return settings;
}
/** 应用设置命令只写本地 SQLite；保存配置不会触发 Provider 请求。 */
export function createApplicationSettingsHandlers(context: CommandContext, db: SqliteDatabase): CommandHandlers {
  return {
    getApplicationSettings: () => context.transaction(() => clearInvalidApplicationDefaults(context, db)),
    updateApplicationSettings: (_ctx, input) => {
      const result = context.transaction(() => {
      check(applicationSettingsOperations.updateApplicationSettings.input, input);
      const settings: ApplicationSettings = { ...read(db), ...structuredClone(input) };
      check(ApplicationSettingsSchema, settings);
      for (const role of roles) {
        const ref = settings.defaults[role];
        if (ref && !validReference(context.repository, role, ref)) throw new BackendError('VALIDATION_ERROR', '默认模型不存在或不支持所选用途，请重新选择。');
      }
      write(context, db, settings);
      context.events.publish({ topic: 'settings' });
      return settings;
      });
      context.scheduler.setConcurrency(result.ai.concurrency);
      return result;
    },
    getModelConfigurationImpact: (_ctx, input: Input<'getModelConfigurationImpact'>) => {
      check(applicationSettingsOperations.getModelConfigurationImpact.input, input);
      if (!context.repository.getProvider(input.providerId)) throw new BackendError('NOT_FOUND', '服务连接不存在。');
      const match = (providerId: string | null, modelId: string | null) => providerId === input.providerId && (input.modelId === undefined || modelId === input.modelId);
      const projectCount = (db.prepare(`SELECT COUNT(*) n FROM projects WHERE
        (reasoning_provider_id=@providerId AND (@modelId IS NULL OR reasoning_model_id=@modelId)) OR
        (image_provider_id=@providerId AND (@modelId IS NULL OR image_model_id=@modelId)) OR
        (segmentation_provider_id=@providerId AND (@modelId IS NULL OR segmentation_model_id=@modelId))`).get({ providerId: input.providerId, modelId: input.modelId ?? null }) as { n: number }).n;
      const store = new RuntimeStore(db);
      const activeJobs = db.prepare(`SELECT j.provider_id, j.model_id, r.payload FROM jobs j
        LEFT JOIN desktop_job_runtime r ON r.job_id=j.id WHERE j.status IN ('QUEUED','RUNNING')`).all() as Array<{ provider_id: string | null; model_id: string | null; payload: string | null }>;
      const activeJobCount = activeJobs.filter(job => {
        // 未提交的排队意图保留原计数；已提交任务与执行器一样使用冻结身份及输入。
        if (!job.payload) return match(job.provider_id, job.model_id);
        const snapshot = store.decode(JobRuntimeSchema, job.payload).snapshot;
        const execution = snapshot.effective.execution as unknown as ExecutionInputs | undefined;
        if (!execution?.intent) return match(job.provider_id, job.model_id);
        if (match(execution.intent.providerId, execution.intent.modelId)) return true;
        // 目录缓存不是依赖；仅非 retry 的有效修订额外调用冻结项目的推理模型。
        const revision = snapshot.type === 'GENERATE' && typeof snapshot.input.revision === 'string' ? snapshot.input.revision.trim() : '';
        if (!revision || revision === 'retry' || !execution.intent.projectId) return false;
        const project = execution.reads[readKey('getProject', [execution.intent.projectId])] as ProjectRecord | null | undefined;
        return Boolean(project && match(project.reasoningProviderId, project.reasoningModelId));
      }).length;
      const settings = read(db);
      const defaultRoles = roles.filter(role => { const ref = settings.defaults[role]; return ref && match(ref.providerId, ref.modelId); });
      return { projectCount, activeJobCount, defaultRoles };
    },
  };
}
