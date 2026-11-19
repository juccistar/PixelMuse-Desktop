import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Space, Spin, Tag } from 'antd';
import { FolderOpen, FolderSync, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { workspace } from '../../api/nativeClient';
import { errorText } from '../../lib/errorText';
import styles from './WorkspacePanel.module.css';
const workspaceKey = ['native-workspace'] as const;
const stateLabels: Record<string, string> = { READY: '可以创作', COPYING: '正在复制素材', VERIFYING: '正在校验素材', RESTARTING: '正在连接新工作空间', FAILED: '迁移未完成' };
const activeStates = new Set(['COPYING', 'VERIFYING', 'RESTARTING']);
function bytes(value: number): string {
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
/** 设置中心的目录选择与迁移界面；查询原生状态决定显示结果。 */
export function WorkspacePanel() {
    const queryClient = useQueryClient();
    const { message } = App.useApp();
    const [pending, setPending] = useState<'choose' | 'cancel' | 'open' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const previousState = useRef<string | null>(null);
    const query = useQuery({ queryKey: workspaceKey, queryFn: () => workspace('migration', {}), staleTime: 0, retry: false, refetchInterval: 1000 });
    const status = query.data;
    const active = Boolean(status && activeStates.has(status.state));
    useEffect(() => {
        if (!status) return;
        if (status.state === 'READY' && previousState.current && activeStates.has(previousState.current)) {
            void queryClient.invalidateQueries({ predicate: item => item.queryKey[0] !== workspaceKey[0] });
        }
        previousState.current = status.state;
    }, [status, queryClient]);
    const act = async (operation: 'choose' | 'cancel' | 'open') => {
        setPending(operation); setError(null);
        try {
            if (operation === 'choose') {
                const result = await workspace('choose', {});
                queryClient.setQueryData(workspaceKey, result.status);
                if (result.canceled) void message.info('已取消选择目录');
            } else if (operation === 'cancel') {
                queryClient.setQueryData(workspaceKey, await workspace('cancel', {}));
            } else await workspace('openFolder', {});
        } catch (cause) { setError(errorText(cause)); }
        finally { setPending(null); }
    };
    return <>
      <p className={styles.intro}>商品素材、采集参考图和创作产物，统一保存在本地工作空间。</p>
      {query.isPending ? <div className={styles.loading}><Spin/> 正在读取工作空间…</div> : null}
      {query.isError ? <Alert type="error" showIcon title="工作空间状态读取失败" description={errorText(query.error)} action={<Button size="small" icon={<RefreshCw size={13}/>} onClick={() => void query.refetch()}>重试</Button>}/> : null}
      {status ? <>
        <div className={styles.directory}><FolderOpen size={20} aria-hidden/><div><span>当前素材目录</span><code aria-label="当前工作空间目录">{status.directory}</code></div></div>
        <Space wrap><Tag color={status.state === 'FAILED' ? 'error' : active ? 'processing' : 'success'}>{stateLabels[status.state]}</Tag><span className={styles.note}>{status.configured ? '已设置独立素材目录' : '使用默认素材目录'}</span></Space>
        {active ? <div className={styles.progress} role="status" aria-live="polite"><Spin size="small"/><div><strong>{stateLabels[status.state]}</strong><p>已复制 {status.copiedFiles} / {status.totalFiles} 个文件 · {bytes(status.copiedBytes)} / {bytes(status.totalBytes)}</p></div></div> : null}
        {status.error ? <Alert type="error" showIcon title="工作空间需要处理" description={status.error}/> : null}
        <div className={styles.actions}><Button type="primary" icon={<FolderSync size={15}/>} disabled={active || Boolean(pending)} loading={pending === 'choose'} onClick={() => void act('choose')}>选择工作空间目录</Button><Button icon={<FolderOpen size={15}/>} disabled={Boolean(pending) || active} loading={pending === 'open'} onClick={() => void act('open')}>在系统中打开</Button>{active ? <Button danger disabled={Boolean(pending) || status.state === 'RESTARTING'} loading={pending === 'cancel'} onClick={() => void act('cancel')}>取消迁移</Button> : null}</div>
      </> : null}
      {error ? <Alert type="error" showIcon title="操作未完成" description={error}/> : null}
      <div className={styles.explanation}><strong>切换时会发生什么</strong><p>先复制现有受管素材并校验，再切换工作空间；原目录的素材保留。请等待当前生成、上传或导出任务完成后再切换。</p><p>项目记录、模型设置和密钥继续保存在应用数据目录。选择目录不会移动凭据或读取目录中的其他用户文件。</p></div>
    </>;
}
