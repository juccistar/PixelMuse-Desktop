import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPLICATION_SETTINGS, type ApplicationSettings } from '@ecomgen/contracts';
import { FakeDesktop } from '../../test/fake-desktop';
import { renderWithProviders } from '../../test/render';
import { ModelConfiguration } from './ModelConfiguration';

let desktop: FakeDesktop;
beforeEach(() => { desktop = new FakeDesktop().install(); });

describe('模型高级设置', () => {
    it('保存完整的运行参数，并保留其他应用设置', async () => {
        let stored: ApplicationSettings = structuredClone(DEFAULT_APPLICATION_SETTINGS);
        desktop.on('getApplicationSettings', () => stored);
        desktop.on('updateApplicationSettings', input => { stored = { ...stored, ...input }; return stored; });
        renderWithProviders(<ModelConfiguration/>);
        fireEvent.click(await screen.findByRole('tab', { name: '高级设置' }));
        fireEvent.change(await screen.findByRole('spinbutton', { name: '同时执行任务数' }), { target: { value: '4' } });
        fireEvent.click(screen.getByRole('button', { name: '保存高级设置' }));
        await waitFor(() => expect(stored.ai.concurrency).toBe(4));
        expect(stored.ai).toEqual({ ...DEFAULT_APPLICATION_SETTINGS.ai, concurrency: 4 });
        expect(stored.defaults).toEqual(DEFAULT_APPLICATION_SETTINGS.defaults);
    });

    it('切换标签时保存失败保留草稿，明确放弃后恢复保存值', async () => {
        desktop.on('updateApplicationSettings', () => { throw new Error('保存被拒绝'); });
        renderWithProviders(<ModelConfiguration/>);
        fireEvent.click(await screen.findByRole('tab', { name: '高级设置' }));
        const input = await screen.findByRole('spinbutton', { name: '推理请求超时（秒）' });
        fireEvent.change(input, { target: { value: '300' } });
        fireEvent.click(screen.getByRole('tab', { name: '模型列表' }));
        fireEvent.click(await screen.findByRole('button', { name: '保存并继续' }));
        expect(await screen.findByText('保存被拒绝')).toBeVisible();
        expect(screen.getByRole('spinbutton', { name: '推理请求超时（秒）' })).toHaveValue('300');
        fireEvent.click(screen.getByRole('tab', { name: '模型列表' }));
        fireEvent.click(await screen.findByRole('button', { name: '放弃修改' }));
        await waitFor(() => expect(screen.getByRole('tab', { name: '模型列表' })).toHaveAttribute('aria-selected', 'true'));
        fireEvent.click(screen.getByRole('tab', { name: '高级设置' }));
        await waitFor(() => expect(screen.getByRole('spinbutton', { name: '推理请求超时（秒）' })).toHaveValue(String(DEFAULT_APPLICATION_SETTINGS.ai.requestTimeoutSeconds)));
    });
});
