import { publicJob } from '../business.js';
import { BackendError } from '../validation.js';
import type { CommandContext, CommandHandlers } from './ports.js';
import type { RuntimeStore } from './state.js';

type Page = { limit?: number; offset?: number };
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;

/** 在运行时同一连接上分页查询，不返回持久输入或执行快照。 */
export function createTaskHistoryCommands(context: CommandContext, store: RuntimeStore): CommandHandlers {
  const query = (type: string, field: string, id: string, page: Page, listing = false) => {
    const where = `type = ? AND CASE WHEN json_valid(input_json) THEN json_extract(input_json, ?) = ? ${listing ? "AND json_extract(input_json, '$.target') = 'LISTING'" : ''} ELSE 0 END`;
    const args = [type, `$.${field}`, id] as const;
    const total = (store.db.prepare(`SELECT count(*) AS total FROM jobs WHERE ${where}`).get(...args) as { total: number }).total;
    const rows = store.db.prepare(`SELECT id FROM jobs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, page.limit ?? 50, page.offset ?? 0) as { id: string }[];
    return { total, jobs: rows.map(row => context.repository.getJob(row.id)).filter((job): job is NonNullable<typeof job> => Boolean(job)) };
  };
  return {
    listPatternListingHistory: (_ctx, input) => {
      if (!context.repository.getPattern(input.patternId)) throw new BackendError('NOT_FOUND', '花型不存在。');
      const result = query('COPYWRITE', 'patternId', input.patternId, input, true);
      return { total: result.total, items: result.jobs.map(job => ({ job: publicJob(job), platform: text(job.input.platform), sellingPoints: text(job.input.sellingPoints), mustIncludeWords: text(job.input.mustIncludeWords), bannedWords: text(job.input.bannedWords), createdAt: job.createdAt })) };
    },
    listModelCastHistory: (_ctx, input) => {
      if (!context.repository.getModel(input.modelId)) throw new BackendError('NOT_FOUND', '模特不存在。');
      const result = query('MODEL_CAST', 'modelId', input.modelId, input);
      return { total: result.total, items: result.jobs.map(publicJob) };
    },
  };
}
