import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCallback, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPLICATION_SETTINGS, type ApplicationSettings, type Input, type UsageEntry } from '@ecomgen/contracts';
import { FakeDesktop, PROVIDER_FIXTURE } from '../../test/fake-desktop';
import { renderWithProviders } from '../../test/render';
import { AppShell } from '../../components/AppShell';
import { useBeforeAppNavigate } from '../../components/navigationGuard';
import { GeneralSettings } from './GeneralSettings';
import { SettingsPage } from './SettingsPage';
import { UsageSettings } from './UsageSettings';
import { ManageModelsButton } from './settingsNavigation';
import { initialModelKey } from '../../api/hooks/useApplicationSettings';
import { ImageModelSelect } from '../patterns/shared';
let desktop: FakeDesktop;
beforeEach(() => { desktop = new FakeDesktop().install(); localStorage.clear(); });
function Probe() { const location = useLocation(); return <p>目的地 {location.pathname}</p>; }
describe('持久设置中心与来源导航', () => {
  it('工作空间位置只在设置内配置，离开设置不保留迁移控件并可从侧栏返回', async () => {
    const status = { directory: 'D:\\PixelMuse\\素材', configured: true, state: 'READY' as const, copiedFiles: 0, totalFiles: 0, copiedBytes: 0, totalBytes: 0 };
    desktop.onWorkspace('migration', () => status).onWorkspace('choose', () => ({ canceled: true, status }));
    const user = userEvent.setup();
    renderWithProviders(<Routes><Route element={<AppShell/>}><Route path="/" element={<Probe/>}/><Route path="/library" element={<Probe/>}/><Route path="/settings/:section" element={<SettingsPage/>}/></Route></Routes>);
    const sidebar = within(screen.getByRole('complementary', { name: '工作空间侧栏' }));
    const assertNoSidebarWorkspace = () => {
      expect(sidebar.queryByRole('button', { name: /本地工作空间|工作空间位置|选择工作空间目录/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: '本地工作空间' })).not.toBeInTheDocument();
    };
    assertNoSidebarWorkspace();
    expect(screen.queryByRole('button', { name: '选择工作空间目录' })).not.toBeInTheDocument();
    expect(desktop.api.workspace).not.toHaveBeenCalled();
    await user.click(sidebar.getByRole('button', { name: '设置' }));
    expect(await screen.findByRole('heading', { name: '常规设置' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '选择工作空间目录' })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole('navigation', { name: '设置分类' })).getByRole('link', { name: '工作空间与数据' }));
    const content = within(screen.getByRole('region', { name: '设置内容' }));
    expect(await content.findByLabelText('当前工作空间目录')).toHaveTextContent(status.directory);
    expect(screen.getAllByRole('button', { name: '选择工作空间目录' })).toHaveLength(1);
    assertNoSidebarWorkspace();
    await user.click(content.getByRole('button', { name: '选择工作空间目录' }));
    expect(await screen.findByText('已取消选择目录')).toBeVisible();
    expect(desktop.api.workspace).toHaveBeenCalledWith('choose', {});
    await user.click(screen.getByRole('button', { name: '返回创作页面' }));
    expect(await screen.findByText('目的地 /')).toBeVisible();
    expect(screen.queryByRole('button', { name: '选择工作空间目录' })).not.toBeInTheDocument();
    await user.click(sidebar.getByRole('button', { name: '资产库' }));
    expect(await screen.findByText('目的地 /library')).toBeVisible();
    assertNoSidebarWorkspace();
    await user.click(sidebar.getByRole('button', { name: '设置' }));
    await user.click(within(await screen.findByRole('navigation', { name: '设置分类' })).getByRole('link', { name: '工作空间与数据' }));
    expect(await screen.findByLabelText('当前工作空间目录')).toHaveTextContent(status.directory);
    expect(screen.getAllByRole('button', { name: '选择工作空间目录' })).toHaveLength(1);
  });
  it('保存常规偏好并在重新挂载后读取，保留模型默认引用', async () => {
    let stored: ApplicationSettings = { ...structuredClone(DEFAULT_APPLICATION_SETTINGS), defaults: { ...DEFAULT_APPLICATION_SETTINGS.defaults, reasoningModel: { providerId: PROVIDER_FIXTURE.id, modelId: 'gpt-4o' } } };
    desktop.on('getApplicationSettings', () => stored);
    desktop.on('updateApplicationSettings', input => { stored = { ...stored, ...input }; return stored; });
    const user = userEvent.setup(); const first = renderWithProviders(<GeneralSettings/>);
    await user.click(await screen.findByRole('switch', { name: '任务完成提醒' }));
    await user.type(screen.getByLabelText('图片文案语言'), 'English');
    await user.click(screen.getByRole('button', { name: '保存常规设置' }));
    await waitFor(() => expect(stored).toMatchObject({ taskNotifications: true, defaults: { copyLanguage: 'English', reasoningModel: { modelId: 'gpt-4o' } } }));
    first.unmount(); renderWithProviders(<GeneralSettings/>);
    expect(await screen.findByLabelText('图片文案语言')).toHaveValue('English');
    expect(screen.getByRole('switch', { name: '任务完成提醒' })).toBeChecked();
  });
  it('保存失败明确提示，不能显示成功', async () => {
    desktop.on('updateApplicationSettings', () => { throw new Error('写入被拒绝'); });
    const user = userEvent.setup(); renderWithProviders(<GeneralSettings/>);
    await user.click(await screen.findByRole('button', { name: '保存常规设置' }));
    expect(await screen.findByText('写入被拒绝')).toBeInTheDocument();
    expect(screen.queryByText('常规设置已保存')).not.toBeInTheDocument();
  });
  it('进入设置等待草稿 flush，返回保留字段、组件实例和查询串', async () => {
    let release!: (value: boolean) => void;
    const flush = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    let mounts = 0;
    function Editor() {
      const [text, setText] = useState(() => { mounts++; return ''; });
      const location = useLocation();
      useBeforeAppNavigate(useCallback(() => flush(), []));
      return <><input aria-label="创作内容" value={text} onChange={event => setText(event.target.value)}/><span>创作视图 {location.search}</span><ManageModelsButton/></>;
    }
    const user = userEvent.setup();
    renderWithProviders(<Routes><Route element={<AppShell/>}><Route path="/projects/:projectId" element={<Editor/>}/><Route path="/settings/:section" element={<SettingsPage/>}/></Route></Routes>, { initialEntries: ['/projects/source?view=results'] });
    await user.type(screen.getByLabelText('创作内容'), '保留画布与提示词');
    await user.click(screen.getByRole('button', { name: '管理模型' }));
    expect(screen.queryByRole('heading', { name: '设置' })).not.toBeInTheDocument();
    await act(async () => release(true));
    expect(await screen.findByRole('heading', { name: '模型配置' })).toBeVisible();
    expect(screen.queryByLabelText('创作内容')).not.toBeVisible();
    // 返回时的 guard 仍然可用，第二次 flush 立即允许。
    flush.mockImplementationOnce(async () => true);
    await user.click(screen.getByRole('button', { name: '返回创作页面' }));
    expect(await screen.findByLabelText('创作内容')).toHaveValue('保留画布与提示词');
    await waitFor(() => expect(screen.getByText('创作视图 ?view=results')).toBeVisible());
    expect(mounts).toBe(1);
  });
  it('初始项目页安全恢复上次业务路由，设置页不会写入恢复位置', async () => {
    desktop.on('getApplicationSettings', () => ({ ...DEFAULT_APPLICATION_SETTINGS, startupPage: 'last', lastWorkspaceRoute: '/library' }));
    const user = userEvent.setup();
    renderWithProviders(<Routes><Route element={<AppShell/>}><Route path="/" element={<Probe/>}/><Route path="/library" element={<Probe/>}/><Route path="/settings/:section" element={<SettingsPage/>}/></Route></Routes>);
    expect(await screen.findByText('目的地 /library')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByRole('heading', { name: '常规设置' })).toBeVisible();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
    const calls = vi.mocked(desktop.api.invoke).mock.calls.filter(([operation]) => operation === 'updateApplicationSettings');
    expect(calls.every(([, input]) => !('lastWorkspaceRoute' in input) || input.lastWorkspaceRoute !== '/settings/general')).toBe(true);
  });
  it('迟到的启动设置不能覆盖用户主动导航', async () => {
    let release!: (value: ApplicationSettings) => void;
    desktop.on('getApplicationSettings', () => new Promise(resolve => { release = resolve; }));
    const user = userEvent.setup();
    renderWithProviders(<Routes><Route element={<AppShell/>}><Route path="/" element={<Probe/>}/><Route path="/library" element={<Probe/>}/><Route path="/patterns" element={<Probe/>}/></Route></Routes>);
    await user.click(within(screen.getByRole('navigation', { name: '全局导航' })).getByRole('button', { name: '资产库' }));
    await act(async () => release({ ...DEFAULT_APPLICATION_SETTINGS, startupPage: 'last', lastWorkspaceRoute: '/patterns' }));
    expect(screen.getByText('目的地 /library')).toBeVisible();
    expect(screen.queryByText('目的地 /patterns')).not.toBeInTheDocument();
  });
  it('应用默认优先于最近使用，已有显式模型不被覆盖', async () => {
    const preferred = { providerId: PROVIDER_FIXTURE.id, modelId: 'gpt-image-1' };
    const options = [{ value: `${preferred.providerId}::${preferred.modelId}` }, { value: 'recent::model' }];
    expect(initialModelKey(options, preferred, 'recent::model')).toBe(options[0]!.value);
    expect(initialModelKey(options, { ...preferred, modelId: 'deleted' }, 'recent::model')).toBeNull();
    desktop.on('getApplicationSettings', () => ({ ...DEFAULT_APPLICATION_SETTINGS, defaults: { ...DEFAULT_APPLICATION_SETTINGS.defaults, imageModel: preferred } }));
    const onChange = vi.fn(); renderWithProviders(<ImageModelSelect value="explicit::model" onChange={onChange} storageKey="test-recent"/>);
    await screen.findByRole('button', { name: '管理模型' });
    await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('getApplicationSettings', {}));
    expect(onChange).not.toHaveBeenCalled();
  });
});
describe('请求用量与价格', () => {
  it('缺失用量不计零，按同一筛选导出 CSV，原生取消不报成功', async () => {
    const exports: Input<'exportUsage'>[] = [];
    desktop.on('exportUsage', input => { exports.push(input); return { name: 'usage.csv', mimeType: 'text/csv', base64: btoa('time,model\n') }; });
    const user = userEvent.setup(); renderWithProviders(<UsageSettings/>);
    expect(await screen.findByText('暂无可估算费用。为模型配置单价后，仅对后续请求保存价格快照。')).toBeVisible();
    expect(screen.getAllByText(/未提供/).length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText('筛选模型 ID'), 'historic-model');
    await user.click(screen.getByRole('combobox', { name: '筛选请求用途' }));
    await user.click(await screen.findByText('文本与视觉推理'));
    await user.click(screen.getByRole('button', { name: '导出 CSV 明细' }));
    await waitFor(() => expect(exports).toEqual([{ modelId: 'historic-model', purpose: 'MODEL' }]));
    expect(desktop.api.application).toHaveBeenCalledWith('saveUsageReport', { name: 'usage.csv', base64: btoa('time,model\n') });
    expect(await screen.findByText('已取消保存')).toBeInTheDocument();
    expect(screen.queryByText('用量明细已保存')).not.toBeInTheDocument();
  });
  it('保留已删除连接和项目的名称快照，失败回执与未知用量分别展示', async () => {
    const entry: UsageEntry = { id: 'history', jobId: 'task', requestKey: 'request', projectId: 'deleted-project', projectName: '历史商品项目', providerId: 'deleted-connection', providerName: '历史服务连接', modelId: 'history-model', purpose: 'PLANNING', state: 'COMPLETED', httpStatus: 429, startedAt: '2026-11-06T00:00:00.000Z', completedAt: '2026-11-06T00:00:01.000Z', inputTokens: 120, outputTokens: null, cachedInputTokens: null, usageSource: 'PROVIDER', estimatedAmount: null, currency: 'CNY', pricingSnapshot: { providerId: 'deleted-connection', modelId: 'history-model', currency: 'CNY', inputPerMillion: 2, outputPerMillion: null, cachedInputPerMillion: null, perRequest: null, updatedAt: '2026-11-06T00:00:00.000Z' } };
    desktop.on('listUsage', () => ({ items: [entry], total: 1 }));
    renderWithProviders(<UsageSettings/>);
    expect(await screen.findByText('历史商品项目')).toBeVisible();
    expect(screen.getByText('历史服务连接 / history-model')).toBeVisible();
    expect(screen.getByText('回执已保存 · HTTP 429')).toBeVisible();
    expect(screen.getByText('120 / 未提供 / 未提供')).toBeVisible();
    expect(screen.getByText('计价快照')).toBeInTheDocument();
  });
  it('价格留空提交 null，明确输入零保留零，仅设置价格不调用生成', async () => {
    let captured: Input<'setModelPricing'> | undefined;
    desktop.on('setModelPricing', input => { captured = input; return { ...input, updatedAt: '2026-11-06T00:00:00.000Z' }; });
    const user = userEvent.setup(); renderWithProviders(<UsageSettings/>);
    await user.click(await screen.findByRole('tab', { name: '模型单价' }));
    await user.click(await screen.findByRole('combobox', { name: '选择计价模型' }));
    await user.click(await screen.findByText('OpenAI 官方 / gpt-4o'));
    await user.type(await screen.findByLabelText('每次请求'), '0');
    await user.click(screen.getByRole('button', { name: '保存模型单价' }));
    await waitFor(() => expect(captured).toMatchObject({ providerId: PROVIDER_FIXTURE.id, modelId: 'gpt-4o', currency: 'USD', inputPerMillion: null, outputPerMillion: null, cachedInputPerMillion: null, perRequest: 0 }));
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('testProviderConnection', expect.anything());
  });
});
