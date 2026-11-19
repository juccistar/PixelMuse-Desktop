import { decodePublicErrorMessage, publicErrorDisplayMessage, type ApplicationInput, type ApplicationOperation, type ApplicationOutput, type CollectionInput, type CollectionOperation, type CollectionOutput, type WorkspaceInput, type WorkspaceOperation, type WorkspaceOutput } from '@ecomgen/contracts';
import { ApiError } from './errors';
function nativeError(error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    const value = error as { message?: unknown; code?: unknown } | null;
    const message = typeof value?.message === 'string' ? value.message : '原生操作失败';
    return new ApiError(decodePublicErrorMessage(message) ?? { code: typeof value?.code === 'string' ? value.code : 'UNKNOWN', message: publicErrorDisplayMessage(message) });
}
/** 应用信息、诊断与统计保存均使用固定原生白名单。 */
export async function application<K extends ApplicationOperation>(operation: K, input: ApplicationInput<K>): Promise<ApplicationOutput<K>> {
    try {
        if (typeof window.ecomgen.application !== 'function') throw new ApiError({ code: 'COMMAND_UNAVAILABLE', message: '当前桌面组件尚未更新，请重新启动 PixelMuse 后重试。' });
        return await window.ecomgen.application(operation, input);
    } catch (error) { throw nativeError(error); }
}
/** 原生功能沿用共享契约，不在渲染层复制接口或向网页直接发送请求。 */
export async function workspace<K extends WorkspaceOperation>(operation: K, input: WorkspaceInput<K>): Promise<WorkspaceOutput<K>> {
    try {
        if (typeof window.ecomgen.workspace !== 'function') throw new ApiError({ code: 'COMMAND_UNAVAILABLE', message: '当前桌面组件尚未更新，请重新启动 PixelMuse 后重试。' });
        return await window.ecomgen.workspace(operation, input);
    }
    catch (error) { throw nativeError(error); }
}
export async function collection<K extends CollectionOperation>(operation: K, input: CollectionInput<K>): Promise<CollectionOutput<K>> {
    try {
        if (typeof window.ecomgen.collection !== 'function') throw new ApiError({ code: 'COMMAND_UNAVAILABLE', message: '当前桌面组件尚未更新，请重新启动 PixelMuse 后重试。' });
        return await window.ecomgen.collection(operation, input);
    }
    catch (error) { throw nativeError(error); }
}
