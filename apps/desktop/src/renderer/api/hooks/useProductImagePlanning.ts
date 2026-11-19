import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Input } from '@ecomgen/contracts';
import { invoke } from '../client';
import { qk } from '../queryKeys';

/** 目录来自后台；保存成功先采用原子回执，再重查关联分镜和项目状态。 */
export function useProjectImagePlanning(projectId: string) {
  return useQuery({ queryKey: qk.imagePlanning(projectId), queryFn: () => invoke('getProjectImagePlanning', { projectId }) });
}
export function useSaveProjectImagePlanning(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<Input<'saveProjectImagePlanning'>, 'projectId'>) => invoke('saveProjectImagePlanning', { projectId, ...input }),
    onSuccess: async (result) => {
      client.setQueryData(qk.imagePlanning(projectId), result.planning);
      await client.invalidateQueries({ queryKey: qk.project(projectId) });
    },
  });
}
export function useCreateProductImagePlanningJob(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<Input<'createProductImagePlanningJob'>, 'projectId'>) => invoke('createProductImagePlanningJob', { projectId, ...input }),
    onSuccess: (job) => {
      client.setQueryData(qk.job(job.id), job);
      void client.invalidateQueries({ queryKey: qk.project(projectId) });
    },
  });
}
