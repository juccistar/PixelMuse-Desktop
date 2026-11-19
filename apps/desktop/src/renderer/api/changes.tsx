import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChangeEvent } from '@ecomgen/contracts';
const prefixes: Record<ChangeEvent['topic'], readonly string[]> = {
  projects: ['projects'], assets: ['projects', 'library-assets'], providers: ['providers', 'projects'], searchSources: ['search-sources', 'health'],
  storyboards: ['projects'], outputs: ['projects', 'library-assets'], jobs: ['jobs', 'projects', 'suite-forge-jobs', 'suite-forge-job-list', 'suite-planning-batches', 'patterns', 'models', 'pattern-drafts'],
  editSessions: ['projects', 'edit-turns'], models: ['models', 'library-assets'], patterns: ['patterns', 'library-assets'], drafts: ['pattern-drafts'], pipelines: ['patterns'],
  catalog: ['suites', 'suite-categories', 'ecom-templates', 'user-templates'], library: ['library-assets'], resources: ['jobs', 'projects', 'models', 'patterns', 'pattern-drafts', 'library-assets'],
  settings: ['application-settings'], usage: ['usage', 'model-pricing'],
};
/** 将 IPC 推送合并为下一帧失效，避免任务进度淹没查询。 */
export function DesktopChanges() {
  const client = useQueryClient();
  useEffect(() => {
    const pending = new Set<string>(); let timer: ReturnType<typeof setTimeout> | undefined;
    const offChange = window.ecomgen.onChanged(event => {
      for (const prefix of prefixes[event.topic]) pending.add(prefix);
      timer ??= setTimeout(() => { timer = undefined; for (const prefix of pending) void client.invalidateQueries({ queryKey: [prefix] }); pending.clear(); }, 25);
    });
    const offStatus = window.ecomgen.onBackendStatus(status => { if (status === 'ready') void client.invalidateQueries(); });
    return () => { offChange(); offStatus(); clearTimeout(timer); };
  }, [client]);
  return null;
}
