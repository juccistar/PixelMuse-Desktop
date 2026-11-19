# 完整迁移共享接口与文件所有权

## 最终交付状态（2026-11-06）

原业务迁移及源码/解包 EXE 完整验收已完成：两份64/64、131操作/29家族/20任务加Listing无缺口，错误0、清理通过；111文件996项根测试通过。最终安装器、静态11项和3789文件payload字节一致性已验证。准确结果与未实测边界见 ../VALIDATION.md；最终证据 `.cache/final-desktop-verification-20261106-2.json`（相对desktop根）。下方所有权段落仅记录历史协调，所有writer/复核已结束，无待恢复执行链。未执行Git提交、安装/升级/卸载或真实模型调用。

本文件由协调者维护，优先于 ownership-plan 中的建议落点。用户要求全部业务迁完才停止；当前不是重新议价或缩减范围。以四份 map 的事实和原源码为对照，不照搬其中与工作区规则冲突的建议。

## 2026-11-06 当前补修所有权

- wf_6bf38477-432 已交付并独立复核 SetupPanel 跨访问保存顺序；原 writer 已结束。
- wf_2cd47eb3-ba6：编辑/分层验收 writer 独占 e2e-full-edit-layers.mjs 和必要 mock 夹具；SOURCE writer 独占 patterns 脚本的 pipeline-source-cancel-retry、唯一回归，并扩展 domain/src/pod-schemas.ts 的 PatternPipelineBlockReason 与对应 catalog 投影以表达 EXTERNAL_RESULT_UNKNOWN；规划/catalog writer 独占 e2e-full-additional.mjs、唯一规划输出测试，并扩展 commands/index.ts 中 listEcomDetailsImageTemplates 的现有公开投影调用。不放宽契约或原始业务校验。
- wf_05d1d2c3-b88：仅独占 e2e-full-recovery.mjs 和唯一恢复验证脚本，定位并复核本次在途请求/崩溃同步及 Node 网络拦截断言；不得改生产或 guard。
- 协调者已补充 harness 的 getResource 明确领域拒绝模式以识别“资源不存在。”；基础设施错误仍不能满足负向断言。上述补修 writer 均已交付，w7olryd1t 亦独立复核通过；不再恢复这些执行链。
- 全工作区构建 bd8pxb04f 已通过，根全测 b070h8c9d 为 109 文件/986 项全过。新包 b6u9mwqta 已生成，静态检查 b6wq3htpz 11/11 通过。完整 Source64（bymp2y2bc）与 EXE64（b8dj3zvcv）执行中，各自隔离 userData/本机假服务。
- wf_fb3724a0-185 / w87axe5sq 仅做最终覆盖与证据边界只读核查，无文件所有权。协调者负责结果判定及最终文档更新；如有新的实际失败再划定唯一修复范围。

## 完整验收首轮后的新所有权

- Source64 已结束为 58 通过/1 失败/5 阻断；EXE64 为 56 通过/2 失败/6 阻断，均未完成。两者在回执下载失败后的首次应用重启没有窗口；EXE 另有新建模特持久成功但侧栏不刷新的问题。
- wf_bea98280-897 / w5akjw98j：独占 e2e-full-startup-guard-launch.mjs、harness 仅生命周期/诊断区段及唯一自测/复现文件。不得扩大生产修改；真实生产启动缺陷先报告后分范围。保留失败，不增加超时掩盖问题，不改变网络隔离/UNKNOWN规则。
- wf_d1b50b0a-df5 / wdc1tfjtd：独占 renderer/api/hooks/useModels.ts，以及确有必要时 ModelsPage/ModelDesigner；唯一 model-create-refresh 测试，e2e-full-ui.mjs 仅 ui-model-designer 段。先证明新建后列表状态问题，不能以等待稳定后才允许创建来隐藏竞态；保持查询为状态真相及原 UI。
- 上一轮 Source/EXE 运行均已结束，清理报告通过，原失败结果不得覆盖。协调者待补修交付后再统一更新构建/打包及完整运行；不恢复旧工作流代理。

## 清理性能阻塞的生产补修所有权

- wf_bea98280-897 的作者已交付真实根因证据：299 资源/41 清理意图/0 任务即可使应用启动超时；1 意图只需 3666ms。逐意图反复扫描其他资源并调用 absolute 的同步 lstat/realpath，导致完整数据量下启动/关闭超过 30s/15s。CDP close 预先中断退出的假设已被五次受控实验反驳，不按该假设修改退出或扩大超时。原工作流剩余阶段只读复核诊断/生命周期；compiled Backend 暂仍旧清理实现。
- 模特新建刷新 wf_d1b50b0a-df5 已独立复核交付，useModels 所有权结束。协调者清理旧 HTTP 注释后构建 ba2i8nx9i 成功。根全测 bl7mkxcd2 为 110 文件/991 项，989 过、2 个新增模型测试失败，不能记作全过。
- wf_bebe0204-c02 / w3y5z2mqt：清理 writer 独占 backend/src/runtime/resources.ts、唯一规模/路径安全回归；不得改 core/files.ts 的路径保护，index.ts 仅证明确有必要时。模型测试 writer 独占 ModelsPage.model-create-refresh-sol.test.tsx 的确定性等待/操作成本改进；不得改生产 hook 或全局超时。各自独立复核。不发恢复型消息、不重叠写入。
- 协调者待该生产补修交付后再统一 emitting build 和最终打包/Source64/EXE64；保留首轮失败报告。新 one-off 安装器内容比对只读检查由协调者维护，无生产文件所有权。

## 诊断隐私补修

- wf_bea98280-897 已完成独立复核：确认生产清理开销阻塞；此外新诊断自由文本仅做已知 Key/Bearer 脱敏，不能保证陌生凭据/私有快照标记不流入证据。探针截获写入，未将 canary 落盘，106 份实际合成日志审计未发现真实泄漏；不要将此声明为已经安全修好。
- wf_06447323-915 / wvin6jlh3 独占 harness 的生命周期诊断序列化及新增相关错误包装、launcher 的对应诊断输出，以及唯一隐私自测。改为固定事件/原因枚举、数字和严格字段白名单；不通过增补 Key 正则声称保证，不改退出/超时/隔离逻辑或其他场景。无生产文件所有权，与 wf_bebe0204-c02 不重叠。
- 模型测试 writer 已交付：四文件19项、4workers通过，复杂cast18.56s；原始no-cache/缓存旧响应负向对照仍失败，采用具体持久化/终态等待、实际事件和该复杂case单独30s预算，未改全局配置。独立复核尚未完成，根110文件尚待重跑。

## 已冻结的决定

- 新版完整 UI 直接迁入原 React 页面、CSS Modules、主题和组件，使用 memory router 保留原九条页面路径与 query 语义。删除简化业务界面的生产入口，不再另造一套风格。
- 全部业务命令为 TypeBox 的具名 IPC 操作。可保留原 OpenAPI operationId 作为语义命令名，但生产不得有 method/path 路由器、Fastify 注入、REST-shaped bridge、SSE/EventSource 或 openapi-fetch。旧注册表只允许作为构建期迁移参考。
- 新 @ecomgen/core 复用完整领域仓库/存储接口，采用 fresh canonical schema。v1/v2 只做一次性显式数据转换，保留原 ID、密文、原始历史输入/指纹、分镜/结果和文件引用；不引入旧任务版本执行器。无法安全变换的旧付费意图保留为不可执行历史/待核实状态，不丢数据、不伪造新产物。
- 只有一个 Backend owner 打开业务 SQLite。所有领域操作与队列共享 EcomRepository、LocalAssetStore、SecretBox 和该连接。旧 core 的历史 DB migrate/config.env 入口不迁入。
- 加密固定使用 AES 的 256 位 GCM 模式；主密钥是 main 的 safeStorage 解封后提供的 32 字节 Buffer。兼容当前桌面 v2 的密文字节格式，不接收旧 Web 主密钥或数据库。
- 原版业务规则优先：CREATIVE 可无商品图，PIXEL_PROTECTED 必须使用本项目商品真值；不沿用 0.2 的普遍真值门槛/固定四图等过度限制。候选数、容量与模型能力按各领域原规则。
- 旧 business/workflows 等简化 IPC 无需维持第二份状态真相；若移除，应同步改测试/renderer，而不是保留运行时兼容分支。
- 整合时核对图片入口的格式与容量，不能让共用画布字节 schema 无意收窄原有文件导入。已验 0.2 存储明确支持 PNG/JPEG/WebP/AVIF/TIFF（基线 packages/backend/src/storage.ts），而当前 ByteImportSchema 仅列前三种，且 UploadAsset/人脸/套图等入口复用它。保留这些既有文件格式并验证真实解码；蒙版仍按其 PNG/几何规则。旧 Web 通用文件上限来自 domain limits 的 30MiB，套图张数为 12，0.2 文件入口为 50MiB；需按业务入口与已发布桌面行为明确处理，不能把一个画布上限套给所有领域。此项为待整合核对，不表示生产入口已修复。

## 包与接口

### core（A 独占）

导出完整 EcomRepository、原 record 类型/字段/方法、LocalAssetStore、SecretBox、fingerprint/目录/流水线纯服务。数据库接口：migrateDesktopDatabase(db)、openDatabase(filename)、DESKTOP_SCHEMA_VERSION，运行时以这些实际导出为准。存储保留原方法功能，但所有实际路径必须受管并拒绝链接跳转，旧桌面平铺文件位置通过迁移后的记录引用保留。

新增统一运行状态/维护持久表或窄存储接口，供 runtime 在同一事务使用（最终名称与字段写入 core/README，其他实施者读取该文档）：

- 任务执行快照与运行状态：按 jobId 唯一、payload JSON，由 runtime TypeBox 校验；保存 immutable snapshot 与逐请求账本，不能覆盖旧原始输入。
- 受管资源登记与引用：资源 ID→受管文件/类别/hash/引用/发布状态，公开 DTO 不暴露路径。
- 持久清理意图：可重入的文件回收/删除任务，不删除仍被执行或历史引用的输入/蒙版/笔迹。

共享运行持久表名称固定为：

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

A 将它们纳入同一 schema-v3 事务。B 在 runtime 中定义并校验这些 JSON payload 的 TypeBox schema；不另行创建并行数据库或不受版本管理的表。desktop_job_runtime 的不可变 snapshot 与原始 preservedHistory 不得被 mutable request/settlement 状态覆盖。

如原仓库字段尚不足表达 UNKNOWN，扩展真实状态类型和 SQL，不把 UNKNOWN 压成可重试 FAILED。

### contracts/domain + runtime（B 独占）

B 独占 contracts/src、domain/src 的共享定义，以及 backend/src/runtime、backend/src/index.ts/database.ts/business.ts/validation.ts 的整合入口。发布完整具名操作注册表、输入输出、事件、资源判别联合，并给其他实施者提供机器可读 operation catalog（含旧来源 operationId/path 仅作迁移参考，生产代码不载入 path 映射）。

B 阶段结束后，协调者安排限定的输入契约修复者，独占 ByteImport 的 MIME 定义/解码、createPatternExtractJob.file 的残留 binary-string 改造及 command-catalog.json 同步，补新图片输入回归测试。验收脚本已确认这两个真实阻塞：AVIF/TIFF 缺失，以及提取入口仍要求旧 multipart 字符串。该修复仅改对应 domain/contracts 及 backend/validation，不修改 C/D/E 实现；串行整合者在交付前避免重叠写这些输入定义。保持全部操作名、资源引用及纯领域接口的既有语义。

已实际复现图片完整性问题：截断 PNG 仍可通过 sharp.metadata()，但真实像素解码失败。当前 core.inspectImage 与 commands/support.readImageInput 都只读 metadata。协调者安排 core 的完整有界解码修复（files.ts 与新增图片验证测试）；C/串行整合者需让 readImageInput 消费实际完整验证，不能只以 magic/metadata 宣称有效图片。先检查字节数/像素上限，再执行完整解码；避免无界巨型 raw Buffer。不得越过当前 C 文件所有权直接改其 helper。

协调者已生成 original-api-inventory.json：旧版 131 个具名操作（52 查询、79 变更）；original-job-inventory.json：20 个 JobType + COPYWRITE/LISTING 分支。catalog 必须逐项说明对应的新命令或受限文件/事件能力，不要求机械保留 131 个命令，但不得有未解释的漏项。文件下载与旧 SSE 可由明确的资源协议/失效事件替代，不恢复旧传输。

共享命令上下文：repository、storage、secrets、catalog、scheduler、events、requestLedger、clock、idFactory、signal。scheduler.enqueue(jobId) 仅唤醒同一 SQLite 队列，不建立第二队列；所有关联记录完成并冻结快照后才允许执行。events.publish 只跨 IPC 发失效标识，不发送数据库行/密钥/路径。

提交结果声明 durable job/aggregate IDs 和 reused，而非 Response/HTTP status。所有 invoke 均 await handler 后再校验输出。安全错误使用明确领域 code/message，不泄漏内部 Error 或原始 Provider 内容。

阻塞缺陷，已由真实 canonical 集成测试复现：commands/storyboard.ts 的生成指纹包含 item.updatedAt，而 execution/job-generation.ts 会在执行状态更新时改它。重复成功生图或重启后重复 UNKNOWN 请求因此新建任务，后者绕过未知窗口保护。C 当前拥有该文件，应改为稳定的实际业务输入指纹，排除状态/进度/执行更新时间等运行字段，同时保留真正提示词/素材/模型/配置变更；若 C 未交付修复，串行整合者必须处理。backend/test/business.test.ts 中成功复用与 UNKNOWN 重开不重发两个断言现均失败，不允许删除/跳过来过关。

运行时负责单 owner、并发、各领域结算、迟到写入 fencing、关闭、恢复、UNKNOWN 优先级及领域重试分派。完整快照和伴随记录必须原子提交；未知窗口不能经通用重试/草稿补偿/流水线重跑绕过。

### commands（C 独占）

C 独占 backend/src/commands/**。从原 routes 中迁入业务校验、读写和持久意图创建，使用 B 的命令注册表和 context，调用 A 的完整仓库。不得使用 Fastify 或模拟 request/reply/HTTP 路由器；只能保留纯领域语义。

C 的 StructuredOutput 交付已于 2026-11-05T14:28:42Z 被工具确认接受，但外层 journal 未登记终态；原文已恢复在 recovered-C-report.json。对应原代理未再写入且不在可停止任务表中。协调者据已交付报告接管已确认缺陷：另行修复者独占 commands/storyboard.ts、support.ts、patterns.ts、patternDrafts.ts 和新 commands/regressions.test.ts，处理生成指纹与完整图片验证；串行整合者在交付前不要重叠写这些文件。其首轮修复已完成，协调者继续限定 storyboard.ts/regressions.test.ts 核对 revision='retry' 的语义：D 不为该标记修订提示词，所以它不能单凭新指纹绕过既有 UNKNOWN；保存重试元数据与稳定实际业务指纹应分开。旧集成测试文件仍由其既有迁移交付保持，不在此修复范围。

覆盖原所有查询/变更族：项目/素材/库、配置/搜索/模板/套图、规划历史/分镜/候选/文案/导出、编辑/分层、花型/草稿/印刷/Listing/流水线、人物模特。文件输入用 B 的受限上传资源，不让 renderer 提供路径。文件保存用资源引用和系统对话框。

### execution（D 独占）

D 独占 backend/src/execution/**，迁入全部旧 20 JobType 和 COPYWRITE Listing 分支的 handler/算法，补齐 WorkerContext 为纯 Backend 端口，不能复制旧 worker 入口/Redis/BullMQ。

导出 createExecutionContext(dependencies)、executeDomainJob(context,job) 或等价明确接口，并列出任务注册表。依赖只来自 core/domain/agent/providers/ecom-skill/ecom-suite，使用 B 的 signal、events、scheduler 和 requestLedger。模型、素材、事实和模板读取执行冻结快照，不重新读当前配置替代快照。

保留稳定产物键、批次/槽位/attempt、编辑血缘、自动分层、Seedream、alpha/像素保护、长图/印刷/接缝处理和事务结算。文件 I/O 与 SQLite 事务不能跨 await。

### renderer/host（E 独占）

E 独占 apps/desktop/src/**（main/preload/renderer）与 apps/desktop/public/**。完整迁入原 UI 依赖闭包，hooks 改为 typed DesktopClient 具名命令；公开 schema 类型只从 contracts/domain 推导，不保留旧 schema.d.ts 为另一份手写真相。

资源 URL 仅携带受限 kind/id/index。main 校验来源和能力，Backend 解析受管路径；canvas fetch 只允许受限资源协议。原生文件选择/拖放/粘贴/画布生成使用有大小/类型/数量约束的资源输入；不得暴露任意 FS 或原始 ipcRenderer。保存 ZIP/PSD/图片/JSON 由资源引用触发系统对话框。事件只失效重查。

E 不改 scripts、package manifest 或锁文件；依赖需求写入自身交接文件，由协调者安装。原 AntD/motion/router/photo-album/virtuoso 等依赖已添加；未引入 openapi-fetch。

E 已交付接受的报告 recovered-E-report.json（九路由、143测试与真实 Electron 假IPC窗口，不是完整业务验收）。剩余明确 DTO 接缝：Output 需公开脱敏 revision?: string，仅投影持久 generationSnapshot.revision（D 的特殊 'retry' 或真实改稿说明），不可回传整个 generationSnapshot。renderer/lib/outputMetadata.ts 已只消费该字段，以保留重新生成标记与批次重试计数。生产 Backend 预整合或其后整合者需同步输出schema/投影/离线catalog，并验证不泄漏其它快照内容。

### 外部请求与 Agent（F 独占）

F 独占 providers/src 与 agent/src 的请求/响应捕获和取消挂钩；B 实现持久 requestLedger 存储，D 绑定到每个任务。二者通过 B 在阶段一声明的窄接口合作，不能各建账本。

F 已交付的实际接线：providers 导出 bindExternalRequests(scope, requestKey, model?) 返回 RequestEvidenceBinding，包含 scope/requestKey/fetchForRequest。AgentRunOptions.external 和 Provider connection.external 接收这个绑定，不是直接传裸 ExternalRequestScope；D 为每个工作流/候选/元素提供稳定前缀及 providerId/modelId，再在产物 checkpoint 中调用相应 scope.committed。SDK 0.84.4 已验证支持直接 fetch 注入，不需要全局拦截。协调者已安装 agent→providers workspace 依赖，按 providers→agent 构建并用普通根配置通过两包 178 项测试。

保留原有实时观察语义：旧 suite-forge 的 onShotProgress 在 SSE 未结束时报告已形成的分镜数。当前 F fetch 先完整 readReceipt 后返回，导致该进度只在 EOF 后出现，需要修正。允许 SDK 在 IN_FLIGHT 期间消费实时 token 以发布非终态进度；完整终态/EOF 回执持久化后，才能让 Agent/探测作为成功返回并进入领域结果校验、产物提交或后续付费轮次。不得把部分流标为 COMPLETED，也不能因此重发。协调者另行安排限域修复 providers/request-evidence、reasoning-probe 与 agent/runtime/stream/对应证据测试；串行整合者在其交付前避免与这些文件重叠写入。现有 bindExternalRequests 调用方式与外部账本接口保持可用。

必须逐模型轮次/候选/分割元素记录稳定 requestKey、IN_FLIGHT、完整响应证据和本地产物状态。捕获响应应早于图片下载/解析/业务校验。已有完整回执可重放并仅续做本地/下载阶段；没有可靠结果的请求进入 UNKNOWN，不自动重发。签名 URL、响应正文和敏感证据在 Backend 内加密保存，公开仅脱敏摘要。

若 Pi SDK 支持注入 fetch，优先注入；否则可在单 Backend 进程用 AsyncLocalStorage 作用域的网络包装捕获请求，必须有真实并发/取消/流式响应测试，不能全局混淆不同任务或绕过安全策略。网络错误和未知结果的自动重发始终关闭；原业务中收到完整回复后的规划 JSON 纠错、文案压缩等明确多轮步骤，可按原有上限保留，但每轮必须有独立稳定请求键和回执，不能把它们变成 SDK 网络重试。不能因第一批 0.2 曾移除修复轮次而漏迁原业务能力。

## 生产 Backend 预整合

C/D/F 交付及已知输入/指纹/图片修复完成后，协调者安排一个预整合者，独占 backend/src/index.ts、business.ts、runtime/** 及必要的 contracts 输出投影与新 backend/test/integration/**，接通默认实际命令/完整执行器及桌面 v1/v2 只读历史资源。E 仍独占 apps 源码，预整合者不改 main/preload/renderer；C 的五个指纹/图片修复文件与原集成测试保持既有所有权。原主工作流若进入其旧串行整合阶段，必须先尊重这个保留范围，不能重叠写入。预整合交付后由协调者统一处理 E 的宿主接线与整体验证。

## 最终接缝与失败测试所有权

全部实现者已交付、原主工作流已停止后，协调者安排两个互不重叠的整合者：

- 历史/输出 UI 整合者：apps 源码、contracts 输出 DTO/对应离线投影、commands 的公开投影（必要时 support/resources/projects/output 查询）及新的投影回归；补历史只读资源展示与 Output.revision，不改生成调度/指纹或既有集成测试。
- 失败测试修复者：backend/test/backend.test.ts、business.test.ts、integration/default-backend.test.ts 与必要测试 helper/局部配置。全量825项中818过/7失败；三项仍用特殊 revision='retry' 强造新任务的旧夹具，必须改用真实新候选意图，保留原断言；其余四项 default integration 超过根20s，需要实际隔离诊断，不能简单抬超时掩盖问题。历史/输出 UI 整合者不要同时改这几个测试文件。

## 协调者保留

工作区全部 package manifest、锁文件、构建/测试/打包配置；desktop/scripts/**；文档状态与覆盖矩阵；最终整合、真实窗口与独立 EXE 验收。其他实施者不要编辑这些文件，自己的新 package.json 除外（依赖写好后统一安装）。

原 0.2 Backend 集成测试 backend/test/backend.test.ts 与 business.test.ts 由协调者安排的独立测试迁移者独占，改用 canonical 命令/新快照，保留有价值的安全和业务断言；另可写 backend/test/desktop-regression-helpers.ts 和 migration-discovery/backend-test-migration.md。C/D 继续只写自己的 commands/execution 测试子目录；串行整合者不要与该测试迁移者重叠写这几个文件。不能为了旧测试恢复 projects.create/workflows.submit 等运行兼容。

## 2026-11-06 独立审核确认的修复所有权

原 A–F、历史 UI 与测试迁移均已交付。当前五类确认阻塞及复现证据见 verified-business-review.json；以下范围互不重叠：

- 流水线来源身份：仅 commands/patternPipelines.ts 与新增 pipeline-source-identity 回归；保留同一来源的幂等，区分不同来源任务。
- 正式花型透明判定：仅 execution/job-patterns.ts 与新增 pattern-transparency-recovery 回归；保留失败候选及完整回执，重试不得跳过透明失败或推进流水线。
- 每产物生成证据：execution/job-generation.ts、job-export.ts、snapshot.ts 与新增 output-provenance 回归；必要的编辑产物证据仅限 execution/job-edit.ts。逐 Output 保存不可变最终提示词/实际附件证据，导出不能使用后来更新的分镜提示词；私有快照不公开到 renderer。
- 草稿补偿恢复：commands/patternDrafts.ts、execution/job-pattern-drafts.ts、context.ts、index.ts，必要时 core/repositories/patternDraftRepository.ts、runtime/request-ledger.ts 与新 draft-compensation 回归；保留完整回执，仅续下载/本地阶段；活动批次不得转移槽位使其他返回结果失效。必要 UI 接缝限 PatternDraftWorkspacePage.tsx/usePatternDrafts.ts。需要扩大范围先交接，不重叠写其他修复文件。

草稿首轮作者已交付，独立复核确认两项残留：完整 HTTP400 拒绝被无条件重放而永远不能显式补偿；恢复整个旧任务会复活用户删除的成功候选。草稿后续修复者接管该同一生产范围及 draft-compensation.test.ts / draft-compensation-independent.test.ts，不得覆盖协调者的 commands.test.ts。原八代理工作流已全部交付。草稿后续任务还须处理第三项已确认问题：混合槽位归属批次定稿不能使用全批最后任务，必须记录所选候选的真实槽位来源；对应 draft-compensation-codex-provenance.test.ts 与 codex-backend 测试也已分给同一后续 writer。其工作流曾为吸收该发现明确停止后再恢复，当前单writer，无原草稿生产 writer。复核新文件必须使用工作流/职责唯一名称，避免同名文件覆盖；不得通过 SendMessage 恢复仍活动的工作流代理。

协调者保留配置、锁文件、文档、统一构建及全量测试。守卫修复者仍限 scripts/e2e-full 的 harness/network/startup/selftest；ctx.inspect 动态导入在真实 Electron evaluate 中失败的测试接缝一并修复，不改生产代码或 fuses。五类修复及最终全量/Electron/EXE 均未完成，不标记整体迁移通过。

## 当前真实窗口整合所有权（2026-11-06 后续）

- wf_d7c46efa-a1c 的 harness/business 请求辅助修复已交付；协调者已修分镜编辑后的过期确认测试，必须重新查询 currentBoard 并用旧版验证拒绝，不能假定 oldVersion+1 仍过期。project-lifecycle 删除后的 getResource 拒绝断言保留，禁止以句柄格式化为由放宽（business.ts 实际调用 resolve）。
- wf_35196ff4-1ff：MIME writer 仅 commands/resources.ts +新 metadata/resource-mime-consistency.test.ts；模型/分割脚本 writer 仅 scripts/e2e-full-patterns.mjs；原版 UI 驱动 writer 仅 scripts/e2e-full-ui.mjs。三者互不重叠，禁止改动另一者文件。
- wf_fc2a1aaa-2ae：限定 runtime/resources.ts +新 runtime/deleted-resource-retirement.test.ts，验证并修复永久删除后无owner资源仍PUBLISHED/待GC却可读取的问题；保留共享文件、job/history引用、持久物理清理与再retain，不改变 MIME/hash 身份约束。不能改 commands/resources.ts 或业务脚本。
- wf_fc2a1aaa-2ae 已交付并独立复核83项及额外真实Backend探针，runtime/resources.ts 不再有writer；待统一 emitting build。
- wf_48999e9f-54e 新增错误码跨沙箱修复者：contracts/src/index.ts及新错误传输schema/codec、preload/index.ts、renderer/api/client.ts（必要时errors.ts）、scripts/e2e-full-harness.mjs与唯一错误边界测试。已实际确认contextBridge丢失Error.code，而PatternDraft/Storyboard/Layers以code分支，不能只在脚本隐藏这一生产问题。保留成功接口、干净用户消息、TypeBox唯一schema、sandbox preload唯一运行依赖electron；不改其它组件或配置，不 emitting dist。前一harness/business作者已交付，协调者当前不再写harness。
- 守卫作者全部交付，额外真实 quit-during-load 与真正启动失败对照均已通过，不再有守卫源码writer。协调者 main 的 !quitting 错误框条件已编入当前构建并完成这两项真实检查。

当前0.3候选包已生成/静态检查与隔离启动通过，但仍需要上述生产修复后重建/重打包；首轮current source64为17通过/17失败/30阻塞，禁止标记完成。所有 `.cache` 证据均保持原样，不覆盖。各新回归文件使用职责唯一名称，禁止通过消息恢复活动工作流代理造成重复writer。

## 协作规则

每个阶段结束后先交付明确接口与文件清单，再启动依赖它的下一阶段。只由一个实施者写同一文件。不要通过消息工具恢复仍在工作流中的同 ID 代理来进行另一条写入链；协调需要写入本文件/阶段输出，下一阶段读取。已发现一次重叠任务并全部停止，core 当前可能有不一致的部分写入，A 必须先核对并恢复一致实现，不能假定它已完成。

无占位业务、无空成功、无静默截断；有明确领域上限的操作使用原规则和清晰错误。完整矩阵与可复现证据齐备后才可标记完成。
