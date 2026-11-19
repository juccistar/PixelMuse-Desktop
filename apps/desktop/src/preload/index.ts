import { contextBridge, ipcRenderer } from 'electron';
import type { ByteImport, ChangeEvent, Input, Operation, Output, PublicErrorTransport, ResourceRef, RpcResponse } from '@ecomgen/contracts';
import type { NativeDesktopApi } from '../shared/native-contracts.js';

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args) as RpcResponse;
  if (!result.ok) {
    // contextBridge 仅保留 Error.message；只投影公开字段，不能序列化整个异常。
    const transport: PublicErrorTransport = { kind: 'ecomgen.public-error', version: 1,
      error: { code: result.error.code, message: result.error.message } };
    const message = channel === 'ecomgen:invoke' ? JSON.stringify(transport) : result.error.message;
    throw Object.assign(new Error(message), { code: result.error.code });
  }
  return result.data as T;
}
// 沙箱 preload 只使用 Electron 和编译时类型；运行时白名单在 main 验证。
const api: NativeDesktopApi = {
  invoke: <K extends Operation>(operation: K, input: Input<K>) => call<Output<K>>('ecomgen:invoke', operation, input),
  pickFiles: options => call<ByteImport[]>('ecomgen:pick-files', options ?? {}),
  saveArtifact: (ref, suggestedName) => call<boolean>('ecomgen:save-artifact', ref, suggestedName),
  resourceUrl: (ref: ResourceRef) => `ecomgen-resource://${ref.kind}/${ref.id}${'index' in ref ? '/' + ref.index : ''}`,
  readClipboardText: () => call<string>('ecomgen:clipboard-read'),
  writeClipboardText: text => call<void>('ecomgen:clipboard-write', text),
  saveGeneratedFile: file => call<boolean>('ecomgen:save-generated', file),
  application: (operation, input) => call('ecomgen:application', operation, input),
  workspace: (operation, input) => call('ecomgen:workspace', operation, input),
  collection: (operation, input) => call('ecomgen:collection', operation, input),
  onChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, change: ChangeEvent) => listener(change);
    ipcRenderer.on('ecomgen:changed', handler);
    return () => ipcRenderer.removeListener('ecomgen:changed', handler);
  },
  onBackendStatus: listener => {
    const handler = (_event: Electron.IpcRendererEvent, status: 'ready' | 'disconnected') => listener(status);
    ipcRenderer.on('ecomgen:status', handler);
    return () => ipcRenderer.removeListener('ecomgen:status', handler);
  },
};
contextBridge.exposeInMainWorld('ecomgen', Object.freeze(api));
