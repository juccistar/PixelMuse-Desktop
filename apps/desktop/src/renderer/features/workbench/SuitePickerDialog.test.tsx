import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDesktop } from '../../test/fake-desktop';
import { renderWithProviders } from '../../test/render';
import { SuitePickerDialog } from './SuitePickerDialog';

beforeEach(() => { new FakeDesktop().install(); });
describe('套图选择的确认与取消', () => {
  it('清空后取消不修改父级选择，重新打开恢复已确认选择', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(), onClose = vi.fn();
    const value = ['suite-example::shot-example'];
    const props = { value, onChange, onClose };
    const view = renderWithProviders(<SuitePickerDialog {...props} open/>);
    await user.click(await screen.findByRole('button', { name: '清空已选' }));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(onChange).not.toHaveBeenCalled(); expect(onClose).toHaveBeenCalledOnce();
    view.rerender(<SuitePickerDialog {...props} open={false}/>);
    view.rerender(<SuitePickerDialog {...props} open/>);
    await user.click(await screen.findByRole('button', { name: '确定选择（1）' }));
    expect(onChange).toHaveBeenCalledWith(value);
  });
  it('明确确认后才提交本次清空', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(), onClose = vi.fn();
    renderWithProviders(<SuitePickerDialog open value={['suite-example::shot-example']} onChange={onChange} onClose={onClose}/>);
    await user.click(await screen.findByRole('button', { name: '清空已选' }));
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '确定选择' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith([]); expect(onClose).toHaveBeenCalledOnce();
  });
});
