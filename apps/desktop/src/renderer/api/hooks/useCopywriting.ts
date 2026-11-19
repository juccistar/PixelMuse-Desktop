import { useMutation, useQuery } from "@tanstack/react-query";
import type * as Contract from "@ecomgen/contracts";
import type { Static } from "@sinclair/typebox";
import { adaptJob, type Job } from "../adapters/projectDetail";
import { invoke, fileInput } from "../client";
import { ApiError } from "../errors";
import { qk } from "../queryKeys";
export type CopywritingTarget = Static<typeof Contract.CopywritingTarget>;
export type CopywritingResult = Static<typeof Contract.CopywritingResultSchema>;
export function useCreateCopywritingJob(projectId: string) {
    return useMutation({
        mutationFn: async (body: Static<typeof Contract.CreateCopywritingJobInput>): Promise<Job> => {
            const job = adaptJob(await invoke("createCopywritingJob", {
                ...{ projectId },
                ...body
            }));
            if (!job)
                throw new ApiError({ code: "UNKNOWN", message: "AI 帮写任务响应无法解析" });
            return job;
        },
    });
}
export function useCopywritingResult(jobId: string | undefined, enabled: boolean) {
    return useQuery({
        queryKey: [...qk.job(jobId ?? ""), "copywriting-result"],
        enabled: Boolean(jobId) && enabled,
        queryFn: () => invoke("getCopywritingResult", {
            ...{ jobId: jobId! }
        }),
    });
}
