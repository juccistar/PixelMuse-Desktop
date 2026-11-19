import { createHash } from 'node:crypto';
import type { SqliteDatabase, SecretBox } from '@ecomgen/core';
import type { ModelPricing, UsageEntry } from '@ecomgen/contracts';
import { ResponseReceiptSchema, type ResponseReceipt } from '@ecomgen/domain';
import { Value } from '@sinclair/typebox/value';
import { JobRuntimeSchema, type FrozenJobSnapshot, type RequestRecord } from './state.js';
import { extractReceiptUsage, estimateUsageAmount } from './usage-extraction.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown, max = 1000): string | null => typeof value === 'string' ? value.slice(0, max) : null;

/** 使用同一连接，发送前插入与运行账本处于同一事务；没有级联删除。 */
export class UsageStore {
  constructor(readonly db: SqliteDatabase) {}
  get(jobId: string, requestKey: string): UsageEntry | undefined {
    const row = this.db.prepare('SELECT entry_json FROM desktop_usage_records WHERE job_id=? AND request_key=?').get(jobId, requestKey) as { entry_json: string } | undefined;
    return row ? JSON.parse(row.entry_json) as UsageEntry : undefined;
  }
  pricing(providerId: string, modelId: string): ModelPricing | null {
    const row = this.db.prepare('SELECT pricing_json FROM desktop_model_pricing WHERE provider_id=? AND model_id=?').get(providerId, modelId) as { pricing_json: string } | undefined;
    return row ? JSON.parse(row.pricing_json) as ModelPricing : null;
  }
  begin(jobId: string, request: RequestRecord, snapshot: FrozenJobSnapshot, historical = false): void {
    if (this.get(jobId, (request.usageKey ?? request.descriptor.requestKey))) return;
    // SEARCH/POLL 的绑定模型仅是调用上下文，不是该次模型收费身份。
    const model = ['MODEL', 'IMAGE', 'SEGMENTATION'].includes(request.descriptor.purpose) ? request.descriptor.model : undefined;
    const job = this.db.prepare('SELECT project_id FROM jobs WHERE id=?').get(jobId) as { project_id: string | null } | undefined;
    const projectId = job?.project_id ?? null;
    const execution = object(snapshot.effective.execution);
    const reads = object(execution?.reads);
    const frozenProvider = model ? object(reads?.[`getProvider:${JSON.stringify([model.providerId])}`]) : undefined;
    const frozenProject = projectId ? object(reads?.[`getProject:${JSON.stringify([projectId])}`]) : undefined;
    const provider = model ? this.db.prepare('SELECT name FROM providers WHERE id=?').get(model.providerId) as { name: string } | undefined : undefined;
    const project = projectId ? this.db.prepare('SELECT name FROM projects WHERE id=?').get(projectId) as { name: string } | undefined : undefined;
    // 历史请求没有当时的价格快照；不能套用今天的单价。
    const pricingSnapshot = !historical && model ? this.pricing(model.providerId, model.modelId) : null;
    const entry: UsageEntry = {
      id: hash(JSON.stringify([jobId, (request.usageKey ?? request.descriptor.requestKey)])), jobId, requestKey: (request.usageKey ?? request.descriptor.requestKey),
      projectId, projectName: text(frozenProject?.name ?? project?.name),
      providerId: model?.providerId ?? null, providerName: text(frozenProvider?.name ?? provider?.name), modelId: model?.modelId ?? null,
      purpose: request.descriptor.purpose, state: request.state === 'VERIFIED_FAILED' ? 'UNKNOWN' : request.state, httpStatus: null,
      startedAt: request.startedAt, completedAt: request.completedAt ?? null,
      inputTokens: null, outputTokens: null, cachedInputTokens: null, usageSource: 'UNAVAILABLE',
      estimatedAmount: null, currency: pricingSnapshot?.currency ?? null, pricingSnapshot,
    };
    this.db.prepare('INSERT INTO desktop_usage_records(id,job_id,request_key,entry_json,started_at) VALUES (?,?,?,?,?) ON CONFLICT(job_id,request_key) DO NOTHING').run(entry.id, jobId, entry.requestKey, JSON.stringify(entry), entry.startedAt);
  }
  complete(jobId: string, request: RequestRecord, receipt: ResponseReceipt): void {
    const entry = this.get(jobId, (request.usageKey ?? request.descriptor.requestKey));
    if (!entry || entry.state === 'COMPLETED') return;
    const usage = extractReceiptUsage(receipt);
    Object.assign(entry, usage, { state: 'COMPLETED', httpStatus: receipt.status, completedAt: request.completedAt ?? null });
    entry.estimatedAmount = estimateUsageAmount(usage, entry.pricingSnapshot);
    this.write(entry);
  }
  unknown(jobId: string, requestKey: string): void {
    const entry = this.get(jobId, requestKey);
    if (entry && entry.state !== 'COMPLETED') { entry.state = 'UNKNOWN'; this.write(entry); }
  }
  private write(entry: UsageEntry): void {
    this.db.prepare('UPDATE desktop_usage_records SET entry_json=? WHERE job_id=? AND request_key=?').run(JSON.stringify(entry), entry.jobId, entry.requestKey);
  }
}

const backfilled = new WeakMap<SqliteDatabase, string>();
/** 通知只发生在最外层提交后；订阅异常不改变请求或统计的持久结果。 */
export function notifyUsage(db: SqliteDatabase, notify?: () => void, committed?: () => boolean): void {
  if (!notify) return;
  if (db.inTransaction) {
    // 原始 RuntimeStore 事务没有事件队列；同步事务退出后核对持久值，回滚不能误报。
    if (committed) queueMicrotask(() => {
      try { if (db.open && !db.inTransaction && committed()) notifyUsage(db, notify); } catch { /* 关闭或恢复失败不影响调用。 */ }
    });
    return;
  }
  try { notify(); } catch { /* 通知可丢弃，查询仍是唯一真相。 */ }
}

/** 每连接仅一次；优先修复未收敛记录，两个持久游标轮转历史，查询不解密回执。 */
export function backfillUsage(db: SqliteDatabase, secrets: Pick<SecretBox, 'decrypt'>, notify?: () => void): string {
  const previous = backfilled.get(db);
  if (previous) return previous;
  const store = new UsageStore(db);
  // 私有维护状态由 core 的显式 v5 DDL 创建，业务初始化不另行修补数据库结构。
  type Cursor = { runtime_rowid: number; request_offset: number };
  type Row = { runtime_rowid: number; job_id: string; bytes: number };
  let bytes = 0, imported = 0, skipped = 0, inspected = 0, snapshots = 0;
  // 每条游标各处理一份大快照；96MiB 响应经两次 base64 编码后仍在此上限内。
  const largeLimit = 256 * 1024 * 1024;
  const visited = new Set<number>();
  for (const lane of ['pending', 'history']) {
    let largeSnapshot = false;
    if (snapshots >= 100 || inspected >= 200) break;
    const cursor = db.prepare('SELECT runtime_rowid,request_offset FROM desktop_usage_recovery WHERE lane=?').get(lane) as Cursor | undefined;
    const start = cursor?.runtime_rowid ?? 0;
    const pending = lane === 'pending' ? `AND EXISTS (SELECT 1 FROM desktop_usage_records u WHERE u.job_id=r.job_id AND json_extract(u.entry_json,'$.state')!='COMPLETED')` : '';
    const select = (comparison: string, limit: number) => db.prepare(`SELECT r.rowid AS runtime_rowid,r.job_id,octet_length(r.payload) AS bytes FROM desktop_job_runtime r WHERE r.rowid${comparison}? ${pending} ORDER BY r.rowid LIMIT ?`).all(start, limit) as Row[];
    // 部分处理的大任务从同一请求位置继续；完整行从下一 rowid 开始，末尾再绕回。
    const rows = select(cursor?.request_offset ? '>=' : '>', 100);
    if (rows.length < 100) rows.push(...select(cursor?.request_offset ? '<' : '<=', 100 - rows.length));
    const snapshotLimit = lane === 'pending' ? 50 : 100;
    const requestLimit = lane === 'pending' ? 100 : 200;
    const byteLimit = lane === 'pending' ? 4 * 1024 * 1024 : 8 * 1024 * 1024;
    for (const row of rows) {
      if (snapshots >= snapshotLimit || inspected >= requestLimit) break;
      if (visited.has(row.runtime_rowid)) continue;
      // 总预算不足时停在上一行，下次从此处继续；跳过并推进会反复饿死同一批大行。
      const large = row.bytes > 1024 * 1024 && row.bytes <= largeLimit;
      if ((large && largeSnapshot) || (!large && row.bytes <= 1024 * 1024 && bytes + row.bytes > byteLimit)) break;
      if (large) largeSnapshot = true;
      visited.add(row.runtime_rowid); snapshots++;
      let offset = row.runtime_rowid === start ? cursor?.request_offset ?? 0 : 0;
      try {
        if (row.bytes > largeLimit) { skipped++; offset = 0; continue; }
        if (!large) bytes += row.bytes;
        const raw = db.prepare('SELECT payload FROM desktop_job_runtime WHERE job_id=?').get(row.job_id) as { payload: string };
        const runtime: unknown = JSON.parse(raw.payload);
        if (!Value.Check(JobRuntimeSchema, runtime)) { skipped++; offset = 0; continue; }
        const requests = [...(runtime.requestHistory ?? []), ...runtime.requests];
        for (; offset < requests.length && inspected < requestLimit; offset++) {
          const request = requests[offset]!;
          inspected++;
          const before = store.get(row.job_id, (request.usageKey ?? request.descriptor.requestKey));
          try {
            db.transaction(() => {
              // 已验证的完成记录及其旧价格快照保持不变，不再重复解密。
              if (before?.state === 'COMPLETED') return;
              store.begin(row.job_id, request.state === 'COMPLETED' ? { ...request, state: 'UNKNOWN' } : request, runtime.snapshot, true);
              if (request.state === 'COMPLETED' && request.encryptedReceipt) {
                const plain = secrets.decrypt(request.encryptedReceipt);
                if (hash(plain) !== request.responseHash) { store.unknown(row.job_id, (request.usageKey ?? request.descriptor.requestKey)); skipped++; return; }
                const receipt: unknown = JSON.parse(plain);
                if (!Value.Check(ResponseReceiptSchema, receipt)) { store.unknown(row.job_id, (request.usageKey ?? request.descriptor.requestKey)); skipped++; return; }
                store.complete(row.job_id, request, receipt); imported++;
              } else if (request.state === 'UNKNOWN' || request.state === 'IN_FLIGHT' || request.state === 'VERIFIED_FAILED') store.unknown(row.job_id, (request.usageKey ?? request.descriptor.requestKey));
            }).immediate();
          } catch {
            skipped++;
            // 已知运行回执完成时不继续宣称仍在网络中；保留待验证状态，下轮有界重试。
            if (request.state === 'COMPLETED') try { store.unknown(row.job_id, (request.usageKey ?? request.descriptor.requestKey)); } catch { /* 数据库仍不可写，下一轮继续。 */ }
          }
          if (JSON.stringify(before) !== JSON.stringify(store.get(row.job_id, (request.usageKey ?? request.descriptor.requestKey)))) notifyUsage(db, notify);
        }
        if (offset >= requests.length) offset = 0;
      } catch { skipped++; offset = 0; }
      finally {
        // 即使单行损坏/持久写失败，也向前推进；下一轮再重试，不让坏行饿死新请求。
        db.prepare('INSERT INTO desktop_usage_recovery VALUES (?,?,?) ON CONFLICT(lane) DO UPDATE SET runtime_rowid=excluded.runtime_rowid,request_offset=excluded.request_offset').run(lane, row.runtime_rowid, offset);
      }
    }
  }
  const note = `历史回填每次启动优先修复未收敛记录，再按持久游标轮转检查最多100份运行快照、最多200个请求，普通快照单份≤1MiB、总计≤8MiB，两条游标各最多处理一份≤256MiB的大快照；本次检查${inspected}个请求，验证完整回执${imported}份，跳过${skipped}项。更早版本、已删除业务或超限回执可能未覆盖；历史无当时价格不估算。Token仅汇总服务明确返回值（Gemini输出包含明确返回的思考Token），缺失不视作零；估算按币种仅汇总可完整计价请求，非实际扣费。任务数来自匹配请求的独立任务，产物数仅含当前业务 outputs 记录，删除业务后产物数会变化。`;
  backfilled.set(db, note);
  return note;
}
