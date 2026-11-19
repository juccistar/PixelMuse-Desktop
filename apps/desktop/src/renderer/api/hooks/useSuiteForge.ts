import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, fileInput } from "../client";
import { qk } from "../queryKeys";
import type * as Contract from "@ecomgen/contracts";
import type { Static } from "@sinclair/typebox";
export type SuiteForgeJob = Static<typeof Contract.JobSchema>;
export type SuiteForgeResult = Static<typeof Contract.SuiteForgeResult>;
export type SuiteForgeJobSummary = Static<typeof Contract.SuiteForgeJobSummary>;
/** commit 请求体就是整份套图文档，与 POST /suites 保持同一形状。 */
export type CommitSuiteBody = Static<typeof Contract.EcomSuiteFile>;
export interface CreateSuiteForgeInput {
    files: File[];
    providerId: string;
    modelId: string;
    name?: string;
    l1?: string;
    l2?: string;
    leaf?: string;
    productFamily?: string;
    targetShotCount?: number;
    userInstruction?: string;
    idempotencyKey?: string;
}
/**
 * 源图与文本提示混合成 multipart：接口按文件内容 hash 计算请求指纹，
 * 重复提交同一批图会复用已有任务而非重复消耗模型额度。
 */
export function useCreateSuiteForge() {
    return useMutation({
        mutationFn: async (input: CreateSuiteForgeInput) => { if (input.files.length < 1 || input.files.length > 12) throw new Error("套图源图需要 1–12 张"); return invoke("createSuiteForgeJob", { ...input, files: await Promise.all(input.files.map(file => fileInput(file))) }); },
    });
}
/** 全局 forge 任务不绑定项目，也没有 IPC 通道；按需轮询单任务端点，终态即停。 */
export function useSuiteForgeJob(jobId: string | undefined) {
    return useQuery({
        queryKey: qk.suiteForgeJob(jobId ?? ""),
        enabled: Boolean(jobId),
        queryFn: async () => invoke("getJob", {
            ...{ jobId: jobId! }
        }),
        refetchInterval: (query) => {
            const status = query.state.data?.status;
            return status === "QUEUED" || status === "RUNNING" ? 1500 : false;
        },
    });
}
export function useSuiteForgeResult(jobId: string | undefined, enabled: boolean) {
    return useQuery({
        queryKey: qk.suiteForgeResult(jobId ?? ""),
        enabled: Boolean(jobId) && enabled,
        queryFn: async () => invoke("getSuiteForgeResult", {
            ...{ jobId: jobId! }
        }),
        staleTime: 0,
    });
}
export function useCommitSuiteForge() {
    const queryClient = useQueryClient();
    return useMutation({
        // 整份套图随请求回传：预览面板里的编辑既覆盖服务端草稿，也直接写入套图库。
        mutationFn: ({ jobId, suite }: {
            jobId: string;
            suite: CommitSuiteBody;
        }) => invoke("commitSuiteForgeResult", {
            ...{ jobId },
            ...suite
        }),
        onSuccess: (_result, { jobId }) => {
            void queryClient.invalidateQueries({ queryKey: qk.suites });
            void queryClient.invalidateQueries({ queryKey: qk.suiteForgeJobList });
            // 结果本身也变了（status 转 COMMITTED），否则刷新回本页时还会显示「待入库」。
            void queryClient.invalidateQueries({ queryKey: qk.suiteForgeResult(jobId) });
        },
    });
}
/** 最近反推列表：含运行中与失败的任务，用于刷新或跳转后回到历史反推。 */
export function useSuiteForgeJobList() {
    return useQuery({
        queryKey: qk.suiteForgeJobList,
        queryFn: async () => invoke("listSuiteForgeJobResults", {
            ...{}
        }),
    });
}
/**
 * 取消反推任务。
 *
 * 与工作台的 useCancelJob 分开：那个 hook 绑定项目并失效项目缓存，而 forge 任务不绑定项目。
 * 后端只有在任务尚未被消费时才能直接移除，运行中只置 cancelRequested，
 * 由 worker 在阶段边界收敛，因此取消后仍需保持轮询直到状态落地。
 */
export function useCancelSuiteForgeJob() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (jobId: string) => invoke("cancelJob", {
            ...{ jobId }
        }),
        onSuccess: (_result, jobId) => {
            void queryClient.invalidateQueries({ queryKey: qk.suiteForgeJob(jobId) });
            void queryClient.invalidateQueries({ queryKey: qk.suiteForgeJobList });
        },
    });
}
