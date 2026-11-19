import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, fileInput } from "../client";
import { qk } from "../queryKeys";
import type * as Contract from '@ecomgen/contracts';
import type { Static } from '@sinclair/typebox';
export type ProviderConfig = Static<typeof Contract.ProviderConfigSchema>;
export type ModelCapability = ProviderConfig['models'][number];
export type CreateProviderInput = Static<typeof Contract.CreateProviderInput>;
export type UpdateProviderInput = Static<typeof Contract.UpdateProviderInput>;
export type DiscoverProviderModelsInput = Static<typeof Contract.DiscoverProviderModelsInput>;
export type DiscoverProviderModelsResult = Contract.Output<'discoverProviderModels'>;
export type TestProviderResult = Contract.Output<'testProviderConnection'>;
export interface TestProviderVariables {
    providerId: string;
    modelId: string;
    kind: "reasoning" | "image" | "segmentation";
}
export function useProviders() {
    return useQuery({
        queryKey: qk.providers,
        queryFn: () => invoke("listProviders", {}),
        staleTime: 30000,
    });
}
export function useCreateProvider() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: CreateProviderInput) => invoke("createProvider", {
            ...body
        }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.providers }),
    });
}
export function useUpdateProvider() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ providerId, body }: {
            providerId: string;
            body: UpdateProviderInput;
        }) => invoke("updateProvider", {
            ...{ providerId },
            ...body
        }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.providers }),
    });
}
export function useDeleteProvider() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (providerId: string) => {
            await invoke("deleteProvider", {
                ...{ providerId }
            });
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.providers }),
    });
}
/** 仅调 Provider 的 /models 探测连通性，不消耗生图额度（契约 testProviderConnection）。 */
export function useTestProvider() {
    return useMutation({
        mutationFn: ({ providerId, modelId, kind }: TestProviderVariables) => invoke("testProviderConnection", {
            ...{ providerId },
            ...{ modelId, kind }
        }),
    });
}
/** 保存前从 /models 拉取模型 ID 列表（契约 discoverProviderModels）；编辑态省略 apiKey 时服务端读取已存密钥。 */
export function useDiscoverProviderModels() {
    return useMutation({
        mutationFn: (body: DiscoverProviderModelsInput) => invoke("discoverProviderModels", {
            ...body
        }),
    });
}
