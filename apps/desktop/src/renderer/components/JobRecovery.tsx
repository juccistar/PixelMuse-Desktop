import { App, Button, Tooltip } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { invoke } from '../api/client';
import { qk } from '../api/queryKeys';
import { errorText } from '../lib/errorText';
import { useBusinessActive } from './businessActivity';

/** 直接处理任务中断，完成后重新读取持久状态。 */
export function JobRecovery({ jobId, allowActions = true, disabled = false, onResolved }: { jobId: string; label?: string; allowActions?: boolean; disabled?: boolean; onResolved?: () => void | Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const active = useBusinessActive();
  disabled ||= !active;
  const client = useQueryClient();
  const { message } = App.useApp();
  const actions = useQuery({ queryKey: ['jobActions', jobId], queryFn: () => invoke('getJobActions', { jobId }), enabled: allowActions });
  const recovery = useQuery({ queryKey: ['jobRecovery', jobId], queryFn: () => invoke('getJobRecovery', { jobId }) });
  const refresh = async () => {
    await Promise.all([['jobs'], ['jobActions'], ['jobRecovery'], ['suite-forge-jobs'], qk.suiteForgeJobList, ['modelCastHistory'], ['patternListingHistory'], ['projects'], qk.models, qk.patterns, qk.patternDrafts].map(queryKey => client.invalidateQueries({ queryKey })));
    window.dispatchEvent(new Event('pixelmuse:job-resolution'));
    await onResolved?.();
  };
  const resolve = async (action: 'RETRY' | 'END') => {
    if (saving || disabled || !actions.data?.[action === 'RETRY' ? 'retry' : 'end']?.available) return;
    setSaving(true);
    try {
      const result = await invoke('resolveJobInterruptions', { jobId, action });
      await refresh();
      const item = result.items.find(item => item.jobId === jobId);
      if (!item || item.status === 'FAILED' || item.status === 'SKIPPED') void message.error(item?.reason ?? '任务未能处理');
      else void message.success(action === 'RETRY' ? '已重试任务' : '已结束中断任务');
    } catch (error) { void message.error(errorText(error)); }
    finally { setSaving(false); }
  };
  const recover = async () => {
    if (saving || disabled || !recovery.data?.canRecover) return;
    setSaving(true);
    try { await invoke('recoverJobLocally', { jobId }); await refresh(); void message.success('已开始本地回执恢复'); }
    catch (error) { void message.error(errorText(error)); }
    finally { setSaving(false); }
  };
  return <>
    {allowActions ? <>
      <Tooltip title={actions.data?.retry.reason ?? (actions.isError ? '无法读取任务操作' : undefined)}><Button size="small" disabled={disabled || saving || !actions.data?.retry.available} onClick={() => void resolve('RETRY')}>重试任务</Button></Tooltip>
      <Tooltip title={actions.data?.end.reason ?? (actions.isError ? '无法读取任务操作' : undefined)}><Button size="small" disabled={disabled || saving || !actions.data?.end.available} onClick={() => void resolve('END')}>结束任务</Button></Tooltip>
    </> : null}
    {recovery.data?.canRecover ? <Button size="small" disabled={disabled || saving} onClick={() => void recover()}>仅恢复本地结果</Button> : null}
    {recovery.isError ? <span role="alert">无法读取本地恢复状态：{errorText(recovery.error)}</span> : null}
  </>;
}
