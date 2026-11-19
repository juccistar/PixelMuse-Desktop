import { createBackend, BackendError } from '@ecomgen/backend';
import type { BackendOptions, Operation, HostOperation } from '@ecomgen/contracts';

const port = process.parentPort;
if (!port) throw new Error('Backend requires an Electron utility process');
let backend: Awaited<ReturnType<typeof createBackend>> | undefined;
let initializing = false;
port.on('message', async ({ data }: { data: { type: string; id?: string; options?: BackendOptions; operation?: string; input?: unknown } }) => {
  if (data.type === 'init') {
    if (backend || initializing || !data.options) return;
    initializing = true;
    try {
      backend = await createBackend(data.options, event => port.postMessage({ type: 'changed', event }));
      port.postMessage({ type: 'ready' });
    } catch {
      port.postMessage({ type: 'fatal', message: '本地数据初始化失败，请检查数据目录权限和日志。' });
    }
    return;
  }
  if (data.type === 'shutdown') {
    try {
      if (!backend) throw new Error('Backend unavailable');
      await backend.close();
      port.postMessage({ type: 'closed' });
      process.exit(0);
    } catch {
      port.postMessage({ type: 'close-failed' });
      process.exit(1);
    }
    return;
  }
  if (!data.id) return;
  if (!backend) {
    port.postMessage({ type: 'response', id: data.id, ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: '本地后台尚未就绪' } });
    return;
  }
  try {
    const result = data.type === 'host'
      ? await backend.invokeHost(data.operation as HostOperation, data.input as never)
      : await backend.invoke(data.operation as Operation, data.input as never);
    port.postMessage({ type: 'response', id: data.id, ok: true, data: result });
  } catch (error) {
    port.postMessage({ type: 'response', id: data.id, ok: false, error: error instanceof BackendError
      ? { code: error.code, message: error.message }
      : { code: 'INTERNAL_ERROR', message: '本地操作失败，请重试或查看诊断日志。' } });
  }
});
