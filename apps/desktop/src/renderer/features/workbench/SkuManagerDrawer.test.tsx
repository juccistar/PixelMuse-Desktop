import '../../test/setup';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectImagePlanning, ProjectSku } from '@ecomgen/contracts';
import { BusinessActivityContext } from '../../components/businessActivity';
import { ASSET_FIXTURE, PROJECT_ID } from '../../test/fixtures';
import { FakeDesktop } from '../../test/fake-desktop';
import { SkuManagerDrawer, type SkuManagerDrawerProps } from './SkuManagerDrawer';

const skuId = (index: number) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const groupId = '20000000-0000-4000-8000-000000000001';
const makeSku = (index = 1, patch: Partial<ProjectSku> = {}): ProjectSku => ({ id: skuId(index), name: `规格 ${index}`, code: null, attributes: [], productAssetIds: [], included: true, ...patch });
const makePlanning = (patch: Partial<ProjectImagePlanning> = {}): ProjectImagePlanning => ({ projectId: PROJECT_ID, revision: 3, config: { mainCount: 5, detailCount: 8, skuImagesPerGroup: 1, shareImages: false }, skus: [], imageGroups: [], updatedAt: '2026-11-07T00:00:00.000Z', ...patch });
function setup(patch: Partial<SkuManagerDrawerProps> = {}) {
  const props: SkuManagerDrawerProps = { open: true, planning: makePlanning(), assets: [ASSET_FIXTURE], saving: false, onSave: vi.fn().mockResolvedValue(undefined), onClose: vi.fn(), onDirtyChange: vi.fn(), ...patch };
  const view = render(<SkuManagerDrawer {...props} />);
  return { ...view, props, user: userEvent.setup() };
}
function change(label: string, value: string) { fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value } }); }
async function fillSixCombinations(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '按规格批量创建' }));
  change('组合属性 1 名称', '颜色'); change('组合属性 1 的值', '白,黑,绿');
  await user.click(screen.getByRole('button', { name: '添加组合属性' }));
  change('组合属性 2 名称', '尺码'); change('组合属性 2 的值', 'M,L');
}
const sixSkus = () => ['白', '黑', '绿'].flatMap((color, colorIndex) => ['M', 'L'].map((size, sizeIndex) => makeSku(colorIndex * 2 + sizeIndex + 1, { name: `${color} ${size}`, attributes: [{ name: '颜色', value: color }, { name: '尺码', value: size }] })));
const colorGroups = () => ['白', '黑', '绿'].map((color, index) => ({ id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, name: `颜色：${color}`, skuIds: [skuId(index * 2 + 1), skuId(index * 2 + 2)], productAssetIds: [ASSET_FIXTURE.id] }));
async function previewColorGroups(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '按属性预览分组' }));
  await user.click(screen.getByRole('checkbox', { name: '按属性 颜色 分组' }));
  await user.click(screen.getByRole('button', { name: '预览图片组' }));
}

describe('SkuManagerDrawer', () => {
  it('目录冲突保留草稿，读取失败可重试，明确载入后才能使用新版本继续保存', async () => {
    const desktop = new FakeDesktop().install();
    const latest = makePlanning({ revision: 4, skus: [makeSku(1, { name: '已保存的最新规格' })] });
    let readFailure = true;
    desktop.on('getProjectImagePlanning', () => { if (readFailure) throw new Error('读取暂时失败'); return latest; });
    const onSave = vi.fn().mockRejectedValueOnce(Object.assign(new Error('规格目录已被修改'), { code: 'CONFLICT' })).mockResolvedValue(undefined);
    const { user, props } = setup({ planning: makePlanning({ skus: [makeSku()] }), onSave });
    change('SKU 1 名称', '本地草稿规格');
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByRole('region', { name: '处理目录冲突' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'SKU 1 名称' })).toHaveValue('本地草稿规格');
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '读取最新目录' }));
    expect(await screen.findByText(/读取最新目录失败/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'SKU 1 名称' })).toHaveValue('本地草稿规格');
    readFailure = false;
    await user.click(screen.getByRole('button', { name: '读取最新目录' }));
    await screen.findByText('已保存的最新规格');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'SKU 1 名称' })).toHaveValue('本地草稿规格');
    await user.click(screen.getByRole('button', { name: '放弃本地草稿并载入最新目录' }));
    expect(screen.getByRole('textbox', { name: 'SKU 1 名称' })).toHaveValue('已保存的最新规格');
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
    change('SKU 1 名称', '在最新目录上修改');
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 4, skus: [expect.objectContaining({ name: '在最新目录上修改' })] }));
  });
  it('空目录不插入设计示例，未修改时不能保存', () => {
    const { props } = setup();
    expect(screen.getByText('还没有 SKU，可添加单个规格或按实际商品属性批量创建。')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'SKU 1 名称' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it.each(['取消', '关闭 SKU 管理', 'Escape'])('%s 会确认脏草稿，继续编辑保留输入，放弃后重开恢复已保存目录', async entry => {
    const planning = makePlanning({ skus: [makeSku()] });
    const { props, user, rerender } = setup({ planning });
    change('SKU 1 名称', '本地未保存名称');
    if (entry === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
    else await user.click(screen.getByRole('button', { name: entry }));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
    const confirmation = screen.getByRole('alertdialog');
    await user.click(within(confirmation).getByRole('button', { name: '继续编辑' }));
    expect(screen.getByRole('textbox', { name: 'SKU 1 名称' })).toHaveValue('本地未保存名称');
    await user.click(screen.getByRole('button', { name: '取消' }));
    await user.click(screen.getByRole('button', { name: '放弃修改' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onSave).not.toHaveBeenCalled();
    expect(planning.skus[0]!.name).toBe('规格 1');
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
    rerender(<SkuManagerDrawer {...props} open={false} />);
    rerender(<SkuManagerDrawer {...props} open />);
    expect(screen.getByRole('textbox', { name: 'SKU 1 名称' })).toHaveValue('规格 1');
  });

  it.each(['继续编辑', 'Escape'])('%s 关闭放弃确认后将焦点返回抽屉中原先编辑的输入框', async dismissal => {
    const { props, user } = setup({ planning: makePlanning({ skus: [makeSku()] }) });
    const name = screen.getByRole('textbox', { name: 'SKU 1 名称' });
    await user.click(name);
    change('SKU 1 名称', '尚未保存的名称');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: '继续编辑' })).toHaveFocus();
    if (dismissal === 'Escape') await user.keyboard('{Escape}');
    else await user.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(name).toHaveFocus();
    expect(name).toHaveValue('尚未保存的名称');
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('从取消按钮进入放弃确认，继续编辑后仍可从该按钮操作', async () => {
    const { user } = setup({ planning: makePlanning({ skus: [makeSku()] }) });
    change('SKU 1 名称', '未保存');
    const cancel = screen.getByRole('button', { name: '取消' });
    await user.click(cancel);
    await user.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(cancel).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('原输入框已隐藏时将焦点安全返回抽屉关闭按钮', async () => {
    const { user } = setup({ planning: makePlanning({ skus: [makeSku()] }) });
    const name = screen.getByRole('textbox', { name: 'SKU 1 名称' });
    await user.click(name);
    change('SKU 1 名称', '未保存');
    await user.keyboard('{Escape}');
    name.style.display = 'none';
    await user.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.getByRole('button', { name: '关闭 SKU 管理' })).toHaveFocus();
  });

  it('抽屉外的焦点不会被当作继续编辑的返回位置', async () => {
    const props: SkuManagerDrawerProps = { open: true, planning: makePlanning({ skus: [makeSku()] }), assets: [], saving: false, onSave: vi.fn().mockResolvedValue(undefined), onClose: vi.fn() };
    render(<><button type="button">业务页按钮</button><SkuManagerDrawer {...props} /></>);
    const user = userEvent.setup();
    change('SKU 1 名称', '未保存');
    await user.click(screen.getByRole('button', { name: '业务页按钮' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.getByRole('button', { name: '关闭 SKU 管理' })).toHaveFocus();
  });

  it('保存失败保留完整草稿和 revision，成功重试后清除 dirty 并关闭', async () => {
    const onSave = vi.fn<SkuManagerDrawerProps['onSave']>().mockRejectedValueOnce(new Error('目录已由其他窗口修改')).mockResolvedValueOnce(undefined);
    const original = makeSku(1, { code: 'OLD', attributes: [{ name: '材料', value: '棉' }], productAssetIds: [ASSET_FIXTURE.id] });
    const { props, user } = setup({ planning: makePlanning({ skus: [original] }), onSave });
    change('SKU 1 名称', '手改名称'); change('SKU 1 编码', ''); change('SKU 1 属性 1 值', '亚麻');
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('目录已由其他窗口修改');
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'SKU 1 名称' })).toHaveValue('手改名称');
    expect(screen.getByRole('textbox', { name: 'SKU 1 属性 1 值' })).toHaveValue('亚麻');
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(onSave).toHaveBeenCalledWith({ expectedRevision: 3, config: props.planning.config, skus: [{ ...original, name: '手改名称', code: null, attributes: [{ name: '材料', value: '亚麻' }] }], imageGroups: [] });
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]![0]).toEqual(onSave.mock.calls[0]![0]);
    expect(original.code).toBe('OLD');
  });

  it('保存中的编辑与关闭被锁住，一次点击只提交一个原子目录', async () => {
    let resolveSave!: () => void;
    const onSave = vi.fn<SkuManagerDrawerProps['onSave']>(() => new Promise<void>(resolve => { resolveSave = resolve; }));
    const { props, user } = setup({ planning: makePlanning({ skus: [makeSku()] }), onSave });
    change('SKU 1 名称', '提交中的名称');
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(screen.getByRole('textbox', { name: 'SKU 1 名称' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '关闭 SKU 管理' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);
    resolveSave();
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  });

  it('查询刷新不覆盖本地输入，保存继续携带打开时的 revision 供 CAS 拒绝', async () => {
    const { props, rerender, user } = setup({ planning: makePlanning({ skus: [makeSku()] }) });
    change('SKU 1 名称', '本地修改');
    rerender(<SkuManagerDrawer {...props} planning={makePlanning({ revision: 4, skus: [makeSku(1, { name: '另一窗口已保存' })] })} />);
    expect(screen.getByRole('textbox', { name: 'SKU 1 名称' })).toHaveValue('本地修改');
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(vi.mocked(props.onSave).mock.calls[0]![0]).toMatchObject({ expectedRevision: 3, skus: [{ id: skuId(1), name: '本地修改' }] });
  });

  it('复制产生新 UUID 和空编码，编辑/参与/删除保留原身份并清理空组', async () => {
    const original = makeSku(1, { code: 'A-1', attributes: [{ name: '任意属性', value: '自定义值' }], productAssetIds: [ASSET_FIXTURE.id] });
    const { props, user } = setup({ planning: makePlanning({ skus: [original], imageGroups: [{ id: groupId, name: '原组', skuIds: [original.id], productAssetIds: [] }] }) });
    await user.click(screen.getByRole('button', { name: '复制 SKU 1' }));
    expect(screen.getByRole('textbox', { name: 'SKU 2 编码' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'SKU 2 属性 1 值' })).toHaveValue('自定义值');
    change('SKU 2 名称', '副本名称');
    await user.click(screen.getByRole('checkbox', { name: 'SKU 2 参与规划' }));
    await user.click(screen.getByRole('button', { name: '删除 SKU 1' }));
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    const saved = vi.mocked(props.onSave).mock.calls[0]![0];
    expect(saved.skus).toHaveLength(1);
    expect(saved.skus[0]).toMatchObject({ name: '副本名称', code: null, included: false, attributes: original.attributes, productAssetIds: original.productAssetIds });
    expect(saved.skus[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(saved.skus[0]!.id).not.toBe(original.id);
    expect(saved.imageGroups).toEqual([]);
  });

  it.each([115, 116])('复制 %i 个 ASCII 加 emoji 的名称时保留完整 Unicode 并遵守 120 长度预算', async asciiLength => {
    const original = makeSku(1, { name: `${'a'.repeat(asciiLength)}😀`, code: 'ORIGINAL' });
    const { props, user } = setup({ planning: makePlanning({ skus: [original] }) });
    await user.click(screen.getByRole('button', { name: '复制 SKU 1' }));
    const expected = `${'a'.repeat(asciiLength)}${asciiLength === 115 ? '😀' : ''} 副本`;
    expect(screen.getByRole('textbox', { name: 'SKU 2 名称' })).toHaveValue(expected);
    expect(screen.getByRole('button', { name: '保存修改' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    const saved = vi.mocked(props.onSave).mock.calls[0]![0].skus;
    expect(saved[0]).toEqual(original);
    expect(saved[1]).toMatchObject({ name: expected, code: null });
    expect(saved[1]!.id).not.toBe(original.id);
    expect(saved[1]!.name.length).toBeLessThanOrEqual(120);
    expect(() => encodeURIComponent(saved[1]!.name)).not.toThrow();
  });

  it('任意有序规格可以新增、排序、删除，保存保持用户顺序', async () => {
    const { props, user } = setup({ planning: makePlanning({ skus: [makeSku(1, { attributes: [{ name: '产地', value: '杭州' }] })] }) });
    await user.click(screen.getByRole('button', { name: '添加 SKU 1 属性' }));
    change('SKU 1 属性 2 名称', '包装方式'); change('SKU 1 属性 2 值', '单独包装');
    await user.click(screen.getByRole('button', { name: '上移 SKU 1 属性 2' }));
    expect(screen.getByRole('textbox', { name: 'SKU 1 属性 1 名称' })).toHaveValue('包装方式');
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(vi.mocked(props.onSave).mock.calls[0]![0].skus[0]!.attributes).toEqual([{ name: '包装方式', value: '单独包装' }, { name: '产地', value: '杭州' }]);
  });

  it('三乘二创建六个组合，再次创建会预览已有六个并阻止重复', async () => {
    const { props, user } = setup();
    await fillSixCombinations(user);
    expect(screen.getByText('预计 6 个组合 · 新增 6 个 · 已有 0 个不重复创建')).toBeInTheDocument();
    expect(props.onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '创建 6 个 SKU' }));
    expect(screen.getAllByRole('textbox', { name: /^SKU \d+ 名称$/ })).toHaveLength(6);
    await fillSixCombinations(user);
    expect(screen.getByText('预计 6 个组合 · 新增 0 个 · 已有 6 个不重复创建')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建 0 个 SKU' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '取消批量创建' }));
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    const skus = vi.mocked(props.onSave).mock.calls[0]![0].skus;
    expect(skus).toHaveLength(6);
    expect(new Set(skus.map(sku => sku.id)).size).toBe(6);
    expect(skus.map(sku => sku.name)).toEqual(['白 / M', '白 / L', '黑 / M', '黑 / L', '绿 / M', '绿 / L']);
    expect(skus.every(sku => sku.code === null && sku.productAssetIds.length === 0)).toBe(true);
  });

  it('组合超限不会静默截断，重复属性值也不能创建', async () => {
    const { props, user } = setup();
    await fillSixCombinations(user);
    change('组合属性 2 的值', Array.from({ length: 21 }, (_, index) => `尺码${index}`).join(','));
    expect(screen.getByText('共 63 个组合，超过单次 60 个上限，请减少属性值。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建 0 个 SKU' })).toBeDisabled();
    expect(screen.queryByRole('textbox', { name: 'SKU 1 名称' })).not.toBeInTheDocument();
    change('组合属性 2 的值', 'M,M');
    expect(screen.getByText('同一属性的值不能重复。')).toBeInTheDocument();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('组合加现有目录超过 60 时整体拒绝', async () => {
    const { user } = setup({ planning: makePlanning({ skus: Array.from({ length: 57 }, (_, index) => makeSku(index + 1)) }) });
    await fillSixCombinations(user);
    expect(screen.getByText('新增后共 63 个 SKU，超过 60 个上限，请减少组合或现有 SKU。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建 0 个 SKU' })).toBeDisabled();
  });

  it('只开启共享不会猜测图片组；六个 SKU 仍然独立', async () => {
    const { props, user } = setup({ planning: makePlanning({ skus: sixSkus() }) });
    await user.click(screen.getByRole('checkbox', { name: '同外观规格共用图片' }));
    expect(screen.getByText('6 个参与规格 · 6 组图片')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(vi.mocked(props.onSave).mock.calls[0]![0]).toMatchObject({ config: { shareImages: true }, imageGroups: [] });
  });

  it('选择颜色属性后先预览确认才将六个 SKU 合并为三组，取消共享恢复六组且身份不变', async () => {
    const skus = sixSkus();
    const { props, user } = setup({ planning: makePlanning({ skus }) });
    await user.click(screen.getByRole('checkbox', { name: '同外观规格共用图片' }));
    await user.click(screen.getByRole('button', { name: '按属性预览分组' }));
    await user.click(screen.getByRole('checkbox', { name: '按属性 颜色 分组' }));
    await user.click(screen.getByRole('button', { name: '预览图片组' }));
    expect(screen.getByLabelText('图片组预览')).toHaveTextContent('白 M、白 L');
    expect(screen.getByText('6 个参与规格 · 6 组图片')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '确认图片分组' }));
    expect(screen.getByText('6 个参与规格 · 3 组图片')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: '同外观规格共用图片' }));
    expect(screen.getByText('6 个参与规格 · 6 组图片')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: '同外观规格共用图片' }));
    expect(screen.getByText('6 个参与规格 · 3 组图片')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    const saved = vi.mocked(props.onSave).mock.calls[0]![0];
    expect(saved.skus.map(sku => sku.id)).toEqual(skus.map(sku => sku.id));
    expect(saved.imageGroups.map(group => group.skuIds)).toEqual([[skuId(1), skuId(2)], [skuId(3), skuId(4)], [skuId(5), skuId(6)]]);
  });

  it('重复按属性确认相同成员不制造脏目录，保存其他修改时仍保留组身份、名称和显式参考', async () => {
    const [white, black, green] = colorGroups();
    const imageGroups = [black!, white!, green!].map(group => ({ ...group, name: `已核对 ${group.name}`, skuIds: [...group.skuIds].reverse() }));
    const planning = makePlanning({ skus: sixSkus(), imageGroups, config: { ...makePlanning().config, shareImages: true } });
    const { props, user } = setup({ planning });
    for (let confirmation = 0; confirmation < 2; confirmation++) {
      await previewColorGroups(user);
      expect(screen.getByLabelText('图片组预览')).toHaveTextContent('已核对 颜色：黑');
      await user.click(screen.getByRole('button', { name: '确认图片分组' }));
      expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
      expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
    }
    expect(props.onSave).not.toHaveBeenCalled();
    change('SKU 1 编码', 'NEW-CODE');
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    const saved = vi.mocked(props.onSave).mock.calls[0]![0];
    expect(saved.imageGroups).toEqual(imageGroups);
    expect(saved.skus.map(sku => sku.id)).toEqual(planning.skus.map(sku => sku.id));
  });

  it('真正改变分组成员时只沿用未变组的身份与参考，新组获得新的身份', async () => {
    const imageGroups = colorGroups();
    const { props, user } = setup({ planning: makePlanning({ skus: sixSkus(), imageGroups, config: { ...makePlanning().config, shareImages: true } }) });
    change('SKU 3 属性 1 值', '绿');
    change('SKU 5 属性 1 值', '黑');
    await previewColorGroups(user);
    await user.click(screen.getByRole('button', { name: '确认图片分组' }));
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    const saved = vi.mocked(props.onSave).mock.calls[0]![0].imageGroups;
    expect(saved).toHaveLength(3);
    expect(saved.find(group => group.skuIds.includes(skuId(1)))).toEqual(imageGroups[0]);
    const newGroups = saved.filter(group => !group.skuIds.includes(skuId(1)));
    expect(new Set(saved.map(group => group.id)).size).toBe(3);
    for (const group of newGroups) {
      expect(imageGroups.map(original => original.id)).not.toContain(group.id);
      expect(group.productAssetIds).toEqual([]);
    }
    expect(newGroups).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '颜色：绿', skuIds: [skuId(3), skuId(6)] }),
      expect.objectContaining({ name: '颜色：黑', skuIds: [skuId(4), skuId(5)] }),
    ]));
  });

  it('显式更改组名和参考仍可保存，随后按同属性确认保留这些更改和原身份', async () => {
    const otherAsset = { ...ASSET_FIXTURE, id: skuId(50), originalName: '另一个产品.png' };
    const imageGroups = [colorGroups()[0]!];
    const { props, user } = setup({ assets: [ASSET_FIXTURE, otherAsset], planning: makePlanning({ skus: sixSkus().slice(0, 2), imageGroups, config: { ...makePlanning().config, shareImages: true } }) });
    await user.click(screen.getByRole('button', { name: '编辑图片组 颜色：白' }));
    change('图片组名称', '重新核对的外观');
    await user.click(screen.getByLabelText('图片组产品参考'));
    await user.click(screen.getByRole('checkbox', { name: '图片组引用 product.png' }));
    await user.click(screen.getByRole('checkbox', { name: '图片组引用 另一个产品.png' }));
    await user.click(screen.getByRole('button', { name: '预览图片组' }));
    await user.click(screen.getByRole('button', { name: '确认图片分组' }));
    expect(screen.getByRole('button', { name: '保存修改' })).toBeEnabled();
    await previewColorGroups(user);
    await user.click(screen.getByRole('button', { name: '确认图片分组' }));
    expect(screen.getByRole('button', { name: '保存修改' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(vi.mocked(props.onSave).mock.calls[0]![0].imageGroups).toEqual([{ ...imageGroups[0]!, name: '重新核对的外观', productAssetIds: [otherAsset.id] }]);
  });

  it.each(['color', 'Ｃｏｌｏｒ'])('Color 与 %s 以一个可读选项分组，保存保留原属性拼写', async alias => {
    const skus = [makeSku(1, { attributes: [{ name: 'Color', value: 'Red' }] }), makeSku(2, { attributes: [{ name: alias, value: 'Red' }] })];
    const { props, user } = setup({ planning: makePlanning({ skus, config: { ...makePlanning().config, shareImages: true } }) });
    await user.click(screen.getByRole('button', { name: '按属性预览分组' }));
    const choices = within(screen.getByRole('group', { name: '分组属性' })).getAllByRole('checkbox');
    expect(choices).toHaveLength(1);
    expect(choices[0]).toHaveAccessibleName('按属性 Color 分组');
    await user.click(choices[0]!);
    await user.click(screen.getByRole('button', { name: '预览图片组' }));
    expect(screen.getByLabelText('图片组预览')).toHaveTextContent('Color：Red：规格 1、规格 2');
    await user.click(screen.getByRole('button', { name: '确认图片分组' }));
    expect(screen.getByText('2 个参与规格 · 1 组图片')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    const saved = vi.mocked(props.onSave).mock.calls[0]![0];
    expect(saved.skus).toEqual(skus);
    expect(saved.imageGroups).toEqual([expect.objectContaining({ name: 'Color：Red', skuIds: skus.map(sku => sku.id), productAssetIds: [] })]);
  });

  it('显式成员组可以选择组参考，已分组成员不能再加入其他组', async () => {
    const { props, user } = setup({ planning: makePlanning({ skus: [makeSku(), makeSku(2), makeSku(3)] }) });
    await user.click(screen.getByRole('checkbox', { name: '同外观规格共用图片' }));
    await user.click(screen.getByRole('button', { name: '选择成员建立图片组' }));
    change('图片组名称', '经核对共图');
    await user.click(screen.getByRole('checkbox', { name: '共图成员 规格 1' }));
    await user.click(screen.getByRole('checkbox', { name: '共图成员 规格 2' }));
    await user.click(screen.getByLabelText('图片组产品参考'));
    await user.click(screen.getByRole('checkbox', { name: '图片组引用 product.png' }));
    await user.click(screen.getByRole('button', { name: '预览图片组' }));
    expect(screen.getByText('3 个参与规格 · 3 组图片')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认图片分组' }));
    expect(screen.getByText('3 个参与规格 · 2 组图片')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '选择成员建立图片组' }));
    expect(screen.getByRole('checkbox', { name: '共图成员 规格 1' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '共图成员 规格 2' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '取消分组' }));
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(vi.mocked(props.onSave).mock.calls[0]![0].imageGroups[0]).toMatchObject({ name: '经核对共图', skuIds: [skuId(1), skuId(2)], productAssetIds: [ASSET_FIXTURE.id] });
  });

  it('产品参考只提供当前项目 truth 图片，已有无效引用须明确移除才能保存', async () => {
    const foreign = { ...ASSET_FIXTURE, id: skuId(50), projectId: skuId(51), originalName: '外项目.png' };
    const style = { ...ASSET_FIXTURE, id: skuId(52), role: 'STYLE_REFERENCE' as const, kind: 'REFERENCE' as const, originalName: '采集风格.png' };
    const nonImage = { ...ASSET_FIXTURE, id: skuId(53), mimeType: 'application/pdf', originalName: '非图片.pdf' };
    const { props, user } = setup({ assets: [ASSET_FIXTURE, foreign, style, nonImage], planning: makePlanning({ skus: [makeSku(1, { productAssetIds: [foreign.id, style.id] })] }) });
    change('SKU 1 名称', '有效修改');
    await user.click(screen.getByLabelText('SKU 1 产品参考'));
    expect(screen.getByRole('checkbox', { name: 'SKU 1 引用 product.png' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /外项目|采集风格|非图片/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '移除无效引用' }));
    await user.click(screen.getByRole('checkbox', { name: 'SKU 1 引用 product.png' }));
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(vi.mocked(props.onSave).mock.calls[0]![0].skus[0]!.productAssetIds).toEqual([ASSET_FIXTURE.id]);
  });

  it('放弃确认期间隐藏或卸载业务页不抢焦点，返回后原目标已卸载则安全聚焦关闭按钮', async () => {
    const props: SkuManagerDrawerProps = { open: true, planning: makePlanning({ skus: [makeSku()] }), assets: [], saving: false, onSave: vi.fn().mockResolvedValue(undefined), onClose: vi.fn() };
    const content = (active: boolean, show = true) => <><button type="button">其他界面操作</button>{show ? <BusinessActivityContext value={active}><SkuManagerDrawer {...props} /></BusinessActivityContext> : null}</>;
    const view = render(content(true));
    const user = userEvent.setup();
    const name = screen.getByRole('textbox', { name: 'SKU 1 名称' });
    await user.click(name);
    change('SKU 1 名称', '保留草稿');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: '继续编辑' })).toHaveFocus();
    view.rerender(content(false));
    expect(name).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    const outside = screen.getByRole('button', { name: '其他界面操作' });
    await user.click(outside);
    await user.keyboard('{Escape}');
    expect(outside).toHaveFocus();
    expect(props.onClose).not.toHaveBeenCalled();
    view.rerender(content(true));
    expect(screen.getByRole('button', { name: '继续编辑' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.getByRole('button', { name: '关闭 SKU 管理' })).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'SKU 1 名称' })).toHaveValue('保留草稿');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    view.rerender(content(false, false));
    await user.click(outside);
    await user.keyboard('{Escape}');
    expect(outside).toHaveFocus();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('隐藏业务页立即移除 portal 和 Escape 监听，返回后继续保留本地草稿', async () => {
    const props: SkuManagerDrawerProps = { open: true, planning: makePlanning({ skus: [makeSku()] }), assets: [], saving: false, onSave: vi.fn().mockResolvedValue(undefined), onClose: vi.fn(), onDirtyChange: vi.fn() };
    const view = render(<BusinessActivityContext value={true}><SkuManagerDrawer {...props} /></BusinessActivityContext>);
    change('SKU 1 名称', '保留草稿');
    view.rerender(<BusinessActivityContext value={false}><SkuManagerDrawer {...props} /></BusinessActivityContext>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onClose).not.toHaveBeenCalled();
    view.rerender(<BusinessActivityContext value={true}><SkuManagerDrawer {...props} /></BusinessActivityContext>);
    expect(screen.getByRole('textbox', { name: 'SKU 1 名称' })).toHaveValue('保留草稿');
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
  });
});
