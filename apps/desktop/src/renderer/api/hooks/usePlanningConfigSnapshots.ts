import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, fileInput } from "../client";
import { qk } from "../queryKeys";
import type { PlanningConfigSnapshot } from "../adapters/projectDetail";
export function usePlanningConfigSnapshots(projectId: string) {
    return useQuery({
        queryKey: qk.planningSnapshots(projectId),
        queryFn: async () => (await invoke("listPlanningConfigSnapshots", {
            ...{ projectId }
        })) as unknown as PlanningConfigSnapshot[],
    });
}
export function useApplyPlanningConfigSnapshot(projectId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (snapshotId: string) => (await invoke("applyPlanningConfigSnapshot", {
            ...{ projectId, snapshotId }
        })) as unknown as {
            project: object;
            snapshot: PlanningConfigSnapshot;
        },
        onSuccess: (result) => {
            queryClient.setQueryData(qk.project(projectId), (current: unknown) => current ? { ...(current as object), ...result.project } : current);
            void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
            void queryClient.invalidateQueries({ queryKey: qk.planningSnapshots(projectId) });
        },
    });
}
