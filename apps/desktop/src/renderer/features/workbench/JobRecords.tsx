import { App, Button, Drawer, Image, Pagination, Tooltip } from 'antd';
import { Activity, CheckCircle2, ChevronRight, CircleAlert, Clock3 } from 'lucide-react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { JobRecovery } from '../../components/JobRecovery';
import { useEffect, useState } from 'react';
import { resourceUrlFor, type DesktopHistory } from '@ecomgen/contracts';
import { adaptJob, type Job, type ProjectDetail } from '../../api/adapters/projectDetail';
import { invoke } from '../../api/client';
import { useCancelJob, useRetryJob } from '../../api/hooks/useJobs';
import { qk } from '../../api/queryKeys';
import { ResourceSaveButton } from '../../components/ResourceSaveButton';
import { useBusinessActive } from '../../components/businessActivity';
import { JOB_STATUS_LABEL } from '../../lib/factClaims';
import { errorText } from '../../lib/errorText';
import { jobErrorText } from '../../lib/jobError';
import { itemDisplayName } from '../../lib/itemName';
import { formatDateTime } from '../../lib/format';
import { useTemplateNames } from '../../api/hooks/useTemplates';
import styles from './JobRecords.module.css';

const PAGE_SIZE = 10;
const KIND_LABEL: Record<DesktopHistory['kind'], string> = { EXPORT: '导出', PLAN: '规划', GENERATE: '生图', SEGMENT: '分割', LAYER: '分层', PATTERN: '花型', SUITE: '套图', PI_AGENT: '文本任务' };
const TASK_LABEL: Record<Job['type'], string> = {
  PLAN: '分镜规划', COPYWRITE: '文案创作', GENERATE: '图片生成', EXPORT: '文件导出', EDIT_PLAN: '编辑规划', EDIT_GENERATE: '图片编辑',
  LAYER_PLAN: '元素识别', LAYER_EXPORT: '图层导出', SUITE_FORGE: '套图反推', MODEL_CAST: '模特定妆', PATTERN_EXTRACT: '花型提取',
  PATTERN_FORGE: '花型起稿', PATTERN_DERIVE: '花型改色', PATTERN_VARIANT: '花型变体', PATTERN_TILE_CHECK: '平铺验缝', PRINT_PACK: '印刷包',
  PATTERN_DRAFT_GENERATE: '草稿生成', PATTERN_DRAFT_EDIT: '草稿编辑', PATTERN_DRAFT_CUTOUT: '草稿去底', PATTERN_DRAFT_PROCESS: '草稿处理',
};
type Filter = 'all' | 'active' | 'attention' | 'done';
const FILTERS: { value: Filter; label: string }[] = [{ value: 'all', label: '全部' }, { value: 'active', label: '进行中' }, { value: 'attention', label: '异常' }, { value: 'done', label: '已完成' }];
function matches(job: Job, filter: Filter): boolean {
  if (filter === 'active') return job.status === 'QUEUED' || job.status === 'RUNNING';
  if (filter === 'attention') return job.status === 'FAILED' || job.status === 'UNKNOWN';
  if (filter === 'done') return job.status === 'SUCCEEDED';
  return true;
}

function JobActions({ job, pending, onCancel, onRetry }: { job: Job; pending: boolean; onCancel: () => void; onRetry: () => void }) {
  const actions = useQuery({ queryKey: ['jobActions', job.id, job.status], queryFn: () => invoke('getJobActions', { jobId: job.id }) });
  if (job.status === 'QUEUED' || job.status === 'RUNNING') return <Tooltip title={actions.data?.cancel.reason}><Button size="small" disabled={!actions.data?.cancel.available || job.cancelRequested || pending} onClick={onCancel}>{job.cancelRequested ? '取消中' : '取消'}</Button></Tooltip>;
  if (job.status === 'FAILED' || job.status === 'CANCELLED') return <Tooltip title={actions.data?.retry.reason ?? (actions.isError ? '无法读取任务操作' : undefined)}><Button size="small" disabled={!actions.data?.retry.available || pending} onClick={onRetry}>重试任务</Button></Tooltip>;
  return null;
}

function HistoryResult({ history }: { history: DesktopHistory }) {
  const result = history.result;
  return <>
    <p className={styles.hint}>桌面 v{history.sourceVersion} · {KIND_LABEL[history.kind]} · 只读历史</p>
    <p className={styles.hint}>原任务：{JOB_STATUS_LABEL[history.originalStatus as Job['status']] ?? history.originalStatus} · 原请求：{history.requestState}</p>
    {history.originalStatus === 'UNKNOWN' || history.requestState === 'IN_FLIGHT' || history.requestState === 'UNKNOWN'
      ? <p className={styles.error}>外部请求结果未知，请核实原服务记录。此历史任务不可执行、重试或重新生成。</p>
      : <p className={styles.hint}>历史任务仅供查看和保存已有文件，不能重新执行。</p>}
    {history.resultStatus === 'UNAVAILABLE' ? <p className={styles.error}>历史结果无法安全读取，原记录已保留。</p> : null}
    {history.resultStatus === 'NONE' && history.files.length === 0 ? <p className={styles.hint}>没有保留的结果或文件。</p> : null}
    {result?.text !== undefined ? <pre className={styles.historyText}>{result.text}</pre> : null}
    {result?.storyboardId ? <p className={styles.hint}>保留分镜：{result.storyboardId}</p> : null}
    {result?.tileability ? <p className={styles.hint}>验缝：{result.tileability.status} · {result.tileability.score}</p> : null}
    {history.files.map((file, index) => <HistoryFile key={`${file.ref.kind}:${file.ref.id}:${index}`} file={file} />)}
  </>;
}
function HistoryFile({ file }: { file: DesktopHistory['files'][number] }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [file]);
  const available = file.available && !failed;
  const url = resourceUrlFor(file.ref);
  const label = file.name ?? `${file.ref.kind} · ${file.ref.id}`;
  return <div className={styles.historyFile}>
    <p className={styles.hint}>{label}</p>
    {available && ['image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(file.mimeType ?? '') ? <Image src={url} alt={label} width={160} onError={() => setFailed(true)} /> : null}
    {available ? <ResourceSaveButton size="small" resourceUrl={url} onSaveError={error => {
      const code = (error as { code?: string })?.code;
      if (code === 'RESOURCE_UNAVAILABLE' || code === 'RESOURCE_CHANGED') setFailed(true);
    }}>保存文件</ResourceSaveButton>
      : <p className={styles.error}>文件不可用：文件缺失、已被修改或无法读取。</p>}
  </div>;
}

/** 页面仅展示一行持久状态摘要；完整任务按项目 ID 分页读取到右侧抽屉。 */
export function JobRecords({ detail, open: controlledOpen, onOpenChange }: { detail: ProjectDetail; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => { if (onOpenChange) onOpenChange(next); else setLocalOpen(next); };
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<Filter>('all');
  const [batchPending, setBatchPending] = useState(false);
  const active = useBusinessActive();
  useEffect(() => { setOpen(false); setPage(1); setFilter('all'); }, [detail.id]);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  const retry = useRetryJob(detail.id), cancel = useCancelJob(detail.id);
  const queryClient = useQueryClient();
  const { notification } = App.useApp();
  const templateNames = useTemplateNames();
  const counts = { active: 0, done: 0, failed: 0, unknown: 0 };
  for (const job of detail.jobs) {
    if (job.status === 'QUEUED' || job.status === 'RUNNING') counts.active++;
    else if (job.status === 'SUCCEEDED') counts.done++;
    else if (job.status === 'FAILED') counts.failed++;
    else if (job.status === 'UNKNOWN') counts.unknown++;
  }
  const filtered = detail.jobs.filter(job => matches(job, filter));
  const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, maxPage);
  const selected = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  // 关闭时不抓取历史正文；摘要来自完整项目查询，不能用最近十条推算全部任务数。
  const queries = useQueries({ queries: selected.map(job => ({
    queryKey: qk.jobRecord(job.id),
    enabled: open && active,
    queryFn: async () => {
      const result = adaptJob(await invoke('getJob', { jobId: job.id }));
      if (!result) throw new Error('任务响应无法解析');
      return result;
    },
    refetchInterval: (query: { state: { data?: Job } }) => open && active && query.state.data && !query.state.data.history && ['QUEUED', 'RUNNING'].includes(query.state.data.status) ? 2000 : false as const,
  })) });
  const act = (work: Promise<unknown>, jobId: string) => {
    void work.then(() => queryClient.invalidateQueries({ queryKey: qk.jobRecord(jobId) }))
      .catch(error => notification.error({ title: '任务操作失败', description: errorText(error) }));
  };
  const batch = async (action: 'RETRY' | 'END') => {
    if (batchPending || !active) return;
    setBatchPending(true);
    try {
      const result = await invoke('resolveJobInterruptions', { projectId: detail.id, action });
      await Promise.all([['jobs'], ['projects'], ['jobActions'], ['jobRecovery'], ['modelCastHistory'], ['patternListingHistory'], ['suite-forge-jobs'], qk.models, qk.patterns, qk.patternDrafts, qk.suiteForgeJobList].map(queryKey => queryClient.invalidateQueries({ queryKey })));
      window.dispatchEvent(new Event('pixelmuse:job-resolution'));
      const count = (status: 'RETRIED' | 'ENDED' | 'SKIPPED' | 'FAILED') => result.items.filter(item => item.status === status).length;
      const reasons = result.items.filter(item => item.status === 'FAILED' || item.status === 'SKIPPED').map(item => `${item.jobId}: ${item.reason ?? '未提供原因'}`);
      notification.open({ title: '批量处理结果', description: `已重试 ${count('RETRIED')}，已结束 ${count('ENDED')}，跳过 ${count('SKIPPED')}，失败 ${count('FAILED')}${reasons.length ? `；${reasons.join('；')}` : ''}` });
    } catch (error) { notification.error({ title: '批量处理失败', description: errorText(error) }); }
    finally { setBatchPending(false); }
  };
  return <>
    <section className={styles.summary} aria-label="执行摘要">
      <div className={styles.stats} aria-live="polite">
        {detail.jobs.length ? <>
          {counts.unknown > 0 ? <span data-state="unknown" data-visible><Clock3 size={14} aria-hidden/>已中断 {counts.unknown}</span> : null}
          {counts.failed > 0 ? <span data-state="failed" data-visible><CircleAlert size={14} aria-hidden/>失败 {counts.failed}</span> : null}
          <span data-state="active"><Activity size={14} aria-hidden/>进行中 {counts.active}</span>
          <span data-state="done"><CheckCircle2 size={14} aria-hidden/>已完成 {counts.done}</span>
        </> : <span>暂无执行任务</span>}
      </div>
      <Button type="text" size="small" className={styles.detailsButton} onClick={() => setOpen(true)} aria-haspopup="dialog">任务详情<ChevronRight size={14} aria-hidden/></Button>
    </section>
    <Drawer title="任务详情" placement="right" size={400} open={open && active} onClose={() => setOpen(false)} rootClassName={styles.drawer} styles={{ mask: { background: 'transparent' }, wrapper: { maxWidth: 'calc(100vw - 16px)' } }}>
      <div className={styles.drawerHeader}>
        <p className={styles.hint}>任务记录 · 共 {detail.jobs.length} 条</p>
        <div className={styles.actions}>
          <Button size="small" disabled={!active || batchPending} onClick={() => void batch('RETRY')}>重试异常任务</Button>
          <Button size="small" disabled={!active || batchPending} onClick={() => void batch('END')}>结束中断任务</Button>
        </div>
        <div className={styles.filters} role="group" aria-label="任务筛选">
          {FILTERS.map(item => <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => { setFilter(item.value); setPage(1); }}>{item.label}</button>)}
        </div>
      </div>
      <section className={styles.records} aria-label="任务记录">
        {!filtered.length ? <p className={styles.empty}>暂无{filter === 'all' ? '' : FILTERS.find(item => item.value === filter)?.label}任务</p> : null}
        {queries.map((query, index) => {
          const job = query.data;
          if (!job) return <div key={selected[index]!.id} className={styles.record}>
            <p className={styles.hint}>{query.isError ? '任务记录加载失败' : '正在读取任务记录…'}</p>
            {query.isError ? <Button size="small" onClick={() => void query.refetch()}>重新读取</Button> : null}
          </div>;
          const item = detail.items.find(item => item.id === (job.storyboardItemId ?? selected[index]!.storyboardItemId));
          const label = job.history ? KIND_LABEL[job.history.kind] : item ? itemDisplayName(item, templateNames) : TASK_LABEL[job.type];
          return <article key={job.id} className={styles.record} data-status={job.status} aria-label={`${label}任务`}>
            <div className={styles.recordHeading}><h3>{label}</h3><span className={styles.status}>{job.cancelRequested && (job.status === 'QUEUED' || job.status === 'RUNNING') ? '取消中' : JOB_STATUS_LABEL[job.status]}</span></div>
            <p className={styles.hint}>{TASK_LABEL[job.type]} · {formatDateTime(job.createdAt)}</p>
            {job.history ? <HistoryResult history={job.history} /> : <>
              {jobErrorText(job) ? <p className={styles.error}>{jobErrorText(job)}</p> : null}
              {job.status === 'UNKNOWN' ? <p className={styles.warning}>任务已中断，可以重试或结束。</p> : null}
              <div className={styles.actions}>
                {['UNKNOWN', 'FAILED', 'CANCELLED'].includes(job.status) ? <JobRecovery jobId={job.id} allowActions={job.status === 'UNKNOWN'} disabled={!active || batchPending || cancel.isPending || retry.isPending} /> : null}
                <JobActions job={job} pending={!active || batchPending || cancel.isPending || retry.isPending} onCancel={() => act(cancel.mutateAsync(job.id), job.id)} onRetry={() => act(retry.mutateAsync(job.id), job.id)} />
              </div>
            </>}
          </article>;
        })}
      </section>
      {filtered.length > PAGE_SIZE ? <Pagination className={styles.pagination} current={current} pageSize={PAGE_SIZE} total={filtered.length} showSizeChanger={false} onChange={setPage} /> : null}
    </Drawer>
  </>;
}
