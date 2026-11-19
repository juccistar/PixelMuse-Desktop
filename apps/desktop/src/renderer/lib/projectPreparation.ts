import { loadImageTypes } from './imageTypes';
import { loadSuiteShots } from './suiteSelection';

/** 准备与规划共享的 UI 意图；实际规划配置以后台冻结快照为准。 */
export interface ProjectPlanningDraft {
  selectionMode: 'AI' | 'MANUAL' | 'SUITE';
  requestedTypes: string[];
  requestedSuiteShots: string[];
  instruction: string;
  styleInstruction?: string;
}
const key = (projectId: string) => `pixelmuse.projectPreparation.${projectId}`;
const memory = new Map<string, ProjectPlanningDraft>();
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
/** 读取项目独立草稿，并兼容原模板选择。 */
export function readProjectPlanningDraft(projectId: string): ProjectPlanningDraft {
  const fallback: ProjectPlanningDraft = { selectionMode: 'AI', requestedTypes: loadImageTypes(projectId), requestedSuiteShots: loadSuiteShots(projectId), instruction: '' };
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(projectId)) ?? 'null');
    if (value && typeof value === 'object' && 'selectionMode' in value && 'requestedTypes' in value && 'requestedSuiteShots' in value && 'instruction' in value &&
      ['AI', 'MANUAL', 'SUITE'].includes(String(value.selectionMode)) && strings(value.requestedTypes) && strings(value.requestedSuiteShots) && typeof value.instruction === 'string') {
      return structuredClone(value as ProjectPlanningDraft);
    }
  } catch { /* 存储不可用时保留当前会话草稿。 */ }
  return structuredClone(memory.get(projectId) ?? fallback);
}
/** 保存选择意图，不保存凭据或冒充已发布配置历史。 */
export function saveProjectPlanningDraft(projectId: string, draft: ProjectPlanningDraft): void {
  memory.set(projectId, structuredClone(draft));
  try { localStorage.setItem(key(projectId), JSON.stringify(draft)); }
  catch { /* 存储配额不足时内存仍保留本次会话。 */ }
}

export type PlanningIntent = { fingerprint: string; regenerationKey: string; instruction?: string };
// 跨阶段/项目卸载仍保留未获明确回执的付费意图；会话存储仅含摘要和随机键。
const unresolvedPlanningIntents = new Map<string, PlanningIntent>();
const planningIntentStorageKey = (projectId: string) => `pixelmuse.imagePlanningIntent.${projectId}`;
/** 读取跨阶段保留的未决规划身份，避免回执丢失后重复计费。 */
export function readPlanningIntent(projectId: string): PlanningIntent | undefined {
  const cached = unresolvedPlanningIntents.get(projectId);
  if (cached) return cached;
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(planningIntentStorageKey(projectId)) ?? 'null');
    if (value && typeof value === 'object' && 'fingerprint' in value && 'regenerationKey' in value &&
      typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint) &&
      typeof value.regenerationKey === 'string' && /^[a-f0-9-]{36}$/i.test(value.regenerationKey)) {
      return { fingerprint: value.fingerprint, regenerationKey: value.regenerationKey };
    }
  } catch { /* 会话存储不可用时，内存仍覆盖组件卸载/重挂。 */ }
  return undefined;
}
/** 提交前记录摘要与随机键，持久存储不含素材或提示词。 */
export function keepPlanningIntent(projectId: string, intent: PlanningIntent) {
  unresolvedPlanningIntents.set(projectId, intent);
  try { sessionStorage.setItem(planningIntentStorageKey(projectId), JSON.stringify({ fingerprint: intent.fingerprint, regenerationKey: intent.regenerationKey })); }
  catch { /* 存储配额或隐私模式不影响当前会话内的重放。 */ }
}
/** 仅在收到明确回执后清除对应意图。 */
export function clearPlanningIntent(projectId: string, regenerationKey: string) {
  if (readPlanningIntent(projectId)?.regenerationKey !== regenerationKey) return;
  unresolvedPlanningIntents.delete(projectId);
  try { sessionStorage.removeItem(planningIntentStorageKey(projectId)); } catch { /* 内存已清理。 */ }
}
