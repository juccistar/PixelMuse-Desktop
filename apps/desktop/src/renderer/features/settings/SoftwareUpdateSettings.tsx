import { Alert, Button, Progress, Skeleton, Space, Switch } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useBusinessActive } from '../../components/businessActivity';
import { application } from '../../api/nativeClient';
import { useSettingsLeave } from './settingsDraft';
import styles from './SoftwareUpdateSettings.module.css';
import settingsStyles from './SettingsPage.module.css';

type Action = 'checkForUpdates' | 'downloadUpdate' | 'cancelUpdateDownload' | 'installUpdate' | 'openUpdateReleases' | 'setUpdatePreferences';
const stateLabels: Record<string, string> = {
    UNSUPPORTED: '当前运行方式不支持自动更新', IDLE: '尚未检查更新', CHECKING: '正在检查更新', AVAILABLE: '有可用更新',
    NOT_AVAILABLE: '当前已是最新版本', DOWNLOADING: '正在下载更新', DOWNLOADED: '更新已下载', INSTALLING: '正在准备安装', ERROR: '更新未完成',
} as const;

/** 更新源和安装动作由主进程控制，界面只展示查询到的状态。 */
export function SoftwareUpdateSettings() {
    const leave = useSettingsLeave();
    const active = useBusinessActive();
    const [pending, setPending] = useState<Action[]>([]);
    const locks = useRef(new Set<Action>());
    const [failure, setFailure] = useState<string | null>(null);
    const status = useQuery({
        queryKey: ['application-update-status'], queryFn: () => application('updateStatus', {}), retry: false, enabled: active,
        refetchOnMount: 'always', refetchIntervalInBackground: false,
        refetchInterval: query => active && (['CHECKING', 'DOWNLOADING', 'INSTALLING'].includes(query.state.data?.state ?? '') || pending.includes('downloadUpdate')) ? 1500 : false,
    });
    const run = async (action: Action, autoCheck?: boolean) => {
        if (locks.current.has(action)) return;
        locks.current.add(action); setPending(current => [...current, action]); setFailure(null);
        try {
            if (action === 'installUpdate' && leave && !await leave()) return;
            if (action === 'setUpdatePreferences') await application(action, { autoCheck: autoCheck! });
            else await application(action, {});
        } catch {
            setFailure(action === 'openUpdateReleases' ? '无法打开下载页面，请稍后重试。' : action === 'setUpdatePreferences' ? '更新设置保存失败，请重试。' : '更新操作未完成，请重试。');
        } finally {
            locks.current.delete(action); setPending(current => current.filter(item => item !== action));
            void status.refetch();
        }
    };
    const data = status.data;
    const busy = pending.length > 0;
    const downloadPending = pending.includes('downloadUpdate');
    return <div className={styles.panel}><h2>软件更新</h2><p className={settingsStyles.hint}>检查 PixelMuse 更新，下载完成后可重启并安装。</p>
      {!data && status.isPending ? <Skeleton active/> : !data ? <Alert type="error" title="无法读取更新状态" description="请稍后重试。" action={<Button onClick={() => void status.refetch()}>重试</Button>}/> : <>
        <div className={styles.status} role="status"><strong>{stateLabels[data.state]}</strong></div>
        <dl className={styles.details}><div><dt>当前版本</dt><dd>{data.currentVersion}</dd></div><div><dt>可用版本</dt><dd>{data.availableVersion || '—'}</dd></div><div><dt>上次检查</dt><dd>{data.checkedAt ? new Date(data.checkedAt).toLocaleString() : '尚未检查'}</dd></div></dl>
        <div className={styles.preference}><div><strong>自动检查更新</strong><p className={settingsStyles.hint}>安装版启动时自动检查是否有新版本，不自动下载或安装。</p></div><Switch aria-label="自动检查更新" checked={data.autoCheck} disabled={busy} onChange={value => void run('setUpdatePreferences', value)}/></div>
        {data.state === 'UNSUPPORTED' ? <><p className={settingsStyles.hint}>源码运行或解包版本不支持自动更新，请下载安装版后使用此功能。</p><Button disabled={busy} loading={pending.includes('openUpdateReleases')} onClick={() => void run('openUpdateReleases')}>打开下载页面</Button></> : <>
          {data.state === 'DOWNLOADING' && data.progress ? <div className={styles.progress}><Progress percent={Math.round(data.progress.percent)} status="active"/><p className={settingsStyles.hint}>{(data.progress.transferred / 1048576).toFixed(1)} / {(data.progress.total / 1048576).toFixed(1)} MB · {(data.progress.bytesPerSecond / 1048576).toFixed(1)} MB/s</p></div> : null}
          <Space wrap>
            {['IDLE', 'NOT_AVAILABLE', 'AVAILABLE', 'ERROR'].includes(data.state) ? <Button disabled={busy} loading={pending.includes('checkForUpdates')} onClick={() => void run('checkForUpdates')}>检查更新</Button> : null}
            {data.state === 'AVAILABLE' || (data.state === 'ERROR' && data.availableVersion) ? <Button type="primary" disabled={busy} loading={downloadPending} onClick={() => void run('downloadUpdate')}>下载更新</Button> : null}
            {data.state === 'DOWNLOADING' || downloadPending ? <Button disabled={pending.includes('cancelUpdateDownload')} loading={pending.includes('cancelUpdateDownload')} onClick={() => void run('cancelUpdateDownload')}>取消下载</Button> : null}
            {data.state === 'DOWNLOADED' ? <Button type="primary" disabled={busy} loading={pending.includes('installUpdate')} onClick={() => void run('installUpdate')}>重启并安装</Button> : null}
          </Space>
        </>}
        {data.error ? <Alert className={styles.alert} type={data.state === 'DOWNLOADED' ? 'warning' : 'error'} title={data.state === 'DOWNLOADED' ? '暂时无法安装' : '更新未完成'} description={data.error}/> : null}
        {data.releaseNotes ? <section className={styles.notes} aria-label="更新说明"><h3>更新说明</h3><p>{data.releaseNotes}</p></section> : null}
      </>}
      {failure ? <Alert className={styles.alert} type="error" title="操作未完成" description={failure}/> : null}
      {data && status.isError ? <Alert className={styles.alert} type="error" title="更新状态读取失败" description="请重试以获取最新状态。" action={<Button onClick={() => void status.refetch()}>重试</Button>}/> : null}
    </div>;
}
