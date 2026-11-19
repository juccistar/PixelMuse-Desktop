import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, fileInput } from "../client";
import { qk } from "../queryKeys";
import type * as Contract from "@ecomgen/contracts";
import type { Static } from "@sinclair/typebox";
export type EcomModel = Static<typeof Contract.EcomModel>;
export type ModelSpec = Static<typeof Contract.ModelSpec>;
export type ModelPortrait = Static<typeof Contract.ModelPortrait>;
export type CreateModelBody = Static<typeof Contract.CreateModelInput>;
export type CreateModelCastBody = Static<typeof Contract.CreateModelCastJobInput>;
export type ModelCastJob = Static<typeof Contract.JobSchema>;
/** 通过具名 IPC 查询全局模特库；任务运行期间由页面按需重查。 */
export function useModels() {
    return useQuery({
        queryKey: qk.models,
        queryFn: () => invoke("listModels", {}),
    });
}
export function useCreateModel() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: CreateModelBody) => invoke("createModel", {
            ...body
        }),
        onSuccess: async () => {
            // 首次列表还没有缓存时，invalidate 会复用旧请求；先取消它，避免创建前的快照覆盖新列表。
            await queryClient.cancelQueries({ queryKey: qk.models, exact: true });
            await queryClient.invalidateQueries({ queryKey: qk.models });
        },
    });
}
export function useDeleteModel() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (modelId: string) => invoke("deleteModel", {
            ...{ modelId }
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.models });
        },
    });
}
/** 通过受控图片字节上传参考脸；新内容替换当前身份基准。 */
export function useUploadReferenceFace() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ modelId, file }: {
            modelId: string;
            file: File;
        }) => {
            return invoke("uploadModelReferenceFace", {
                ...{ modelId },
                ...{ file: await fileInput(file) }
            });
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.models });
        },
    });
}
export function useDeleteReferenceFace() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (modelId: string) => invoke("deleteModelReferenceFace", {
            ...{ modelId }
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.models });
        },
    });
}
/**
 * 发起选角生成；后端按指纹去重，重复提交同一 spec 会复用既有任务。
 *
 * reused 来自具名命令返回的领域标记；复用已成功任务时不会产生新候选。
 * 页面据此决定是否轮询，并准确提示本次复用情况。
 */
export function useCreateModelCastJob() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ modelId, body }: {
            modelId: string;
            body: CreateModelCastBody;
        }) => {
            const result = await invoke("createModelCastJob", {
                ...{ modelId },
                ...body
            });
            return { job: result, reused: result.reused };
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.models });
        },
    });
}
/** 候选定妆照列表；生成期间由页面用 job 轮询结果驱动 refetch。 */
export function useModelPortraits(modelId: string | undefined) {
    return useQuery({
        queryKey: qk.modelPortraits(modelId ?? ""),
        enabled: Boolean(modelId),
        queryFn: () => invoke("listModelPortraits", {
            ...{ modelId: modelId! }
        }),
        staleTime: 0,
    });
}
export function useSelectModelPortrait() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (portraitId: string) => invoke("selectModelPortrait", {
            ...{ portraitId }
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.models });
        },
    });
}
export function useDeleteModelPortrait() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (portraitId: string) => invoke("deleteModelPortrait", {
            ...{ portraitId }
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.models });
        },
    });
}
