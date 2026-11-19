import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adaptJob, type Job } from "../adapters/projectDetail";
import { invoke } from "../client";
import { ApiError } from "../errors";
import { qk } from "../queryKeys";
import type { PlanningJobInput } from "../serializePlanningBody";
import { serializePlanningBody } from "../serializePlanningBody";
export type PlanningJobResult = Job & {
    reused: boolean;
};
export function useCreatePlanningJob(projectId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (input: PlanningJobInput): Promise<PlanningJobResult> => {
            return invoke('createPlanningJob', { projectId, ...input });
        },
        onSuccess: (job) => {
            queryClient.setQueryData(qk.job(job.id), job);
            void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
        },
    });
}
