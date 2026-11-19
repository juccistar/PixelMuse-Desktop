import { App, Button, type ButtonProps } from 'antd';
import { useState } from 'react';
import { saveResource } from '../lib/resource';
import { errorText } from '../lib/errorText';
/** 资源保存保留原按钮外观，取消不显示成功，失败展示真实领域错误。 */
export function ResourceSaveButton({ resourceUrl, onSaveError, children, ...props }: ButtonProps & { resourceUrl: string; onSaveError?: (error: unknown) => void }) {
  const { message } = App.useApp(); const [saving, setSaving] = useState(false);
  return <Button {...props} loading={saving} onClick={async () => {
    setSaving(true);
    try { await saveResource(resourceUrl); } catch (error) { onSaveError?.(error); void message.error(errorText(error)); }
    finally { setSaving(false); }
  }}>{children}</Button>;
}
