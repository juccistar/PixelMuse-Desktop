import { Alert, App, Button, Form, Input, InputNumber, Pagination, Select, Skeleton, Tabs } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { SettingsDraftProvider, useSettingsDraft, useSettingsLeave } from './settingsDraft';
import type { Input as OperationInput, ModelPricing, UsageFilter, UsageEntry } from '@ecomgen/contracts';
import { invoke } from '../../api/client';
import { application } from '../../api/nativeClient';
import { useProviders } from '../../api/hooks/useProviders';
import { useProjects } from '../../api/hooks/useProjects';
import { errorText } from '../../lib/errorText';
import styles from './SettingsPage.module.css';
const number = (value: number | null) => value === null ? '未提供' : value.toLocaleString();
const purposes = [{ value: 'MODEL', label: '文本与视觉推理' }, { value: 'IMAGE', label: '图像生成与编辑' }, { value: 'SEGMENTATION', label: '图片分割' }, { value: 'SEARCH', label: '联网搜索' }, { value: 'POLL', label: '状态查询' }];
function purposeLabel(value: string): string { return purposes.find(item => item.value === value)?.label ?? value; }
function status(entry: UsageEntry): string {
    if (entry.state === 'UNKNOWN') return '结果未知';
    if (entry.state === 'IN_FLIGHT') return '进行中';
    if (entry.httpStatus === null) return '已完成回执（响应状态未提供）';
    return `回执已保存 · HTTP ${entry.httpStatus}`;
}
/** 请求和业务产物分别统计，费用按请求发生时的价格快照估算。 */
export function UsageSettings() {
    const leave = useSettingsLeave();
    return leave ? <UsageContent/> : <SettingsDraftProvider>{() => <UsageContent/>}</SettingsDraftProvider>;
}
function UsageContent() {
    const leave = useSettingsLeave();
    const [tab, setTab] = useState('records');
    const [filter, setFilter] = useState<UsageFilter>({});
    const [page, setPage] = useState(1);
    const [exporting, setExporting] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const providers = useProviders();
    const projects = useProjects();
    const summary = useQuery({ queryKey: ['usage', 'summary', filter], queryFn: () => invoke('getUsageSummary', filter) });
    const entries = useQuery({ queryKey: ['usage', 'entries', filter, page], queryFn: () => invoke('listUsage', { ...filter, limit: 50, offset: (page - 1) * 50 }) });
    const { message } = App.useApp();
    const change = <K extends keyof UsageFilter>(key: K, value: UsageFilter[K]) => { setPage(1); setFilter(current => { const next = { ...current }; if (value) next[key] = value; else delete next[key]; return next; }); };
    const exportCsv = async () => {
        setExporting(true); setFailure(null);
        try { const report = await invoke('exportUsage', filter); const result = await application('saveUsageReport', { name: report.name, base64: report.base64 }); void message.info(result.saved ? '用量明细已保存' : '已取消保存'); }
        catch (error) { setFailure(errorText(error)); }
        finally { setExporting(false); }
    };
    const value = summary.data;
    return <><h2>用量统计</h2><p className={styles.hint}>请求数不等于扣费次数。失败、取消的任务可能已有前序用量；缺失 Token 显示“未提供”。费用为估算，不代表实际账单或余额。</p>
      <Tabs activeKey={tab} onChange={key => { if (key !== tab) void (leave?.() ?? Promise.resolve(true)).then(ok => { if (ok) setTab(key); }); }} items={[{ key: 'records', label: '请求与业务明细', children: <>
        <div className={styles.filters}>
          <label>开始时间<Input type="datetime-local" aria-label="用量开始时间" onChange={event => change('from', event.target.value ? new Date(event.target.value).toISOString() : undefined)}/></label>
          <label>结束时间<Input type="datetime-local" aria-label="用量结束时间" onChange={event => change('to', event.target.value ? new Date(event.target.value).toISOString() : undefined)}/></label>
          <Select aria-label="筛选服务连接" allowClear placeholder="所有服务连接" value={filter.providerId} loading={providers.isPending} options={providers.data?.items.map(item => ({ value: item.id, label: item.name }))} onChange={value => { change('providerId', value); change('modelId', undefined); }}/>
          <Input aria-label="筛选模型 ID" placeholder="模型 ID（含历史模型）" value={filter.modelId ?? ''} onChange={event => change('modelId', event.target.value || undefined)}/>
          <Select aria-label="筛选项目" showSearch optionFilterProp="label" allowClear placeholder="所有项目" value={filter.projectId} options={projects.data?.items.map(item => ({ value: item.id, label: item.name }))} onChange={value => change('projectId', value)}/>
          <Select aria-label="筛选请求用途" allowClear placeholder="所有请求用途" value={filter.purpose} options={purposes} onChange={value => change('purpose', value)}/>
          <Select aria-label="筛选请求状态" allowClear placeholder="所有请求状态" value={filter.state} options={[{ value: 'COMPLETED', label: '已有回执（含失败响应）' }, { value: 'IN_FLIGHT', label: '进行中' }, { value: 'UNKNOWN', label: '结果未知' }]} onChange={value => change('state', value)}/>
          <Button loading={exporting} onClick={() => void exportCsv()}>导出 CSV 明细</Button><Button onClick={() => { void summary.refetch(); void entries.refetch(); }}>刷新</Button>
        </div>
        <details><summary>按历史记录 ID 筛选</summary><p className={styles.hint}>连接或项目删除后，仍可使用历史明细中的 ID 筛选。</p><div className={styles.filters}><Input aria-label="历史服务连接 ID" placeholder="服务连接 ID" value={filter.providerId ?? ''} onChange={event => change('providerId', event.target.value || undefined)}/><Input aria-label="历史项目 ID" placeholder="项目 ID" value={filter.projectId ?? ''} onChange={event => change('projectId', event.target.value || undefined)}/></div></details>
        {failure ? <Alert type="error" title="导出未完成" description={failure}/> : null}
        {summary.isPending ? <Skeleton active/> : summary.isError ? <Alert type="error" title="统计读取失败" description={errorText(summary.error)} action={<Button onClick={() => void summary.refetch()}>重试</Button>}/> : value ? <>
          <table className={styles.table}><caption>筛选范围内的汇总</caption><thead><tr><th>统计项</th><th>数量</th><th>统计项</th><th>数量</th></tr></thead><tbody>
            <tr><td>服务请求</td><td>{number(value.requestCount)}</td><td>有可靠用量的请求</td><td>{number(value.withUsageCount)}</td></tr>
            <tr><td>完整回执</td><td>{number(value.completedCount)}（其中失败响应 {value.failedResponseCount}）</td><td>进行中 / 结果未知</td><td>{value.inFlightCount} / {value.unknownCount}</td></tr>
            <tr><td>关联任务</td><td>{number(value.taskCount)}</td><td>项目成图（现存）</td><td>{number(value.outputCount)}</td></tr>
            <tr><td>已记录输入 / 输出 Token</td><td>{number(value.inputTokens)} / {number(value.outputTokens)}</td><td>已记录缓存输入 Token</td><td>{number(value.cachedInputTokens)}</td></tr>
          </tbody></table>
          <table className={styles.table}><caption>费用估算（按币种分别汇总）</caption><thead><tr><th>币种</th><th>估算金额</th><th>已计价请求</th></tr></thead><tbody>{value.amounts.map(amount => <tr key={amount.currency}><td>{amount.currency}</td><td>{amount.estimatedAmount.toLocaleString(undefined, { maximumFractionDigits: 8 })}</td><td>{amount.pricedRequests}</td></tr>)}</tbody></table>{value.amounts.length === 0 ? <p className={styles.hint}>暂无可估算费用。为模型配置单价后，仅对后续请求保存价格快照。</p> : null}
          <p className={styles.hint}>{value.historyNote}</p>
        </> : null}
        {entries.isError ? <Alert type="error" title="请求明细读取失败" description={errorText(entries.error)} action={<Button onClick={() => void entries.refetch()}>重试</Button>}/> : entries.isPending ? <Skeleton active/> : <>
          <div className={styles.scroll}><table className={styles.table}><caption>服务请求明细</caption><thead><tr><th>时间 / 任务</th><th>项目 / 服务连接 / 模型</th><th>用途 / 状态</th><th>输入 / 输出 / 缓存 Token</th><th>费用估算</th></tr></thead><tbody>{entries.data.items.map(entry => <tr key={entry.id}><td>{new Date(entry.startedAt).toLocaleString()}<small>任务 {entry.jobId}</small><small>请求 {entry.requestKey}</small></td><td>{entry.projectName ?? entry.projectId ?? '无项目'}<small>{entry.providerName ?? entry.providerId ?? '未记录连接'} / {entry.modelId ?? '未记录模型'}</small><details><summary>记录 ID</summary><small>项目 {entry.projectId ?? '无'}<br/>连接 {entry.providerId ?? '未提供'}</small></details></td><td>{purposeLabel(entry.purpose)}<small>{status(entry)}</small></td><td>{number(entry.inputTokens)} / {number(entry.outputTokens)} / {number(entry.cachedInputTokens)}<small>{entry.usageSource === 'PROVIDER' ? '服务返回' : '服务未提供可靠用量'}</small></td><td>{entry.estimatedAmount === null ? '未提供' : `${entry.currency} ${entry.estimatedAmount.toLocaleString(undefined, { maximumFractionDigits: 8 })}`}{entry.pricingSnapshot ? <details><summary>计价快照</summary><small>{entry.pricingSnapshot.currency} · 每百万输入 / 输出 / 缓存：{number(entry.pricingSnapshot.inputPerMillion)} / {number(entry.pricingSnapshot.outputPerMillion)} / {number(entry.pricingSnapshot.cachedInputPerMillion)}<br/>每次请求：{number(entry.pricingSnapshot.perRequest)}</small></details> : <small>未配置价格快照</small>}</td></tr>)}</tbody></table></div>
          {entries.data.items.length === 0 ? <p className={styles.empty}>当前筛选范围没有请求记录。实际任务发起模型调用后，会记录请求状态与可获得的用量。</p> : null}<Pagination current={page} pageSize={50} total={entries.data.total} showSizeChanger={false} onChange={setPage}/>
        </>}
      </> }, { key: 'pricing', label: '模型单价', children: <PricingSettings/> }]}/>
    </>;
}
function PricingSettings() {
    const providers = useProviders();
    const pricing = useQuery({ queryKey: ['model-pricing'], queryFn: () => invoke('listModelPricing', {}) });
    const client = useQueryClient();
    const update = useMutation({ mutationFn: (input: OperationInput<'setModelPricing'>) => invoke('setModelPricing', input), onSuccess: () => client.invalidateQueries({ queryKey: ['model-pricing'] }) });
    const [selected, setSelected] = useState<string | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [dirty, setDirty] = useState(false);
    const [form] = Form.useForm<Pick<ModelPricing, 'currency' | 'inputPerMillion' | 'outputPerMillion' | 'cachedInputPerMillion' | 'perRequest'>>();
    const baseline = useRef('');
    const savedValues = useRef<Pick<ModelPricing, 'currency' | 'inputPerMillion' | 'outputPerMillion' | 'cachedInputPerMillion' | 'perRequest'>>({ currency: 'USD', inputPerMillion: null, outputPerMillion: null, cachedInputPerMillion: null, perRequest: null });
    const leave = useSettingsLeave();
    const { message } = App.useApp();
    const choices = providers.data?.items.flatMap(provider => provider.models.map(model => ({ value: `${provider.id}::${model.id}`, label: `${provider.name} / ${model.id}`, providerId: provider.id, modelId: model.id }))) ?? [];
    const model = choices.find(item => item.value === selected);
    const current = pricing.data?.items.find(item => item.providerId === model?.providerId && item.modelId === model?.modelId);
    const snapshot = (values: Pick<ModelPricing, 'currency' | 'inputPerMillion' | 'outputPerMillion' | 'cachedInputPerMillion' | 'perRequest'>) => JSON.stringify([values.currency, values.inputPerMillion ?? null, values.outputPerMillion ?? null, values.cachedInputPerMillion ?? null, values.perRequest ?? null]);
    const save = useCallback(async (values: Pick<ModelPricing, 'currency' | 'inputPerMillion' | 'outputPerMillion' | 'cachedInputPerMillion' | 'perRequest'>): Promise<boolean> => {
        if (!model || update.isPending) return false;
        try { await update.mutateAsync({ providerId: model.providerId, modelId: model.modelId, currency: values.currency, inputPerMillion: values.inputPerMillion ?? null, outputPerMillion: values.outputPerMillion ?? null, cachedInputPerMillion: values.cachedInputPerMillion ?? null, perRequest: values.perRequest ?? null }); baseline.current = snapshot(values); savedValues.current = { ...values }; setDirty(false); setFailure(null); void message.success('模型单价已保存，仅影响后续请求'); return true; }
        catch (error) { setFailure(errorText(error)); return false; }
    }, [model, update, message]);
    const draft = useMemo(() => dirty || update.isPending ? { save: async () => { try { return await save(await form.validateFields()); } catch { return false; } }, discard: () => { form.setFieldsValue(savedValues.current); setDirty(false); setFailure(null); }, isSaving: () => update.isPending } : null, [dirty, form, save, update.isPending]);
    useSettingsDraft(draft);
    if (pricing.isPending || providers.isPending) return <Skeleton active/>;
    if (pricing.isError || providers.isError) return <Alert type="error" title="单价读取失败" description={errorText(pricing.error ?? providers.error)} action={<Button onClick={() => { void pricing.refetch(); void providers.refetch(); }}>重试</Button>}/>;
    return <><p className={styles.hint}>单价由你填写，用于费用估算。留空表示未提供，明确填写 0 表示免费。修改仅影响后续请求的价格快照，历史记录不重新计价。</p><Select aria-label="选择计价模型" style={{ width: '100%', maxWidth: 660 }} placeholder="选择服务连接与模型" value={selected} options={choices} onChange={value => { if (value === selected) return; void (leave?.() ?? Promise.resolve(true)).then(ok => { if (!ok) return; const next = choices.find(item => item.value === value); const prices = pricing.data.items.find(item => item.providerId === next?.providerId && item.modelId === next?.modelId) ?? { currency: 'USD' as const, inputPerMillion: null, outputPerMillion: null, cachedInputPerMillion: null, perRequest: null }; form.setFieldsValue(prices); baseline.current = snapshot(prices); savedValues.current = { ...prices }; setDirty(false); setFailure(null); setSelected(value); }); }}/>
      {model ? <Form form={form} key={selected} disabled={update.isPending} layout="vertical" className={styles.form} initialValues={current ?? { currency: 'USD', inputPerMillion: null, outputPerMillion: null, cachedInputPerMillion: null, perRequest: null }} onValuesChange={(_, values) => setDirty(snapshot(values) !== baseline.current)} onFinish={values => void save(values)}>
        <Form.Item name="currency" label="计价币种" rules={[{ required: true }]}><Select options={[{ value: 'USD', label: 'USD' }, { value: 'CNY', label: 'CNY' }]}/></Form.Item>
        {([{ name: 'inputPerMillion', label: '每百万输入 Token' }, { name: 'outputPerMillion', label: '每百万输出 Token' }, { name: 'cachedInputPerMillion', label: '每百万缓存输入 Token' }, { name: 'perRequest', label: '每次请求' }] as const).map(field => <Form.Item key={field.name} name={field.name} label={field.label}><InputNumber min={0} max={1_000_000_000} precision={8} placeholder="未提供" style={{ width: '100%' }}/></Form.Item>)}
        {failure ? <Alert type="error" title="单价保存失败" description={failure}/> : null}<Button type="primary" htmlType="submit" loading={update.isPending}>保存模型单价</Button>
      </Form> : <p className={styles.empty}>选择一个模型配置估算单价。</p>}
      <table className={styles.table}><caption>已配置单价</caption><thead><tr><th>服务连接 / 模型</th><th>币种</th><th>输入 / 输出 / 缓存（每百万 Token）</th><th>每请求</th></tr></thead><tbody>{pricing.data.items.map(item => <tr key={`${item.providerId}::${item.modelId}`}><td>{providers.data.items.find(provider => provider.id === item.providerId)?.name ?? item.providerId} / {item.modelId}</td><td>{item.currency}</td><td>{number(item.inputPerMillion)} / {number(item.outputPerMillion)} / {number(item.cachedInputPerMillion)}</td><td>{number(item.perRequest)}</td></tr>)}</tbody></table>
    </>;
}
