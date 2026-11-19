import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adaptStoryboard, adaptStoryboardBundle, adaptStoryboardItem, type StoryboardItem, } from "../adapters/projectDetail";
import { invoke, fileInput } from "../client";
import { ApiError } from "../errors";
import { qk } from "../queryKeys";
import type * as Contract from "@ecomgen/contracts";
import type { Static } from "@sinclair/typebox";
export type UpdateStoryboardItemInput = Static<typeof Contract.UpdateStoryboardItemInput>;
export function useStoryboard(projectId: string | undefined) {
    return useQuery({
        queryKey: qk.storyboard(projectId ?? ""),
        enabled: Boolean(projectId),
        queryFn: async () => {
            const raw = await invoke("getStoryboard", {
                ...{ projectId: projectId! }
            });
            return adaptStoryboardBundle(raw);
        },
    });
}
export function useUpdateStoryboardItem(projectId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ itemId, body }: {
            itemId: string;
            body: UpdateStoryboardItemInput;
        }) => {
            const raw = await invoke("updateStoryboardItem", {
                ...{ itemId },
                ...body
            });
            const item = adaptStoryboardItem(raw);
            if (!item) {
                throw new ApiError({ code: "UNKNOWN", message: "分镜更新响应无法解析" });
            }
            return item;
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.storyboard(projectId) });
            void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
        },
    });
}
export function useDeleteStoryboardItem(projectId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (itemId: string) => {
            await invoke("deleteStoryboardItem", {
                ...{ itemId }
            });
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.storyboard(projectId) });
            void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
        },
    });
}
export function useConfirmStoryboard(projectId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (version: number) => {
            const raw = await invoke("confirmStoryboard", {
                ...{ projectId },
                ...{ version }
            });
            const storyboard = adaptStoryboard(raw);
            if (!storyboard) {
                throw new ApiError({ code: "UNKNOWN", message: "确认分镜响应无法解析" });
            }
            return storyboard;
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.storyboard(projectId) });
            void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
        },
    });
}
export function selectedStoryboardItem(items: StoryboardItem[], itemId: string | null): StoryboardItem | undefined {
    if (!itemId)
        return items[0];
    return items.find((item) => item.id === itemId) ?? items[0];
}
