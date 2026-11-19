import type { SqliteDatabase } from '@ecomgen/core';
import type { ModelPricing, UsageEntry, UsageFilter, UsageSummary } from '@ecomgen/contracts';
import type { CommandContext } from '../runtime/ports.js';
import { BackendError } from '../validation.js';
import { backfillUsage, notifyUsage } from '../runtime/usage-store.js';

const MAX_EXPORT_ROWS = 10000;
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
function where(filter: UsageFilter): { sql: string; parameters: (string | number)[] } {
  const clauses: string[] = [], parameters: (string | number)[] = [];
  for (const field of ['providerId', 'modelId', 'projectId', 'purpose', 'state'] as const) {
    if (filter[field] !== undefined) { clauses.push(`json_extract(u.entry_json,'$.${field}')=?`); parameters.push(filter[field]!); }
  }
  for (const field of ['from', 'to'] as const) if (filter[field] !== undefined) {
    const date = new Date(filter[field]!);
    if (!Number.isFinite(date.getTime())) throw new BackendError('INVALID_INPUT', '时间筛选无效。');
    clauses.push(`u.started_at${field === 'from' ? '>=' : '<='}?`); parameters.push(date.toISOString());
  }
  if (filter.from && filter.to && Date.parse(filter.from) > Date.parse(filter.to)) throw new BackendError('INVALID_INPUT', '开始时间不能晚于结束时间。');
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', parameters };
}
function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  // CSV 引号不能阻止表格执行公式；检查前导空白/控制字符后再加文本前缀。
  if (/^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** 请求明细、币种分组估算和安全 CSV 共用筛选，不读取原始回执。 */
export function createUsageHandlers(context: CommandContext, db: SqliteDatabase) {
  const historyNote = backfillUsage(db, context.secrets, () => context.events.publish({ topic: 'usage' }));
  const count = (filter: UsageFilter): number => {
    const query = where(filter);
    return (db.prepare(`SELECT count(*) AS total FROM desktop_usage_records u ${query.sql}`).get(...query.parameters) as { total: number }).total;
  };
  const entries = (filter: UsageFilter, limit: number, offset = 0): UsageEntry[] => {
    const query = where(filter);
    return (db.prepare(`SELECT u.entry_json FROM desktop_usage_records u ${query.sql} ORDER BY u.started_at DESC,u.id DESC LIMIT ? OFFSET ?`).all(...query.parameters, limit, offset) as { entry_json: string }[]).map(row => JSON.parse(row.entry_json) as UsageEntry);
  };
  return {
    listModelPricing: (_ctx: CommandContext, _input: Record<string, never>) => ({ items: (db.prepare('SELECT pricing_json FROM desktop_model_pricing ORDER BY provider_id,model_id').all() as { pricing_json: string }[]).map(row => JSON.parse(row.pricing_json) as ModelPricing) }),
    setModelPricing: (_ctx: CommandContext, input: Omit<ModelPricing, 'updatedAt'>): ModelPricing => {
      for (const field of ['inputPerMillion', 'outputPerMillion', 'cachedInputPerMillion', 'perRequest'] as const) if (input[field] !== null && (typeof input[field] !== 'number' || !Number.isFinite(input[field]) || input[field]! < 0 || input[field]! > 1e9)) throw new BackendError('INVALID_INPUT', '单价必须为有限非负数，或留空。');
      if (!['USD', 'CNY'].includes(input.currency)) throw new BackendError('INVALID_INPUT', '币种无效。');
      const provider = context.repository.getProvider(input.providerId);
      if (!provider?.models.some(model => model.id === input.modelId)) throw new BackendError('INVALID_INPUT', '服务连接或模型已失效，请重新选择。');
      const pricing: ModelPricing = { providerId: input.providerId, modelId: input.modelId, currency: input.currency, inputPerMillion: input.inputPerMillion, outputPerMillion: input.outputPerMillion, cachedInputPerMillion: input.cachedInputPerMillion, perRequest: input.perRequest, updatedAt: context.clock() };
      db.prepare('INSERT INTO desktop_model_pricing(provider_id,model_id,pricing_json) VALUES (?,?,?) ON CONFLICT(provider_id,model_id) DO UPDATE SET pricing_json=excluded.pricing_json').run(pricing.providerId, pricing.modelId, JSON.stringify(pricing));
      notifyUsage(db, () => context.events.publish({ topic: 'usage' }));
      return pricing;
    },
    listUsage: (_ctx: CommandContext, input: UsageFilter & { limit?: number; offset?: number }) => {
      const limit = input.limit ?? 50, offset = input.offset ?? 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) throw new BackendError('INVALID_INPUT', '分页参数无效。');
      return { items: entries(input, limit, offset), total: count(input) };
    },
    getUsageSummary: (_ctx: CommandContext, input: UsageFilter): UsageSummary => {
      const query = where(input);
      const result = db.prepare(`SELECT count(*) AS requestCount,
        COALESCE(sum(json_extract(u.entry_json,'$.state')='COMPLETED'),0) AS completedCount,
        COALESCE(sum(json_extract(u.entry_json,'$.httpStatus')>=400),0) AS failedResponseCount,
        COALESCE(sum(json_extract(u.entry_json,'$.state')='UNKNOWN'),0) AS unknownCount,
        COALESCE(sum(json_extract(u.entry_json,'$.state')='IN_FLIGHT'),0) AS inFlightCount,
        COALESCE(sum(json_extract(u.entry_json,'$.usageSource')='PROVIDER'),0) AS withUsageCount,
        sum(CAST(json_extract(u.entry_json,'$.inputTokens') AS REAL)) AS inputTokens,
        sum(CAST(json_extract(u.entry_json,'$.outputTokens') AS REAL)) AS outputTokens,
        sum(CAST(json_extract(u.entry_json,'$.cachedInputTokens') AS REAL)) AS cachedInputTokens,
        count(DISTINCT u.job_id) AS taskCount
        FROM desktop_usage_records u ${query.sql}`).get(...query.parameters) as Omit<UsageSummary, 'amounts' | 'outputCount' | 'historyNote'>;
      const amounts = db.prepare(`SELECT json_extract(u.entry_json,'$.currency') AS currency,sum(json_extract(u.entry_json,'$.estimatedAmount')) AS estimatedAmount,count(*) AS pricedRequests
        FROM desktop_usage_records u ${query.sql}${query.sql ? ' AND' : ' WHERE'} json_extract(u.entry_json,'$.estimatedAmount') IS NOT NULL AND json_extract(u.entry_json,'$.currency') IN ('USD','CNY') GROUP BY currency ORDER BY currency`).all(...query.parameters) as UsageSummary['amounts'];
      const outputCount = (db.prepare(`SELECT count(*) AS total FROM outputs WHERE job_id IN (SELECT DISTINCT u.job_id FROM desktop_usage_records u ${query.sql})`).get(...query.parameters) as { total: number }).total;
      let overflow = false;
      for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const) if (result[field] !== null && !Number.isSafeInteger(result[field])) { result[field] = null; overflow = true; }
      return { ...result, amounts, outputCount, historyNote: overflow ? `${historyNote}部分Token汇总超出可精确表示的范围，已显示为未提供；明细保留原计数。` : historyNote };
    },
    exportUsage: (_ctx: CommandContext, input: UsageFilter) => {
      if (count(input) > MAX_EXPORT_ROWS) throw new BackendError('EXPORT_LIMIT', '明细超过10000条，请缩小时间或模型筛选范围后导出。');
      const columns = ['id', 'jobId', 'requestKey', 'projectId', 'projectName', 'providerId', 'providerName', 'modelId', 'purpose', 'state', 'httpStatus', 'startedAt', 'completedAt', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'usageSource', 'estimatedAmount', 'currency'] as const;
      const priceColumns = ['inputPerMillion', 'outputPerMillion', 'cachedInputPerMillion', 'perRequest', 'updatedAt'] as const;
      const lines = ['﻿' + [...columns, ...priceColumns.map(field => `pricing_${field}`)].map(csvCell).join(',')];
      let bytes = Buffer.byteLength(lines[0]! + '\r\n');
      // 分页限制内存，超过容量直接失败，不生成看似完整的截断报表。
      for (let offset = 0; ; offset += 200) {
        const page = entries(input, 200, offset);
        for (const entry of page) {
          const line = [...columns.map(field => entry[field]), ...priceColumns.map(field => entry.pricingSnapshot?.[field] ?? null)].map(csvCell).join(',');
          bytes += Buffer.byteLength(line + '\r\n');
          if (bytes > MAX_EXPORT_BYTES) throw new BackendError('EXPORT_LIMIT', 'CSV超过8MiB，请缩小筛选范围后导出。');
          lines.push(line);
        }
        if (page.length < 200) break;
      }
      return { name: `PixelMuse-usage-${context.clock().slice(0, 10)}.csv`, mimeType: 'text/csv' as const, base64: Buffer.from(lines.join('\r\n') + '\r\n').toString('base64') };
    },
  };
}
