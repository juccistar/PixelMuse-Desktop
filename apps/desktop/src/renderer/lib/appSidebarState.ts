import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/** 全局导航单独保存偏好，避免影响工作台内部的配置侧栏。 */
export const APP_SIDEBAR_STORAGE_KEYS = {
    collapsed: 'pixelmuse.appSidebar.collapsed',
    width: 'pixelmuse.appSidebar.width',
} as const;
/** 用户手动调宽的范围与收起后的图标栏宽度。 */
export const APP_SIDEBAR_WIDTH = { min: 172, max: 320, collapsed: 68, step: 8 } as const;

function clampWidth(width: number): number {
    return Math.round(Math.min(APP_SIDEBAR_WIDTH.max, Math.max(APP_SIDEBAR_WIDTH.min, width)));
}
function readPreference(key: string): string | null {
    try { return localStorage.getItem(key); }
    catch { return null; }
}
function savePreference(key: string, value: string): void {
    try { localStorage.setItem(key, value); }
    catch { /* 存储不可用时仍保留本次会话的交互。 */ }
}
/** 缺少有效宽度时继续使用现有的响应式 CSS 默认值。 */
export function loadAppSidebarState(): { collapsed: boolean; width: number | null } {
    const rawWidth = readPreference(APP_SIDEBAR_STORAGE_KEYS.width);
    const width = rawWidth?.trim() ? Number(rawWidth) : NaN;
    return {
        collapsed: readPreference(APP_SIDEBAR_STORAGE_KEYS.collapsed) === '1',
        width: Number.isFinite(width) ? clampWidth(width) : null,
    };
}

type Drag = {
    target: HTMLDivElement;
    pointerId: number;
    startX: number;
    startWidth: number;
    width: number;
    previousWidth: number | null;
};
function releaseCapture(drag: Drag): void {
    try {
        if (drag.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
    } catch { /* 卸载或系统取消时，浏览器可能已经释放捕获。 */ }
}

/** 仅管理全局侧栏的尺寸、收起与指针捕获，不接管业务导航。 */
export function useAppSidebarState() {
    const [state, setState] = useState(loadAppSidebarState);
    const [measuredWidth, setMeasuredWidth] = useState(208);
    const [resizing, setResizing] = useState(false);
    const sidebarRef = useRef<HTMLElement>(null);
    const dragRef = useRef<Drag | null>(null);
    const readWidth = () => {
        const actual = sidebarRef.current?.getBoundingClientRect().width;
        return actual && Number.isFinite(actual) ? clampWidth(actual) : state.width ?? measuredWidth;
    };
    // 默认宽度仍由原 CSS token 决定；测量值使窄窗、缩放后的 ARIA 数值保持准确。
    useLayoutEffect(() => {
        if (state.collapsed || !sidebarRef.current) return;
        const sidebar = sidebarRef.current;
        const measure = () => {
            const actual = sidebar.getBoundingClientRect().width;
            if (actual > 0 && Number.isFinite(actual)) setMeasuredWidth(clampWidth(actual));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(sidebar);
        return () => observer.disconnect();
    }, [state.collapsed]);

    const finishDrag = useCallback((commit: boolean) => {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        const changed = commit && drag.width !== drag.startWidth;
        setState(current => ({ ...current, width: changed ? drag.width : drag.previousWidth }));
        setResizing(false);
        if (changed) savePreference(APP_SIDEBAR_STORAGE_KEYS.width, String(drag.width));
        releaseCapture(drag);
    }, []);
    useEffect(() => () => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (drag) releaseCapture(drag);
    }, []);

    const toggleCollapsed = () => {
        finishDrag(false);
        const collapsed = !state.collapsed;
        setState(current => ({ ...current, collapsed }));
        savePreference(APP_SIDEBAR_STORAGE_KEYS.collapsed, collapsed ? '1' : '0');
    };
    const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (state.collapsed || dragRef.current || !event.isPrimary || event.button !== 0) return;
        try { event.currentTarget.setPointerCapture(event.pointerId); }
        catch { return; }
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        const width = readWidth();
        dragRef.current = { target: event.currentTarget, pointerId: event.pointerId, startX: event.clientX, startWidth: width, width, previousWidth: state.width };
        setResizing(true);
    };
    const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag.width = clampWidth(drag.startWidth + event.clientX - drag.startX);
        setState(current => ({ ...current, width: drag.width }));
    };
    const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId === event.pointerId) finishDrag(true);
    };
    const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId === event.pointerId) finishDrag(false);
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (state.collapsed || dragRef.current) return;
        const current = state.width ?? readWidth();
        let width: number;
        switch (event.key) {
            case 'ArrowLeft': width = current - APP_SIDEBAR_WIDTH.step; break;
            case 'ArrowRight': width = current + APP_SIDEBAR_WIDTH.step; break;
            case 'Home': width = APP_SIDEBAR_WIDTH.min; break;
            case 'End': width = APP_SIDEBAR_WIDTH.max; break;
            default: return;
        }
        event.preventDefault();
        width = clampWidth(width);
        setState(value => ({ ...value, width }));
        savePreference(APP_SIDEBAR_STORAGE_KEYS.width, String(width));
    };
    return {
        collapsed: state.collapsed,
        width: state.collapsed ? `${APP_SIDEBAR_WIDTH.collapsed}px` : state.width === null ? 'var(--app-sidebar-w)' : `${state.width}px`,
        expandedWidth: state.width ?? measuredWidth,
        resizing, sidebarRef, toggleCollapsed,
        resizeHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture: onPointerCancel, onKeyDown },
    };
}
