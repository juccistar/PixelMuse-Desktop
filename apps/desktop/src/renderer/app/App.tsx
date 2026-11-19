import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from 'react';
import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { MotionConfig } from "motion/react";
import { RouterProvider } from "react-router";
import { isApiError } from "../api/errors";
import { antdTheme } from "../design/antdTheme";
import { router } from "./routes";
import { DesktopChanges } from '../api/changes';
const reducedMotionQuery = '(prefers-reduced-motion: reduce)';
const readReducedMotion = () => window.matchMedia(reducedMotionQuery).matches;
const subscribeReducedMotion = (changed: () => void) => {
    const media = window.matchMedia(reducedMotionQuery);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
};
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30000,
            // 4xx 是确定性失败（校验/冲突/能力），重试无意义；5xx 与网络错误重试 2 次
            retry: false,
            refetchOnWindowFocus: false,
        },
    },
});
export function App() {
    const reducedMotion = useSyncExternalStore(subscribeReducedMotion, readReducedMotion);
    // 只缩短 CSS 动画会中断弹层定位的准备阶段；减弱动态时通过组件库正式关闭动画。
    const theme = useMemo(() => reducedMotion ? { ...antdTheme, token: { ...antdTheme.token, motion: false } } : antdTheme, [reducedMotion]);
    return (<MotionConfig reducedMotion="user">
      <ConfigProvider theme={theme} locale={zhCN} button={{ autoInsertSpace: false }}>
        <AntdApp>
          <QueryClientProvider client={queryClient}>
            <DesktopChanges />
            <RouterProvider router={router}/>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>
    </MotionConfig>);
}
