import { createContext, useContext, useEffect } from 'react';
export type BeforeNavigate = () => Promise<boolean>;
/** 共享侧栏离开创作页前，等待该页提交尚未保存的编辑。 */
export const NavigationGuardContext = createContext<((guard: BeforeNavigate | null) => void) | null>(null);
export function useBeforeAppNavigate(guard: BeforeNavigate): void {
    const register = useContext(NavigationGuardContext);
    useEffect(() => {
        register?.(guard);
        return () => register?.(null);
    }, [register, guard]);
}
