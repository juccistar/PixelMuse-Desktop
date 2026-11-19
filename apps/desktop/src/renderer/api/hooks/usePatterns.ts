import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, fileInput } from "../client";
import { qk } from "../queryKeys";
import type * as Contract from "@ecomgen/contracts";
import type { Static } from "@sinclair/typebox";
export type Pattern = Static<typeof Contract.Pattern>;
export type PrintPack = Static<typeof Contract.PrintPack>;
export type PodPrintSpec = Static<typeof Contract.PodPrintSpec>;
export type PodPrintSpecList = Static<typeof Contract.PodPrintSpecList>;
export type PatternListingResult = Static<typeof Contract.PatternListingResult>;
export type ListingPlatform = Static<typeof Contract.ListingPlatform>;
export type PodPrintLayout = Static<typeof Contract.PodPrintLayout>;
export type PodRepeatLayout = Static<typeof Contract.PodRepeatLayout>;
export type CreatePatternExtractBody = Static<typeof Contract.CreatePatternExtractJobInput>;
export type CreatePrintPackBody = Static<typeof Contract.CreatePrintPackJobInput>;
export type CreatePatternListingBody = Static<typeof Contract.CreatePatternListingJobInput>;
export type CreatePatternDeriveBody = Static<typeof Contract.CreatePatternDeriveJobInput>;
export type CreatePatternVariantBody = Static<typeof Contract.CreatePatternVariantJobInput>;
export type PatternBackgroundMode = Static<typeof Contract.PatternBackgroundMode>;
export type PatternVariantAxis = Static<typeof Contract.PatternVariantAxis>;
export type PatternVariantPreset = Static<typeof Contract.PatternVariantPreset>;
export type UpdatePatternBody = Static<typeof Contract.UpdatePatternInput>;
export type PatternPipeline = Static<typeof Contract.PatternPipeline>;
export type PatternPipelineStep = Static<typeof Contract.PatternPipelineStep>;
export type PatternPipelineStepName = Static<typeof Contract.PatternPipelineStepName>;
export type PatternPipelineResolution = Static<typeof Contract.PatternPipelineResolution>;
export type PatternPipelineAnswers = Static<typeof Contract.PatternPipelineAnswers>;
export type CreatePatternPipelineBody = Static<typeof Contract.CreatePatternPipelineInput>;
/** 全局花型库列表；不绑定项目，也没有 IPC 通道，页面在任务运行期间按需轮询。 */
export function usePatterns() {
    return useQuery({
        queryKey: qk.patterns,
        queryFn: () => invoke("listPatterns", {}),
    });
}
export function useDeletePattern() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (patternId: string) => invoke("deletePattern", {
            ...{ patternId }
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.patterns });
        },
    });
}
/** 印刷规格目录：静态数据，进页面缓存后不再频繁刷新。 */
export function usePodPrintSpecs() {
    return useQuery({
        queryKey: qk.podPrintSpecs,
        queryFn: () => invoke("listPodPrintSpecs", {}),
        staleTime: Number.POSITIVE_INFINITY,
    });
}
/**
 * 发起提取；后端按源图 hash 去重，重复提交复用既有任务。
 * reused 由状态码判定：200 表示复用已成功任务，202 表示新任务已入队。
 */
export function useCreatePatternExtractJob() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ body, file }: {
            body: Omit<CreatePatternExtractBody, "file">;
            file: File;
        }) => {
            const result = await invoke('createPatternExtractJob', { ...body, file: await fileInput(file) });
            return { job: result, reused: result.reused };
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.patterns });
        },
    });
}
/** 上传花型文件：跳过提取直接入库（来源 UPLOADED）；带 pipeline 时服务端顺带起链。 */
export function useUploadPattern() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ file, name, tags, pipeline }: {
            file: File;
            name?: string;
            tags?: string[];
            pipeline?: PatternPipelineAnswers;
        }) => {
            return invoke("uploadPattern", { file: await fileInput(file), name, tags: tags ? JSON.stringify(tags) : undefined, pipeline: pipeline ? JSON.stringify(pipeline) : undefined });
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.patterns });
        },
    });
}
/** 成规格包：任务与领域记录一起返回，页面轮询 printPack 状态。 */
export function useCreatePrintPackJob() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ patternId, body }: {
            patternId: string;
            body: CreatePrintPackBody;
        }) => {
            const result = await invoke("createPrintPackJob", {
                ...{ patternId },
                ...body
            });
            const data = await result;
            return { job: data.job, printPack: data.printPack, reused: result.reused };
        },
        onSuccess: (_data, variables) => {
            void queryClient.invalidateQueries({ queryKey: qk.printPacks(variables.patternId) });
            void queryClient.invalidateQueries({ queryKey: qk.patterns });
        },
    });
}
export function usePatternPrintPacks(patternId: string | undefined) {
    return useQuery({
        queryKey: qk.printPacks(patternId ?? ""),
        enabled: Boolean(patternId),
        queryFn: () => invoke("listPatternPrintPacks", {
            ...{ patternId: patternId! }
        }),
        staleTime: 0,
        refetchInterval: (query) => {
            const items = query.state.data?.items ?? [];
            return items.some((pack) => pack.status === "QUEUED" || pack.status === "RUNNING") ? 1500 : false;
        },
    });
}
/** 发起 Listing 文案；同输入复用旧结果，重新生成需换 idempotencyKey。 */
export function useCreatePatternListingJob() {
    return useMutation({
        mutationFn: async ({ patternId, body }: {
            patternId: string;
            body: CreatePatternListingBody;
        }) => {
            const result = await invoke("createPatternListingJob", {
                ...{ patternId },
                ...body
            });
            return { job: await result, reused: result.reused };
        },
    });
}
/** 花型衍生（改色）：确定性本地运算；同参数复用既有任务。 */
export function useCreatePatternDeriveJob() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ patternId, body }: {
            patternId: string;
            body: CreatePatternDeriveBody;
        }) => {
            const result = await invoke("createPatternDeriveJob", {
                ...{ patternId },
                ...body
            });
            return { job: await result, reused: result.reused };
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.patterns });
        },
    });
}
/**
 * 生成式衍生（画风 / 构图）：付费生图，源花型作参考图；同参数复用既有任务。
 * 与改色分开两个 hook，因为一个零费用一个会产生调用，UI 需要分别标注。
 */
export function useCreatePatternVariantJob() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ patternId, body }: {
            patternId: string;
            body: CreatePatternVariantBody;
        }) => {
            const result = await invoke("createPatternVariantJob", {
                ...{ patternId },
                ...body
            });
            return { job: await result, reused: result.reused };
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.patterns });
        },
    });
}
/** 发起验缝：本地确定性判定，零费用、不改动图稿；同花型同算法版本复用既有任务。 */
export function useCreatePatternTileCheckJob() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ patternId }: {
            patternId: string;
        }) => {
            const result = await invoke("createPatternTileCheckJob", {
                ...{ patternId }
            });
            return { job: await result, reused: result.reused };
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.patterns });
        },
    });
}
/** 重命名/改标签（PATCH /patterns/{patternId}），成功后失效花型列表。 */
export function useUpdatePattern() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ patternId, body }: {
            patternId: string;
            body: UpdatePatternBody;
        }) => invoke("updatePattern", {
            ...{ patternId },
            ...body
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.patterns });
        },
    });
}
/** Listing 结果查询：任务 SUCCEEDED 后才启用；结果端点在任务未成功时返回 404/409，禁用重试。 */
export function usePatternListingResult(patternId: string | undefined, jobId: string | undefined, enabled: boolean) {
    return useQuery({
        queryKey: qk.patternListingJob(patternId ?? "", jobId ?? ""),
        enabled: Boolean(patternId && jobId) && enabled,
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        queryFn: () => invoke("getPatternListingResult", {
            ...{ patternId: patternId!, jobId: jobId! }
        }),
    });
}
/** 流水线终态：不在这三个状态时轮询停止，终态即停。 */
function pipelineActive(pipeline: PatternPipeline): boolean {
    return pipeline.status === "QUEUED" || pipeline.status === "RUNNING" || pipeline.status === "AWAITING_INPUT";
}
/**
 * 花型的流水线收据列表，最新在前。
 *
 * AWAITING_INPUT 也算在途：它不是终态，用户裁决之后流水线会继续推进，所以轮询必须继续，
 * 否则裁决完成后的进度变化将永远不会出现在页面上。
 */
export function usePatternPipelines(patternId: string | undefined) {
    return useQuery({
        queryKey: qk.patternPipelines(patternId ?? ""),
        enabled: Boolean(patternId),
        staleTime: 0,
        queryFn: () => invoke("listPatternPipelines", {
            ...{ patternId: patternId! }
        }),
        refetchInterval: (query) => ((query.state.data?.items ?? []).some(pipelineActive) ? 1500 : false),
    });
}
/** 建链（三问一跑）：进行中的同参数流水线返回 200 复用，新建返回 202。 */
export function useCreatePatternPipeline(patternId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (body: CreatePatternPipelineBody) => {
            const result = await invoke("createPatternPipeline", {
                ...{ patternId },
                ...body
            });
            return { pipeline: await result, reused: result.reused };
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.patternPipelines(patternId) });
        },
    });
}
/**
 * 单步重跑。下游步骤会被一并重置（其结果基于旧输入），所以列表与相关领域记录都要重取。
 */
export function useRetryPatternPipelineStep(patternId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ pipelineId, step }: {
            pipelineId: string;
            step: PatternPipelineStepName;
        }) => invoke("retryPatternPipelineStep", {
            ...{ pipelineId, step }
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.patternPipelines(patternId) });
            void queryClient.invalidateQueries({ queryKey: qk.patterns });
        },
    });
}
/** AWAITING_INPUT 的裁决：改用居中版式继续，或明知有接缝仍出满印。 */
export function useContinuePatternPipeline(patternId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ pipelineId, resolution }: {
            pipelineId: string;
            resolution: PatternPipelineResolution;
        }) => invoke("continuePatternPipeline", {
            ...{ pipelineId },
            ...{ resolution }
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.patternPipelines(patternId) });
        },
    });
}
/** 取消流水线：先断在途任务再落状态，服务端已保证顺序。 */
export function useCancelPatternPipeline(patternId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (pipelineId: string) => invoke("cancelPatternPipeline", {
            ...{ pipelineId }
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.patternPipelines(patternId) });
            void queryClient.invalidateQueries({ queryKey: qk.printPacks(patternId) });
        },
    });
}
