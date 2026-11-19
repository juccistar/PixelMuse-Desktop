import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApplicationOutput } from '@ecomgen/contracts';
import { FakeDesktop } from '../../test/fake-desktop';
import { renderWithProviders } from '../../test/render';
import { SettingsPage } from './SettingsPage';

let desktop: FakeDesktop;
let current: ApplicationOutput<'updateStatus'>;
beforeEach(() => {
    desktop = new FakeDesktop().install();
    current = { state: 'IDLE', currentVersion: '0.4.8', availableVersion: null, releaseNotes: '', releaseDate: null, checkedAt: null, error: null, supported: true, unsupportedReason: null, autoCheck: true, releaseUrl: 'https://github.com/juccistar/pixelmuse-releases/releases', progress: null };
    desktop.onApplication('updateStatus', () => current);
});
function renderSettings() {
    return renderWithProviders(<Routes><Route path="/settings/:section" element={<SettingsPage/>}/></Routes>, { initialEntries: ['/settings/updates'] });
}
describe('软件更新设置', () => {
    it('查询状态、保存偏好并以纯文本展示更新说明', async () => {
        desktop.onApplication('setUpdatePreferences', input => { current = { ...current, autoCheck: input.autoCheck }; return current; });
        desktop.onApplication('checkForUpdates', () => { current = { ...current, state: 'AVAILABLE', availableVersion: '0.4.9', checkedAt: '2026-11-09T00:00:00Z', releaseNotes: '<img src=x onerror=alert(1)>' }; return current; });
        const user = userEvent.setup(); renderSettings();
        expect(await screen.findByText('0.4.8')).toBeVisible();
        await user.click(screen.getByRole('switch', { name: '自动检查更新' }));
        await waitFor(() => expect(desktop.api.application).toHaveBeenCalledWith('setUpdatePreferences', { autoCheck: false }));
        await waitFor(() => expect(screen.getByRole('switch', { name: '自动检查更新' })).not.toBeChecked());
        await user.click(screen.getByRole('button', { name: '检查更新' }));
        expect(await screen.findByText('0.4.9')).toBeVisible();
        const notes = screen.getByRole('region', { name: '更新说明' });
        expect(notes).toHaveTextContent('<img src=x onerror=alert(1)>');
        expect(notes.querySelector('img')).toBeNull();
        expect(screen.getByRole('button', { name: '下载更新' })).toBeVisible();
    });
    it('切换设置页后重新查询后台下载状态并允许取消', async () => {
        current = { ...current, state: 'DOWNLOADING', availableVersion: '0.4.9', progress: { percent: 40, transferred: 40, total: 100, bytesPerSecond: 10 } };
        desktop.onApplication('cancelUpdateDownload', () => { current = { ...current, state: 'AVAILABLE', progress: null }; return current; });
        const user = userEvent.setup(); renderSettings();
        expect(await screen.findByText('正在下载更新')).toBeVisible();
        const navigation = screen.getByRole('navigation', { name: '设置分类' });
        await user.click(within(navigation).getByRole('link', { name: '关于 PixelMuse' }));
        current = { ...current, progress: { percent: 80, transferred: 80, total: 100, bytesPerSecond: 10 } };
        await user.click(within(navigation).getByRole('link', { name: '软件更新' }));
        await waitFor(() => expect(screen.getByText('80%')).toBeVisible());
        await user.click(screen.getByRole('button', { name: '取消下载' }));
        expect(await screen.findByRole('button', { name: '下载更新' })).toBeVisible();
    });
    it('后台繁忙保留安装入口并显示具体原因，发布缺失不伪装为最新版', async () => {
        current = { ...current, state: 'DOWNLOADED', availableVersion: '0.4.9' };
        desktop.onApplication('installUpdate', () => { current = { ...current, error: '后台仍有任务或工作空间操作，请完成后再安装更新。' }; return current; });
        const user = userEvent.setup(); renderSettings();
        await user.click(await screen.findByRole('button', { name: '重启并安装' }));
        expect(await screen.findByText('后台仍有任务或工作空间操作，请完成后再安装更新。')).toBeVisible();
        expect(screen.getByRole('button', { name: '重启并安装' })).toBeEnabled();
        const navigation = screen.getByRole('navigation', { name: '设置分类' });
        await user.click(within(navigation).getByRole('link', { name: '关于 PixelMuse' }));
        current = { ...current, state: 'ERROR', availableVersion: null, error: '发布仓库尚未提供可用的正式版本。' };
        await user.click(within(navigation).getByRole('link', { name: '软件更新' }));
        expect(await screen.findByText('发布仓库尚未提供可用的正式版本。')).toBeVisible();
        expect(screen.queryByText('当前已是最新版本')).not.toBeInTheDocument();
    });
    it('不支持自动更新时提供固定下载页面操作', async () => {
        current = { ...current, state: 'UNSUPPORTED', supported: false };
        const user = userEvent.setup(); renderSettings();
        expect(await screen.findByText(/源码运行或解包版本/)).toBeVisible();
        expect(screen.queryByText('当前已是最新版本')).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: '打开下载页面' }));
        expect(desktop.api.application).toHaveBeenCalledWith('openUpdateReleases', {});
    });
});
