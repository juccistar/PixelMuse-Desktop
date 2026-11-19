# 模块功能地图

路由真相见[app/routes.tsx](../apps/desktop/src/renderer/app/routes.tsx)。页面经api/hooks调用contracts具名操作，Backend命令提交意图，长任务在execution/runtime执行。

| 模块与路由 | 用户能力 | 主要入口 |
| --- | --- | --- |
| 项目画廊 `/` | 新建、编辑、归档、恢复、永久删除、进入项目 | renderer/features/home，projects共享卡片 |
| 工作台 `/projects/:projectId` | 商品事实与角色素材、采集、配置；AI/手选模板/套图及主图/SKU/详情图片规划；规格目录、显式共图、分镜确认、多候选生成、审核、文案、编辑/分层和导出 | renderer/features/workbench；backend/commands与execution |
| 资产库 `/library` | 七类资产筛选、分页、预览、保存、按类型复制到项目 | renderer/features/library |
| 套图工坊 `/suite-forge` | 多图反推、进度与历史草稿、编辑、确认入库后进入项目使用 | renderer/features/suite-forge；agent/ecom-suite-forge |
| 模特库 `/models` | 人物身份、参考脸、定妆照候选、人工选定与删除 | renderer/features/models |
| 花型库 `/patterns` | 上传、分割/生成式提取、主题起稿与正式花型浏览 | renderer/features/patterns |
| 花型工作区 `/patterns/:patternId` | 本地改色、生成式变体、验缝、印刷包、示意图、Listing、成包流水线 | patterns；backend/execution的pattern/print/pipeline实现 |
| 草稿列表 `/pattern-drafts` | 创建、归档、恢复和删除未定稿创作 | renderer/features/pattern-drafts |
| 起稿工作台 `/pattern-drafts/:draftId` | revision CAS自动保存、参考图、批次/槽位/候选、笔迹/接缝改稿、去底、改色、比较与显式定稿 | pattern-drafts；草稿commands/execution |
| 设置 `/settings/:section` | 常规、模型、用量、工作空间与数据、搜索采集、软件更新、关于 | renderer/features/settings |

StoryboardStage显示紧凑分镜规划卡片，仅用实际引用的项目图片作为参考；卡片区域可滚动，底部选择数量与确认生成始终可达。ResultsWorkspace显示成图数量、独立下载选择与紧凑导出工具栏，ReviewStage按主区域可用宽度排列画廊。同一生成批次与分镜的候选默认叠放，悬停或聚焦可左右切图、重新生成、下载或进入灯箱，也可展开全部候选缩略条；查看候选不改变已选下载集合。刷新保留当前图，新增结果置于叠层前方，原结果与编辑版本保留。ResultsWorkspace为显式重新生成分配regenerationKey，单图快捷操作固定candidateCount=1，同键重放去重；活跃或未知请求由Backend拒绝另开意图。

参考素材预览由StoryboardStage统一管理，卡片与检查器使用同一多图预览；批量删除逐项调用既有删除命令，成功项取消勾选，受保护或失败项保留。公开Job契约携带storyboardItemId以关联实际画面，ReviewStage用当前QUEUED/RUNNING任务显示动态状态，只读历史不参与忙碌与中断判断。EditImageWorkspace仅在IPC提交前创建本地版本占位；持久turn查询决定后续状态，失败显示黑图红色提示，成功由实际Output取代，不生成虚构产物身份。

编辑规划在普通提示与结构化schema中都限定领域枚举。Backend将非法方案、空回复和未遵守蒙版映射为受控错误；公开错误只包含白名单代码和固定文案。用户主动重试已确定无效的方案时，归档原完整MODEL回执并保留用量，新请求获得独立代次；其余完整回执继续重放，UNKNOWN不自动重发。

两页共用JobRecords的一行执行摘要，按完整项目任务统计进行中、完成、失败与已中断。右侧任务抽屉按项目任务ID分页读取canonical getJob，关闭时不读取正文；保留过滤、历史结果和原资源保存。业务页隐藏时抽屉关闭；UNKNOWN任务可直接重试/结束，批量操作覆盖当前项目所有符合条件的任务而非仅当前页，不需要填表或二次确认。只读历史、执行中或领域关联过期的任务继续受保护。Listing、模特、花型流水线和单图编辑等上下文也提供对应恢复入口，操作后重新读取持久状态。

商品描述与补充说明的AI帮写沿用已有单任务流程。商品描述任务排队或运行时，界面和Backend均阻止补充说明任务；提交后者前等待在途保存并保存未保存的描述。页面重新挂载不会自动应用旧结果。

## 设置中心

| 分类 | 功能与边界 |
| --- | --- |
| general | 启动页、缩放、通知、创作默认参数；不改已有项目或冻结任务 |
| models | 模型列表、服务连接、默认用途和AI高级设置；API Key留空保留；变更用途/能力前检查引用影响 |
| usage | 请求级Token、未知值、条件筛选、币种分开估算、单价快照、CSV；不等同服务账单 |
| storage | 唯一工作空间位置入口、迁移进度/取消、失联重连、打开目录和数据说明 |
| search | 搜索源、项目采集入口与来源记录；人工确认参考用途 |
| updates | 检查、下载和安装软件更新；Pi随软件一起更新 |
| about | 版本/运行环境、固定目录和诊断导出 |

模型高级设置包括推理请求超时30–1800秒（默认240）、思考强度auto/off/low/medium/high（默认auto）、最大输出Token 512–65536（默认16384）及全局并发1–16（默认2）。推理参数在提交新任务时冻结；旧快照保留原有默认行为。并发调整影响后续认领，调低不取消活动任务。探测仍为轻量请求，搜索保留独立超时；Pi随软件更新交付。

## 长任务和数据流

原业务有20类任务；COPYWRITE内部包含Listing分支。完整注册表以[execution/index.ts](../packages/backend/src/execution/index.ts)与[runtime/ports.ts](../packages/backend/src/runtime/ports.ts)为准。不要另写第二份分派表作为事实来源。

常见修改路径：

1. 表单/画布在features收集意图并校验基础输入。
2. contracts定义输入和公开结果；main与Backend继续校验。
3. commands在同一事务创建Job、关联行和冻结快照，提交后唤醒队列。
4. execution通过RequestLedger执行受控外部请求并处理真实字节。
5. checkpoint核对attempt/runToken，发布产物与资源引用；settle更新关联状态。
6. 事件触发查询失效，页面读取已持久化结果。

## 能力表述

- Pi用于具体业务工作流，不是开放聊天或任意shell代理。
- PIXEL_PROTECTED要求本项目PRODUCT_TRUTH；普通远端整图生成不保证逐像素不变。
- 人工矩形分层不等于自动识别；SAM源RGB与alpha的合成、模型生成背景是不同路径。
- 取消请求不等于确认外部未收费。未知外部结果不能自动重试或通过换指纹绕过。
- 工作空间移除重复入口，不删除迁移、复制校验、繁忙拒绝或重连功能。
