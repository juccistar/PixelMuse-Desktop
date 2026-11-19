import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceStatus } from '@ecomgen/contracts';
import { FakeDesktop } from '../../test/fake-desktop';
import { renderWithProviders } from '../../test/render';
import { WorkspacePanel } from './WorkspacePanel';
let desktop: FakeDesktop;
let status: WorkspaceStatus;
beforeEach(() => {
    desktop = new FakeDesktop().install();
    status = { directory: 'D:\\PixelMuse\\素材', configured: true, state: 'READY', copiedFiles: 0, totalFiles: 0, copiedBytes: 0, totalBytes: 0 };
    desktop.onWorkspace('migration', () => status).onWorkspace('openFolder', () => null);
});
describe('工作空间原生状态', () => {
    it('展示原生只读目录，打开文件夹只调用受限操作', async () => {
        const user = userEvent.setup(); renderWithProviders(<WorkspacePanel/>);
        expect(await screen.findByLabelText('当前工作空间目录')).toHaveTextContent(status.directory);
        await user.click(screen.getByRole('button', { name: '在系统中打开' }));
        expect(desktop.api.workspace).toHaveBeenCalledWith('openFolder', {});
    });
    it('选择取消保留原目录，不显示迁移成功', async () => {
        desktop.onWorkspace('choose', () => ({ canceled: true, status }));
        const user = userEvent.setup(); renderWithProviders(<WorkspacePanel/>);
        await screen.findByLabelText('当前工作空间目录');
        await user.click(screen.getByRole('button', { name: '选择工作空间目录' }));
        expect(await screen.findByText('已取消选择目录')).toBeInTheDocument();
        expect(screen.getByLabelText('当前工作空间目录')).toHaveTextContent(status.directory);
        expect(desktop.api.workspace).toHaveBeenCalledWith('choose', {});
    });
    it('轮询复制进度并把取消交给原生迁移，不先宣布完成', async () => {
        desktop.onWorkspace('choose', () => { status = { ...status, state: 'COPYING', copiedFiles: 2, totalFiles: 10, copiedBytes: 1024, totalBytes: 8192 }; return { canceled: false, status }; });
        desktop.onWorkspace('cancel', () => { status = { ...status, state: 'READY' }; return status; });
        const user = userEvent.setup(); renderWithProviders(<WorkspacePanel/>);
        await screen.findByLabelText('当前工作空间目录');
        await user.click(screen.getByRole('button', { name: '选择工作空间目录' }));
        expect(await screen.findByText(/已复制 2 \/ 10 个文件/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '选择工作空间目录' })).toBeDisabled();
        await user.click(screen.getByRole('button', { name: '取消迁移' }));
        await waitFor(() => expect(screen.queryByRole('button', { name: '取消迁移' })).not.toBeInTheDocument());
        expect(desktop.api.workspace).toHaveBeenCalledWith('cancel', {});
        expect(screen.getByLabelText('当前工作空间目录')).toHaveTextContent('D:\\PixelMuse\\素材');
    });
    it.each(['VERIFYING', 'RESTARTING'] as const)('迁移阶段 %s 禁止重新选择和打开目录，连接阶段不能取消', async state => {
        status = { ...status, state };
        renderWithProviders(<WorkspacePanel/>);
        await screen.findByLabelText('当前工作空间目录');
        expect(screen.getByRole('button', { name: '选择工作空间目录' })).toBeDisabled();
        expect(screen.getByRole('button', { name: '在系统中打开' })).toBeDisabled();
        const cancel = screen.getByRole('button', { name: '取消迁移' });
        if (state === 'RESTARTING') expect(cancel).toBeDisabled();
        else expect(cancel).toBeEnabled();
    });
    it('媒体离线仍展示原目录和原生错误，可选择原目录重新连接', async () => {
        status = { ...status, state: 'FAILED', error: '工作空间不可用，请连接原设备' };
        desktop.onWorkspace('choose', () => { status = { ...status, state: 'READY', error: undefined }; return { canceled: false, status }; });
        const user = userEvent.setup(); renderWithProviders(<WorkspacePanel/>);
        expect(await screen.findByText('工作空间不可用，请连接原设备')).toBeVisible();
        expect(screen.getByLabelText('当前工作空间目录')).toHaveTextContent(status.directory);
        await user.click(screen.getByRole('button', { name: '选择工作空间目录' }));
        expect(await screen.findByText('可以创作')).toBeVisible();
        expect(screen.queryByText('工作空间不可用，请连接原设备')).not.toBeInTheDocument();
        expect(desktop.api.workspace).toHaveBeenCalledWith('choose', {});
    });
    it('目录选择失败明确显示错误，原目录保持可见', async () => {
        desktop.onWorkspace('choose', () => { throw new Error('当前有运行任务，请稍后重试'); });
        const user = userEvent.setup(); renderWithProviders(<WorkspacePanel/>);
        await screen.findByLabelText('当前工作空间目录');
        await user.click(screen.getByRole('button', { name: '选择工作空间目录' }));
        expect(await screen.findByText('当前有运行任务，请稍后重试')).toBeInTheDocument();
        expect(screen.getByLabelText('当前工作空间目录')).toHaveTextContent(status.directory);
    });
});
