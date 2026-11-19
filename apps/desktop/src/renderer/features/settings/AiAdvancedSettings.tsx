import { Alert, App, Button, Form, InputNumber, Select } from 'antd';
import { useCallback, useMemo, useRef, useState } from 'react';
import { DEFAULT_AI_RUNTIME_SETTINGS, type AiRuntimeSettings } from '@ecomgen/contracts';
import { useUpdateApplicationSettings } from '../../api/hooks/useApplicationSettings';
import { errorText } from '../../lib/errorText';
import { useSettingsDraft } from './settingsDraft';
import styles from './SettingsPage.module.css';

/** 推理参数用于新任务，并发设置控制后续任务认领。 */
export function AiAdvancedSettings({ settings }: { settings: AiRuntimeSettings }) {
    const update = useUpdateApplicationSettings();
    const { message } = App.useApp();
    const [form] = Form.useForm<AiRuntimeSettings>();
    const initial = useRef<AiRuntimeSettings>({ ...DEFAULT_AI_RUNTIME_SETTINGS, ...settings });
    const saved = useRef<AiRuntimeSettings>(initial.current);
    const [dirty, setDirty] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const save = useCallback(async (values: AiRuntimeSettings) => {
        setFailure(null);
        try {
            await update.mutateAsync({ ai: values });
            saved.current = { ...values };
            setDirty(false);
            void message.success('高级设置已保存');
            return true;
        } catch (error) {
            setFailure(errorText(error));
            return false;
        }
    }, [message, update]);
    const draft = useMemo(() => dirty || update.isPending ? {
        save: async () => { try { return await save(await form.validateFields()); } catch { return false; } },
        discard: () => { form.setFieldsValue(saved.current); setDirty(false); setFailure(null); },
        isSaving: () => update.isPending,
    } : null, [dirty, form, save, update.isPending]);
    useSettingsDraft(draft);
    const integerRule = (min: number, max: number) => ({ type: 'integer' as const, required: true, min, max, message: `请输入 ${min} 到 ${max} 之间的整数` });
    return <>
      <p className={styles.hint}>推理参数只用于以后提交的新任务，已提交任务保持原参数。并发设置更新后影响后续任务认领。</p>
      <p className={styles.hint}>Pi SDK 随 PixelMuse 一起更新。</p>
      <Form form={form} className={styles.form} layout="vertical" initialValues={initial.current} disabled={update.isPending}
        onValuesChange={(_, values: AiRuntimeSettings) => setDirty(JSON.stringify(values) !== JSON.stringify(saved.current))}
        onFinish={values => void save(values)}>
        <Form.Item name="requestTimeoutSeconds" label="推理请求超时（秒）" rules={[integerRule(30, 1800)]}><InputNumber min={30} max={1800} precision={0}/></Form.Item>
        <Form.Item name="thinkingLevel" label="思考强度" extra="自动保留工作流默认，低、中、高只对支持思考的模型有效。" rules={[{ required: true, message: '请选择思考强度' }]}>
          <Select options={[{ value: 'auto', label: '自动' }, { value: 'off', label: '关闭' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }]}/>
        </Form.Item>
        <Form.Item name="maxOutputTokens" label="最大输出 Token" rules={[integerRule(512, 65536)]}><InputNumber min={512} max={65536} precision={0}/></Form.Item>
        <Form.Item name="concurrency" label="同时执行任务数" extra="跨项目共享，包含队列任务；降低数量不会打断正在执行的任务。" rules={[integerRule(1, 16)]}><InputNumber min={1} max={16} precision={0}/></Form.Item>
        {failure ? <Alert type="error" title="保存失败" description={failure}/> : null}
        <Button type="primary" htmlType="submit" loading={update.isPending}>保存高级设置</Button>
      </Form>
    </>;
}
