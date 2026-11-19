import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Input } from '@ecomgen/contracts';
import { invoke } from '../client';
export const applicationSettingsKey = ['application-settings'] as const;
/** 全局默认只提供初始值；项目和任务配置继续由各自查询决定。 */
export function useApplicationSettings() {
    return useQuery({ queryKey: applicationSettingsKey, queryFn: () => invoke('getApplicationSettings', {}), staleTime: 30_000 });
}
export function useUpdateApplicationSettings() {
    const client = useQueryClient();
    return useMutation({ mutationFn: (input: Input<'updateApplicationSettings'>) => invoke('updateApplicationSettings', input), onSuccess: settings => { client.setQueryData(applicationSettingsKey, settings); } });
}
export function referenceKey(value: { providerId: string; modelId: string } | null | undefined): string | null {
    return value ? `${value.providerId}::${value.modelId}` : null;
}
/** 失效的显式选择保留供用户重选，不静默切换其他模型。 */
export function initialModelKey(options: Array<{ value: string }>, preferred: { providerId: string; modelId: string } | null | undefined, recent?: string | null): string | null {
    const key = referenceKey(preferred);
    if (key) return options.some(option => option.value === key) ? key : null;
    return recent && options.some(option => option.value === recent) ? recent : options[0]?.value ?? null;
}
