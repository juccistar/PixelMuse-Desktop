import { DEFAULT_APPLICATION_SETTINGS, applicationOperations, type ApplicationOperation, type ApplicationInput, type ApplicationOutput, operations, resourceUrlFor, collectionOperations, workspaceOperations, type CollectionOperation, type CollectionInput, type CollectionOutput, type WorkspaceOperation, type WorkspaceInput, type WorkspaceOutput, type ChangeEvent, type Input, type Operation, type Output } from '@ecomgen/contracts';
import { Value } from '@sinclair/typebox/value';
import { MAX_PRODUCT_IMAGE_TARGETS, resolveProductImageTargets, type ProjectImagePlanning } from '@ecomgen/contracts';
import { vi } from 'vitest';
import type { NativeDesktopApi } from '../../shared/native-contracts';
import { ASSET_FIXTURE, OUTPUT_FIXTURE, PLAN_JOB_FIXTURE, PROJECT_FIXTURE, PROJECT_IMAGE_PLANNING_FIXTURE, TEMPLATE_FIXTURES, USER_TEMPLATE_FIXTURE, projectDetailPayload } from './fixtures';
export const PROVIDER_FIXTURE = {
  id: PROJECT_FIXTURE.reasoningProviderId, name: 'OpenAI 官方', baseUrl: 'https://provider.invalid/v1', reasoningProtocol: 'openai', hasApiKey: true,
  models: [{ id: 'gpt-4o', supportsVision: true, supportsTools: true, supportsThinking: false, supportsStructuredOutput: true, imageApiKind: null }, { id: 'gpt-image-1', supportsVision: false, supportsTools: false, supportsThinking: false, supportsStructuredOutput: false, imageApiKind: 'openai_images' }],
  createdAt: PROJECT_FIXTURE.createdAt, updatedAt: PROJECT_FIXTURE.updatedAt,
};
/** 纯具名 IPC 假实现：直接检查真实契约，不引入 URL 路由、HTTP 请求或网络 mock。 */
export class FakeDesktop {
  private handlers = new Map<Operation, (input: never) => unknown>();
  private applicationHandlers = new Map<ApplicationOperation, (input: never) => unknown>();
  private collectionHandlers = new Map<CollectionOperation, (input: never) => unknown>();
  private workspaceHandlers = new Map<WorkspaceOperation, (input: never) => unknown>();
  private changes = new Set<(event: ChangeEvent) => void>();
  private statuses = new Set<(status: 'ready' | 'disconnected') => void>();
  api: NativeDesktopApi;
  constructor() {
    this.api = {
      invoke: vi.fn(async <K extends Operation>(name: K, input: Input<K>): Promise<Output<K>> => {
        const schema = operations[name];
        if (!Value.Check(schema.input, input)) throw Object.assign(new Error(`Invalid input ${name}: ${[...Value.Errors(schema.input, input)].map(e => e.path + ' ' + e.message).join(', ')}`), { code: 'INVALID_INPUT' });
        const handler = this.handlers.get(name);
        if (!handler) throw new Error(`Unconfigured named IPC operation: ${name}`);
        const value = await handler(input as never);
        const result = Value.Clean(schema.output, structuredClone(value));
        if (!Value.Check(schema.output, result)) throw new Error(`Invalid output ${name}: ${[...Value.Errors(schema.output, result)].map(e => e.path + ' ' + e.message).join(', ')}`);
        return result as Output<K>;
      }),
      collection: vi.fn(async <K extends CollectionOperation>(name: K, input: CollectionInput<K>): Promise<CollectionOutput<K>> => {
        const schema = collectionOperations[name];
        if (!Value.Check(schema.input, input)) throw new Error(`Invalid collection input ${name}`);
        const handler = this.collectionHandlers.get(name);
        if (!handler) throw new Error(`Unconfigured collection operation: ${name}`);
        const value = await handler(input as never);
        if (!Value.Check(schema.output, value)) throw new Error(`Invalid collection output ${name}`);
        return value as CollectionOutput<K>;
      }),
      workspace: vi.fn(async <K extends WorkspaceOperation>(name: K, input: WorkspaceInput<K>): Promise<WorkspaceOutput<K>> => {
        const schema = workspaceOperations[name];
        if (!Value.Check(schema.input, input)) throw new Error(`Invalid workspace input ${name}`);
        const handler = this.workspaceHandlers.get(name);
        if (!handler) throw new Error(`Unconfigured workspace operation: ${name}`);
        const value = await handler(input as never);
        if (!Value.Check(schema.output, value)) throw new Error(`Invalid workspace output ${name}`);
        return value as WorkspaceOutput<K>;
      }),
      application: vi.fn(async <K extends ApplicationOperation>(name: K, input: ApplicationInput<K>): Promise<ApplicationOutput<K>> => {
        const schema = applicationOperations[name];
        if (!Value.Check(schema.input, input)) throw new Error(`Invalid application input ${name}`);
        const handler = this.applicationHandlers.get(name);
        if (!handler) throw new Error(`Unconfigured application operation: ${name}`);
        const value = await handler(input as never);
        if (!Value.Check(schema.output, value)) throw new Error(`Invalid application output ${name}`);
        return value as ApplicationOutput<K>;
      }),
      pickFiles: vi.fn(async () => []), saveArtifact: vi.fn(async () => true), resourceUrl: resourceUrlFor,
      saveGeneratedFile: vi.fn(async () => true), readClipboardText: vi.fn(async () => ''), writeClipboardText: vi.fn(async () => {}),
      onChanged: listener => { this.changes.add(listener); return () => { this.changes.delete(listener); }; },
      onBackendStatus: listener => { this.statuses.add(listener); return () => { this.statuses.delete(listener); }; },
    };
    let settings = structuredClone(DEFAULT_APPLICATION_SETTINGS);
    this.on('getApplicationSettings', () => settings);
    this.on('updateApplicationSettings', input => { settings = { ...settings, ...input }; return settings; });
    this.on('getModelConfigurationImpact', () => ({ projectCount: 0, activeJobCount: 0, defaultRoles: [] }));
    this.on('listModelPricing', () => ({ items: [] }));
    this.on('listUsage', () => ({ items: [], total: 0 }));
    this.on('getUsageSummary', () => ({ requestCount: 0, completedCount: 0, failedResponseCount: 0, unknownCount: 0, inFlightCount: 0, withUsageCount: 0, inputTokens: null, outputTokens: null, cachedInputTokens: null, amounts: [], taskCount: 0, outputCount: 0, historyNote: '仅统计已可靠记录的请求，产物按当前业务记录统计。' }));
    this.onApplication('info', () => ({ name: 'PixelMuse', version: '0.4.0-test', platform: 'win32', arch: 'x64', electronVersion: '45', chromeVersion: '134', nodeVersion: '22', packaged: false, notificationsSupported: true }));
    const updateStatus = { state: 'UNSUPPORTED' as const, currentVersion: '0.4.0-test', availableVersion: null, releaseNotes: '', releaseDate: null, checkedAt: null, error: null, supported: false, unsupportedReason: '当前运行方式不支持自动更新', autoCheck: true, releaseUrl: 'https://github.com/juccistar/pixelmuse-releases/releases' as const, progress: null };
    this.onApplication('updateStatus', () => updateStatus);
    this.onApplication('checkForUpdates', () => updateStatus);
    this.onApplication('downloadUpdate', () => updateStatus);
    this.onApplication('cancelUpdateDownload', () => updateStatus);
    this.onApplication('installUpdate', () => updateStatus);
    this.onApplication('setUpdatePreferences', input => ({ ...updateStatus, autoCheck: input.autoCheck }));
    this.onApplication('openUpdateReleases', () => null);
    this.onApplication('openDirectory', () => null);
    this.onApplication('exportDiagnostics', () => ({ saved: false }));
    this.onApplication('saveUsageReport', () => ({ saved: false }));
    this.on('getHealth', () => ({ status: 'ready', version: 'test', webResearchAvailable: true, activeJobs: 0 }));
    this.on('getJobActions', () => ({ cancel: { available: false, reason: null }, retry: { available: false, reason: null }, end: { available: false, reason: null } }));
    this.on('getJobRecovery', () => ({ canRecover: false, recoveryReason: '暂不支持恢复' }));
    this.on('resolveJobInterruptions', () => ({ items: [] }));
    this.on('listProviders', () => ({ items: [PROVIDER_FIXTURE], nextCursor: null }));
    this.on('listProjects', () => ({ items: [], nextCursor: null }));
    this.onCollection('sources', () => ({ items: [] }));
    this.on('getProject', () => projectDetailPayload());
    this.on('listAssets', () => ({ items: [ASSET_FIXTURE] }));
    this.on('listSearchSources', () => ({ items: [], nextCursor: null }));
    this.on('listEcomDetailsImageTemplates', () => TEMPLATE_FIXTURES);
    this.on('listUserTemplates', () => ({ items: [USER_TEMPLATE_FIXTURE] }));
    this.on('listPlanningConfigSnapshots', () => []);
    this.on('getStoryboard', () => ({ storyboard: null, items: [] }));
    const imagePlanning = new Map<string, ProjectImagePlanning>();
    const readPlanning = (projectId: string): ProjectImagePlanning => imagePlanning.get(projectId) ?? { ...structuredClone(PROJECT_IMAGE_PLANNING_FIXTURE), projectId };
    this.on('getProjectImagePlanning', input => readPlanning(input.projectId));
    this.on('saveProjectImagePlanning', input => {
      const previous = readPlanning(input.projectId);
      if (previous.revision !== input.expectedRevision) throw Object.assign(new Error('图片目录已更新，请重新读取'), { code: 'CONFLICT' });
      const planning = { projectId: input.projectId, revision: previous.revision + 1, config: input.config, skus: input.skus, imageGroups: input.imageGroups, updatedAt: '2026-11-07T00:00:00.000Z' };
      imagePlanning.set(input.projectId, structuredClone(planning));
      return { planning, staleItemIds: [] };
    });
    this.on('createProductImagePlanningJob', input => {
      const planning = readPlanning(input.projectId);
      const targets = resolveProductImageTargets(planning);
      if (input.expectedRevision !== planning.revision) throw Object.assign(new Error('图片目录版本已变化'), { code: 'CONFLICT' });
      if ((!targets.length && input.scope !== 'STALE') || targets.length > MAX_PRODUCT_IMAGE_TARGETS) throw Object.assign(new Error('规划画面数量无效'), { code: 'INVALID_INPUT' });
      return { ...PLAN_JOB_FIXTURE, projectId: input.projectId, status: targets.length ? 'QUEUED' : 'SUCCEEDED', reused: false };
    });
    const workbenches = new Map<string, Output<'getProjectWorkbench'>>();
    const readWorkbench = (projectId: string): Output<'getProjectWorkbench'> => workbenches.get(projectId) ?? { projectId, revision: 0, adoptions: [], detailOrder: [], updatedAt: null };
    this.on('getProjectWorkbench', input => readWorkbench(input.projectId));
    this.on('saveProjectWorkbench', input => {
      const previous = readWorkbench(input.projectId);
      if (previous.revision !== input.expectedRevision) throw Object.assign(new Error('采用与顺序已更新，请重新读取'), { code: 'CONFLICT' });
      const next = { projectId: input.projectId, revision: previous.revision + 1, adoptions: input.adoptions, detailOrder: input.detailOrder, updatedAt: '2026-11-07T00:00:00.000Z' };
      workbenches.set(input.projectId, structuredClone(next));
      return next;
    });
    this.on('listProjectExports', () => ({ items: [] }));
    this.on('listModelCastHistory', () => ({ items: [], total: 0 }));
    this.on('listPatternListingHistory', () => ({ items: [], total: 0 }));
    this.on('getEditSession', input => ({ id: input.sessionId, projectId: PROJECT_FIXTURE.id, currentOutputId: OUTPUT_FIXTURE.id, status: 'ACTIVE', memorySummary: {}, turns: [], versions: [OUTPUT_FIXTURE], createdAt: PROJECT_FIXTURE.createdAt, updatedAt: PROJECT_FIXTURE.updatedAt }));
    this.on('getJob', () => PLAN_JOB_FIXTURE);
    this.on('listSuites', () => ({ items: [], nextCursor: null, total: 0, l1Counts: {}, originCounts: { builtin: 0, user: 0 } }));
    this.on('listSuiteCategories', () => ({ l1: [], l2: {} }));
    this.on('listLibraryAssets', () => ({ items: [], nextCursor: null, total: 0 }));
    this.on('listModels', () => ({ items: [], nextCursor: null }));
    this.on('listPatterns', () => ({ items: [] }));
    this.on('listPatternDrafts', () => ({ items: [] }));
    this.on('listPodPrintSpecs', () => ({ items: [] }));
    this.on('listSuiteForgeJobResults', () => ({ items: [] }));
  }
  on<K extends Operation>(name: K, handler: (input: Input<K>) => unknown): this { this.handlers.set(name, handler as (input: never) => unknown); return this; }
  onApplication<K extends ApplicationOperation>(name: K, handler: (input: ApplicationInput<K>) => unknown): this { this.applicationHandlers.set(name, handler as (input: never) => unknown); return this; }
  onCollection<K extends CollectionOperation>(name: K, handler: (input: CollectionInput<K>) => unknown): this { this.collectionHandlers.set(name, handler as (input: never) => unknown); return this; }
  onWorkspace<K extends WorkspaceOperation>(name: K, handler: (input: WorkspaceInput<K>) => unknown): this { this.workspaceHandlers.set(name, handler as (input: never) => unknown); return this; }
  emit(event: ChangeEvent): void { for (const listener of this.changes) listener(event); }
  status(status: 'ready' | 'disconnected'): void { for (const listener of this.statuses) listener(status); }
  install(): this { Object.defineProperty(window, 'ecomgen', { configurable: true, value: this.api }); return this; }
  get listenerCount(): number { return this.changes.size + this.statuses.size; }
}
