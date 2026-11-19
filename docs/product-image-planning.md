# 商品图片规划与SKU维护

本文面向后续开发维护者，说明新增商品图片规划的业务边界与接线。界面参考图仅作设计展示，不作为商品事实、SKU种子数据或真实模型效果。发布与实际验证状态以[验证记录](../VALIDATION.md)为准。

## 用户工作流

图片规划分为主图、SKU图、详情图。主图和详情图配置画面数，SKU图由当前参与的规格及用户明确建立的图片组计算。每画面候选数仍是独立的生图设置，单张分镜可以覆盖项目默认值。

管理SKU时在右侧抽屉编辑名称、可选编码、任意规格属性、项目产品参考和参与状态。新增、复制、组合创建和分组都只修改本地草稿；保存采用版本校验和原子提交，失败时保留输入；冲突后可读取最新目录对照，须明确放弃草稿才载入，不自动合并。取消不会自动保存。复制条目使用新身份并清空编码。组合创建先检查笛卡尔积的数量与重复项，再生成可编辑的条目。

同外观规格共图需要用户显式建立并确认图片组。启用共图开关本身不推断颜色、尺码或容量是否相同；未归入已确认图片组的SKU仍独立规划。停用共图时，目录内规格身份保留，各参与SKU重新独立计算；重新启用可继续使用已确认的组。

例如主图5张、6个SKU明确共用3组图、每组1个画面、详情8张，合计16个画面；每画面2个候选时预计生成32张。关闭共图则为19个画面、38张候选。界面中的数量来自真实目录，不把示例商品自动保存到新项目。

商品准备集中素材与配置，“AI 一键规划”先等待保存再形成分镜；保存SKU或计数不调用模型。选择并确认当前分镜版本后才创建生图任务。新主流程提供模型自主规划和套图批量规划：自主模式直接读取商品图与参考图，按实际用途数量写每个画面的一份提示词；套图模式将完整镜头清单保存为项目实例，由镜头用途派生数量，每目标精确绑定镜头，不按另一份总数循环套用。自主模式可只借用套图风格，不采用其结构。明确的旧MANUAL单模板接口保留原模板校验，工作台新入口不依赖人工分类。取消未成图需求使用excludedTargetIds排除稳定目标，其他目标编号及历史归属保持不变。

套图镜头可编辑标题、用途、意图和创作指导，增删镜头同步数量；SKU镜头按用户明确的规格／共图组展开，未配置SKU镜头时不生成SKU画面。套图版本和镜头身份冻结，后续编辑不会改写在途任务。满意规划可提交抽象任务，移除商品专属事实后生成套图工坊草稿，需检查并确认后入库。

首页“套图批量创作”组织多个已有商品项目：逐商品检查和规划，显示各自进度和错误；用户检查后明确提交已就绪商品生图。批次记录只关联原有PLAN／GENERATE任务，状态和产物仍来自canonical任务查询。部分失败不抹除其他商品成功结果，重开可恢复批次查询，不自动从规划推进生图。共享参考来源需显式选择，只复制非商品参考图到各项目，不共享商品真值。

参考素材可从规划卡片与检查器打开多图预览，预览不改变选择。“删除所选”直接处理全部已勾选需求；已有成图、活动生成和中断屏障保护的画面不能删除，部分失败或受保护项保留选中并列出原因。成图与修改页按实际任务显示排队或生成动画，已有图片在再生成期间继续可看。单图编辑提交后立即出现加载版本占位，需补充/待确认分别显示，失败为黑色缩略图与红色感叹号，成功替换成真实独立版本。

## 数据所有权

SKU、共享组和规划配置属于项目聚合，由Backend在唯一SQLite连接保存。renderer只通过TypeBox定义的具名IPC访问，不读取SQLite或任意本地文件。目录采用整体revision进行乐观并发控制；无变化保存不制造新版本，过期保存拒绝覆盖他人的修改。

SKU属性以{name,value}数组表示，允许任意规格名称，避免把用户属性名变成对象结构或内部私有字段。引用必须属于当前项目，且为图像类型的PRODUCT_TRUTH；采集的STYLE_REFERENCE不能自动变成商品真值。当前项目商品图容量仍沿用原上限，多SKU可显式引用这些产品图，不因此放宽所有模型的附件限制。

用途MAIN/SKU/DETAIL与assetType模板、shotRole画面角色分别保存。每个新分镜保存当时的目标身份、用途、SKU名称/编码/属性快照、产品引用及来源指纹；过期和替代标记是独立的可变元数据。成图和编辑后代从实际生成证据继承安全的用途/SKU快照，不能查询今天的SKU目录来重新标记旧图。完整generationSnapshot继续私有。

旧项目没有SKU证据时保持空目录和未分类分镜/成图。替代规划不删除旧分镜身份、版本JSON、输出、编辑版本或回执；旧成图仍可查看和导出。修改SKU只使真正受影响的未生成规划待更新，其他手工描述和候选设置保留；生成中的任务继续使用提交时冻结的输入，结算后解除过期标志。已有产图的分镜沿用原规格语义；如需按修改后的规格创建新画面，应重新规划，不回写旧图。

## 通信与实现入口

| 入口 | 职责 |
| --- | --- |
| getProjectImagePlanning | 查询项目目录与规划配置，revision0表示尚未配置 |
| saveProjectImagePlanning | expectedRevision校验，原子保存配置/SKU/共图组，返回新目录及受影响分镜ID |
| createProductImagePlanningJob | 对已保存版本请求ALL或STALE规划；新主流程冻结视觉规划版本2，套图镜头来自保存目录，可选风格指导，返回持久PLAN及去重信息 |
| getSuitePlanningBlueprint | 从明确选择的套图生成可编辑镜头实例和内容版本 |
| createSuitePlanningBatch / getSuitePlanningBatch / listSuitePlanningBatches | 创建及聚合逐商品独立规划任务，持久保留部分错误 |
| generateSuitePlanningBatch / retrySuitePlanningBatch | 用户明确触发生图或重试失败项，成功结果保留 |
| createStoryboardSuiteJob | 抽象当前规划为可复用套图草稿，沿用套图工坊检查与确认入库 |
| getProjectWorkbench / saveProjectWorkbench | 查询与CAS保存采用版本和详情目标顺序；按冻结目标核对输出归属 |
| listProjectExports | 查询项目导出历史及公开资源地址；新导出冻结实际输出集合 |
| [domain/product-image-planning.ts](../packages/domain/src/product-image-planning.ts) | 规格/组/用途TypeBox模型、容量与纯目标解析 |
| [contracts/product-image-planning.ts](../packages/contracts/src/product-image-planning.ts) | 三个新具名操作的公开输入输出 |
| [core/schema.ts](../packages/core/src/schema.ts)与[database.ts](../packages/core/src/database.ts) | canonical v12及旧桌面数据库的显式事务升级 |
| [backend/product-image-planning.ts](../packages/backend/src/product-image-planning.ts) | 目录默认态、目标指纹及共享业务辅助 |
| [commands/product-image-planning.ts](../packages/backend/src/commands/product-image-planning.ts) | 查询与保存处理器 |
| [commands/product-image-planning-jobs.ts](../packages/backend/src/commands/product-image-planning-jobs.ts) | 规划提交、版本及活动/未知请求屏障 |
| [execution/product-image-planning.ts](../packages/backend/src/execution/product-image-planning.ts) | 有界批次、上下文、真实已产图判断与发布辅助 |
| [execution/image-work-barrier.ts](../packages/backend/src/execution/image-work-barrier.ts) | 项目启用判定与重试/编辑入口屏障，包含revision0默认目录的新规划 |
| [StoryboardStage.tsx](../apps/desktop/src/renderer/features/workbench/StoryboardStage.tsx) | 图片规划主区域、数量、用途分组、选择与确认 |
| [SkuManagerDrawer.tsx](../apps/desktop/src/renderer/features/workbench/SkuManagerDrawer.tsx) | 可取消的规格草稿、组合/共图预览和显式保存 |

## 执行与安全约束

一次产品规划使用一个持久PLAN任务，冻结目录、项目、目标和资源；内部按用途和SKU图片组作确定性小批次，每次规划最多12个画面。单次产品规划整体最多96个画面；目录可暂存超限选择，但提交规划必须明确拒绝超限，不能静默截断。

每画面只有一份最终提示词。候选数只保存于本地配置、分镜和任务快照，不进入规划模型的系统提示词、任务文本、JSON上下文或输出schema，也不写入最终生图提示词。Agent在模型返回后从本地冻结配置绑定candidateCount；每画面2候选意味着程序发起2次独立图片模型请求，每次1张，提示词、附件和有效参数相同，各自有稳定请求身份。用户显式修改单张分镜候选数的能力保留。修订时首候选先执行一次提示词修订并持久保存，其他候选等待并共享该结果；修订中断保留UNKNOWN，不派生新的提示词或隐式发送图片请求。

mode必须严格等于冻结的defaultMode，提示词也须按该模式编写。完整回复冲突最多纠正一次，要求返回完整方案并重写冲突提示词；持续冲突则失败，不靠后端改标签放行。新版视觉规划还校验实际视觉能力、商品附件、所选参考和提示词句柄，不静默过滤未知句柄或截断超限参考。此校验不等于已证明任意自然语言提示词或真实图片的全部语义。

不同批次有独立且稳定的外部请求身份，沿用统一视觉约束，全部校验成功后才在一个事务内发布。失败、取消或未知不能伪装为完整规划；独立PLAN符合条件时可仅重放已有完整回执；缺少后续回执则失败并保留数据，不发新模型请求。迟到发布须检查来源是否仍新鲜。SKU图的像素保护使用该目标显式选择的当前项目真值子集，避免把其他颜色一并交给模型；旧普通分镜保留原规则。远端整图生成仍不能保证逐像素不变。

确认继续携带当前分镜版本；未完成、过期或被替代的草稿不得进入新生成。活动/未知请求不能通过改变目录版本、目标身份、分镜ID或regenerationKey绕过去重和外部请求账本。业务状态仍来自查询，事件只触发重查。

执行摘要继续占一行。SKU与任务详情共用右侧抽屉空间，不能同时展开；离开项目、进入设置或切换抽屉时保护未保存草稿，隐藏业务页不得留下可交互的portal。分镜编辑关闭与切换统一等待保存，失败保留输入，明确删除时取消尾随防抖。规划提交回执不确定时，跨阶段重新进入继续复用原意图；会话仅保存SHA-256摘要与随机提交键。单图下载按原生文件名边界保留扩展名和完整Unicode码点，避免长共图标签阻止保存。

## 验证入口

[reference-led-planning-acceptance.mjs](../scripts/reference-led-planning-acceptance.mjs)验证新版自主规划、镜头编辑、保存套图、批量确认与重开；[product-image-planning-acceptance.mjs](../scripts/product-image-planning-acceptance.mjs)保留SKU规划专项；[project-workflow-v2-acceptance.mjs](../scripts/project-workflow-v2-acceptance.mjs)覆盖三阶段工作台、采用重开、单图修改与导出恢复。两者均在隔离数据下驱动真实Electron，使用本机假Provider、合成图像和真实SQLite/ZIP；不调用真实模型、不执行安装器。每次指定新的空证据目录。相关持久化、迁移、契约、执行快照与界面行为回归按实际改动范围运行，不能沿用旧版完整验收结论。实际通过范围和限制记录在VALIDATION.md。
