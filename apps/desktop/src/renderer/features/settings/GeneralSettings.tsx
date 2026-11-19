import { Alert, App, Button, Form, Input, Select, Skeleton, Switch } from 'antd';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useSettingsDraft } from './settingsDraft';
import type { ApplicationSettings } from '@ecomgen/contracts';
import { useApplicationSettings, useUpdateApplicationSettings } from '../../api/hooks/useApplicationSettings';
import { errorText } from '../../lib/errorText';
import styles from './SettingsPage.module.css';
/** 常规偏好和新创作初始值，保存后不回写现有项目。 */
export function GeneralSettings() {
    const settings = useApplicationSettings();
    if (settings.isPending) return <Skeleton active/>;
    if (settings.isError) return <Alert type="error" title="常规设置读取失败" description={errorText(settings.error)} action={<Button onClick={() => void settings.refetch()}>重试</Button>}/>;
    return <GeneralForm key="general" settings={settings.data}/>;
}
function GeneralForm({ settings }: { settings: ApplicationSettings }) {
    const update = useUpdateApplicationSettings();
    const { message } = App.useApp();
    const [failure, setFailure] = useState<string | null>(null);
    const [dirty, setDirty] = useState(false);
    type Values = Pick<ApplicationSettings, 'startupPage' | 'interfaceScale' | 'taskNotifications'> & Omit<ApplicationSettings['defaults'], 'reasoningModel' | 'imageModel' | 'segmentationModel'>;
    const [form] = Form.useForm<Values>();
    const initial = useRef({ ...settings.defaults, startupPage: settings.startupPage, interfaceScale: settings.interfaceScale, taskNotifications: settings.taskNotifications });
    const baseline = useRef<string | null>(null);
    const savedValues = useRef<Values>(initial.current);
    const snapshot = (values: Values) => JSON.stringify([values.startupPage, values.interfaceScale, values.taskNotifications, values.promptLanguage, values.copyLanguage?.trim() || null, values.imageResolution, values.imageAspectRatio, values.candidatesPerType, values.webResearchEnabled]);
    const save = useCallback(async (values: Values): Promise<boolean> => {
        setFailure(null);
        try {
            // 获取当前模型默认值，避免打开本页后从模型页更新的引用被旧表单覆盖。
            const { startupPage, interfaceScale, taskNotifications, ...defaults } = values;
            await update.mutateAsync({ startupPage, interfaceScale, taskNotifications, defaults: { ...settings.defaults, ...defaults, copyLanguage: defaults.copyLanguage?.trim() || null } });
            baseline.current = snapshot(values); savedValues.current = { ...values }; setDirty(false);
            void message.success('常规设置已保存'); return true;
        } catch (error) { setFailure(errorText(error)); return false; }
    }, [message, settings.defaults, update]);
    const draft = useMemo(() => dirty || update.isPending ? {
        save: async () => { try { return await save(await form.validateFields()); } catch { return false; } },
        discard: () => { form.setFieldsValue(savedValues.current); setDirty(false); setFailure(null); }, isSaving: () => update.isPending,
    } : null, [dirty, form, save, update.isPending]);
    useSettingsDraft(draft);
    return <><h2>常规设置</h2><p className={styles.hint}>调整应用偏好。创作默认参数只用于新项目和未配置的工作台。</p>
      <Form form={form} disabled={update.isPending} className={styles.form} layout="vertical" initialValues={initial.current} onValuesChange={(_, values: Values) => { baseline.current ??= snapshot({ ...initial.current } as Values); setDirty(snapshot(values) !== baseline.current); }} onFinish={values => void save(values)}>
        <Form.Item name="startupPage" label="启动时打开"><Select options={[{ value: 'projects', label: '所有项目' }, { value: 'last', label: '恢复上次创作页面' }]}/></Form.Item>
        <Form.Item name="interfaceScale" label="界面缩放"><Select options={[0.8, 0.9, 1, 1.1, 1.2, 1.3].map(value => ({ value, label: `${Math.round(value * 100)}%` }))}/></Form.Item>
        <Form.Item name="taskNotifications" label="任务完成提醒" valuePropName="checked" extra="提醒当前会话任务的完成、失败和取消结果。极快完成的任务可能不弹出通知，结果仍可在任务记录查看；实际展示受系统通知设置影响。"><Switch aria-label="任务完成提醒"/></Form.Item>
        <h3>新项目创作默认参数</h3>
        <Form.Item name="promptLanguage" label="提示词语言"><Select options={[{ value: 'CHINESE', label: '中文' }, { value: 'ENGLISH', label: '英文' }]}/></Form.Item>
        <Form.Item name="copyLanguage" label="图片文案语言" extra="留空沿用项目的自动语言选择。"><Input maxLength={64} placeholder="如：中文、English"/></Form.Item>
        <Form.Item name="imageResolution" label="图片尺寸"><Select options={['1K', '2K', '4K'].map(value => ({ value, label: value }))}/></Form.Item>
        <Form.Item name="imageAspectRatio" label="图片比例"><Select options={['AUTO', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '4:5', '5:4', '21:9'].map(value => ({ value, label: value === 'AUTO' ? '自动' : value }))}/></Form.Item>
        <Form.Item name="candidatesPerType" label="每类候选数量"><Select options={[1, 2, 3, 4].map(value => ({ value, label: `${value} 张` }))}/></Form.Item>
        <Form.Item name="webResearchEnabled" label="默认启用联网研究" valuePropName="checked"><Switch aria-label="默认启用联网研究"/></Form.Item>
        {failure ? <Alert type="error" title="保存失败" description={failure}/> : null}
        <Button type="primary" htmlType="submit" loading={update.isPending}>保存常规设置</Button>
      </Form></>;
}
