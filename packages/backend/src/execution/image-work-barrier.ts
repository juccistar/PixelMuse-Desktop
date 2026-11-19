import type { EcomRepository } from '@ecomgen/core';
import type { RequestLedgerPort } from '../runtime/ports.js';
import { assertNoImageWork } from './product-image-planning.js';

/** 默认目录也能提交产品规划；启用状态不能只靠目录是否保存过判断。 */
export function isImagePlanningProject(repository: EcomRepository, projectId: string): boolean {
  return (repository.getProjectImagePlanning(projectId)?.revision ?? 0) > 0
    || repository.listJobs(projectId).some(job => job.type === 'PLAN' && Boolean(job.input.productImagePlanning))
    || repository.listStoryboardItems(projectId).some(item => Boolean(item.imagePlanning));
}

/** 新付费工作和显式恢复在最后同步写入前共用项目屏障，已有意图的查询在调用前完成。 */
export function assertProjectImageWorkAllowed(
  repository: EcomRepository,
  ledger: Pick<RequestLedgerPort, 'hasUnknown'>,
  projectId: string,
  options: { exceptJobId?: string; exceptJobIds?: readonly string[]; imagePlanning?: boolean } = {},
): void {
  if (options.imagePlanning || isImagePlanningProject(repository, projectId)) {
    assertNoImageWork(repository, ledger, projectId, { exceptJobId: options.exceptJobId, exceptJobIds: options.exceptJobIds });
  }
}
