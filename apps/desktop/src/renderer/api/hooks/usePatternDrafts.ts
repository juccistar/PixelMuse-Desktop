import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, fileInput } from "../client";
import { qk } from "../queryKeys";
import type * as Contract from "@ecomgen/contracts";
import type { Static } from "@sinclair/typebox";
export type PatternDraft = Static<typeof Contract.PatternDraft>;
export type PatternDraftList = Static<typeof Contract.PatternDraftList>;
export type DraftConditions = Static<typeof Contract.DraftConditions>;
export type DraftMedia = Static<typeof Contract.DraftMedia>;
export type DraftMediaRole = Static<typeof Contract.DraftMediaRole>;
export type DraftBatch = Static<typeof Contract.DraftBatch>;
export type DraftSlot = Static<typeof Contract.DraftSlot>;
export type DraftCandidate = Static<typeof Contract.DraftCandidate>;
export type DraftBatchOperation = Static<typeof Contract.DraftBatchOperation>;
export type DraftComposeType = Static<typeof Contract.DraftComposeType>;
export type DraftSeamEdge = Static<typeof Contract.DraftSeamEdge>;
export type DraftRecolorParams = Static<typeof Contract.DraftRecolorParams>;
export type CreatePatternDraftBody = Static<typeof Contract.CreatePatternDraftInput>;
export type UpdatePatternDraftBody = Static<typeof Contract.UpdatePatternDraftInput>;
export type CreateDraftBatchBody = Static<typeof Contract.CreateDraftBatchInput>;
export type FinalizeDraftCandidateBody = Static<typeof Contract.FinalizeDraftCandidateInput>;
export type FinalizeDraftCandidateResponse = Static<typeof Contract.FinalizeDraftCandidateResponse>;
export type DraftJobRef = Static<typeof Contract.DraftJobRef>;
/** 草稿列表：默认只看活跃草稿；归档草稿由页面显式请求。 */
export function usePatternDrafts(includeArchived = false) {
    return useQuery({
        queryKey: [...qk.patternDrafts, { archived: includeArchived }] as const,
        queryFn: () => invoke("listPatternDrafts", {
            ...includeArchived ? { archived: true } : {}
        }),
    });
}
export function usePatternDraft(draftId: string | undefined) {
    return useQuery({
        queryKey: qk.patternDraft(draftId ?? ""),
        enabled: Boolean(draftId),
        queryFn: () => invoke("getPatternDraft", {
            ...{ draftId: draftId! }
        }),
    });
}
export function useCreatePatternDraft() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: CreatePatternDraftBody) => invoke("createPatternDraft", {
            ...body
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.patternDrafts });
        },
    });
}
/** 自动保存。409 冲突由调用方处理：保留本地未提交内容，提示重新加载/合并。 */
export function useUpdatePatternDraft(draftId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: UpdatePatternDraftBody) => invoke("updatePatternDraft", {
            ...{ draftId },
            ...body
        }),
        onSuccess: (draft) => {
            queryClient.setQueryData(qk.patternDraft(draftId), draft);
        },
    });
}
export function useDeletePatternDraft() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (draftId: string) => invoke("deletePatternDraft", {
            ...{ draftId }
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.patternDrafts });
        },
    });
}
export function useDraftMedia(draftId: string | undefined) {
    return useQuery({
        queryKey: qk.draftMedia(draftId ?? ""),
        enabled: Boolean(draftId),
        queryFn: () => invoke("listDraftMedia", {
            ...{ draftId: draftId! }
        }),
    });
}
export function useCreateDraftMedia(draftId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (input: {
            file?: File;
            role: DraftMediaRole;
            source?: "UPLOAD" | "PATTERN";
            patternId?: string;
            notes?: string;
        }) => {
            return invoke("createDraftMedia", { draftId, ...input, file: input.file ? await fileInput(input.file) : undefined });
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.draftMedia(draftId) });
        },
    });
}
export function useUpdateDraftMedia(draftId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ mediaId, body }: {
            mediaId: string;
            body: {
                notes?: string;
            };
        }) => invoke("updateDraftMedia", {
            ...{ draftId, mediaId },
            ...body
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.draftMedia(draftId) });
        },
    });
}
export function useDeleteDraftMedia(draftId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (mediaId: string) => invoke("deleteDraftMedia", {
            ...{ draftId, mediaId }
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.draftMedia(draftId) });
        },
    });
}
/** 活跃批次按需轮询：任何槽位仍在 QUEUED/RUNNING 时刷新批次，全部终态后停止。候选由 useDraftCandidates 独立追平。 */
export function useDraftBatches(draftId: string | undefined) {
    return useQuery({
        queryKey: qk.draftBatches(draftId ?? ""),
        enabled: Boolean(draftId),
        queryFn: () => invoke("listDraftBatches", {
            ...{ draftId: draftId! }
        }),
        refetchInterval: (query) => {
            const batches = query.state.data?.items ?? [];
            return batches.some((batch) => batch.slots.some((slot) => slot.status === "QUEUED" || slot.status === "RUNNING")) ? 1500 : false;
        },
    });
}
/**
 * 候选按需轮询：以"已成功槽位数"为应到候选数，候选少于应到数时继续拉取，追平后停止。
 *
 * 不能用"还有没有 QUEUED/RUNNING 槽位"判断——最后一个槽位转终态时这个信号立刻变假，
 * 若候选恰好在最后一次轮询之后写库，轮询就此停止且永不再拉，表现为"生成成功却不回显"。
 * 以应到数是否追平为准，漏拉最多持续一个轮询周期，且不会在无待拉候选时空转。
 */
export function useDraftCandidates(draftId: string | undefined, expectedCount: number) {
    return useQuery({
        queryKey: qk.draftCandidates(draftId ?? ""),
        enabled: Boolean(draftId),
        queryFn: () => invoke("listDraftCandidates", {
            ...{ draftId: draftId! }
        }),
        refetchInterval: (query) => ((query.state.data?.items.length ?? 0) < expectedCount ? 2000 : false),
    });
}
export function useCreateDraftBatch(draftId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: CreateDraftBatchBody) => invoke("createDraftBatch", {
            ...{ draftId },
            ...body
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.draftBatches(draftId) });
            void queryClient.invalidateQueries({ queryKey: qk.draftCandidates(draftId) });
        },
    });
}
export function useCreateDraftEdit(draftId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ candidateId, body }: {
            candidateId: string;
            body: CreateDraftBatchBody;
        }) => invoke("createDraftCandidateEdit", {
            ...{ draftId, candidateId },
            ...body
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.draftBatches(draftId) });
            void queryClient.invalidateQueries({ queryKey: qk.draftCandidates(draftId) });
        },
    });
}
export function useRetryDraftBatch(draftId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (batchId: string) => invoke("retryFailedDraftBatch", {
            ...{ draftId, batchId }
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.draftBatches(draftId) });
            void queryClient.invalidateQueries({ queryKey: qk.draftCandidates(draftId) });
        },
    });
}
/** 删除单个候选：候选是探索结果，允许清理不要的那几张。 */
export function useDeleteDraftCandidate(draftId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (candidateId: string) => invoke("deleteDraftCandidate", {
            ...{ draftId, candidateId }
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.draftCandidates(draftId) });
            void queryClient.invalidateQueries({ queryKey: qk.draftBatches(draftId) });
            void queryClient.invalidateQueries({ queryKey: qk.patternDraft(draftId) });
            void queryClient.invalidateQueries({ queryKey: qk.patternDrafts });
        },
    });
}
/** 验缝：本地确定性任务，完成后候选上的判定与逐轴证据会被刷新回来。 */
export function useDraftTileCheck(draftId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (candidateId: string) => invoke("checkDraftCandidateTileability", {
            ...{ draftId, candidateId }
        }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.draftCandidates(draftId) });
        },
    });
}
/** 定稿：把选定候选复制进正式花型库；同候选重复定稿返回已有花型，不启动生产。 */
export function useFinalizeDraftCandidate(draftId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ candidateId, body }: {
            candidateId: string;
            body: FinalizeDraftCandidateBody;
        }) => {
            const result = await invoke("finalizeDraftCandidate", {
                ...{ draftId, candidateId },
                ...body
            });
            const data = await result;
            return { pattern: data.pattern, reused: data.reused };
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: qk.patterns });
            void queryClient.invalidateQueries({ queryKey: qk.patternDraft(draftId) });
        },
    });
}
