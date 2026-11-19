import { useCallback, useContext, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Link, useOutlet, useLocation, useNavigate, UNSAFE_LocationContext } from 'react-router';
import { WorkspaceRouteSchema } from '@ecomgen/contracts';
import { Value } from '@sinclair/typebox/value';
import { useQueryClient } from '@tanstack/react-query';
import { invoke } from '../api/client';
import { useApplicationSettings } from '../api/hooks/useApplicationSettings';
import { SettingsNavigationContext, type SettingsSection } from '../features/settings/settingsNavigation';
import { ConfigProvider, Tooltip } from 'antd';
import { LayoutGrid, LibraryBig, PanelLeftClose, PanelLeftOpen, PencilRuler, Settings2, Shapes, Sparkles, UserRound } from 'lucide-react';
import { APP_SIDEBAR_WIDTH, useAppSidebarState } from '../lib/appSidebarState';
import { NavigationGuardContext, type BeforeNavigate } from './navigationGuard';
import { BusinessActivityContext } from './businessActivity';
import mark from '../assets/pixelmuse.svg';
import styles from './AppShell.module.css';
const navigationGroups = [
    { id: 'workspace', label: '工作台', items: [
        { path: '/', label: '项目', icon: LayoutGrid },
        { path: '/pattern-drafts', label: '创作草稿', icon: PencilRuler },
    ] },
    { id: 'assets', label: '素材', items: [
        { path: '/library', label: '资产库', icon: LibraryBig },
        { path: '/models', label: '模特库', icon: UserRound },
    ] },
    { id: 'tools', label: '创作工具', items: [
        { path: '/suite-forge', label: '套图工坊', icon: Sparkles },
        { path: '/patterns', label: '花型工坊', icon: Shapes },
    ] },
];
/** 九个页面共享的持久工作空间；业务页只保留自己的工具栏。 */
export function AppShell() {
    const location = useLocation();
    const navigate = useNavigate();
    const appSidebar = useAppSidebarState();
    const sidebarId = useId();
    const sidebarToggleLabel = appSidebar.collapsed ? '展开侧栏' : '收起侧栏';
    const guardRef = useRef<BeforeNavigate | null>(null);
    const settingsGuardRef = useRef<BeforeNavigate | null>(null);
    const movingRef = useRef(false);
    const [moving, setMoving] = useState(false);
    const settings = useApplicationSettings();
    const queryClient = useQueryClient();
    const outlet = useOutlet();
    const inSettings = location.pathname.startsWith('/settings');
    const businessOutlet = useRef(inSettings ? null : outlet);
    const locationContext = useContext(UNSAFE_LocationContext);
    const businessLocation = useRef(locationContext);
    if (!inSettings) { businessOutlet.current = outlet; businessLocation.current = locationContext; }
    const businessContainer = useRef<HTMLDivElement>(null);
    const getBusinessPopupContainer = useCallback(() => businessContainer.current ?? document.body, []);
    const sourceRef = useRef<string | null>(null);
    const initialLocation = useRef(location.key);
    const userNavigated = useRef(false);
    const restored = useRef(false);
    const [startupReady, setStartupReady] = useState(false);
    // 延迟返回的设置不能抢走用户已经打开的页面；只在初始项目页尝试一次恢复。
    useEffect(() => {
        if (restored.current || (!settings.data && !settings.isError)) return;
        restored.current = true;
        const target = settings.data?.lastWorkspaceRoute;
        if (!userNavigated.current && location.key === initialLocation.current && location.pathname === '/' && settings.data?.startupPage === 'last' && target && Value.Check(WorkspaceRouteSchema, target) && target !== '/') {
            void Promise.resolve(navigate(target, { replace: true })).finally(() => setStartupReady(true));
        } else setStartupReady(true);
    }, [settings.data, settings.isError, location.key, location.pathname, navigate]);
    useEffect(() => {
        if (!startupReady || inSettings || !Value.Check(WorkspaceRouteSchema, location.pathname)) return;
        const timer = window.setTimeout(() => { void invoke('updateApplicationSettings', { lastWorkspaceRoute: location.pathname }).catch(() => undefined); }, 150);
        return () => window.clearTimeout(timer);
    }, [startupReady, inSettings, location.pathname]);
    useEffect(() => window.ecomgen.onChanged(event => {
        if (event.topic === 'settings') void queryClient.invalidateQueries({ queryKey: ['application-settings'] });
        if (event.topic === 'providers') void queryClient.invalidateQueries({ queryKey: ['providers'] });
        if (event.topic === 'usage') void queryClient.invalidateQueries({ queryKey: ['usage'] });
    }), [queryClient]);
    const register = useCallback((guard: BeforeNavigate | null) => { guardRef.current = guard; }, []);
    // 隐藏的创作页仍会刷新；其守卫不能覆盖正在编辑的设置草稿。
    const registerSettings = useCallback((guard: BeforeNavigate | null) => { settingsGuardRef.current = guard; }, []);
    const go = async (path: string) => {
        if (movingRef.current || location.pathname === path) return;
        userNavigated.current = true;
        movingRef.current = true;
        setMoving(true);
        try {
            const guard = inSettings ? settingsGuardRef.current : guardRef.current;
            if (guard && !await guard()) return;
            await navigate(path);
        } finally { movingRef.current = false; setMoving(false); }
    };
    const openSettings = async (section: SettingsSection = 'general') => {
        if (!inSettings) sourceRef.current = `${location.pathname}${location.search}`;
        await go(`/settings/${section}`);
    };
    const sidebarToggle = <Tooltip title={sidebarToggleLabel} placement="right" trigger={['hover', 'focus']}>
      <button type="button" className={styles.sidebarToggle} aria-label={sidebarToggleLabel} aria-expanded={!appSidebar.collapsed} aria-controls={sidebarId} onClick={appSidebar.toggleCollapsed}>
        {appSidebar.collapsed ? <PanelLeftOpen size={16} strokeWidth={1.6} aria-hidden/> : <PanelLeftClose size={16} strokeWidth={1.6} aria-hidden/>}
      </button>
    </Tooltip>;
    return <SettingsNavigationContext.Provider value={{ open: openSettings, close: () => go(sourceRef.current ?? '/'), source: sourceRef.current }}><NavigationGuardContext.Provider value={register}>
      <div className={styles.shell} style={{ '--app-sidebar-width': appSidebar.width } as CSSProperties} data-resizing={appSidebar.resizing || undefined}>
        <aside ref={appSidebar.sidebarRef} id={sidebarId} className={styles.sidebar} data-collapsed={appSidebar.collapsed || undefined} aria-label="工作空间侧栏">
          <Tooltip title={appSidebar.collapsed ? 'PixelMuse' : undefined} placement="right" trigger={['hover', 'focus']}>
            <Link to="/" aria-label="PixelMuse" className={styles.brand} onClick={event => { event.preventDefault(); void go('/'); }}>
              <img src={mark} alt="" width={29} height={31}/><span className={styles.brandName}>PixelMuse</span>
            </Link>
          </Tooltip>
          {!appSidebar.collapsed ? <div className={styles.sidebarTools}>
            <p className={styles.positioning}>商品视觉创作工作台</p>
            {sidebarToggle}
          </div> : null}
          <nav className={styles.nav} aria-label="全局导航" aria-busy={moving}>
            {navigationGroups.map(group => (
              <div className={styles.navGroup} key={group.id} role="group" aria-labelledby={`global-nav-${group.id}`}>
                <p className={styles.sectionLabel} id={`global-nav-${group.id}`}>{group.label}</p>
                <div className={styles.navItems}>
                  {group.items.map(({ path, label, icon: Icon }) => {
                    const active = path === '/' ? location.pathname === '/' || location.pathname.startsWith('/projects/') : location.pathname === path || location.pathname.startsWith(`${path}/`);
                    return <Tooltip key={path} title={appSidebar.collapsed ? label : undefined} placement="right" trigger={['hover', 'focus']}>
                      <button type="button" aria-label={label} aria-current={active ? 'page' : undefined} disabled={moving} onClick={() => void go(path)}>
                        <Icon size={18} strokeWidth={1.6} aria-hidden/><span className={styles.navLabel}>{label}</span>
                      </button>
                    </Tooltip>;
                  })}
                </div>
              </div>
            ))}
          </nav>
          <div className={styles.bottom}>
            <Tooltip title={appSidebar.collapsed ? '设置' : undefined} placement="right" trigger={['hover', 'focus']}>
              <button type="button" aria-label="设置" aria-current={inSettings ? 'page' : undefined} disabled={moving} onClick={() => void openSettings()}><Settings2 size={18} strokeWidth={1.6} aria-hidden/><span className={styles.navLabel}>设置</span></button>
            </Tooltip>
            {appSidebar.collapsed ? <div className={styles.collapsedToggle}>{sidebarToggle}</div> : null}
          </div>
          {!appSidebar.collapsed ? <div className={styles.resizeHandle} role="separator" tabIndex={0} aria-label="调整侧栏宽度" aria-orientation="vertical" aria-controls={sidebarId} aria-valuemin={APP_SIDEBAR_WIDTH.min} aria-valuemax={APP_SIDEBAR_WIDTH.max} aria-valuenow={appSidebar.expandedWidth} aria-valuetext={`${appSidebar.expandedWidth} 像素`} {...appSidebar.resizeHandlers}/> : null}
        </aside>
        <div className={styles.content}>
          <div ref={businessContainer} hidden={inSettings} inert={inSettings}><BusinessActivityContext.Provider value={!inSettings}><ConfigProvider getPopupContainer={getBusinessPopupContainer}><UNSAFE_LocationContext.Provider value={businessLocation.current}>{businessOutlet.current}</UNSAFE_LocationContext.Provider></ConfigProvider></BusinessActivityContext.Provider></div>
          {inSettings ? <NavigationGuardContext.Provider value={registerSettings}>{outlet}</NavigationGuardContext.Provider> : null}
        </div>
      </div>
    </NavigationGuardContext.Provider></SettingsNavigationContext.Provider>;
}
