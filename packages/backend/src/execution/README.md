# Backend 领域执行层

执行入口位于 `index.ts`，处理器与本地图像算法位于本目录。它使用 Backend 唯一的 SQLite 仓库、受管存储、SecretBox、目录、事件、调度器、取消信号和逐请求账本；没有独立 worker、数据库连接、队列服务或环境配置入口。

## 接线与公开 API

`registerExecutors: RegisterExecutors` 精确实现 `../runtime/ports.ts` 的注册接口。协调者在创建 Backend 时将其注入第三个参数：

```ts
import { registerExecutors } from './execution/index.js';

createBackend(options, onChange, {
  commands: registerCommands,
  executors: registerExecutors,
});
```

命令创建 Job 和全部伴随行后，在同一同步事务内调用 `createExecutionSnapshot(context, job, resources?)`，然后 `context.scheduler.freeze(job.id, snapshot)`。事务提交后再 enqueue。草稿必须先分配全部目标槽位，流水线必须先关联当前步骤。C 的 `commands/support.ts` 已引用该快照工厂。冻结的资源应由命令层先登记，再传入 `{ref,hash}[]`。

| 导出 | 签名与职责 |
| --- | --- |
| `registerExecutors` | `(context: CommandContext) => ExecutorMap`；完整20类型映射，每项具有 snapshotSchema、execute、settle、retry。 |
| `createExecutionSnapshot` | `(context: CommandContext, job: JobRecord, resources?: FrozenJobSnapshot['resources']) => FrozenJobSnapshot`；只做同步领域读取，不做文件或网络 I/O。 |
| `executionSnapshotSchema` | TypeBox schema；验证版本、任务身份、输入、有效依赖与资源列表。 |
| `createExecutionContext` | `(runtime: ExecutionContext) => WorkerContext`；组装冻结仓库读视图、受 fencing 保护的写入、受管资源发布和真实 Agent/Provider。 |
| `executeDomainJob` | `(context: ExecutionContext, job: JobRecord = context.job) => Promise<void>`；显式 switch，未知类型抛错。 |
| `settleDomainJob` | `(context: CommandContext, job: JobRecord, status: JobTerminalStatus, runtime: JobRuntimeRecord) => void`；必须在运行时的同步终态事务内调用。 |
| `retryDomainJob` | `(context: CommandContext, job: JobRecord, runtime: JobRuntimeRecord) => JobRecord`；必须在同步事务内调用；复用同一快照和请求回执，恢复相关聚合。 |
| `generationKeyFor` | `(jobId: string, candidateIndex: number) => string`；稳定的候选/Provider幂等身份。 |
| `candidateIdFor` | `(jobId: string, index: number) => string`；从稳定键派生的 UUID 形式身份，供正式花型、草稿和自动编辑子任务使用。 |
| `JobCancelled` | 业务取消错误；最终 UNKNOWN/CANCELLED 优先级由运行时账本裁决。 |

`WorkerContext` 的类型在 `context.ts`。原处理器的显式 `execute*` 函数仍在对应 `job-*.ts` 导出，供针对性测试调用；生产通过调度器和 `executeDomainJob` 执行。

## 完整任务注册

| JobType | 实际处理器与结果 |
| --- | --- |
| PLAN | `executePlan`：规划、视觉素材短指代、模板/套图、搜索审计，原子保存分镜和规划配置快照。 |
| COPYWRITE | `executeCopywriting`；PRODUCT_DESCRIPTION / PLANNING_INSTRUCTION 保存独立文案结果；target=LISTING 分派 `executePatternListing` 保存花型平台文案，不要求项目。 |
| GENERATE | `executeGeneration`：候选序号/批次、最终提示词、可选提示词修订、真值素材、尺寸/比例/质量/格式与稳定 Output。 |
| EXPORT | `executeExport`：真实流式 ZIP、来源 manifest、可选详情长图与切片。 |
| EDIT_PLAN | `executeEditPlan`：引用、蒙版、事实和分支记忆；NEED_INPUT / AWAITING_CONFIRMATION / 自动生成三条真实分支。 |
| EDIT_GENERATE | `executeEditGeneration`：多候选、局部保护、自然融合、扩图、Output父/根/会话/回合血缘与逐输出记忆。 |
| LAYER_PLAN | `executeLayerPlan`：视觉识别元素，持久化中英文分割提示。 |
| LAYER_EXPORT | `executeLayerExport`：自动/文本/矩形SAM、Seedream分层、原图像素PNG和真实PSD。 |
| SUITE_FORGE | `executeSuiteForge`：多源图反推、过程计数、契约验证与独立套图草稿，确认入库仍由命令负责。 |
| MODEL_CAST | `executeModelCast`：冻结人物规格/参考脸、多候选定妆照与模型来源。 |
| PATTERN_EXTRACT | `executePatternExtract`：分割提取或生成式摊平提取；分割只从源像素取图。 |
| PATTERN_FORGE | `executePatternForge`：主题起稿、多候选正式花型与底版承诺校验。 |
| PATTERN_DERIVE | `executePatternDerive`：确定性改色、新花型及父血缘。 |
| PATTERN_VARIANT | `executePatternVariant`：画风/构图预设、参考源图、多候选与背景约束。 |
| PATTERN_TILE_CHECK | `executePatternTileCheck`：确定性验缝及算法版本，保持原图。 |
| PRINT_PACK | `executePrintPack`：印刷尺寸/DPI、居中/满印、全部重复排列、原生重复单元、品类示意图和manifest。 |
| PATTERN_DRAFT_GENERATE | `executeDraftGenerate`：主题、多参考用途、分辨率/质量/底版，独立草稿槽位和候选。 |
| PATTERN_DRAFT_EDIT | `executeDraftEdit`：整图/笔迹改稿和定向接缝编辑，保留父候选，REPEAT改稿后复检。 |
| PATTERN_DRAFT_CUTOUT | `executeDraftCutout`：真实SAM去底、源像素/alpha、保持原画布。 |
| PATTERN_DRAFT_PROCESS | `executeDraftProcess`：本地改色新候选，或只写逐轴验缝证据。 |

## 冻结、提交与恢复

`effective.execution` 保存任务的 Provider/模型/项目/分镜引用、完整项目事实、Provider能力与历史密文、素材及hash、用户模板、搜索源、目录文档、编辑回合/会话/祖先输出、草稿批次/父候选和相关花型。执行读取这些值；模型引用不取认领时可能已变化的 Job 外键。新任务不读取旧 Web 数据、环境变量或旧运行模块。

实时读取仅用于已存在产物、槽位归属/attempt、当前流水线步骤、取消、分支选择和发布检查。仓库变更全部进入 `ExecutionContext.checkpoint`；文件写前后检查当前代次，写入携带 signal。候选行/草稿槽位成功/验缝证据/资源登记在同一同步事务发布。SQLite事务不跨 await。

外部调用使用 F 的 `bindExternalRequests(context.external, stableKey, model)`。图片按稳定候选键，分割按元素/槽位键，Agent按工作流前缀和模型轮次分别记录。没有另一份请求账本。完整回执先于业务解码和下载持久化；重试仍使用原请求键。未知请求不会经候选重试、草稿补偿或流水线重跑绕过。已成功产物逐身份查找，不按已有数量推算下一序号。

`retryDomainJob` 只接收 FAILED/CANCELLED 的非历史任务，拒绝任何 IN_FLIGHT/UNKNOWN、旧slot attempt和已替换的流水线步骤。它通过 B 的 `RuntimeStore` 访问 Backend仓库已有的同一连接/运行表，将原运行记录恢复READY，保留快照和加密回执，并恢复编辑、草稿、分层、导出或流水线关联；不创建新连接或新账本。B 在此回调外统一递增任务attempt和runToken。

自动编辑子任务使用确定性UUID，继承原任务有效配置，只补入刚保存的编辑计划。流水线按 SOURCE→TILE_CHECK→PRINT_PACK→LISTING 推进；每次终态和下一任务/快照原子提交。SOURCE优先使用首个有产物的候选序号。非镜像满印验缝失败停在SEAM_RISK，等待原命令入口明确裁决。冻结的stepId/jobId与运行代次共同阻止迟到推进。

输出、PSD/层文件、定妆照、正式花型、草稿候选、印刷文件和ZIP在发布事务内登记ResourceRef及真实hash。聚合owner与C一致：project / pattern / draft / model；另保留job历史引用。缩略图登记自身WebP字节hash，不能冒用原图hash。

## 像素与几何护栏

局部选区外包含透明像素的隐藏RGB也逐字节保留。扩图原区域以RGBA字节回贴，不能让生成底图透入原图透明区域。编辑/保护蒙版错配直接失败，不静默缩放选区。扩图拒绝负数、非整数与超容量。接缝带对小画布和小数输入进行安全有界取整。

SAM及Seedream元素层RGB取自原图，模型alpha只作为选区；Seedream补绘底图保留原图alpha。空mask、无效矩形、重复元素身份、缺失的请求元素和不支持的矩形协议明确失败。正式生成花型归一化为PNG再登记，避免文件扩展名与实际编码不一致。背景承诺未兑现时保留已付费产物并如实报告失败/警告，不伪装透明。

## 依赖与验证

使用工作区已有 core/domain/contracts/agent/providers/ecom-skill/ecom-suite，以及 sharp、archiver、ag-psd；无需新增manifest或安装请求。原业务处理器和算法迁自原Worker源码，删除队列/进程/环境接线；第三方库继续使用各自已有来源与声明，没有复制项目许可证。

执行层测试配置位于 `../../test/execution/vitest.config.ts`，直接解析各工作区源码，避免并行开发时误用旧dist。

```text
node desktop/node_modules/vitest/vitest.mjs run --root E:/EcomGen/desktop --config E:/EcomGen/desktop/packages/backend/test/execution/vitest.config.ts
node desktop/node_modules/typescript/bin/tsc -p E:/EcomGen/desktop/packages/backend/tsconfig.json --noEmit
```

2026-11-05使用指定Node22.23.4执行：13个测试文件、106项测试全部通过。集成测试使用真实隔离SQLite、存储、调度器、请求账本和图像算法，只有上游fetch响应被替换；Pi真实解析模拟SSE，图片/SAM/Seedream真实适配器执行。覆盖全部20类任务、Listing分支、SOURCE到Listing完整流水线、安全本地重试、成功草稿槽位保留、UNKNOWN补偿屏障、旧代次拒绝及真实PSD/ZIP/印刷产物。

Backend常规noEmit曾通过；最后并行复核遇到所有权范围外正在更新的 `validation.ts` 对 `contracts.MAX_IMAGE_TRANSPORT_BYTES` 的引用暂未导出。单独检查Agent也发现 `stream.ts` 引用的 `providers.settleRecordedFetch` 尚未出现在依赖声明中，以及 `AssistantMessageEventStream` 从Pi包顶层仅以type导出却被作为构造器使用（TS1362）。这些需对应所有者完成接线/依赖构建，不能据此声称最终全工作区构建已通过。协调者应在其余角色稳定后统一构建依赖并运行整合/真实Electron/最终EXE验收。本目录测试通过不等于完整应用已验收。
