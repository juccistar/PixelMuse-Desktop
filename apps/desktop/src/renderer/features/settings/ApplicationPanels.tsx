import { Alert, App, Button, Select, Skeleton, Space } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { application, collection } from '../../api/nativeClient';
import { useProjects } from '../../api/hooks/useProjects';
import { errorText } from '../../lib/errorText';
import { SearchSourceView } from '../providers/SearchSourceView';
import { CollectionDialog } from '../collection/CollectionDialog';
import { WorkspacePanel } from '../workspace/WorkspacePanel';
import styles from './SettingsPage.module.css';
function NativeActions({ diagnostics = false }: { diagnostics?: boolean }) {
    const [pending, setPending] = useState<string | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const { message } = App.useApp();
    const run = async (target: 'applicationData' | 'logs' | 'diagnostics') => {
        setPending(target); setFailure(null);
        try {
            if (target === 'diagnostics') { const result = await application('exportDiagnostics', {}); void message.info(result.saved ? '脱敏诊断已保存' : '已取消保存'); }
            else await application('openDirectory', { target });
        } catch (error) { setFailure(errorText(error)); }
        finally { setPending(null); }
    };
    return <><Space wrap><Button disabled={pending !== null} loading={pending === 'applicationData'} onClick={() => void run('applicationData')}>打开应用数据目录</Button>{diagnostics ? <><Button disabled={pending !== null} loading={pending === 'logs'} onClick={() => void run('logs')}>打开日志目录</Button><Button disabled={pending !== null} loading={pending === 'diagnostics'} onClick={() => void run('diagnostics')}>导出脱敏诊断</Button></> : null}</Space>{failure ? <Alert type="error" title="操作未完成" description={failure}/> : null}</>;
}
export function StorageSettings() {
    return <><h2>工作空间与数据</h2><WorkspacePanel/><h3>应用数据</h3><p className={styles.hint}>项目数据库、模型配置和加密密钥保存在应用数据目录，与媒体目录分开管理。通过下方按钮在系统中查看实际位置。</p><NativeActions/></>;
}
export function AboutSettings() {
    const info = useQuery({ queryKey: ['application-info'], queryFn: () => application('info', {}), retry: false });
    return <><h2>关于 PixelMuse</h2><p className={styles.hint}>商品视觉创作工作台 · 本地项目、素材与创作流程。</p>
      {info.isPending ? <Skeleton active/> : info.isError ? <Alert type="error" title="应用信息读取失败" description={errorText(info.error)} action={<Button onClick={() => void info.refetch()}>重试</Button>}/> : <table className={styles.table}><caption>运行环境</caption><tbody>{[['应用', `${info.data.name} ${info.data.version}`], ['平台', `${info.data.platform} / ${info.data.arch}`], ['Electron', info.data.electronVersion], ['Chromium', info.data.chromeVersion], ['Node.js', info.data.nodeVersion], ['运行方式', info.data.packaged ? '已打包桌面应用' : '开发版本'], ['系统通知', info.data.notificationsSupported ? '系统支持' : '系统暂不支持']].map(([name, value]) => <tr key={name}><th scope="row">{name}</th><td>{value}</td></tr>)}</tbody></table>}
      <h3>帮助与诊断</h3><p className={styles.hint}>连接问题可在“模型配置”中检查地址、密钥与协议。诊断文件仅包含版本、平台与固定健康信息，不复制原始日志或项目素材。</p><NativeActions diagnostics/>
      <h3>本轮更新</h3><p className={styles.hint}>应用内设置中心，按模型管理服务连接与默认用途；常规创作偏好、请求用量记录和费用估算集中维护。</p>
      <details><summary>第三方组件说明</summary><p className={styles.hint}>桌面框架 Electron、界面 React / Ant Design、路由 React Router、查询 TanStack Query、图标 Lucide、图片处理 Sharp、持久化 SQLite，以及对应依赖。完整许可随发行包的第三方许可文件提供。</p></details>
    </>;
}
export function SearchSettings() {
    const projects = useProjects();
    const [projectId, setProjectId] = useState<string>();
    const [collecting, setCollecting] = useState(false);
    const sources = useQuery({ queryKey: ['collection-sources', projectId], queryFn: () => collection('sources', { projectId: projectId! }), enabled: Boolean(projectId) });
    return <><h2>搜索与采集</h2><p className={styles.hint}>搜索服务供联网研究使用，按启用状态与优先级调用。采集的参考图保留来源记录，需要人工确认后才可作为商品事实。</p><SearchSourceView/>
      <h3>商品参考图采集</h3><p className={styles.hint}>按项目管理采集会话。在采集面板可关闭窗口、清除站点会话或查看导入结果；登录状态不会进入来源记录。</p><Space wrap><Select aria-label="采集项目" placeholder="选择项目查看采集来源" showSearch optionFilterProp="label" loading={projects.isPending} value={projectId} style={{ width: 300 }} options={projects.data?.items.map(item => ({ value: item.id, label: item.name }))} onChange={setProjectId}/><Button disabled={!projectId} onClick={() => setCollecting(true)}>打开项目采集面板</Button></Space>
      {projects.isError ? <Alert type="error" title="项目列表读取失败" description={errorText(projects.error)} action={<Button onClick={() => void projects.refetch()}>重试</Button>}/> : null}
      {projectId && sources.isPending ? <Skeleton active/> : sources.isError ? <Alert type="error" title="来源记录读取失败" description={errorText(sources.error)} action={<Button onClick={() => void sources.refetch()}>重试</Button>}/> : projectId && sources.data ? <><table className={styles.table}><caption>已导入素材来源</caption><thead><tr><th>来源平台 / 页面</th><th>商品页面标题</th><th>采集时间</th></tr></thead><tbody>{sources.data.items.map((item, index) => <tr key={`${item.assetId}:${index}`}><td>{item.platform}<small>{item.pageUrl}</small></td><td>{item.title || '未提供标题'}</td><td>{new Date(item.collectedAt).toLocaleString()}</td></tr>)}</tbody></table>{sources.data.items.length === 0 ? <p className={styles.hint}>该项目尚无采集来源记录。</p> : null}</> : null}
      {collecting && projectId ? <CollectionDialog projectId={projectId} onClose={() => setCollecting(false)}/> : null}
    </>;
}
