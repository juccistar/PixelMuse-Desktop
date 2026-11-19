import { resourceUrlFor, type Input } from '@ecomgen/contracts';
import { outputImagePlanning } from '../execution/snapshot.js';
import { ensureProject } from './helpers.js';
import { ApiError, type CommandFlow, type CommandScope } from './support.js';

/** 采用状态只接受本项目真实输出；历史输出继续使用其冻结目标身份。 */
export function projectWorkbenchCommands(ctx: CommandScope) {
  const { repository } = ctx;
  return {
    getProjectWorkbench: function* (input: Input<'getProjectWorkbench'>): CommandFlow<unknown> {
      ensureProject(repository, input.projectId);
      return repository.getProjectWorkbench(input.projectId);
    },
    saveProjectWorkbench: function* (input: Input<'saveProjectWorkbench'>): CommandFlow<unknown> {
      ensureProject(repository, input.projectId);
      const current = repository.getProjectWorkbench(input.projectId);
      if (current.revision !== input.expectedRevision) throw new ApiError('CONFLICT', '采用状态已变化，请刷新后保存。');
      if (new Set(input.adoptions.map(entry => entry.targetId)).size !== input.adoptions.length) throw new ApiError('VALIDATION_ERROR', '同一目标只能采用一个版本。');
      const outputs = repository.listOutputs(input.projectId);
      const detailTargets = new Set(repository.listStoryboardItems(input.projectId).filter(item => !item.imagePlanning || item.imagePlanning.purpose === 'DETAIL').map(item => item.imagePlanning?.targetId ?? item.id));
      for (const output of outputs) {
        const frozen = outputImagePlanning(output.generationSnapshot);
        if (frozen?.purpose === 'DETAIL') detailTargets.add(frozen.targetId);
      }
      for (const entry of input.adoptions) {
        const output = outputs.find(value => value.id === entry.outputId && value.projectId === input.projectId);
        const item = output ? repository.getStoryboardItem(output.storyboardItemId) : undefined;
        if (!output || !item || item.projectId !== input.projectId || (outputImagePlanning(output.generationSnapshot)?.targetId ?? item.id) !== entry.targetId) throw new ApiError('VALIDATION_ERROR', '采用图片必须属于当前项目及对应画面。');
      }
      if (input.detailOrder.some(id => !detailTargets.has(id))) throw new ApiError('VALIDATION_ERROR', '详情顺序只能包含本项目详情画面。');
      const saved = repository.saveProjectWorkbench({ projectId: input.projectId, revision: current.revision + 1, adoptions: input.adoptions, detailOrder: input.detailOrder, updatedAt: new Date().toISOString() });
      ctx.events.publish({ topic: 'outputs', projectId: input.projectId });
      return saved;
    },
    listProjectExports: function* (input: Input<'listProjectExports'>): CommandFlow<unknown> {
      ensureProject(repository, input.projectId);
      const outputIds = new Set(repository.listOutputs(input.projectId).map(output => output.id));
      const items = repository.listJobs(input.projectId).filter(job => job.type === 'EXPORT').flatMap(job => {
        const record = repository.getExportByJobId(job.id);
        if (!record || record.projectId !== input.projectId) return [];
        const exportedOutputIds = job.input.exportedOutputIds ?? job.input.outputIds;
        return [{ id: record.id, projectId: record.projectId, jobId: record.jobId, status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
          outputIds: Array.isArray(exportedOutputIds) ? exportedOutputIds.filter((id): id is string => typeof id === 'string' && outputIds.has(id)) : [],
          longImage: Boolean(job.input.longImage), downloadUrl: record.status === 'SUCCEEDED' && record.storagePath ? resourceUrlFor({ kind: 'EXPORT', id: record.id }) : null }];
      });
      return { items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)) };
    },
  };
}
