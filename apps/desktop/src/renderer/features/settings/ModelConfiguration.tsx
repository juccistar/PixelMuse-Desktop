import { Alert, App, Button, Input, Modal, Select, Skeleton, Space, Tabs, Tag } from 'antd';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ApplicationSettings } from '@ecomgen/contracts';
import { invoke } from '../../api/client';
import { applicationSettingsKey, referenceKey, useApplicationSettings, useUpdateApplicationSettings } from '../../api/hooks/useApplicationSettings';
import { useDeleteProvider, useProviders, useUpdateProvider, type ProviderConfig, type ModelCapability } from '../../api/hooks/useProviders';
import { modelOptions, parseModelKey, segmentationModelOptions } from '../../lib/modelOptions';
import { errorText } from '../../lib/errorText';
import { ProviderFormView } from '../providers/ProviderFormView';
import styles from './SettingsPage.module.css';
import { SettingsDraftProvider, useSettingsLeave } from './settingsDraft';
import { AiAdvancedSettings } from './AiAdvancedSettings';
type Editor = { kind: 'create' } | { kind: 'edit'; provider: ProviderConfig };
type Row = { provider: ProviderConfig; model: ModelCapability };
const roles: Record<string, string> = { reasoning: '默认推理', image: '默认生图', segmentation: '默认分割', reasoningModel: '默认推理', imageModel: '默认生图', segmentationModel: '默认分割' };
function purpose(model: ModelCapability) { return model.segmentationProtocol ? 'segmentation' : model.imageApiKind ? 'image' : 'reasoning'; }
/** 模型为主入口，服务连接保留原有身份、密钥和高级协议。 */
export function ModelConfiguration() {
    const leave = useSettingsLeave();
    return leave ? <ModelConfigurationContent/> : <SettingsDraftProvider>{() => <ModelConfigurationContent/>}</SettingsDraftProvider>;
}
function ModelConfigurationContent() {
    const leave = useSettingsLeave();
    const providers = useProviders();
    const settings = useApplicationSettings();
    const [tab, setTab] = useState('models');
    const [search, setSearch] = useState('');
    const [kind, setKind] = useState('all');
    const [editor, setEditor] = useState<Editor | null>(null);
    const [busy, setBusy] = useState(false);
    const [checks, setChecks] = useState<Record<string, string>>({});
    const removeProvider = useDeleteProvider();
    const updateProvider = useUpdateProvider();
    const updateSettings = useUpdateApplicationSettings();
    const client = useQueryClient();
    const { modal, message } = App.useApp();
    const [failure, setFailure] = useState<string | null>(null);
    const remove = async (provider: ProviderConfig, model?: ModelCapability) => {
        setBusy(true); setFailure(null);
        try {
            const impact = await invoke('getModelConfigurationImpact', { providerId: provider.id, ...(model ? { modelId: model.id } : {}) });
            modal.confirm({ title: `移除${model ? `模型 ${model.id}` : `服务连接 ${provider.name}`}？`,
                content: <><p>关联 {impact.projectCount} 个项目、{impact.activeJobCount} 个进行中任务。</p><p>默认用途：{impact.defaultRoles.map(role => roles[role] ?? role).join('、') || '无'}。失效默认将清除，项目需重新选择；已提交任务继续使用冻结配置。</p></>,
                okText: '移除', cancelText: '取消', okButtonProps: { danger: true },
                onOk: async () => {
                    try {
                        if (model) await updateProvider.mutateAsync({ providerId: provider.id, body: { models: provider.models.filter(item => item.id !== model.id) } });
                        else await removeProvider.mutateAsync(provider.id);
                        await client.invalidateQueries({ queryKey: applicationSettingsKey });
                        void message.success('已移除');
                    } catch (error) { setFailure(errorText(error)); throw error; }
                },
            });
        } catch (error) { setFailure(errorText(error)); }
        finally { setBusy(false); }
    };
    if (providers.isPending || settings.isPending) return <Skeleton active/>;
    if (providers.isError || settings.isError) return <Alert type="error" title="模型配置读取失败" description={errorText(providers.error ?? settings.error)} action={<Button onClick={() => { void providers.refetch(); void settings.refetch(); }}>重试</Button>}/>;
    const items = providers.data.items;
    const allRows: Row[] = items.flatMap(provider => provider.models.map(model => ({ provider, model })));
    const rows = allRows.filter(({ provider, model }) => (kind === 'all' || purpose(model) === kind) && `${provider.name} ${model.id}`.toLowerCase().includes(search.toLowerCase()));
    const defaultRoles = ({ provider, model }: Row) => Object.entries(settings.data.defaults).filter(([key, value]) => key.endsWith('Model') && typeof value === 'object' && value && 'providerId' in value && value.providerId === provider.id && value.modelId === model.id).map(([key]) => roles[key]);
    const setDefault = async (row: Row) => {
        const role = `${purpose(row.model)}Model` as 'reasoningModel' | 'imageModel' | 'segmentationModel';
        const reference = { providerId: row.provider.id, modelId: row.model.id, ...(row.model.segmentationProtocol ? { protocol: row.model.segmentationProtocol } : {}) };
        try { await updateSettings.mutateAsync({ defaults: { ...settings.data.defaults, [role]: reference } }); void message.success('默认用途已保存'); }
        catch (error) { setFailure(errorText(error)); }
    };
    return <><h2>模型配置</h2><p className={styles.hint}>按用途管理模型，通过服务连接维护地址与密钥。保存配置不会发起生成请求。</p>
      {failure ? <Alert type="error" title="操作未完成" description={failure} closable onClose={() => setFailure(null)}/> : null}
      <Tabs activeKey={tab} onChange={key => { if (key !== tab) void (leave?.() ?? Promise.resolve(true)).then(ok => { if (ok) setTab(key); }); }} items={[
        { key: 'models', label: '模型列表', children: <>
          <div className={styles.actions}><Input aria-label="搜索模型" placeholder="搜索模型 ID 或服务连接" value={search} onChange={event => setSearch(event.target.value)}/><Select aria-label="筛选模型用途" value={kind} onChange={setKind} options={[{ value: 'all', label: '全部用途' }, { value: 'reasoning', label: '推理' }, { value: 'image', label: '生图' }, { value: 'segmentation', label: '分割' }]}/><Button type="primary" onClick={() => setEditor({ kind: 'create' })}>添加模型</Button></div>
          <p className={styles.hint}>添加顺序：选择或新建服务连接 → 拉取列表或手填模型 → 确认用途与能力 → 保存。已有连接可通过“编辑”添加多个模型。</p>
          <div className={styles.scroll}><table className={styles.table}><thead><tr><th>模型 / 服务连接</th><th>用途与能力</th><th>默认用途</th><th>验证状态</th><th>操作</th></tr></thead><tbody>{rows.map(row => <tr key={`${row.provider.id}::${row.model.id}`}><td><strong>{row.model.id}</strong><small>{row.provider.name}</small></td><td><Tag>{({ reasoning: '推理', image: '生图', segmentation: '分割' })[purpose(row.model)]}</Tag>{row.model.supportsVision ? <Tag>视觉理解</Tag> : null}{row.model.supportsThinking ? <Tag>思考</Tag> : null}{row.model.supportsTools ? <Tag>工具调用</Tag> : null}{row.model.supportsStructuredOutput ? <Tag>结构化输出</Tag> : null}{row.model.imageApiKind ? <small>{row.model.imageApiKind} · 图像生成 / 编辑以模型实际支持为准</small> : null}{row.model.segmentationProtocol ? <small>{row.model.segmentationProtocol}</small> : null}</td><td>{defaultRoles(row).join('、') || '—'}</td><td>{checks[`${row.provider.id}::${row.model.id}`] ?? '未记录连接检查'}<small>能力验证、生成试跑未记录；在创作页面明确提交后才会实际调用模型。</small></td><td><Space wrap><Button size="small" onClick={() => setEditor({ kind: 'edit', provider: row.provider })}>编辑</Button><Button size="small" loading={updateSettings.isPending} onClick={() => void setDefault(row)}>设为默认</Button><Button size="small" danger disabled={busy || row.provider.models.length <= 1} title={row.provider.models.length <= 1 ? '连接至少保留一个模型；可在服务连接中移除整个连接' : undefined} onClick={() => void remove(row.provider, row.model)}>移除</Button></Space></td></tr>)}</tbody></table></div>{rows.length === 0 ? <p className={styles.empty}>{allRows.length ? '没有匹配的模型，请调整筛选。' : '尚未添加模型。添加服务连接与模型后即可开始创作。'}</p> : null}
        </> },
        { key: 'connections', label: '服务连接', children: <><div className={styles.actions}><p className={styles.hint}>一个连接关联多个模型。密钥加密保存，编辑时留空保留原值。</p><Button type="primary" onClick={() => setEditor({ kind: 'create' })}>添加服务连接</Button></div><table className={styles.table}><thead><tr><th>服务连接</th><th>协议</th><th>密钥 / 模型</th><th>操作</th></tr></thead><tbody>{items.map(provider => <tr key={provider.id}><td><strong>{provider.name}</strong><small>{provider.baseUrl}</small></td><td>{provider.reasoningProtocol}</td><td>{provider.hasApiKey ? '已配置，可替换' : '未配置密钥'}<small>{provider.models.length} 个模型</small></td><td><Space><Button onClick={() => setEditor({ kind: 'edit', provider })}>编辑</Button><Button danger disabled={busy} onClick={() => void remove(provider)}>移除</Button></Space></td></tr>)}</tbody></table>{items.length === 0 ? <p className={styles.empty}>还没有服务连接。</p> : null}</> },
        { key: 'defaults', label: '默认用途', children: <DefaultModels settings={settings.data} providers={items}/> },
        { key: 'advanced', label: '高级设置', children: <AiAdvancedSettings settings={settings.data.ai}/> },
      ]}/>
      <Modal open={editor !== null} title={editor?.kind === 'create' ? '添加模型与服务连接' : '编辑模型与服务连接'} width={850} footer={null} destroyOnHidden onCancel={() => setEditor(null)}>
        {editor?.kind === 'create' ? <div className={styles.actions}><span>已有服务连接？</span><Select aria-label="选择已有服务连接" placeholder="选择连接，添加模型" style={{ width: 300 }} options={items.map(provider => ({ value: provider.id, label: provider.name }))} onChange={id => { const provider = items.find(item => item.id === id); if (provider) setEditor({ kind: 'edit', provider }); }}/></div> : null}
        {editor ? <ProviderFormView key={editor.kind === 'edit' ? editor.provider.id : 'new'} view={editor} onConnectionCheck={(modelId, result) => { if (editor.kind === 'edit') setChecks(current => ({ ...current, [`${editor.provider.id}::${modelId}`]: result.ok ? `连接可达 · ${result.latencyMs}ms${result.modelAvailable === false ? '，服务列表未返回该模型' : ''}（本次会话）` : `连接检查失败：${result.message ?? '未完成'}（本次会话）` })); }} onDone={provider => { if (provider) setChecks(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${provider.id}::`)))); setEditor(null); }}/>: null}
      </Modal>
    </>;
}
function DefaultModels({ settings, providers }: { settings: ApplicationSettings; providers: ProviderConfig[] }) {
    const update = useUpdateApplicationSettings();
    const { message } = App.useApp();
    const [failure, setFailure] = useState<string | null>(null);
    const change = async (role: 'reasoningModel' | 'imageModel' | 'segmentationModel', key: string | undefined) => {
        const ref = key ? parseModelKey(key) : null;
        const segmentation = segmentationModelOptions(providers).find(item => item.value === key);
        try {
            await update.mutateAsync({ defaults: { ...settings.defaults, [role]: role === 'segmentationModel' ? ref && segmentation ? { ...ref, protocol: segmentation.protocol } : null : ref } });
            void message.success('默认用途已保存'); setFailure(null);
        } catch (error) { setFailure(errorText(error)); }
    };
    return <><p className={styles.hint}>仅填充新项目或尚未配置的工作台。已有项目保留自己的模型；已提交任务使用冻结配置。删除后失效的模型需要重新选择。</p><table className={styles.table}><thead><tr><th>默认用途</th><th>模型</th></tr></thead><tbody>{(['reasoningModel', 'imageModel', 'segmentationModel'] as const).map(role => {
        const options = role === 'segmentationModel' ? segmentationModelOptions(providers) : modelOptions(providers, role === 'reasoningModel' ? 'reasoning' : 'image');
        const current = referenceKey(settings.defaults[role]);
        return <tr key={role}><td>{roles[role]}模型</td><td><Select aria-label={`${roles[role]}模型`} style={{ width: '100%', maxWidth: 550 }} allowClear placeholder="未指定，创作时选择" disabled={update.isPending} value={current ?? undefined} options={options.map(option => ({ value: option.value, label: option.label }))} onChange={key => void change(role, key)}/>{current && !options.some(item => item.value === current) ? <Alert type="warning" title="默认模型已失效，请重新选择"/> : null}</td></tr>;
    })}</tbody></table>{failure ? <Alert type="error" title="保存失败" description={failure}/> : null}</>;
}
