import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPLICATION_SETTINGS, type ApplicationSettings } from '@ecomgen/contracts';
import { FakeDesktop } from '../../test/fake-desktop';
import { renderWithProviders } from '../../test/render';
import { AppShell } from '../../components/AppShell';
import { SettingsPage } from './SettingsPage';
import { UsageSettings } from './UsageSettings';
let desktop: FakeDesktop;
beforeEach(() => { desktop = new FakeDesktop().install(); localStorage.clear(); });
function Destination() { const location = useLocation(); return <p>目的地 {location.pathname}</p>; }
function setup(section = 'general') {
  return renderWithProviders(<Routes><Route element={<AppShell/>}><Route path="/" element={<Destination/>}/><Route path="/library" element={<Destination/>}/><Route path="/settings/:section" element={<SettingsPage/>}/></Route></Routes>, { initialEntries: [`/settings/${section}`] });
}
async function category(name: string) { await userEvent.setup().click(within(screen.getByRole('navigation', { name: '设置分类' })).getByRole('link', { name })); }
async function chooseModel(name: string) {
  fireEvent.mouseDown(await screen.findByLabelText('选择计价模型', { selector: 'input' }));
  const options = await screen.findAllByTitle(name);
  fireEvent.click(options.find(element => element.classList.contains('ant-select-item-option'))!);
}
describe('设置草稿离开保护', () => {
  it('分类切换可继续编辑，保存失败留在原处，成功保存后才离开', async () => {
    let stored: ApplicationSettings = structuredClone(DEFAULT_APPLICATION_SETTINGS);
    let failure = true;
    desktop.on('getApplicationSettings', () => stored);
    desktop.on('updateApplicationSettings', input => { if (failure && input.defaults) throw new Error('保存被拒绝'); stored = { ...stored, ...input }; return stored; });
    const user = userEvent.setup(); setup();
    fireEvent.change(await screen.findByLabelText('图片文案语言'), { target: { value: 'English' } });
    await category('用量统计');
    await user.click(await screen.findByRole('button', { name: '继续编辑' }));
    expect(screen.getByLabelText('图片文案语言')).toHaveValue('English');
    await category('用量统计');
    await user.click(await screen.findByRole('button', { name: '保存并继续' }));
    expect(await screen.findByText('保存被拒绝')).toBeVisible();
    expect(screen.getByRole('heading', { name: '常规设置' })).toBeVisible();
    expect(screen.getByLabelText('图片文案语言')).toHaveValue('English');
    failure = false;
    await category('用量统计');
    await user.click(await screen.findByRole('button', { name: '保存并继续' }));
    expect(await screen.findByRole('heading', { name: '用量统计' })).toBeVisible();
    expect(stored.defaults.copyLanguage).toBe('English');
    await category('常规设置');
    expect(await screen.findByLabelText('图片文案语言')).toHaveValue('English');
  });

  it('从全局导航离开设置也需明确放弃，重新进入不会显示已丢弃值', async () => {
    const user = userEvent.setup(); setup();
    fireEvent.change(await screen.findByLabelText('图片文案语言'), { target: { value: '未保存语言' } });
    await user.click(within(screen.getByRole('navigation', { name: '全局导航' })).getByRole('button', { name: '资产库' }));
    await user.click(await screen.findByRole('button', { name: '继续编辑' }));
    expect(screen.getByLabelText('图片文案语言')).toHaveValue('未保存语言');
    await user.click(within(screen.getByRole('navigation', { name: '全局导航' })).getByRole('button', { name: '资产库' }));
    await user.click(await screen.findByRole('button', { name: '放弃修改' }));
    expect(await screen.findByText('目的地 /library')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByLabelText('图片文案语言')).toHaveValue('');
    expect(vi.mocked(desktop.api.invoke).mock.calls.some(([operation, input]) => operation === 'updateApplicationSettings' && 'defaults' in input)).toBe(false);
  });

  it('切换计价模型时选择继续编辑，保留原模型和未保存单价', async () => {
    renderWithProviders(<UsageSettings/>);
    fireEvent.click(await screen.findByRole('tab', { name: '模型单价' }));
    await chooseModel('OpenAI 官方 / gpt-4o');
    fireEvent.change(await screen.findByRole('spinbutton', { name: '每次请求' }), { target: { value: '1.25' } });
    await chooseModel('OpenAI 官方 / gpt-image-1');
    fireEvent.click(await screen.findByRole('button', { name: '继续编辑' }));
    expect(Number((screen.getByRole('spinbutton', { name: '每次请求' }) as HTMLInputElement).value)).toBe(1.25);
    expect(screen.getByRole('combobox', { name: '选择计价模型' }).closest('.ant-select')).toHaveTextContent('gpt-4o');
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('setModelPricing', expect.anything());
  });

  it('明确放弃单价草稿后切换标签，返回恢复已保存值且再次切模型不再确认', async () => {
    renderWithProviders(<UsageSettings/>);
    fireEvent.click(await screen.findByRole('tab', { name: '模型单价' }));
    await chooseModel('OpenAI 官方 / gpt-4o');
    fireEvent.change(await screen.findByRole('spinbutton', { name: '每次请求' }), { target: { value: '1.25' } });
    fireEvent.click(screen.getByRole('tab', { name: '请求与业务明细' }));
    fireEvent.click(await screen.findByRole('button', { name: '放弃修改' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: '请求与业务明细' })).toHaveAttribute('aria-selected', 'true'));
    fireEvent.click(screen.getByRole('tab', { name: '模型单价' }));
    await waitFor(() => expect(screen.getByRole('spinbutton', { name: '每次请求' })).toHaveValue(''));
    await chooseModel('OpenAI 官方 / gpt-image-1');
    expect(screen.queryByRole('button', { name: '放弃修改' })).not.toBeInTheDocument();
    expect(desktop.api.invoke).not.toHaveBeenCalledWith('setModelPricing', expect.anything());
  });
});
