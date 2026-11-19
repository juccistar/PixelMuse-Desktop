建议按六名实施者拆分，先冻结共享接口并完成 v2 数据迁移与请求账本，再按领域并行实现。每个领域负责人同时负责持久化、执行器、原版页面和行为测试；共享入口只允许指定负责人修改。此次交付是实施分工与完成门槛，未修改代码、运行测试或验证迁移完成。

**先统一四份地图中的冲突**

- 旧版是 **20 个 JobType，加 COPYWRITE 内的 LISTING 分支，共 21 个业务执行分支**。新版现有 PI_AGENT 和独立分割入口继续保留；v2 的 LAYER/PATTERN/SUITE 等任务通过版本解码器兼容，不能丢弃或默认分派为 EXPORT。
- CREATIVE 规划和生成允许无商品图；PIXEL_PROTECTED 必须有本项目 PRODUCT_TRUTH，并自动携带完整商品真值集合。上传容量、非商品参考数量、各业务候选数和规划数量分别采用共享规则，不能统一套用当前“四图/十二项”限制。
- 帮写结果独立保存，原 UI 的完成后自动回填行为应保留；回填携带目标字段修订，目标已被用户修改时保留结果并提示冲突，防止迟到结果覆盖新输入。不新增强制采纳审批。
- 编辑保留 NEED_INPUT、需要确认和无需确认三个分支。需要确认时显式 approve；无需确认时通过事务创建唯一生成子任务。不能无条件增加审批，也不能跳过原本需要的审批。
- 分层采用 `auto/manual/prompt` 三种明确来源；manual 必须有 bbox，prompt 是独立来源，不能伪装为缺框的 manual。
- 已存在的编辑规划、Prompt 修订、Seedream 适配器、模特规则、草稿引用/颜色解析、印刷规格和重复排列注册表继续复用。需要接线和修正的实现不能再复制成平行版本。

**共享接口决定**

1. **契约与版本**

   由实施者 A 维护整个 [contracts 源码目录](E:/EcomGen/desktop/packages/contracts/src/index.ts) 和 [domain 源码目录](E:/EcomGen/desktop/packages/domain/src/index.ts)。拆分具体 TypeBox 模块并统一导出；所有通信类型由 `Static` 推导。既有 domain schema 能复用的直接组合，不再手写另一套 DTO。

   采用 canonical schema v3：空库直接创建最终结构；现有桌面 v1/v2 通过显式迁移进入 v3。数据库版本、任务快照版本、算法版本分别管理，不能用数据库升级重写历史快照。

   项目平台允许空数组，文案语种和提示词语种独立；模型引用统一为 `ModelRef { providerId, modelId }`。“Provider 模型”和“人物模特”采用不同 schema 和标识字段。

2. **领域命令**

   使用具名操作族：`projects.*`、`assets.*`、`library.*`、`providers.*`、`searchSources.*`、`planning.*`、`planningHistory.*`、`storyboards.*`、`storyboardItems.*`、`copywriting.*`、`generation.*`、`outputs.*`、`exports.*`、`editSessions.*`、`editReferences.*`、`editTurns.*`、`layerPlans.*`、`layerExports.*`、`layerCompositions.*`、`models.*`、`portraits.*`、`templates.*`、`userTemplates.*`、`suites.*`、`suiteForge.*`、`patterns.*`、`drafts.*`、`draftMedia.*`、`draftBatches.*`、`draftCandidates.*`、`printSpecs.*`、`printPacks.*`、`patternListings.*`、`patternPipelines.*`。

   `jobs.get/list/cancel/retry` 支持全局及实体作用域查询；返回 `retryable`、阻断原因、尝试关系和脱敏请求证据。所有提交返回持久意图 ID、相关聚合 ID 和 `reused`。同 clientKey 不同有效载荷返回冲突。

   旧 `business.*`、`workflows.*`、`jobs.export` 仅作为新领域服务适配入口，不继续维护第二份配置或结果。

3. **唯一存储所有者与事务**

   Backend 独占 SQLite、凭据和业务存储。领域仓库工厂接受同一个连接；公共命令、执行器及跨域结算使用同一个同步事务上下文，事务内不得 `await`。

   `BackendDependencies` 固定为 repository、storage、secrets、catalog、scheduler、events、clock、idFactory。入口执行顺序必须为校验输入 → `await handler` → 校验输出。提交事务只冻结快照、创建 Job 和伴随记录；提交后唤醒调度器并发出失效事件。

   每个领域暴露 `registerHandlers`、明确的 executor 注册以及同步 settlement/recovery hook。A 负责组合，不允许领域自行建立队列、数据库连接或恢复循环。

4. **请求账本与恢复**

   每次模型轮次、搜索请求、Prompt 修订、生图候选和分割元素分别拥有稳定 requestKey。发网前持久化 IN_FLIGHT；Provider 响应、Agent 原始回复或远端任务标识持久化后才记 COMPLETED。领域产物是否提交另设字段。

   Provider 适配器必须在图片下载、解码和结构校验之前交付可恢复响应证据；签名 URL 等敏感内容仅在 Backend 内保护保存。仅在调用最终返回后记账不足以覆盖下载失败窗口。

   UNKNOWN 优先于普通失败和取消，不得被后续候选成功清除，也不能经草稿补偿、流水线重跑、删除 Provider 或修改指纹绕过。已保存回执可以继续本地下载、解析和发布；只有未发送或有明确安全依据的失败才允许重新请求。

   Job 与 Slot、Turn、LayerExport、PipelineStep 的状态在同一结算事务推进。槽位发布校验 `batchId + slotIndex + attempt + jobId`；流水线发布校验 step 代次，阻止旧执行器迟到写入。

5. **产物、引用与文件生命周期**

   Artifact 是文件真相，Output 是生成结果真相，Asset 是用户导入或明确复制的项目输入。自动生成结果不再写成 STYLE_REFERENCE，也不消耗上传额度或自动进入规划上下文。

   ArtifactRef 使用受限判别联合，包含资源 ID、类别及必要的文件索引；公开 DTO 不含磁盘路径。缩略图分别记录源 hash 与实际 WebP hash。

   文件生命周期统一为暂存 → 原子发布 → 领域关联；发布日志、引用保留和持久清理队列处理文件系统与数据库之间的故障。已引用的临时参考、笔迹、蒙版、源图不能按普通终态清理；无引用暂存资源需要回收。

6. **原 UI 与宿主边界**

   恢复全部九个旧路由，使用 memory router 保留路径和查询参数语义。迁入原页面、CSS Modules、主题、locale、reduced-motion 和共享组件，保持暗色琥珀、顶栏、画廊、抽屉、画布、比较轨与历史视图。

   页面通过 typed DesktopClient 调用具名 IPC。原生选择、拖放、粘贴和画布上传使用受限资源导入，返回逐文件结果、可取消操作 ID 和资源 ID；保存通过 ArtifactRef 与系统对话框完成。生产 CSP 和导航限制继续有效。

   公共 health 移除 `dataDir`，返回 Backend 状态及能力。事件只触发重查；临时查询失败不能移除持久任务或在途卡片。

**六名实施者的排他文件边界**

下列新增目录是建议的实施落点。同一目录只归一个负责人；共享文件修改交给其所有者串行集成。

1. **A：契约、迁移、队列与 Backend 集成**

   独占：

   - `E:/EcomGen/desktop/packages/contracts/src/`
   - `E:/EcomGen/desktop/packages/domain/src/`
   - `E:/EcomGen/desktop/packages/backend/src/database.ts`
   - `E:/EcomGen/desktop/packages/backend/src/migrations/`
   - `E:/EcomGen/desktop/packages/backend/src/runtime/`
   - `E:/EcomGen/desktop/packages/backend/src/repository.ts`
   - `E:/EcomGen/desktop/packages/backend/src/storage.ts`
   - `E:/EcomGen/desktop/packages/backend/src/validation.ts`
   - `E:/EcomGen/desktop/packages/backend/src/index.ts`
   - `E:/EcomGen/desktop/packages/backend/src/business.ts`
   - `E:/EcomGen/desktop/packages/backend/test/migrations/`
   - `E:/EcomGen/desktop/packages/backend/test/runtime/`

   交付统一仓库组合、调度器、请求账本、Artifact 登记与引用、清理队列、领域重试分派、恢复和关闭流程。A 是唯一修改数据库 DDL、根 handler/executor 注册表及兼容适配层的人。

   迁移须在唯一 owner 取得后、恢复和 pump 之前完成；使用 SQLite backup API 建立一致性备份。重建 jobs 及引用表时显式处理外键，事务内校验并更新版本。迁移不访问 Provider、不移动图片、不重发任务。

   保留项目、Provider、素材、任务、分镜和结果 ID，密文字节、原始 snapshot 字节、fingerprint、requestState、resultName 和旧文件引用。合并 project_business 后消除双份配置。旧单模型 Provider 转成稳定的单模型目录项。

   仅能可靠追溯为 GENERATE 的旧结果提升为 Output；旧 asset ID 建兼容别名。其他历史产物保留兼容来源，不虚构正式花型或自动分层记录。活动意图去重与成功结果复用分离，UNKNOWN 继续占用意图保护。

2. **B：项目、素材、库、规划、分镜与多候选生成**

   独占：

   - `E:/EcomGen/desktop/packages/backend/src/domains/projects/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/assets/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/library/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/planning/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/storyboards/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/copywriting/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/generation/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/outputs/`
   - `E:/EcomGen/desktop/packages/backend/src/execution/visual-assets.ts`
   - `E:/EcomGen/desktop/packages/backend/src/execution/image-params.ts`
   - `E:/EcomGen/desktop/packages/agent/src/`
   - `E:/EcomGen/desktop/packages/ecom-skill/src/`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/features/home/`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/features/projects/`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/features/library/`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/features/project-planning/`

   负责原 WorkbenchPage、SetupPanel、AssetsStage、StoryboardStage、Inspector 的迁入，统一放入 project-planning 目录；从 C 导入结果、编辑和分层模块。

   OutputRepository 由 B 实现并向 C 提供同步创建、查询及血缘写入端口，C 不另写 Output SQL。Library 查询通过规范表投影覆盖全部来源，先过滤再去重和分页；禁止正式花型、规格包被复制成项目商品真值。

   重点交付追加规划语义、配置历史二十份、完整业务字段、研究审计、两种帮写、分镜 CAS 和自动保存、多镜多候选、稳定 generationKey，以及逐 Output 的最终 Prompt、附件顺序/hash 和实际参数。项目改名和无效保存不能制造新付费意图。

   B 同时改造 Agent 流调用边界，接 A 的逐轮账本；不能以 `maxRetries=0` 代替多轮审计。

3. **C：编辑、自动分层、结果审阅与交付**

   独占：

   - `E:/EcomGen/desktop/packages/backend/src/domains/edits/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/layers/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/exports/`
   - `E:/EcomGen/desktop/packages/backend/src/export.ts`
   - `E:/EcomGen/desktop/packages/backend/src/image/edit-imaging.ts`
   - `E:/EcomGen/desktop/packages/backend/src/image/mask-utils.ts`
   - `E:/EcomGen/desktop/packages/backend/src/image/layer-composite.ts`
   - `E:/EcomGen/desktop/packages/backend/src/image/long-image.ts`
   - `E:/EcomGen/desktop/packages/backend/src/image/vision-cache.ts`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/features/results/`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/features/image-editing/`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/features/layers/`

   迁入 ResultsWorkspace、ReviewStage、EditImageWorkspace、LayersPanel、LayerStackDialog 及依赖闭包。复用 B 的 Output/生成端口、D 的 Provider 适配器和 A 的任务/Artifact 服务。

   编辑保留分支记忆、参考用途/顺序、真实蒙版、扩图、多候选和完整血缘。保护语义以受保护 RGBA 精确回贴实现并测试，修正旧透明隐藏 RGB 和半透明扩图混合问题。

   分层覆盖视觉识别、三类元素、SAM 和 Seedream、背景处理、实测 bbox、历史及可见图层编排。导出覆盖单图、选图 ZIP、长图、切片、图层 PNG/ZIP/真实 PSD。视觉缓存独立于缩略图；纯计算模块不得持有 SQLite。

4. **D：Provider、搜索源、模板套图与人物模特**

   独占：

   - `E:/EcomGen/desktop/packages/providers/src/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/providers/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/search-sources/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/catalog/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/suite-forge/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/models/`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/features/providers/`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/features/templates/`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/features/suite-forge/`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/features/models/`

   提供 SelectedModel、有效参数及能力解析、响应持久化钩子和无自动重发的网络适配。编辑能力按模型声明和明确规则解析，不能仅凭兼容协议认定支持全部能力。Provider 删除通过 A 的协调端口清引用、处理 queued 和在途任务。

   模型发现和测试复用现有实现；保存配置不自动测试。密钥修订、空值保留和所有公共投影遵循统一凭据端口。

   SuiteCatalog 保留来源冲突顺序和精确元数据语义：total/l1Counts 随 origin，originCounts 为全库，ids 查询覆盖普通筛选和分页；用户最近导入优先展示，详情按需加载。Forge 是全局多图任务，保留完整 hints、进度、最近历史、可编辑草稿和幂等 commit。

   人物模特保留原设计器、创建后身份规格固定、参考脸、定妆候选、唯一 selected 和身份筛选；肖像按 job/candidateIndex 定位，不能按已有数量推断缺口。

5. **E：正式花型、完整草稿工坊、印刷与成包流水线**

   独占：

   - `E:/EcomGen/desktop/packages/backend/src/domains/patterns/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/drafts/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/print-packs/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/pattern-listings/`
   - `E:/EcomGen/desktop/packages/backend/src/domains/pattern-pipelines/`
   - `E:/EcomGen/desktop/packages/backend/src/image/pattern-background.ts`
   - `E:/EcomGen/desktop/packages/backend/src/image/pattern-derive.ts`
   - `E:/EcomGen/desktop/packages/backend/src/image/tile-verify.ts`
   - `E:/EcomGen/desktop/packages/backend/src/image/seam-edit.ts`
   - `E:/EcomGen/desktop/packages/backend/src/image/repeat-unit.ts`
   - `E:/EcomGen/desktop/packages/backend/src/image/print-pack.ts`
   - `E:/EcomGen/desktop/packages/backend/src/image/print-mockups.ts`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/features/patterns/`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/features/pattern-drafts/`

   负责花型墙、详情、全部来源入口与衍生、草稿列表/画布/候选轨、规格包、Listing 和流水线 UI。Listing 复用 B 的 Agent COPYWRITE 工作流，不新造平行模型服务。

   草稿冻结 composeType、父图、参考/笔迹 hash、Prompt 版本和有效参数；ordinal 单调不复用。选择、比较、删除清指针、定稿回写均推进 revision。只补偿明确失败槽位，所有写入带 attempt 身份。

   媒体、笔迹、正式花型采用不同保留规则。定稿独立复制、按候选幂等，不自动成包。接缝改稿修正小图 band 和坐标描述，中心像素保持不变。

   流水线来源身份进入指纹；SOURCE 与流水线记录先于任务可执行。任务完成、步骤结算、下一个 Job/伴随记录创建同事务。重跑检查目标和全部下游，保留旧尝试；三种接缝裁决、UNKNOWN 阻断及取消传播不可旁路。

6. **F：Electron、原 UI 外壳、资源桥接与最终验收**

   独占：

   - `E:/EcomGen/desktop/apps/desktop/src/main/`
   - `E:/EcomGen/desktop/apps/desktop/src/preload/`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/App.tsx`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/main.tsx`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/env.d.ts`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/index.html`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/styles.css`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/app/`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/components/`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/api/`
   - `E:/EcomGen/desktop/apps/desktop/src/renderer/lib/`
   - `E:/EcomGen/desktop/scripts/`
   - `E:/EcomGen/desktop/README.md`
   - `E:/EcomGen/desktop/VALIDATION.md`

   另由 F 独占工作区全部 package manifest、锁文件、构建/测试/打包配置。其他负责人提交依赖需求，由 F 一次性集成。

   F 迁入导航、原共享组件和样式，接入九路由及 B—E 的页面。领域 hooks 放在各自 feature 目录，F 的 api 目录仅提供公共传输和资源能力，不复制业务状态。

   资源桥接覆盖原生导入、逐文件错误、取消、受限 bytes、预览、画布读取、缩略图、保存与窄化剪贴板能力。旧 components 中的简化页面待完整页面接通后由 F 删除。

   各领域负责人编写其所属目录内的行为测试；F 负责场景化假 Provider、真实 Electron、独立 EXE、资源检查与安装升级卸载验收，依据证据更新文档。

**依赖与集成顺序**

1. **接口冻结阶段**：A 定义 TypeBox、同步仓库端口、快照联合、Artifact、请求账本和结算 hook；F 提供原 UI 外壳及资源客户端。B—E 同步提取旧 Worker、页面和依赖闭包，不等待基础设施才开始整理实现。
2. **持久化门槛**：A 完成 v1/v2→v3、回滚、合法密文继续解密、旧任务兼容及请求回执恢复测试。未通过前，新执行器不能进入可发请求的注册表。
3. **并行闭环**：B 完成项目主链和 Output；C 基于已冻结端口实现编辑/分层/交付；D 提供配置、目录与全局库；E 实现花型、草稿和印刷本地链；F 同步接入页面及假服务。
4. **跨域集成**：B 的 Output 供 C；D 的目录和搜索供 B；D 的适配器供 B/C/E；E 的正式花型供草稿定稿、Library 和流水线。跨域只调用公开端口，不能跨目录直接写表。
5. **最终收口**：A 串行合入注册表、兼容层和共享 schema；F 串行合入路由、依赖、打包与 E2E。完整页面接通后撤掉简化界面及重复真相，最后执行全部完成门槛。

**最终完成清单**

每项必须具备“契约 → 持久化 → 执行/查询 → 原 UI → 真实产物或状态 → 行为证据”，不能仅以入口、任务 ID 或构建成功勾选。

- [ ] 项目：默认模型配对创建、封面、编辑、归档/恢复、安全永久删除、planningRevision。
- [ ] 素材：kind/role 分离、选择/拖放/粘贴、容量与 hash 去重、删除、完整商品真值输入。
- [ ] 全局资产库：七类来源、筛选/先筛后去重/稳定分页、缩略图、独立复制和保存。
- [ ] Provider：多模型、连接解析、发现、手动测试、能力/协议、密钥保护、删除关联处理。
- [ ] 搜索与业务设置：全部品牌/事实/市场/语言/模型字段、可空平台、研究开关、实际回退与完整审计。
- [ ] 用户模板与套图目录：CRUD/导入、运行时解析、逐镜/跨套选择、懒加载和精确计数、删除后明确失效。
- [ ] 规划与帮写：AI/MANUAL/套图/Pi、CREATIVE 无图、像素保护门槛、覆盖参数、显式重规划、二十份历史、两个帮写目标。
- [ ] 分镜：追加历史、稳定排序、编辑/自动保存/flush、风险事实、状态限制、CAS、“确认并生成所选”。
- [ ] 生成：多镜多候选、稳定键与批次、实际 Prompt/附件/参数快照、幂等及仅补明确失败候选。
- [ ] 结果交付：原始/编辑分组、灯箱/关系画布、重生、单图、选图排序 ZIP、长图与不裁穿单屏的切片。
- [ ] 编辑：会话/分支记忆/血缘、完整画布、蒙版/保护/扩图、参考用途和顺序、澄清/确认/无需确认分支、多候选。
- [ ] 分割：fal、Grounded SAM、Gitee SAM3 的实际请求、文本/框能力、gzip RLE、空 mask 与像素/alpha 校验。
- [ ] 自动分层：视觉方案、三种元素来源、方案/hash 绑定、SAM/Seedream、背景、历史和实测 bbox。
- [ ] 图层编排：显隐/命名/排序、PNG/ZIP/真实 PSD；回读层序、坐标、RGBA、manifest 和合成预览。
- [ ] 套图工坊：全局多图/hints、真实进度、最近任务、编辑审阅、幂等 commit、入库后可规划生成。
- [ ] 模特库：原身份设计器、参考脸、候选缺口恢复、唯一 selected、筛选、资产库复用与安全删除。
- [ ] 正式花型：上传、两种提取、主题起稿、多候选、风格/构图衍生、完整 HSL、来源/父谱系、透明承诺校验。
- [ ] 花型草稿：PLACEMENT/REPEAT、CAS、稳定图号/颜色/草图/笔迹、五类批次操作、比较/删除/归档、attempt 隔离和幂等定稿。
- [ ] 验缝与接缝改稿：逐轴证据/算法版本、原图 hash 不变、小图边界、真实环绕输入、只回写边缘带。
- [ ] 印刷规格包：六品类、全部共享重复布局、尺寸/DPI/安全区、示意图、原生 tile、版本化 manifest。
- [ ] Listing：三平台、真实视觉输入、硬性文本/禁词校验、独立结果、复制与重启恢复。
- [ ] 成包流水线：既有花型及来源入口、SOURCE→TILE_CHECK→PRINT_PACK→LISTING、三种裁决、取消/重跑/代次隔离、终态再次执行。
- [ ] 持久队列：全部旧任务及新版入口显式分派、全局查询、并发上限、领域化重试、取消/关闭/崩溃恢复。
- [ ] 请求与产物：逐轮/逐候选/逐元素回执、响应后下载失败可恢复、UNKNOWN 不重发、部分产物保留、引用保护和可重入清理。
- [ ] 数据升级：合成真实 v1/v2、合法密文、原始快照/ID/文件引用保持、故障回滚、重复开库、外键/完整性、高版本拒绝。
- [ ] 原 UI：九路由及全部抽屉、画布、候选轨、比较、历史、中文错误、键盘和 reduced-motion；打包窗口验证画布读写及 SVG 平铺。
- [ ] 最终验证：在 `E:/EcomGen/desktop` 执行 `pnpm build`、`pnpm test`、`pnpm test:e2e:mock`；用本机假服务验成功、拒绝、失败、UNKNOWN、取消、重启、重复提交及迟到结果。
- [ ] 独立发布：EXE 运行同一业务矩阵，核原生模块和资源；隔离验证安装、桌面旧数据升级、卸载数据保留。包中无 legacy 运行依赖、旧服务/.env、用户数据或凭据。
- [ ] 文档：上述闭环全部通过后，才将 README 和 VALIDATION 标为完整迁移；记录未签名、真实模型质量等实际验证边界，不复用 0.2.0 的 220 项记录作为此次完成证据。