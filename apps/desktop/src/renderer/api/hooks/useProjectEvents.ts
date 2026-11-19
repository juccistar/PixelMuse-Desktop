import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ChangeEvent } from '@ecomgen/contracts';
export type EventConnection = 'idle' | 'open' | 'retrying';
/** IPC 事件只失效查询，绝不把事件内容写入业务状态。 */
export function useProjectEvents(projectId: string | undefined): EventConnection {
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<EventConnection>('idle');
  useEffect(() => {
    if (!projectId) return;
    setConnection('open');
    const changed = window.ecomgen.onChanged((event: ChangeEvent) => {
      if (event.projectId && event.projectId !== projectId) return;
      void queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
      if (event.topic === 'jobs') void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      if (event.topic === 'editSessions') void queryClient.invalidateQueries({ queryKey: ['edit-turns'] });
    });
    const status = window.ecomgen.onBackendStatus(value => {
      setConnection(value === 'ready' ? 'open' : 'retrying');
      if (value === 'ready') void queryClient.invalidateQueries();
    });
    return () => { changed(); status(); };
  }, [projectId, queryClient]);
  return connection;
}
