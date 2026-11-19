import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDesktop, PROVIDER_FIXTURE } from '../../test/fake-desktop';
import { renderWithProviders } from '../../test/render';
import { ModelConfiguration } from '../settings/ModelConfiguration';
import { ProviderFormView } from './ProviderFormView';
let desktop: FakeDesktop;
beforeEach(() => { desktop = new FakeDesktop().install(); });
describe('模型与服务连接管理 · 假 IPC', () => {
  it('默认以模型列表呈现用途和能力，服务连接集中显示密钥状态', async () => {
    const user = userEvent.setup(); renderWithProviders(<ModelConfiguration/>);
    expect(await screen.findByText('gpt-4o')).toBeInTheDocument();
    expect(screen.getByText('视觉理解')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '服务连接' }));
    expect(await screen.findByText('已配置，可替换')).toBeInTheDocument();
    expect(screen.getByText('2 个模型')).toBeInTheDocument();
  });
  it('创建保留多模型配置，保存本身不发起探测', async () => {
    let captured: unknown;
    desktop.on('createProvider', input => { captured = input; return PROVIDER_FIXTURE; });
    const user = userEvent.setup(); renderWithProviders(<ProviderFormView view={{ kind: 'create' }} onDone={() => {}}/>);
    await user.type(screen.getByLabelText(/名称/), '隔离服务连接');
    await user.type(screen.getByLabelText('Base URL'), 'https://provider.invalid/v1');
    await user.type(screen.getByLabelText('API Key'), 'test-only-credential');
    await user.type(screen.getByPlaceholderText('模型 ID，如 gpt-image-1'), 'test-image');
    await user.click(screen.getByRole('button', { name: /^添加$/ }));
    await waitFor(() => expect(captured).toMatchObject({ name: '隔离服务连接', apiKey: 'test-only-credential', models: [{ id: 'test-image' }] }));
    expect(await screen.findByText('已添加服务连接')).toBeInTheDocument();
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('testProviderConnection', expect.anything());
    expect(screen.getByLabelText(/API Key/)).toHaveValue('');
  });
  it('编辑留空保留密钥和高级协议能力', async () => {
    let captured: unknown;
    const provider = { ...PROVIDER_FIXTURE, reasoningProtocol: 'openai_responses' as const };
    desktop.on('updateProvider', input => { captured = input; return provider; });
    const user = userEvent.setup(); renderWithProviders(<ProviderFormView view={{ kind: 'edit', provider: provider as never }} onDone={() => {}}/>);
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(captured).toMatchObject({ providerId: provider.id, reasoningProtocol: 'openai_responses', models: [{ id: 'gpt-4o', supportsVision: true, supportsTools: true, supportsStructuredOutput: true }, { id: 'gpt-image-1', imageApiKind: 'openai_images' }] }));
    expect(captured).not.toHaveProperty('apiKey');
  });
  it('剪贴板按钮继续使用窄原生文本能力', async () => {
    vi.mocked(desktop.api.readClipboardText).mockResolvedValue(JSON.stringify({ _type: 'newapi_channel_conn', key: 'test-only-credential', url: 'https://provider.invalid' }));
    const user = userEvent.setup(); renderWithProviders(<ProviderFormView view={{ kind: 'create' }} onDone={() => {}}/>);
    await user.click(screen.getByRole('button', { name: /读取剪贴板/ }));
    await waitFor(() => expect(screen.getByLabelText('Base URL')).toHaveValue('https://provider.invalid/v1'));
    expect(screen.getByLabelText('API Key')).toHaveValue('test-only-credential');
    expect(desktop.api.readClipboardText).toHaveBeenCalledTimes(1);
  });
  it('仅明确检查才调用连接探测，并把本次结果与能力验证分开展示', async () => {
    desktop.on('testProviderConnection', input => ({ ok: true, ...input, latencyMs: 25, models: ['gpt-4o'], modelAvailable: true }));
    const user = userEvent.setup(); renderWithProviders(<ModelConfiguration/>);
    await user.click((await screen.findAllByRole('button', { name: '编辑' }))[0]!);
    const dialog = screen.getByRole('dialog');
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('testProviderConnection', expect.anything());
    await user.click(within(dialog).getAllByRole('button', { name: '测试' })[0]!);
    expect(await screen.findByText('连通 · 25ms')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(await screen.findByText('连接可达 · 25ms（本次会话）')).toBeVisible();
  });
  it('移除前查询项目、任务与默认用途影响，确认后才调用删除', async () => {
    desktop.on('getModelConfigurationImpact', () => ({ projectCount: 3, activeJobCount: 2, defaultRoles: ['reasoningModel'] }));
    desktop.on('deleteProvider', () => null);
    const user = userEvent.setup(); renderWithProviders(<ModelConfiguration/>);
    await user.click(await screen.findByRole('tab', { name: '服务连接' }));
    await user.click(await screen.findByRole('button', { name: '移除' }));
    expect(await screen.findByText('关联 3 个项目、2 个进行中任务。')).toBeInTheDocument();
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('deleteProvider', expect.anything());
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '移除' }));
    await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('deleteProvider', { providerId: PROVIDER_FIXTURE.id }));
  });
});
