import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Input } from '@ecomgen/contracts';
import { invoke } from '../client';

export function useSuitePlanningBlueprint() {
  return useMutation({ mutationFn: (suiteId: string) => invoke('getSuitePlanningBlueprint', { suiteId }) });
}
export function useSuitePlanningBatches(enabled: boolean) {
  return useQuery({ queryKey: ['suite-planning-batches'], enabled, queryFn: () => invoke('listSuitePlanningBatches', {}), refetchInterval: query => query.state.data?.items.some(batch => batch.entries.some(entry => entry.planStatus === 'QUEUED' || entry.planStatus === 'RUNNING' || (batch.phase === 'GENERATION' && entry.generationCompleted < entry.generationTotal && !entry.error))) ? 2000 : false });
}
export function useSuitePlanningBatchActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ['suite-planning-batches'] });
  const create = useMutation({ mutationFn: (input: Input<'createSuitePlanningBatch'>) => invoke('createSuitePlanningBatch', input), onSuccess: refresh });
  const generate = useMutation({ mutationFn: (batchId: string) => invoke('generateSuitePlanningBatch', { batchId }), onSuccess: refresh });
  const retry = useMutation({ mutationFn: (batchId: string) => invoke('retrySuitePlanningBatch', { batchId }), onSuccess: refresh });
  return { create, generate, retry };
}
export function useCreateStoryboardSuiteJob() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: Input<'createStoryboardSuiteJob'>) => invoke('createStoryboardSuiteJob', input), onSuccess: () => client.invalidateQueries({ queryKey: ['suite-forge-job-list'] }) });
}
