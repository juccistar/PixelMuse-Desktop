import { App, Button } from 'antd';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavigationGuardContext, type BeforeNavigate } from '../../components/navigationGuard';

type Draft = { save: () => Promise<boolean>; discard: () => void; isSaving: () => boolean };
const DraftContext = createContext<((draft: Draft | null) => void) | null>(null);
const LeaveContext = createContext<BeforeNavigate | null>(null);

export function useSettingsLeave() { return useContext(LeaveContext); }

/** 设置表单通过此接口注册尚未保存的草稿。 */
export function useSettingsDraft(draft: Draft | null) {
    const register = useContext(DraftContext);
    const current = useRef(draft);
    current.current = draft;
    const active = draft !== null;
    useEffect(() => {
        if (!active || !register) return;
        register({ save: () => current.current?.save() ?? Promise.resolve(false), discard: () => current.current?.discard(), isSaving: () => current.current?.isSaving() ?? false });
        return () => register(null);
    }, [register, active]);
}

/** 协调设置内切换和全局导航，保存失败时保留当前表单。 */
export function SettingsDraftProvider({ children }: { children: (leave: BeforeNavigate) => ReactNode }) {
    const [draft, setDraft] = useState<Draft | null>(null);
    const draftRef = useRef<Draft | null>(null);
    const registerAppGuard = useContext(NavigationGuardContext);
    const { modal } = App.useApp();
    const register = useCallback((next: Draft | null) => { draftRef.current = next; setDraft(next); }, []);
    const pending = useRef<Promise<boolean> | null>(null);
    const leave = useCallback(() => {
        if (!draftRef.current) return Promise.resolve(true);
        if (pending.current) return pending.current;
        if (draftRef.current.isSaving()) return Promise.resolve(false);
        const promise = new Promise<boolean>(resolve => {
            let settled = false;
            let saving = false;
            const finish = (result: boolean) => { if (!settled) { settled = true; resolve(result); } };
            const dialog = modal.confirm({
                title: '有未保存的设置',
                content: '保存修改后继续，或放弃修改。',
                closable: false, maskClosable: false, keyboard: false,
                footer: () => <><Button onClick={() => { if (!saving) { finish(false); dialog.destroy(); } }}>继续编辑</Button><Button danger onClick={() => { if (!saving) { draftRef.current?.discard(); finish(true); dialog.destroy(); } }}>放弃修改</Button><Button type="primary" onClick={async () => { if (saving) return; saving = true; try { const saved = await draftRef.current?.save() ?? false; finish(saved); dialog.destroy(); } finally { saving = false; } }}>保存并继续</Button></>,
            });
        });
        pending.current = promise;
        void promise.finally(() => { pending.current = null; });
        return promise;
    }, [modal]);
    useEffect(() => {
        if (!draft || !registerAppGuard) return;
        registerAppGuard(leave);
        return () => registerAppGuard(null);
    }, [draft, leave, registerAppGuard]);
    return <DraftContext.Provider value={register}><LeaveContext.Provider value={leave}>{children(leave)}</LeaveContext.Provider></DraftContext.Provider>;
}
