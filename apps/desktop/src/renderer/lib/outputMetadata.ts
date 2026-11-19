import type { Output } from '../api/adapters/projectDetail';
/** 仅消费脱敏的公开 revision；执行快照不得穿过 IPC。 */
export function outputRevision(output: Output): string | undefined {
  return 'revision' in output && typeof output.revision === 'string' ? output.revision : undefined;
}
