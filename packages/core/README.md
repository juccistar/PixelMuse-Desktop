# Core 桌面领域持久化

`@ecomgen/core` 是 Backend 使用的 SQLite 仓储、受管文件存储及纯领域服务包。包入口为 `src/index.ts`，构建入口为 `dist/index.js`。所有连接、仓储和运行表必须由同一个 Backend owner 持有。本包不读取环境变量，不启动进程、定时器、网络服务或队列，也不加载旧 Web 数据库迁移链。

## 安装与构建

依赖声明已完成，可由协调者统一安装：

- `@ecomgen/domain: workspace:*`
- `@ecomgen/ecom-suite: workspace:*`
- `better-sqlite3: ^13.0.0`
- `sharp: ^0.35.3`
- 开发类型 `@types/better-sqlite3: ^7.6.13`

不使用 archiver；ZIP 生产方将内容写入 `putExportStream` 提供的流。根 manifest、锁文件、安装脚本和打包配置由协调者维护。

```sh
pnpm --filter @ecomgen/core build
pnpm --filter @ecomgen/core test
```

本阶段使用现有依赖进行了包内验证：TypeScript 构建通过；8 个测试文件、98 项测试通过。`better-sqlite3` 实际验证版本为 13.0.3，sharp 为 0.35.5；测试使用隔离临时数据库及临时文件，不调用 Provider。

## 数据库 API

```ts
export type SqliteDatabase = Database.Database;
export const DESKTOP_SCHEMA_VERSION = 3;
export function migrateDesktopDatabase(db: SqliteDatabase): void;
export function openDatabase(filename: string): SqliteDatabase;
```

`openDatabase` 为 Backend 打开一个连接，设置 WAL、外键和 busy timeout，然后同步迁移；失败会关闭连接。调用方负责最终关闭连接。`:memory:` 可用于隔离测试。传入的文件位置只能由 Backend/main 决定。

`migrateDesktopDatabase` 要求不在已有事务中，支持空库、实际发布过的桌面 v1/v2 和本包创建的 v3。迁移使用一个 `IMMEDIATE` 事务同时提交 DDL、数据转换与 `user_version=3`，失败恢复原表、原数据和外键设置。它拒绝未知版本、无版本非空库、不符合发布结构的 v1/v2、源库视图/触发器及缺表缺列的 v3；不尝试执行旧任务或导入 Web 库。

### v1/v2 转换决定

- 项目、Provider、素材、任务及分镜版本/条目保留原 ID。Provider 密文字节不重加密、不解密；模型 ID、协议、能力及素材角色进入当前字段。素材大小进入 `assets.byte_size`，对应 `AssetRecord.byteSize`。
- 商品描述、事实、禁用宣称、平台、提示词语种和模型配置进入当前 Project；额外原始配置仍完整保存在 `desktop_project_history.settings_json`，不会因缺少新字段而截掉历史内容。发布版 v2 删除 Provider 不清理配置中的引用；转换时将找不到 Provider 的推理/图片选择及对应模型清空（包括分镜条目的图片选择），不伪造 Provider 或模型。原始 settings 字符串和分镜 JSON 保持原样留在历史中。
- 原任务快照字符串同时保留在 `jobs.input_json` 与 `desktop_job_history.snapshot_json`；原指纹不重新计算。原任务行、状态、请求状态、错误、结果 JSON、显示文件名和实际文件引用保存在独立只读历史中。
- 全部旧任务设置 `preserved_history=1`、`retryable=0`。v2 在本地输入准备前先标记 `RUNNING`，在外部调用前再持久化 `IN_FLIGHT`；因此显式 `NOT_SENT` 的外部运行任务可确认为未发送，成为 `CANCELLED` 历史。外部请求未决、`IN_FLIGHT`、旧 `UNKNOWN` 或无法确认安全性的外部运行任务保持 `UNKNOWN`，即使已请求取消也不解除保护。只读历史的 `request_state` 保留原值，不随迁移后的任务状态改写；v1 没有该字段，保留保守判定。它们都不能作为 v3 工作项执行。数据库触发器阻止通用重试、移除历史标记及改写历史输入/指纹。
- 不制造 Output、Pattern 或其它新产物来冒充旧结果。v2 结果原本落在 Asset 中，因此保留这些 Asset 和原结果 JSON，供 Backend 生成历史只读投影。
- `storyboard_versions` 保留所有旧版分镜的原始 JSON 和原始版本 ID；当前 `storyboards` 指向最新版本，所有旧 item 行仍保留。新规划通过 `saveStoryboard` 追加 v3 版本，确认仅更新该 v3 版本，不改写 v1/v2 原文。
- v2 的 `assets/<assetId>.*`、`exports/<jobId>.zip`、`exports/<jobId>.psd` 等平铺文件引用保持有效；迁移不移动或复制任何素材。路径必须为安全相对引用，不接收绝对路径、替代流或穿越片段。
- `desktop_provider_history` 保留旧 Provider 行以便解释模型转换；其中包含密文。这些内部历史不能直接作为公开 DTO。

历史表：`desktop_job_history`、`desktop_project_history`、`desktop_provider_history`、`storyboard_versions`。`desktop_schema` 保存 v3 身份标记。它们和领域表、下面三个运行表在同一个 schema-v3 事务内创建。

### Runtime 共享表：固定名称和字段

```sql
CREATE TABLE desktop_job_runtime (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE desktop_resources (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE desktop_cleanup_queue (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

B/runtime 在同一连接上读写这些表，并定义、版本化和 TypeBox 校验 payload。本包不猜测 payload 字段，也不创建第二份队列。不可变 `snapshot`、`preservedHistory` 与 mutable 请求/结算状态必须由 runtime 分开维护；更新请求账本不能覆盖原始输入。

## 仓储 API

```ts
new EcomRepository(db: SqliteDatabase)
repository.transaction<T>(work: () => T): T
repository.getPreservedJobHistory(jobId: string): PreservedDesktopJobHistory | undefined
repository.getPreservedProjectHistory(projectId: string): {
  sourceVersion: number; projectJson: string; settingsJson: string | null
} | undefined
repository.listStoryboardVersions(projectId: string): StoryboardVersionRecord[]
```

保留原 `EcomRepository` 全部公开方法和 record 类型；原方法名对照检查无缺失。`repository.ts` 还导出各聚合仓储类及 record 类型。完整声明可从生成的 `dist/repository.d.ts`、`dist/repositories/*.d.ts` 查看。

| 聚合 | 门面方法族 |
| --- | --- |
| Provider、搜索 | listProviders/getProvider/saveProvider/deleteProvider；listSearchSources/getSearchSource/saveSearchSource/deleteSearchSource |
| 用户模板、套图、反推 | UserTemplate、UserSuite CRUD，save/get/commitSuiteForgeResult |
| 人物模特、定妆照 | Model CRUD、setModelReferenceFace、Portrait 创建/查询/选择/删除 |
| 花型、规格包、Listing | Pattern CRUD、来源/产物/验缝查询、PrintPack 创建/更新/查询、Listing 保存/查询 |
| 草稿 | PatternDraft revision CAS，Media、Batch、Slot、Candidate 完整原方法；引用路径与父子候选查询 |
| 流水线 | 创建/查询/更新流水线、步骤、job 反查与指纹复用 |
| 项目 | Project CRUD/归档删除、封面投影、规划配置历史 |
| 素材与库 | Asset CRUD、Library 筛选/去重/分页、内容 hash 找回原文件 |
| 分镜 | save/get/confirmStoryboard、条目查询/编辑/删除 |
| 任务与研究 | Job 创建/更新/指纹/恢复/查询、Copywriting、WebResearchAudit/Attempt |
| 输出与编辑 | Output 稳定键/候选/血缘、EditSession/Turn/Reference、分支记忆 |
| 导出与分层 | Export、LayerPlan、LayerExport 创建/更新/历史查询 |

`transaction` 只能调用同步仓储和 SQL，不得传入 async 回调。文件和网络 I/O 必须在事务外执行；得到实际文件后，runtime 在一个同步事务中提交结果行、资源发布状态和 Job/聚合终态。

`JobRecord.preservedHistory` 是只读状态字段；创建新 Job 不允许传入该字段。Job、DraftSlot、PatternPipelineStep、LayerPlan、LayerExport 支持真实 `UNKNOWN`；流水线未知请求使用 `AWAITING_INPUT` + `EXTERNAL_RESULT_UNKNOWN` 阻塞原因。B 的公开契约应使用这些实际状态，不能把它们转为可补偿 `FAILED`。

`recoverInterruptedJobs` 是基于 `EXTERNAL_REQUEST_STARTED` 标记的同步仓储恢复工具；完整 runtime 应先结合持久请求账本作恢复判定。在外部请求发出前，runtime 必须原子写请求账本并设置该标记。未决请求变为 `UNKNOWN`、`retryable=false`；草稿槽位和流水线同时进入未知/阻塞状态。已请求取消且没有外部未决窗口的任务成为 `CANCELLED`，不会清掉取消意图重新排队。数据库触发器阻止 UNKNOWN 经 Job 重试、槽位换任务或流水线清空 jobId 绕过；只有获得可靠结果后的结算可以落成功。Provider 删除同样保留已发出请求的 UNKNOWN，并使受影响项目的 planningRevision 递增。

失败槽位补偿仅允许 `FAILED`，拒绝成功/未知/已有运行意图、重复序号和不存在序号；整批赋值在一个事务中完成。新 Output 只对 generationKey 唯一冲突复用，其它数据库约束必须报错，不能返回未实际插入的记录。

## 受管文件 API

```ts
new LocalAssetStore(root: string, options?: AssetStoreOptions)
```

保留原存储所有公开方法：`initialize`、`putAsset`、`putOutput`、`putExportStream`、`putEditArtifact`、`putEditReferenceAsset`、`putLayerArtifact`、`putSuiteForgeSource`、`putModelReferenceFace`、`putModelPortrait`、`putPatternArtifact`、`putPatternSource`、`putDraftMedia`、`putDraftCandidate`、`putPrintPackArtifact`、`thumbnailPath`、`putThumbnail`、`hasThumbnail`、`read`、`stream`、`size`、`exists`、`delete`、`deleteProject`、`deleteModel`、`deletePattern`、`deletePrintPack`、`deleteDraft`、`absolute`。

新增 `inspectImage(content, signal?)` 返回实际 `width/height/format/hasAlpha`。上传和 Provider 结果入口应调用它检查图片解码与像素限制；存储不会仅因扩展名伪造图片尺寸或修改源像素。

缓冲写方法末尾新增可选 `{ signal?: AbortSignal }`，保持原参数顺序。`putOutput` 的新增参数在 `idempotencyKey` 后；其它有 extension 的方法在 extension 后。`read(path,{ signal?,maxBytes? })`、`stream(path,{ signal? })` 支持取消；`putExportStream(projectId,produce,{ signal?,idempotencyKey?,maxBytes? })` 支持有界流式导出。

默认上限：图片 64 MiB、解码 100,000,000 像素、缓冲读写 256 MiB、流式导出 2 GiB；可由 Backend 显式调整，非法限制会报错。调用方不能通过单次 read/export 参数绕过实例上限。

所有路径必须在受管根内；根及父目录、文件、递归删除子树都检查实际路径，拒绝 symbolic link/junction、硬链接、设备名称、替代流与穿越。写入使用随机独占临时文件、同步磁盘后原子发布；失败/取消清理临时文件。草稿候选使用不可变发布：同路径相同内容复用，不同内容报冲突。`putOutput` 保持原幂等路径覆盖孤儿文件语义，runtime 必须先按 generationKey 查已提交结果，不能用它覆盖已有产物。

`deleteProject` 只删除项目命名空间目录，不能按项目 ID 猜出 v2 平铺文件。删除聚合前，runtime 必须把该聚合实际文件引用登记到持久清理意图；确认不存在执行/历史引用后再按显式引用调用 `delete`。不能扫描整个 assets/exports 目录按猜测删文件。`absolute` 和所有历史路径只供 Backend/main 使用，不得暴露给 renderer。

## 密文与纯服务

```ts
new SecretBox(key: Buffer) // 恰好 32 字节；只接收 main 解封后的主密钥
box.encrypt(plainText: string): string
box.decrypt(cipherText: string): string
```

加密固定为 AES-256-GCM；Base64 内容为 `12-byte IV || 16-byte tag || ciphertext`，兼容桌面 v2。构造器复制密钥；每次加密使用独立随机 IV。格式错误、截断、标签/密文篡改或错误主密钥均失败。

纯服务导出：`normalize`、`requestFingerprint`、`SuiteCatalog`、`SUITE_PAGE_SIZE_DEFAULT/MAX`、目录查询/分页类型，及 `pipelineStepPlan`、`createPipelineStepJob`、`nextPipelineStep`、`startPipelineStep`、`settlePipelineStep`、`resetPipelineStepsFrom`。流水线创建/衔接在同步仓储事务中完成，完成持久化后由调用方唤醒 scheduler；重复创建现有步骤意图会报错，UNKNOWN 或活动步骤不能直接 reset。

## 验证范围

`database.test.ts` 验证真实 v1/v2→v3、原密文/快照/指纹/配置/分镜/结果/平铺文件保留、重开幂等、事务中途失败与修复后重迁、未知/伪装结构拒绝、三个运行表和任务原子提交/回滚。每个正常迁移还检查 SQLite integrity 和 foreign keys。

`unknown-intent.test.ts` 验证 UNKNOWN 优先级、取消恢复、草稿/流水线重试屏障、Provider 删除与步骤创建故障回滚。`files-boundaries.test.ts` 验证 junction/硬链接/路径/字节和像素限制、不可变候选、流失败/超限/取消清理、平铺文件按引用删除。`secrets.test.ts` 验证实际 v2 密文格式及 GCM 完整性。原仓储、草稿、存储和套图目录行为测试均保留并按桌面边界调整。
