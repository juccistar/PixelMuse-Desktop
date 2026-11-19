import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CollectionSnapshot } from '@ecomgen/contracts';
import { FakeDesktop } from '../../test/fake-desktop';
import { renderWithProviders } from '../../test/render';
import { CollectionDialog, CollectionSources, validCollectionUrl } from './CollectionDialog';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
let desktop: FakeDesktop;
let snapshot: CollectionSnapshot;
beforeEach(() => {
    desktop = new FakeDesktop().install();
    snapshot = { collectionId: 'collection-one', revision: 1, state: 'OPEN', page: { url: 'https://shop.example/product', title: '真实商品页', platform: '网页' }, candidates: [{ candidateId: 'one', width: 800, height: 600, label: '主图参考' }, { candidateId: 'two', width: 600, height: 800, label: '细节参考' }] };
    desktop.onCollection('open', () => snapshot).onCollection('status', () => snapshot).onCollection('refresh', () => snapshot).onCollection('preview', () => ({ dataUrl: png })).onCollection('close', () => { snapshot = { ...snapshot, state: 'CLOSED', candidates: [], revision: snapshot.revision + 1 }; return null; });
});
async function open() {
    const user = userEvent.setup();
    renderWithProviders(<CollectionDialog projectId="project-one" onClose={() => undefined}/>);
    await user.type(screen.getByRole('textbox', { name: '商品链接' }), 'https://shop.example/product');
    await user.click(screen.getByRole('button', { name: '打开浏览窗口' }));
    await screen.findByText('真实商品页');
    return user;
}
describe('真实原生采集交互', () => {
    it('仅接纳无凭据的 HTTP(S) 地址，未选择时不能导入', async () => {
        expect(validCollectionUrl('file:///secret.png')).toBe(false);
        expect(validCollectionUrl('https://user:pass@shop.example')).toBe(false);
        expect(validCollectionUrl('https://shop.example/product')).toBe(true);
        await open();
        expect(screen.getByRole('button', { name: '导入当前项目' })).toBeDisabled();
        const preview = await screen.findByRole('img', { name: '采集图片 1' });
        expect(preview.getAttribute('src')).toBe(png);
    });
    it('逐张报告后端确认的已导入与重复，不修改商品角色或事实', async () => {
        desktop.onCollection('import', input => ({ assetId: `asset-${input.candidateId}`, status: input.candidateId === 'one' ? 'IMPORTED' : 'ALREADY_PRESENT' }));
        const user = await open();
        await user.click(screen.getByRole('checkbox', { name: '选择图片 1' }));
        await user.click(screen.getByRole('checkbox', { name: '选择图片 2' }));
        await user.click(screen.getByRole('button', { name: '导入当前项目' }));
        expect(await screen.findByText('已导入')).toBeInTheDocument();
        expect(await screen.findByText('项目中已存在')).toBeInTheDocument();
        expect(desktop.api.collection).toHaveBeenCalledWith('import', { collectionId: 'collection-one', revision: 1, candidateId: 'one' });
        expect(desktop.api.invoke).not.toHaveBeenCalled();
    });
    it('读取页面新版本会清除过期选择，导入前再检查版本', async () => {
        const user = await open();
        await user.click(screen.getByRole('checkbox', { name: '选择图片 1' }));
        snapshot = { ...snapshot, revision: 2 };
        await user.click(screen.getByRole('button', { name: '导入当前项目' }));
        expect(await screen.findByText('页面已变化，请重新读取图片后选择。')).toBeInTheDocument();
        expect(desktop.api.collection).not.toHaveBeenCalledWith('import', expect.anything());
        expect(screen.getByRole('checkbox', { name: '选择图片 1' })).not.toBeChecked();
    });
    it('真实失败留在结果中，不能显示已导入', async () => {
        desktop.onCollection('import', () => { throw new Error('图片处理失败'); });
        const user = await open();
        await user.click(screen.getByRole('checkbox', { name: '选择图片 1' }));
        await user.click(screen.getByRole('button', { name: '导入当前项目' }));
        expect(await screen.findByText('未导入')).toBeInTheDocument();
        expect(screen.getByText(/图片处理失败/)).toBeInTheDocument();
        expect(screen.queryByText('已导入')).not.toBeInTheDocument();
    });
    it('取消调用原生 close，并停止尚未提交的后续图片', async () => {
        let release!: () => void;
        desktop.onCollection('import', () => new Promise(resolve => { release = () => resolve({ assetId: 'committed-one', status: 'IMPORTED' }); }));
        const user = await open();
        await user.click(screen.getByRole('checkbox', { name: '选择图片 1' }));
        await user.click(screen.getByRole('checkbox', { name: '选择图片 2' }));
        await user.click(screen.getByRole('button', { name: '导入当前项目' }));
        await waitFor(() => expect(release).toBeTypeOf('function'));
        await user.click(screen.getByRole('button', { name: '取消导入' }));
        expect(desktop.api.collection).toHaveBeenCalledWith('close', { collectionId: 'collection-one' });
        await act(async () => release());
        expect(await screen.findByText('已导入')).toBeInTheDocument();
        expect(desktop.api.collection).not.toHaveBeenCalledWith('import', expect.objectContaining({ candidateId: 'two' }));
    });
    it('重新读取会清除旧选择，手动图片链接通过同一候选接口加入', async () => {
        desktop.onCollection('refresh', () => { snapshot = { ...snapshot, revision: 2 }; return snapshot; });
        desktop.onCollection('addImage', () => { snapshot = { ...snapshot, candidates: [...snapshot.candidates, { candidateId: 'manual', width: 0, height: 0, label: '手动图片链接' }] }; return snapshot; });
        const user = await open();
        await user.click(screen.getByRole('checkbox', { name: '选择图片 1' }));
        await user.click(screen.getByRole('button', { name: '读取当前页图片' }));
        await waitFor(() => expect(screen.getByRole('checkbox', { name: '选择图片 1' })).not.toBeChecked());
        await user.type(screen.getByRole('textbox', { name: '图片链接' }), 'https://shop.example/image.jpg');
        await user.click(screen.getByRole('button', { name: '添加候选' }));
        expect(await screen.findByRole('checkbox', { name: '选择图片 3' })).toBeInTheDocument();
        expect(desktop.api.collection).toHaveBeenCalledWith('addImage', { collectionId: 'collection-one', url: 'https://shop.example/image.jpg' });
    });
    it('轮询发现用户关闭浏览窗口时清除选择并停用导入', async () => {
        const user = await open();
        await user.click(screen.getByRole('checkbox', { name: '选择图片 1' }));
        snapshot = { ...snapshot, state: 'CLOSED', candidates: [], revision: 2 };
        await screen.findAllByText('浏览窗口已关闭', {}, { timeout: 3000 });
        expect(screen.getByRole('button', { name: '导入当前项目' })).toBeDisabled();
        expect(screen.queryByRole('checkbox', { name: '选择图片 1' })).not.toBeInTheDocument();
    });
    it('清除本次登录调用原生清理，并读取真实关闭状态', async () => {
        desktop.onCollection('clearSession', () => { snapshot = { ...snapshot, state: 'CLOSED', candidates: [], revision: 2 }; return null; });
        const user = await open();
        await user.click(screen.getByRole('button', { name: '清除本次登录' }));
        expect(desktop.api.collection).toHaveBeenCalledWith('clearSession', { collectionId: 'collection-one' });
        await waitFor(() => expect(screen.getByRole('button', { name: '读取当前页图片' })).toBeDisabled());
    });
    it('单独查询持久来源并展示页面和时间', async () => {
        desktop.onCollection('sources', () => ({ items: [{ assetId: 'asset-one', platform: '网页', pageUrl: 'https://shop.example/product', title: '商品来源', collectedAt: '2026-11-06T10:00:00.000Z' }] }));
        renderWithProviders(<CollectionSources projectId="project-one"/>);
        expect(await screen.findByText('商品来源')).toBeInTheDocument();
        expect(screen.getByText('https://shop.example/product')).toBeInTheDocument();
        expect(document.querySelector('time')?.dateTime).toBe('2026-11-06T10:00:00.000Z');
    });
});
