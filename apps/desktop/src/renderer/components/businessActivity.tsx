import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { useLocation, useNavigate, type NavigateOptions, type To } from 'react-router';

/** 设置保留业务实例，但隐藏实例不能接管全局输入或抢走当前路由。 */
export const BusinessActivityContext = createContext(true);

/** 当前业务视图是否处于前台；独立渲染的业务组件默认活跃。 */
export function useBusinessActive(): boolean {
    return useContext(BusinessActivityContext);
}

/** 后台产生的结果跳转只在返回同一来源时执行，离开来源后丢弃。 */
export function useBusinessNavigate() {
    const navigate = useNavigate();
    const active = useBusinessActive();
    const location = useLocation();
    const source = `${location.pathname}${location.search}`;
    const current = useRef({ active, source, navigate, mounted: true });
    current.current = { active, source, navigate, mounted: true };
    const pending = useRef<{ to: To; options?: NavigateOptions; source: string } | null>(null);
    useEffect(() => {
        current.current.mounted = true;
        return () => { current.current.mounted = false; pending.current = null; };
    }, []);
    useEffect(() => {
        if (!active || !pending.current) return;
        const next = pending.current;
        pending.current = null;
        if (next.source === source) void navigate(next.to, next.options);
    }, [active, source, navigate]);
    return useCallback((to: To, options?: NavigateOptions) => {
        const state = current.current;
        if (!state.mounted) return;
        if (state.active) return state.navigate(to, options);
        pending.current = { to, options, source: state.source };
    }, []);
}
