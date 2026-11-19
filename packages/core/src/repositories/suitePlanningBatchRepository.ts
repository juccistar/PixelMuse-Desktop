import type { SuitePlanningBlueprint } from '@ecomgen/domain';
import type { SqliteDatabase } from '../database.js';
import { json, now, parse, type Row } from './internal.js';

/** 批次仅保存组织信息，执行状态以各 job 为准。 */
export interface SuitePlanningBatchRecord {
  id: string;
  requestKey: string;
  payload: {
    suiteBlueprint: SuitePlanningBlueprint;
    userInstruction?: string;
    referenceSourceProjectId?: string;
    entries: Array<{ projectId: string; planJobId?: string; generationKey?: string; generationJobIds?: string[]; error?: string }>;
    phase: 'PLANNING' | 'GENERATION';
  };
  createdAt: string;
  updatedAt: string;
}

export class SuitePlanningBatchRepository {
  public constructor(private readonly db: SqliteDatabase) {}
  public createSuitePlanningBatch(input: Pick<SuitePlanningBatchRecord, 'id' | 'requestKey' | 'payload'>): SuitePlanningBatchRecord {
    const timestamp = now();
    this.db.prepare('INSERT INTO desktop_suite_planning_batches(id,request_key,payload_json,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(input.id, input.requestKey, json(input.payload), timestamp, timestamp);
    return this.getSuitePlanningBatch(input.id)!;
  }
  public getSuitePlanningBatch(id: string): SuitePlanningBatchRecord | undefined {
    const row = this.db.prepare('SELECT * FROM desktop_suite_planning_batches WHERE id=?').get(id) as Row | undefined;
    return row ? mapBatch(row) : undefined;
  }
  public findSuitePlanningBatchByRequestKey(key: string): SuitePlanningBatchRecord | undefined {
    const row = this.db.prepare('SELECT * FROM desktop_suite_planning_batches WHERE request_key=?').get(key) as Row | undefined;
    return row ? mapBatch(row) : undefined;
  }
  public updateSuitePlanningBatch(id: string, payload: SuitePlanningBatchRecord['payload']): SuitePlanningBatchRecord | undefined {
    this.db.prepare('UPDATE desktop_suite_planning_batches SET payload_json=?,updated_at=? WHERE id=?').run(json(payload), now(), id);
    return this.getSuitePlanningBatch(id);
  }
  public listSuitePlanningBatches(): SuitePlanningBatchRecord[] {
    return (this.db.prepare('SELECT * FROM desktop_suite_planning_batches ORDER BY created_at,id').all() as Row[]).map(mapBatch);
  }
}
function mapBatch(row: Row): SuitePlanningBatchRecord {
  return { id: String(row.id), requestKey: String(row.request_key), payload: parse<SuitePlanningBatchRecord['payload']>(row.payload_json), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
