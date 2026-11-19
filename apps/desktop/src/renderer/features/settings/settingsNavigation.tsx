import { Button } from 'antd';
import { createContext, useContext } from 'react';
import { useLocation, useNavigate } from 'react-router';
export type SettingsSection = 'general' | 'models' | 'usage' | 'storage' | 'search' | 'about';
export interface SettingsNavigation {
    open: (section?: SettingsSection) => Promise<void>;
    close: () => Promise<void>;
    source: string | null;
}
export const SettingsNavigationContext = createContext<SettingsNavigation | null>(null);
/** 从任意选择器进入设置，来源和草稿保存由应用壳统一处理。 */
export function useSettingsNavigation(): SettingsNavigation {
    const shared = useContext(SettingsNavigationContext);
    const location = useLocation();
    const navigate = useNavigate();
    return shared ?? {
        source: (location.state as { settingsSource?: string } | null)?.settingsSource ?? null,
        open: async (section = 'models') => { await navigate(`/settings/${section}`, { state: { settingsSource: `${location.pathname}${location.search}` } }); },
        close: async () => { await navigate((location.state as { settingsSource?: string } | null)?.settingsSource ?? '/'); },
    };
}
export function ManageModelsButton() {
    const settings = useSettingsNavigation();
    return <Button type="link" size="small" onClick={() => void settings.open('models')}>管理模型</Button>;
}
