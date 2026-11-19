import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, fileInput } from "../client";
import { qk } from "../queryKeys";
import type * as Contract from "@ecomgen/contracts";
import type { Static } from "@sinclair/typebox";
export type SearchSourceConfig = Static<typeof Contract.SearchSourceConfigSchema>;
export type SearchSourceInput = Static<typeof Contract.CreateSearchSourceInput>;
export function useSearchSources() {
    return useQuery({ queryKey: qk.searchSources, queryFn: () => invoke("listSearchSources", {}) });
}
export function useCreateSearchSource() {
    const queryClient = useQueryClient();
    return useMutation({ mutationFn: (body: SearchSourceInput) => invoke("createSearchSource", {
            ...body
        }), onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.searchSources }) });
}
export function useUpdateSearchSource() {
    const queryClient = useQueryClient();
    return useMutation({ mutationFn: ({ sourceId, body }: {
            sourceId: string;
            body: Partial<SearchSourceInput>;
        }) => invoke("updateSearchSource", {
            ...{ sourceId },
            ...body
        }), onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.searchSources }) });
}
export function useDeleteSearchSource() {
    const queryClient = useQueryClient();
    return useMutation({ mutationFn: async (sourceId: string) => { await invoke("deleteSearchSource", {
            ...{ sourceId }
        }); }, onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.searchSources }) });
}
