# Backend 领域命令

入口 `registerDomainCommands(context: CommandContext): CommandHandlers` 位于 `index.ts`。将该函数交给 `createBackend(..., { commands: registerDomainCommands, executors: registerExecutors })`。所有处理器按契约操作名注册；启动注册时逐项核对 `operations`，遗漏领域操作直接失败，没有 method/path 分派、旧 request/reply、HTTP 业务桥或未知操作兜底。

原业务包含 **127 个领域命令**，`createRuntimeCommands` 提供 `getHealth`、`getJob`、`cancelJob`、`retryJob`、`listJobs`、`getJobRequests`、`getResource` 这 **7 个运行时命令**；名单导出为 `RUNTIME_OWNED_COMMANDS`。设置中心新增应用设置、模型影响和请求用量的 **8 个命令**，目前共142项具名操作。设置由领域注册器接入，用量处理器在Backend入口共享同一数据库连接；没有新的网络业务层。旧 noop 和事件传输的退休说明仍以 `contracts/command-catalog.json` 为准，失效通知使用 `ChangeEvent`。

## 领域覆盖

| 模块 | 真实行为 |
| --- | --- |
| `projects.ts`、`lifecycle.ts` | 项目完整事实/配置、归档/恢复/永久删除、封面、素材上传/用途/删除、独立库复制、库筛选/去重/分页、规划 AI/MANUAL 分支、20 份规划配置历史及应用、独立文案任务与用户采纳。 |
| `providers.ts`、`searchSources.ts` | 多模型和互斥能力、保留未重输的加密 key、模型发现的保存值/表单覆盖、零计费连通性检查、删除 Provider 前取消并等待执行、搜索源优先级/启用/必需 key。连接测试的 reasoning 分支只读模型目录，不发送付费推理 POST。 |
| `userTemplates.ts`、`suites.ts`、`suiteForge.ts` | 内置模板、用户模板、套图筛选/分页/导入/编辑/删除/刷新/分类、完整反推源图及 hints、历史草稿、编辑后确认入库，保留目录与仓储的一致更新。 |
| `storyboard.ts`、`versioning.ts` | 版本确认 CAS、手动修改/删除推进聚合版本、稳定 item/output ID、模板及套图存在性、跨项目素材拒绝、GENERATING/GENERATED 修改限制、多候选/批次/覆盖配置/指纹复用。 |
| `outputs.ts` | 选图导出/长图意图及 Export 伴随行、自动识别方案、自动元素的方案身份/源图 hash 校验、manual bbox 和 prompt 元素、协议图层上限、持久 LayerPlan/LayerExport 与历史记录。 |
| `editSessions.ts`、`edit-turn.ts`、`lifecycle.ts` | 会话复用、编辑分支谱系与分支记忆、临时/项目参考、过期/重复/归属检查、PNG 蒙版实际尺寸、冻结 generationConfig、Turn/参考绑定/Job 同事务、规划结果审批和输出版本选择。 |
| `models.ts`、`lifecycle.ts` | 身份规格互斥校验、参考脸版本、选角意图/候选数、定妆照查询/选定/删除、模特删除前等待活动任务。 |
| `patterns.ts`、`lifecycle.ts` | 上传、SEGMENT/GENERATE 提取、起稿、改色、变体轴/预设、透明背景能力、验缝、规格包、Listing 分支、可选来源流水线和指纹复用。 |
| `patternDrafts.ts` | Draft revision CAS、Media ordinal/notes、引用编号校验、GENERATE/EDIT/SEAM_EDIT/CUTOUT/RECOLOR、Batch/Slot/Job 原子创建、clientKey 输入冲突、仅失败槽位补偿、父候选/笔迹、验缝任务、显式且幂等的入库定稿。 |
| `patternPipelines.ts` | 来源步骤、规格/Listing 参数、持久步骤/任务/快照、成包复用、SEAM_RISK 人工裁决、重跑/取消、UNKNOWN 与外部未决窗口屏障。后续自动步骤的成功推进由 D 的同步 settle 完成。 |
| `resources.ts`、`index.ts` | 每个原文件操作的具名 ResourceHandle、草稿归属检查、按 hash 单飞生成缩略图、查询资源登记、真实文件校验、显式 owner 保留/释放与持久可重入清理。 |

## 事务与冻结输入

`support.ts` 的 `runCommandFlow` 将每段同步领域工作放入 `context.transaction`。生成器的同步 queue/events/cancel 继续在同一事务内执行；遇到文件或网络 Promise 时先提交同步段，再等待，不跨 await 持有 SQLite 事务。

Job、Turn/临时参考绑定、Batch/Slot、Pipeline/Step、Export、LayerPlan/LayerExport、PrintPack 等必须完整创建后才调用 `scheduler.freeze`。freeze 与关联记录同事务；事务成功后才 `scheduler.enqueue`。最终公开投影在提交前校验，注册的处理器总是 await 真实领域结果。

冻结结构使用 D 已导出的 `createExecutionSnapshot(context, job, resources)`，来源为 `../execution/snapshot.ts`。必须保留该导出或同步调整本目录调用。快照包含实际项目、模型/密文、事实、素材、模板、编辑回合、批次/槽位 attempt 和必要套图。PLAN/SUITE_FORGE 保留完整目录；其它任务只需要其显式引用的套图分镜，不为每个本地处理任务复制完整目录。执行期不能改用当前配置。

CREATIVE 可没有商品图；PIXEL_PROTECTED 在提交前验证实际本项目真值和模板的图片参考能力，冻结所有实际图像资源。未知模板、缺失/跨项目引用、模型用途不符、未知外部请求的补偿/重跑均明确失败。普通文案结果不自动覆盖商品描述；采纳使用显式 `updateProject`。执行器自己的自动后续任务仍必须遵循 D 的快照、CAS 和同步结算规则。

## 资源与删除

公开投影按契约字段构造，递归清除路径、执行输入、密文和回执；任务错误使用安全摘要。素材/产物通过 `ecomgen-resource://` 身份寻址。公开查询会准备引用及缩略图，使历史图片不依赖已删除的文件路由。文件内容或 hash 不符会报错。

参考脸使用 `{ kind: 'MODEL_FACE', id: '<model UUID>-<content hash>' }`。Renderer 必须使用返回的 `referenceFaceUrl`，不要自行把 model ID 当作可变文件身份。替换参考脸保留旧任务对旧字节的引用。

上传准备的文件先登记随机暂存资源和清理意图；成功领域行用另一资源身份保留同一路径，失败时清理队列回收无领域引用的文件。B 当前在接受命令前及等待全部命令/执行结束后清理；不要在命令的异步准备期间额外并发调用 cleanup。永久删除不执行原目录递归删除，不猜测 v2 平铺文件归属。先取消/等待执行，再登记实际路径的清理意图；仍被其它聚合、执行或历史引用的源图/蒙版/笔迹保持保留。UNKNOWN 项目/草稿/模特/花型删除受保护；Provider 删除保留未知请求证据并清理当前模型选择。

三个命令侧窄适配目前使用 `EcomRepository` 已持有的同一 `db` 连接：素材角色 UPDATE、手动分镜修订、按 owner 枚举资源。原因是 A 当前门面未提供这些窄方法。没有打开第二连接或创建新表；事务均由 context 控制。协调者可在后续把这三个适配收拢成 core/runtime 的公开方法；不得改成另建状态真相或更换连接。

## 验证与集成界限

使用指定 Node 22.23.4，实际执行：

- `desktop/node_modules/vitest/vitest.mjs run --root E:/EcomGen/desktop packages/backend/test/commands`：2 文件，28 项测试通过，无跳过。
- `desktop/node_modules/typescript/bin/tsc -p E:/EcomGen/desktop/packages/backend/test/commands/tsconfig.json`：commands 源码与两份测试严格类型检查通过。
- `desktop/node_modules/typescript/bin/tsc -p E:/EcomGen/desktop/packages/backend/tsconfig.json --noEmit`：当前全 Backend 类型检查通过。

测试使用隔离 SQLite、临时目录、生成 PNG、两项套图快照测试夹具和本机假 Provider 的 GET /models。包含全部操作注册核对、真实 scheduler 接线、await、完整伴随记录、第二次 freeze 故障的整批回滚、不可变快照、UNKNOWN、失败槽位补偿、文件准备回收、公开投影与文件 hash。未调用真实模型，未停止旧服务/已有 EcomGen 窗口，未读取旧环境变量/用户库/素材，未修改任何 manifest、锁文件或根配置。

已有依赖足够：core/contracts/domain/providers/ecom-skill/ecom-suite、TypeBox 和 sharp。无需新依赖安装。

迁移阶段交接事项（历史，当前整合与 Source/EXE 完整业务验收已完成，实际结果见[验证记录](../../../../VALIDATION.md)）：

1. 在生产 Backend 注入本注册器与 D 的全部执行器，并完成 E 的 IPC/宿主/原版 UI 接线、F 的网络回执及全工作区/EXE 验收。上述命令测试不等于完整执行器或真实窗口验收。
2. `ByteImportSchema` 与 `decodeByteImport` 当前只允许 PNG/JPEG/WebP。本目录遵守该冻结契约并保留 50MiB 桌面文件上限；已发布桌面的 AVIF/TIFF 格式支持必须由 B/协调者扩展契约/解码和 E 文件选择后共同接入。不能以当前三格式断言旧有全部格式已迁完。
3. 没有业务行的新 v1/v2 保留任务产物需要由整合层通过 `DesktopHistoryRepository` 登记资源并提供只读历史投影；本目录不从旧 Web 数据库或素材目录导入。当前领域行支持的历史资源和缩略图已接入。
4. 自动连续步骤与候选执行、自动采用的迟到结果 fencing、外部未知窗口恢复由 D/B/F 的真实集成负责，必须再跑完整假协议流程；不能只依据命令意图创建通过便宣称整个工坊完成。
