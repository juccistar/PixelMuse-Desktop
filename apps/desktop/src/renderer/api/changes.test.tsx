import '../test/setup';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_APPLICATION_SETTINGS } from '@ecomgen/contracts';
import { FakeDesktop } from '../test/fake-desktop';
import { DesktopChanges } from './changes';
import { invoke } from './client';
import { useApplicationSettings } from './hooks/useApplicationSettings';

describe('设置与用量推送重新查询实际页面数据', () => {
  it('后台设置、用量及单价变更使已打开的查询更新，且卸载解除订阅', async () => {
    const desktop = new FakeDesktop().install();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let scale = 1, requests = 0, pricingCount = 0;
    desktop.on('getApplicationSettings', () => ({ ...DEFAULT_APPLICATION_SETTINGS, interfaceScale: scale }));
    function Probe() {
      const settings = useApplicationSettings();
      const usage = useQuery({ queryKey: ['usage', 'summary'], queryFn: async () => { await invoke('getUsageSummary', {}); return requests; } });
      const pricing = useQuery({ queryKey: ['model-pricing'], queryFn: async () => { await invoke('listModelPricing', {}); return pricingCount; } });
      return <><output aria-label="当前缩放">{settings.data?.interfaceScale}</output><output aria-label="当前请求数">{usage.data}</output><output aria-label="当前单价数">{pricing.data}</output></>;
    }
    const rendered = render(<QueryClientProvider client={client}><DesktopChanges/><Probe/></QueryClientProvider>);
    await waitFor(() => expect(screen.getByLabelText('当前缩放')).toHaveTextContent('1'));
    await waitFor(() => expect(screen.getByLabelText('当前请求数')).toHaveTextContent('0'));
    scale = 1.2;
    act(() => desktop.emit({ topic: 'settings' }));
    await waitFor(() => expect(screen.getByLabelText('当前缩放')).toHaveTextContent('1.2'));
    requests = 3; pricingCount = 1;
    act(() => desktop.emit({ topic: 'usage' }));
    await waitFor(() => expect(screen.getByLabelText('当前请求数')).toHaveTextContent('3'));
    await waitFor(() => expect(screen.getByLabelText('当前单价数')).toHaveTextContent('1'));
    rendered.unmount();
    expect(desktop.listenerCount).toBe(0);
    client.clear();
  });
});
