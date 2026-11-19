import { useQuery } from '@tanstack/react-query';
import { invoke } from '../client';
import { qk } from '../queryKeys';
/** 后台领域能力查询，同时验证 utilityProcess 已就绪。 */
export function useHealth() {
  return useQuery({ queryKey: qk.health, queryFn: () => invoke('getHealth', {}), refetchInterval: 30000, retry: false });
}
