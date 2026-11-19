import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useParams } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { ASSET_ID, OUTPUT_ID, OUTPUT_ID_B, PROJECT_FIXTURE } from '../../test/fixtures';
import { FakeDesktop, PROVIDER_FIXTURE } from '../../test/fake-desktop';
import { renderWithProviders } from '../../test/render';
import { HomePage } from './HomePage';
import { SettingsPage } from '../settings/SettingsPage';
import { DEFAULT_APPLICATION_SETTINGS } from '@ecomgen/contracts';
let desktop: FakeDesktop;
beforeEach(() => { desktop = new FakeDesktop().install(); });
describe('原版项目画廊 · 具名 IPC', () => {
  it('保留品牌、后台状态、归档和设置入口', async () => {
    const user = userEvent.setup(); renderWithProviders(<Routes><Route path="/" element={<HomePage/>}/><Route path="/settings/:section" element={<SettingsPage/>}/></Routes>);
    expect(screen.getByRole('heading', { name: '商品视觉创作工作台' })).toBeInTheDocument();
    expect(await screen.findByText('项目画廊 · 暂无项目')).toBeInTheDocument();
    expect(await screen.findByText('本地后台已连接')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByRole('heading', { name: '模型配置' })).toBeInTheDocument();
  });
  it('保留封面、原图角标和成图数量', async () => {
    desktop.on('listProjects', () => ({ items: [{ ...PROJECT_FIXTURE, cover: { productAssetId: ASSET_ID, coverOutputId: OUTPUT_ID, previewOutputIds: [OUTPUT_ID_B], outputCount: 3 } }], nextCursor: null }));
    renderWithProviders(<HomePage />);
    expect(await screen.findByRole('link', { name: /无线耳机 SPU/ })).toBeInTheDocument();
    expect(screen.getByText('原图')).toBeInTheDocument(); expect(screen.getByText('生成 3 张套图')).toBeInTheDocument();
    expect(screen.getAllByRole('presentation').some(img => img.getAttribute('src')?.startsWith('ecomgen-resource://'))).toBe(true);
  });
  it('归档使用 updateProject 的 archived 字段', async () => {
    let archived = false;
    desktop.on('listProjects', () => ({ items: archived ? [] : [PROJECT_FIXTURE], nextCursor: null }));
    desktop.on('updateProject', input => { archived = input.archived === true; return { ...PROJECT_FIXTURE, archivedAt: '2026-11-05T00:00:00.000Z' }; });
    const user = userEvent.setup(); renderWithProviders(<HomePage />);
    await user.click(await screen.findByRole('button', { name: /项目操作：归档/ }));
    await user.click(await screen.findByText('归档项目')); await waitFor(() => expect(archived).toBe(true));
  });
  it('永久删除保留二次确认', async () => {
    let deleted = false;
    desktop.on('listProjects', input => ({ items: input.archived && !deleted ? [{ ...PROJECT_FIXTURE, archivedAt: '2026-11-05T00:00:00.000Z' }] : [], nextCursor: null }));
    desktop.on('deleteProject', () => { deleted = true; return null; });
    const user = userEvent.setup(); renderWithProviders(<HomePage />);
    await user.click(await screen.findByRole('button', { name: /已归档/ }));
    await user.click(await screen.findByRole('button', { name: '项目操作：恢复或删除' }));
    await user.click(await screen.findByText('删除项目')); expect(deleted).toBe(false);
    await user.click(await screen.findByRole('button', { name: '永久删除' })); await waitFor(() => expect(deleted).toBe(true));
  });
  it('按默认模型对创建并导航到原工作台路由', async () => {
    let captured: unknown;
    desktop.on('createProject', input => { captured = input; return { ...PROJECT_FIXTURE, name: '未命名项目' }; });
    function Probe() { const { projectId } = useParams(); return <div>工作台 {projectId}</div>; }
    await desktop.api.invoke('listProviders', {});
    const user = userEvent.setup(); renderWithProviders(<Routes><Route path="/" element={<HomePage />} /><Route path="/projects/:projectId" element={<Probe />} /></Routes>);
    await user.click(await screen.findByRole('button', { name: /新建项目/ }));
    await waitFor(() => expect(captured).toMatchObject({ name: '未命名项目', defaultMode: 'CREATIVE', reasoningModelId: 'gpt-4o', imageModelId: 'gpt-image-1' }));
    expect(await screen.findByText(`工作台 ${PROJECT_FIXTURE.id}`)).toBeInTheDocument();
  });
  it('新项目使用持久默认模型和创作参数，不修改现有项目', async () => {
    desktop.on('getApplicationSettings', () => ({ ...DEFAULT_APPLICATION_SETTINGS, defaults: { ...DEFAULT_APPLICATION_SETTINGS.defaults, reasoningModel: { providerId: PROVIDER_FIXTURE.id, modelId: 'preferred-reasoning' }, imageModel: { providerId: PROVIDER_FIXTURE.id, modelId: 'preferred-image' }, promptLanguage: 'ENGLISH', copyLanguage: 'Deutsch', imageResolution: '2K', imageAspectRatio: '4:5', candidatesPerType: 3, webResearchEnabled: true } }));
    desktop.on('listProviders', () => ({ items: [{ ...PROVIDER_FIXTURE, models: [...PROVIDER_FIXTURE.models, { ...PROVIDER_FIXTURE.models[0], id: 'preferred-reasoning' }, { ...PROVIDER_FIXTURE.models[1], id: 'preferred-image' }] }], nextCursor: null }));
    let captured: unknown;
    desktop.on('createProject', input => { captured = input; return PROJECT_FIXTURE; });
    const user = userEvent.setup(); renderWithProviders(<Routes><Route path="/" element={<HomePage/>}/><Route path="/projects/:projectId" element={<p>新工作台</p>}/></Routes>);
    await user.click(await screen.findByRole('button', { name: '新建项目' }));
    await waitFor(() => expect(captured).toMatchObject({ reasoningModelId: 'preferred-reasoning', imageModelId: 'preferred-image', promptLanguage: 'ENGLISH', copyLanguage: 'Deutsch', imageResolution: '2K', imageAspectRatio: '4:5', candidatesPerType: 3, webResearchEnabled: true }));
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('updateProject', expect.anything());
  });
  it('无模型对时进入设置，不能伪造项目创建', async () => {
    desktop.on('listProviders', () => ({ items: [], nextCursor: null }));
    const user = userEvent.setup(); renderWithProviders(<Routes><Route path="/" element={<HomePage/>}/><Route path="/settings/:section" element={<SettingsPage/>}/></Routes>);
    await user.click(await screen.findByRole('button', { name: /新建项目/ }));
    expect(await screen.findByRole('heading', { name: '模型配置' })).toBeInTheDocument();
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('createProject', expect.anything());
  });
});
