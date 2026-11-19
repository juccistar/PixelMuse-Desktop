import type { SqliteDatabase } from '@ecomgen/core';
import type { CommandScope } from './support.js';

/** 手动分镜编辑推进确认版本，同时保留先前版本 JSON 和稳定 item/output ID。 */
export function advanceStoryboardRevision(context: CommandScope, projectId: string): void {
  const storyboard = context.repository.getStoryboard(projectId); if (!storyboard) return;
  const db = (context.repository as unknown as { db: SqliteDatabase }).db;
  const next = storyboard.version + 1, time = context.clock();
  const status = context.repository.listStoryboardItems(projectId).some(item => item.imagePlanning && !item.planningSuperseded) ? 'DRAFT' : storyboard.status;
  db.prepare('UPDATE storyboards SET version=?,status=?,updated_at=? WHERE project_id=? AND version=?').run(next,status,time,projectId,storyboard.version);
  // STALE 规划只追加受影响目标；其余当前项可能仍属于更早的版本。
  db.prepare('UPDATE storyboard_items SET storyboard_version=? WHERE project_id=? AND planning_superseded=0').run(next,projectId);
  const id = context.idFactory();
  const data = { ...storyboard, status, version: next, updatedAt: time, id, items: context.repository.listStoryboardItems(projectId).filter(item => !item.planningSuperseded) };
  db.prepare('INSERT INTO storyboard_versions(id,project_id,version,source_job_id,source_version,confirmed,data_json,created_at) VALUES(?,?,?,NULL,3,?,?,?)').run(id,projectId,next,status === 'CONFIRMED' ? 1 : 0,JSON.stringify(data),time);
}
