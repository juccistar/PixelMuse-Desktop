import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_SIDEBAR_STORAGE_KEYS, loadAppSidebarState } from '../lib/appSidebarState';
import { FakeDesktop } from '../test/fake-desktop';
import { renderWithProviders } from '../test/render';
import { AppShell } from './AppShell';
import { useBeforeAppNavigate, type BeforeNavigate } from './navigationGuard';

const WORKBENCH_KEY = 'ecomgen.workspace.sidebarCollapsed';
function Destination() { const location = useLocation(); return <p>目的地 {location.pathname}</p>; }
function GuardedEditor({ guard }: { guard: BeforeNavigate }) {
    useBeforeAppNavigate(guard);
    return <Destination/>;
}
function renderShell(guard: BeforeNavigate = async () => true, initialEntry = '/') {
    return renderWithProviders(<Routes><Route element={<AppShell/>}>
        <Route path="/" element={<Destination/>}/>
        <Route path="/projects/:projectId" element={<GuardedEditor guard={guard}/>}/>
        <Route path="/library" element={<Destination/>}/>
        <Route path="/settings/:section" element={<Destination/>}/>
    </Route></Routes>, { initialEntries: [initialEntry] });
}
function firePointer(target: Element, type: string, values: Partial<{ pointerId: number; clientX: number; isPrimary: boolean; button: number }> = {}) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ pointerId: 7, clientX: 208, isPrimary: true, button: 0, ...values })) {
        Object.defineProperty(event, key, { value });
    }
    fireEvent(target, event);
}

beforeEach(() => { new FakeDesktop().install(); localStorage.clear(); });
afterEach(() => { localStorage.clear(); });

describe('全局侧栏收起与调宽', () => {
    it('独立读取全局偏好，限制越界宽度并忽略无效存储', () => {
        localStorage.setItem(WORKBENCH_KEY, '1');
        expect(loadAppSidebarState()).toEqual({ collapsed: false, width: null });
        localStorage.setItem(APP_SIDEBAR_STORAGE_KEYS.collapsed, '1');
        for (const [stored, expected] of [['9999', 320], ['-20', 172], ['248.7', 249], ['NaN', null], ['Infinity', null], ['', null], ['{bad}', null]] as const) {
            localStorage.setItem(APP_SIDEBAR_STORAGE_KEYS.width, stored);
            expect(loadAppSidebarState()).toEqual({ collapsed: true, width: expected });
        }
        localStorage.setItem(APP_SIDEBAR_STORAGE_KEYS.collapsed, 'invalid');
        expect(loadAppSidebarState().collapsed).toBe(false);
        expect(localStorage.getItem(WORKBENCH_KEY)).toBe('1');
    });

    it('收起后保留名称提示、嵌套路由选中与导航守卫，重挂载恢复且不改工作台偏好', async () => {
        localStorage.setItem(WORKBENCH_KEY, '1');
        let release!: (allowed: boolean) => void;
        const guard = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
        const user = userEvent.setup();
        const first = renderShell(guard, '/projects/source');
        const sidebar = screen.getByRole('complementary', { name: '工作空间侧栏' });
        const toggle = within(sidebar).getByRole('button', { name: '收起侧栏' });
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBe(sidebar);
        expect(within(sidebar).getByRole('button', { name: '项目' })).toHaveAttribute('aria-current', 'page');
        await user.click(toggle);
        expect(within(sidebar).getByRole('button', { name: '展开侧栏' })).toHaveAttribute('aria-expanded', 'false');
        expect(within(sidebar).getByRole('link', { name: 'PixelMuse' })).toBeInTheDocument();
        expect(screen.queryByRole('separator', { name: '调整侧栏宽度' })).not.toBeInTheDocument();
        expect(within(sidebar).getByRole('button', { name: '设置' })).toBeEnabled();
        const library = within(sidebar).getByRole('button', { name: '资产库' });
        await user.hover(library);
        expect(await screen.findByRole('tooltip', { name: '资产库' })).toBeInTheDocument();
        await user.click(library);
        expect(guard).toHaveBeenCalledTimes(1);
        expect(screen.getByText('目的地 /projects/source')).toBeInTheDocument();
        await act(async () => release(true));
        expect(await screen.findByText('目的地 /library')).toBeInTheDocument();
        expect(library).toHaveAttribute('aria-current', 'page');
        await user.click(within(sidebar).getByRole('button', { name: '设置' }));
        expect(await screen.findByText('目的地 /settings/general')).toBeInTheDocument();
        expect(localStorage.getItem(APP_SIDEBAR_STORAGE_KEYS.collapsed)).toBe('1');
        expect(localStorage.getItem(APP_SIDEBAR_STORAGE_KEYS.width)).toBeNull();
        first.unmount();
        renderShell();
        await user.click(screen.getByRole('button', { name: '展开侧栏' }));
        expect(screen.getByRole('button', { name: '收起侧栏' })).toHaveAttribute('aria-expanded', 'true');
        expect(localStorage.getItem(APP_SIDEBAR_STORAGE_KEYS.collapsed)).toBe('0');
        expect(localStorage.getItem(WORKBENCH_KEY)).toBe('1');
    });

    it('分隔条键盘按八像素调宽，Home/End到达边界，收起与重挂载保留宽度', async () => {
        const user = userEvent.setup();
        const first = renderShell();
        const handle = screen.getByRole('separator', { name: '调整侧栏宽度' });
        expect(handle).toHaveAttribute('aria-orientation', 'vertical');
        expect(handle).toHaveAttribute('tabindex', '0');
        expect(handle).toHaveAttribute('aria-valuemin', '172');
        expect(handle).toHaveAttribute('aria-valuemax', '320');
        expect(handle).toHaveAttribute('aria-valuenow', '208');
        expect(document.getElementById(handle.getAttribute('aria-controls')!)).toBe(screen.getByRole('complementary', { name: '工作空间侧栏' }));
        act(() => handle.focus());
        await user.keyboard('{ArrowRight}');
        expect(handle).toHaveAttribute('aria-valuenow', '216');
        await user.keyboard('{Home}{ArrowLeft}');
        expect(handle).toHaveAttribute('aria-valuenow', '172');
        await user.keyboard('{End}{ArrowRight}{ArrowLeft}');
        expect(handle).toHaveAttribute('aria-valuenow', '312');
        expect(localStorage.getItem(APP_SIDEBAR_STORAGE_KEYS.width)).toBe('312');
        await user.click(screen.getByRole('button', { name: '收起侧栏' }));
        expect(localStorage.getItem(APP_SIDEBAR_STORAGE_KEYS.width)).toBe('312');
        await user.click(screen.getByRole('button', { name: '展开侧栏' }));
        expect(screen.getByRole('separator', { name: '调整侧栏宽度' })).toHaveAttribute('aria-valuenow', '312');
        first.unmount();
        renderShell();
        expect(screen.getByRole('separator', { name: '调整侧栏宽度' })).toHaveAttribute('aria-valuenow', '312');
    });

    it('仅捕获主指针，拖动完成才保存，取消或丢失捕获恢复且卸载释放', () => {
        const view = renderShell();
        const sidebar = screen.getByRole('complementary', { name: '工作空间侧栏' });
        const shell = sidebar.parentElement!;
        const handle = screen.getByRole('separator', { name: '调整侧栏宽度' });
        let captured: number | null = null;
        handle.setPointerCapture = vi.fn(id => { captured = id; });
        handle.hasPointerCapture = vi.fn(id => captured === id);
        handle.releasePointerCapture = vi.fn(() => { captured = null; });
        firePointer(handle, 'pointerdown', { isPrimary: false });
        firePointer(handle, 'pointerdown', { button: 2 });
        expect(handle.setPointerCapture).not.toHaveBeenCalled();
        firePointer(handle, 'pointerdown');
        expect(handle.setPointerCapture).toHaveBeenCalledWith(7);
        expect(shell).toHaveAttribute('data-resizing', 'true');
        firePointer(handle, 'pointermove', { clientX: 999 });
        expect(handle).toHaveAttribute('aria-valuenow', '320');
        expect(localStorage.getItem(APP_SIDEBAR_STORAGE_KEYS.width)).toBeNull();
        firePointer(handle, 'pointermove', { pointerId: 8, clientX: 172 });
        firePointer(handle, 'pointerup', { pointerId: 8 });
        expect(handle).toHaveAttribute('aria-valuenow', '320');
        expect(shell).toHaveAttribute('data-resizing', 'true');
        firePointer(handle, 'pointerup', { clientX: 999 });
        expect(localStorage.getItem(APP_SIDEBAR_STORAGE_KEYS.width)).toBe('320');
        expect(handle.releasePointerCapture).toHaveBeenCalledWith(7);
        expect(shell).not.toHaveAttribute('data-resizing');
        firePointer(handle, 'pointermove', { clientX: 172 });
        expect(handle).toHaveAttribute('aria-valuenow', '320');
        firePointer(handle, 'pointerdown', { clientX: 320 });
        firePointer(handle, 'pointermove', { clientX: 100 });
        expect(handle).toHaveAttribute('aria-valuenow', '172');
        firePointer(handle, 'pointercancel');
        expect(handle).toHaveAttribute('aria-valuenow', '320');
        expect(shell).not.toHaveAttribute('data-resizing');
        firePointer(handle, 'pointerdown', { clientX: 320 });
        firePointer(handle, 'pointermove', { clientX: 250 });
        firePointer(handle, 'lostpointercapture');
        expect(handle).toHaveAttribute('aria-valuenow', '320');
        expect(shell).not.toHaveAttribute('data-resizing');
        firePointer(handle, 'pointerdown', { clientX: 320 });
        firePointer(handle, 'pointermove', { clientX: 250 });
        view.unmount();
        expect(captured).toBeNull();
        expect(localStorage.getItem(APP_SIDEBAR_STORAGE_KEYS.width)).toBe('320');
    });

    it('存储读写抛错时仍能展开、收起与键盘调宽', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
        const user = userEvent.setup();
        renderShell();
        await user.click(screen.getByRole('button', { name: '收起侧栏' }));
        await user.click(screen.getByRole('button', { name: '展开侧栏' }));
        const handle = screen.getByRole('separator', { name: '调整侧栏宽度' });
        act(() => handle.focus());
        await user.keyboard('{End}');
        await waitFor(() => expect(handle).toHaveAttribute('aria-valuenow', '320'));
    });
});
