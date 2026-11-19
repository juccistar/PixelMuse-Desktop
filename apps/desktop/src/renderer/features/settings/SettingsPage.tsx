import { Button } from 'antd';
import { NavLink, useNavigate, useParams } from 'react-router';
import { SettingsDraftProvider } from './settingsDraft';
import { GeneralSettings } from './GeneralSettings';
import { ModelConfiguration } from './ModelConfiguration';
import { UsageSettings } from './UsageSettings';
import { SoftwareUpdateSettings } from './SoftwareUpdateSettings';
import { AboutSettings, SearchSettings, StorageSettings } from './ApplicationPanels';
import { useSettingsNavigation } from './settingsNavigation';
import styles from './SettingsPage.module.css';
const sections = [
    ['general', '常规设置'], ['models', '模型配置'], ['usage', '用量统计'], ['storage', '工作空间与数据'], ['search', '搜索与采集'], ['updates', '软件更新'], ['about', '关于 PixelMuse'],
] as const;
/** 应用内独立设置中心，继续保留主导航和来源创作上下文。 */
export function SettingsPage() {
    const { section = 'models' } = useParams();
    const navigation = useSettingsNavigation();
    const navigate = useNavigate();
    const Panel = ({ general: GeneralSettings, models: ModelConfiguration, usage: UsageSettings, storage: StorageSettings, search: SearchSettings, updates: SoftwareUpdateSettings, about: AboutSettings } as Record<string, typeof GeneralSettings>)[section];
    return <SettingsDraftProvider>{leave => <main className={styles.page}><header className={styles.header}><div><h1>设置</h1><p>模型、创作偏好与本地工作空间</p></div><Button onClick={() => void navigation.close()}>{navigation.source ? '返回创作页面' : '返回项目'}</Button></header><div className={styles.layout}><nav className={styles.nav} aria-label="设置分类">{sections.map(([key, label]) => <NavLink key={key} to={`/settings/${key}`} replace onClick={event => { event.preventDefault(); if (key !== section) void leave().then(ok => { if (ok) void navigate(`/settings/${key}`, { replace: true }); }); }}>{label}</NavLink>)}</nav><section className={styles.content} aria-label="设置内容">{Panel ? <Panel key={section}/> : <><h2>未找到该设置分类</h2><NavLink to="/settings/models">打开模型配置</NavLink></>}</section></div></main>}</SettingsDraftProvider>;
}
