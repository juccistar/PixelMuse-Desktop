import { Button } from "antd";
import { Settings2 } from "lucide-react";
import { useContext, useEffect, type ReactNode } from "react";
import { useSettingsNavigation } from '../features/settings/settingsNavigation';
import { NavigationGuardContext } from './navigationGuard';
import { HealthBadge } from "./HealthBadge";
import styles from "./AppTopbar.module.css";
export type AppTopbarSection = "home" | "forge" | "patterns" | "drafts" | "library" | "models" | "workbench";
const SECTION_LABEL: Record<AppTopbarSection, string> = { home: '所有项目', forge: '套图工坊', patterns: '花型工坊', drafts: '创作草稿', library: '资产库', models: '模特库', workbench: '项目工作台' };
interface AppTopbarProps {
    current: AppTopbarSection;
    brand?: ReactNode;
    leftExtra?: ReactNode;
    center?: ReactNode;
    settingsOpen: boolean;
    onSettingsOpenChange: (open: boolean) => void;
}
/** 页面上下文工具栏；全局导航只在持久侧栏展示一次。 */
export function AppTopbar({ current, brand, leftExtra, center, settingsOpen, onSettingsOpenChange }: AppTopbarProps) {
    const shell = useContext(NavigationGuardContext);
    const settings = useSettingsNavigation();
    useEffect(() => {
        if (settingsOpen) { onSettingsOpenChange(false); void settings.open('models'); }
    }, [settingsOpen, onSettingsOpenChange, settings]);
    return <header className={styles.topbar}>
      <div className={styles.left}>{brand ?? <span className={styles.section}>{SECTION_LABEL[current]}</span>}{leftExtra}</div>
      <div className={styles.center}>{center}</div>
      <div className={styles.actions}>
        <HealthBadge />
        {!shell ? <Button icon={<Settings2 size={16}/>} onClick={() => onSettingsOpenChange(true)}>设置</Button> : null}
      </div>
    </header>;
}
