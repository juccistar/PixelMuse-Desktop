import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDesktop, PROVIDER_FIXTURE } from '../../test/fake-desktop';
import { renderWithProviders } from '../../test/render';
import { ProviderFormView } from './ProviderFormView';
let desktop: FakeDesktop;
beforeEach(() => {
  desktop = new FakeDesktop().install();
  desktop.on('getModelConfigurationImpact', () => ({ projectCount: 2, activeJobCount: 1, defaultRoles: ['imageModel'] }));
  desktop.on('updateProvider', input => ({ ...PROVIDER_FIXTURE, ...input }));
});
describe('同 ID 模型配置的影响确认', () => {
  it.each(['purpose', 'image-protocol', 'capability', 'reasoning-protocol'] as const)('%s 修改必须查询影响，取消保留原配置，确认后才保存', async change => {
    const user = userEvent.setup();
    renderWithProviders(<ProviderFormView view={{ kind: 'edit', provider: PROVIDER_FIXTURE as never }} onDone={() => {}}/>);
    if (change === 'purpose' || change === 'image-protocol') {
      await user.click(screen.getByLabelText('模型 2 的模型类型'));
      await user.click(await screen.findByText(change === 'purpose' ? '无（推理）' : 'Gemini（Nano Banana）', { selector: '.ant-select-item-option-content' }));
    } else if (change === 'capability') {
      await user.click(screen.getByText('高级能力设置'));
      await user.click(screen.getAllByRole('switch')[0]!);
    } else {
      await user.click(screen.getByText('高级连接协议'));
      await user.click(screen.getByLabelText('推理协议'));
      await user.click(await screen.findByText('OpenAI Responses'));
    }
    await user.click(screen.getByRole('button', { name: '保存' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText(/关联 2 个项目、1 个进行中任务/)).toBeVisible());
    expect(desktop.api.invoke).toHaveBeenCalledWith('getModelConfigurationImpact', { providerId: PROVIDER_FIXTURE.id, modelId: change === 'purpose' || change === 'image-protocol' ? 'gpt-image-1' : 'gpt-4o' });
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('updateProvider', expect.anything());
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('updateProvider', expect.anything());
    await user.click(screen.getByRole('button', { name: '保存' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '确认保存' }));
    await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('updateProvider', expect.objectContaining({ providerId: PROVIDER_FIXTURE.id })));
    const update = vi.mocked(desktop.api.invoke).mock.calls.find(([operation]) => operation === 'updateProvider')![1];
    expect(update).not.toHaveProperty('apiKey');
    expect(update).toMatchObject({ models: change === 'purpose' ? [{ id: 'gpt-4o', supportsTools: true, supportsVision: true }, { id: 'gpt-image-1', imageApiKind: null }] : change === 'image-protocol' ? [{ id: 'gpt-4o', supportsTools: true }, { id: 'gpt-image-1', imageApiKind: 'gemini' }] : change === 'capability' ? [{ id: 'gpt-4o', supportsVision: false, supportsTools: true, supportsStructuredOutput: true }, { id: 'gpt-image-1', imageApiKind: 'openai_images' }] : [{ id: 'gpt-4o', supportsVision: true, supportsTools: true }, { id: 'gpt-image-1', imageApiKind: 'openai_images' }] });
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('testProviderConnection', expect.anything());
  });
  it('只改显示名称不弹影响确认，留空密钥与所有模型能力仍保留', async () => {
    const user = userEvent.setup();
    const provider = { ...PROVIDER_FIXTURE, models: PROVIDER_FIXTURE.models.map(model => ({ ...model, supportsVision: true, supportsThinking: true, supportsTools: true, supportsStructuredOutput: true })) };
    renderWithProviders(<ProviderFormView view={{ kind: 'edit', provider: provider as never }} onDone={() => {}}/>);
    await user.type(screen.getByLabelText('名称'), ' 新名称');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(desktop.api.invoke).toHaveBeenCalledWith('updateProvider', expect.objectContaining({ name: `${PROVIDER_FIXTURE.name} 新名称`, models: provider.models })));
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('getModelConfigurationImpact', expect.anything());
    expect(vi.mocked(desktop.api.invoke).mock.calls.find(([operation]) => operation === 'updateProvider')![1]).not.toHaveProperty('apiKey');
  });
});
