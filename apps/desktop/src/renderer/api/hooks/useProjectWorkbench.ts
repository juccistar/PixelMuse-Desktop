import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Input } from '@ecomgen/contracts';
import { invoke } from '../client';

/** 后台采用与排序状态是唯一真相；下载勾选由结果工作区单独维护。 */
export function useProjectWorkbench(projectId: string) {
  return useQuery({ queryKey: ['projects', projectId, 'workbench'], queryFn: () => invoke('getProjectWorkbench', { projectId }) });
}

/** 整体保存携带 revision，冲突时重查而不覆盖其他窗口的选择。 */
export function useSaveProjectWorkbench(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<Input<'saveProjectWorkbench'>, 'projectId'>) => invoke('saveProjectWorkbench', { projectId, ...input }),
    onSuccess: value => { client.setQueryData(['projects', projectId, 'workbench'], value); },
    onError: () => { void client.invalidateQueries({ queryKey: ['projects', projectId, 'workbench'] }); },
  });
}

/** 从持久导出记录恢复已生成文件，活动导出完成后会重新查询。 */
export function useProjectExports(projectId: string) {
  return useQuery({ queryKey: ['projects', projectId, 'exports'], queryFn: () => invoke('listProjectExports', { projectId }), refetchInterval: query => query.state.data?.items.some(item => item.status === 'QUEUED' || item.status === 'RUNNING') ? 2000 : false });
}
