# PixelMuse 验证记录

工作区整理注（2026-11-09）：旧记录中的失败打包大文件及写入测试副本已按[清理清单](docs/cleanup-record-20261109.json)移除，诊断元数据按原始字节归档；旧路径与新位置可通过该清单追溯。正式版本、最终报告和截图保留，源码、编译运行文件及45个历史版本关键文件的前后哈希一致。本次清理未执行新的应用构建、业务测试或安装验收，不改变下述各版本的实际验证范围。

## 0.5.0参考图驱动规划打包与公开发布（2026-11-12，已发布）

[PixelMuse 0.5.0](https://github.com/juccistar/pixelmuse-releases/releases/tag/v0.5.0)已正式发布并设为GitHub最新稳定版。应用manifest与独立输出目录更新为0.5.0，保留安装身份、原userData、旧版本产物及历史证据。打包前冻结[295个编译运行文件](.cache/release-0.5.0-source-fingerprint-20261112.json)，业务运行指纹为`0d28f2e28ca720bc9197e3758f89f568955fe7c24b4a80bf0d92c9470e4b6b7c`。

本次发布沿用下方开发阶段22文件314项相关专项和Source窗口结果，只补产品版本与发布边界所需的检查，没有因版本号递增重跑全工作区构建、全量测试或完整历史窗口套件。先执行`pnpm --filter @ecomgen/desktop build`，再执行该应用的`run dist`；dist固定`--publish never`，上传与公开发布随后单独执行。

| 检查 | 实际结果与证据 |
| --- | --- |
| 产品构建 | [桌面类型检查与Electron构建](.cache/release-0.5.0-desktop-build-20261112.log)通过；必要业务依赖已在开发阶段构建 |
| NSIS打包 | [Windows x64安装器日志](.cache/release-0.5.0-package-20261112.log)记录成功，输出位于`release/0.5.0/` |
| 发布静态检查 | [13/13通过](.cache/release-0.5.0-static-20261112.json)，覆盖实际版本、入口、生产依赖、原生资源与数据卫生 |
| 安装器内容 | [3843个应用文件逐个哈希一致](.cache/release-0.5.0-payload-20261112.json)，与`win-unpacked`相符；未执行安装器 |
| 实际解包EXE | [3场景32断言通过](.cache/release-0.5.0-exe-20261112-1/result.json)，rendererErrors与cleanupErrors均为空；覆盖自主规划、套图镜头／草稿、批次明确生图、离开隐藏与重开查询 |
| 编译与产物绑定 | [最终绑定报告](.cache/release-0.5.0-binding-20261112.json)核对295个运行文件、Source／EXE指纹、ASAR／EXE／安装器哈希及更新元数据 |
| 草稿附件核验 | [草稿报告](.cache/release-0.5.0-draft-verified-20261112.json)核对发布ID、目标commit、三个附件大小及服务端SHA-256 |
| 公开发布核验 | [无需认证的公开报告](.cache/release-0.5.0-public-verified-20261112.json)确认v0.5.0为stable/latest、仅三个预期附件且大小／服务端摘要一致，实际下载`latest.yml`并核对版本、大小和SHA-512 |

开发阶段Source窗口报告中的产品元数据仍为0.4.8，其业务编译指纹与0.5.0解包EXE完全一致；绑定报告明确保留这一差异，没有把旧报告版本改成0.5.0。已查看EXE的自主分镜及重开批次截图，使用隔离userData、合成素材、本机假Provider和真实IPC／SQLite。

发布附件如下，表中为本地与GitHub服务端一致的SHA-256：

| 附件 | 字节数 | SHA-256 |
| --- | --- | --- |
| [PixelMuse-0.5.0-x64-Setup.exe](release/0.5.0/PixelMuse-0.5.0-x64-Setup.exe) | 177854905 | `59bee50adff6eac9267fdfbf662a6dfec5431f90b4f13cb72deea6117f87a42b` |
| [latest.yml](release/0.5.0/latest.yml) | 355 | `76a732fec4bb7646e596a31e134b1d6479c433a3de56e522de136d1c733931bb` |
| [PixelMuse-0.5.0-x64-Setup.exe.blockmap](release/0.5.0/PixelMuse-0.5.0-x64-Setup.exe.blockmap) | 185431 | `bb7da834d8370c861d583165d902e5e6566e59579da2f81e3a98f1b1ad4fbb32` |

更新清单中的安装器大小为177854905字节，SHA-512为`fGh/uNZYbRIfwknG+i4TGcbymAR6tiK3E8yegUtMmdVWg/FlzdEY1/ttYVDDlEnNJFd6BMn3P1dI/P3G7xPaDg==`。本机直接访问GitHub网页下载地址曾ECONNRESET或连接超时，最终改用无需认证的公开Release附件API下载并核验同一`latest.yml`；网页下载路由未验证通过，也未从公开地址重新下载整个安装器。

发布标签内容仅为发布仓库的README；本次只上传上述三个附件，没有上传本地原始工程、测试数据或报告，也未创建源码Git提交或推送。安装包仍包含运行所需的编译后JavaScript，不能视为客户端实现不可见。

本轮未访问真实用户数据库或真实模型，未执行实际安装、已安装路径启动、覆盖升级或卸载，未配置Windows代码签名。v12迁移使用已有隔离合成库专项；升级前退出并备份完整userData和当前媒体工作空间，不能用0.4.8或更旧版本打开已升级的同一数据库。真实图片风格质量仍需单独评估。

## 参考图驱动自主规划与套图批量创作（2026-11-12，源码开发阶段，发布见上方）

新版工作台使用显式视觉规划版本2及MODEL_DIRECT／SUITE来源；自主规划不再注入人工分类目录、模板工具或固定角色序列。实际商品／参考图、比例与分辨率进入冻结请求，套图镜头决定用途数量并按SKU组展开。候选数从规划模型输入、输出schema和生图提示词移除，由本地配置绑定；每画面一份提示词，按候选数发起独立图片调用，修订只执行一次并持久共享。跨商品批次关联既有任务，逐商品保留事实、素材、部分成功与错误，用户确认后才生图；满意规划可抽象为工坊草稿再检查入库。

本轮涉及契约、迁移、队列恢复与界面，故构建必要依赖链及Agent／Backend／desktop应用，并对这些实际边界运行专项，没有扩展为全工作区业务回归。canonical v12新增规划来源、批次关联与共享修订表，旧分镜、设置、产物和请求记录保持原义。

- 自动专项[按最新执行结果去重汇总](.cache/reference-led-planning-20261112-final.json)：**22文件、314项通过**。包含规划与套图Agent、真实Backend／SQLite／Pi与本机Provider、v12及旧库迁移、公开契约、调度和项目屏障，以及保存顺序／草稿／分镜等相关renderer行为。筛选复验不重复计数，未将未执行的筛选行算作新的通过。
- 真实执行验证6画面只有6份提示词，2候选产生12次独立图片请求，同画面请求提示词／附件相同、幂等身份不同；SKU商品子集隔离、模式纠正、UNKNOWN、共享修订断线与重启、两个商品部分失败和原候选批量恢复均有专项证据。
- 最终受影响应用包构建记录见[构建日志](.cache/reference-led-build-20261112-final.log)；内部包按dist导出，构建后才进行真实窗口验收。未修改根依赖、锁文件、Electron或原生模块版本。
- 真实Electron使用隔离userData、合成图片和本机假Provider，操作自主规划、镜头编辑及数量绑定、保存套图草稿、跨商品批次明确生图及重开；最终**3场景、32断言通过**，rendererErrors和cleanupErrors均为空，结果见[窗口专项](.cache/reference-led-source-20261112-3/result.json)。已查看[自主规划](.cache/reference-led-source-20261112-3/autonomous-storyboard.png)、[套图镜头编辑](.cache/reference-led-source-20261112-3/suite-shot-editor.png)和[重开后的批次完成状态](.cache/reference-led-source-20261112-3/batch-completed-reopened.png)。最终运行编译指纹为`0d28f2e28ca720bc9197e3758f89f568955fe7c24b4a80bf0d92c9470e4b6b7c`。没有将假Provider成图作为真实质量证据。

过程证据保留：[首轮自动专项](.cache/reference-led-planning-20261112-initial.json)发现纯本地退役不应要求模型、批次字符串错误被按Job错误投影，以及测试使用旧模型更新输入；修正后[相关Backend复验50项](.cache/reference-led-planning-20261112-backend-fixes.json)通过。后续[边界专项](.cache/reference-led-planning-20261112-boundaries.json)发现同画面候选原互斥检查阻挡批量恢复，并存在缺少新商品输入的旧夹具、旧界面控件和离线契约目录断言；修正生产边界并更新夹具／目录后，[4文件复验](.cache/reference-led-planning-20261112-boundaries-final.json)除一个UI用例整组运行超时外通过，该用例保持原时限[单项复验](.cache/reference-led-planning-20261112-ui-final.json)通过。首次Backend构建的规划快照类型缺字段已补齐。首轮窗口驱动误收起默认展开区域，修正驱动后通过，最终再次核对构建后窗口及跳转隐藏行为；未放宽测试时限或把失败结果伪作成功。

上述源码开发阶段未运行完整历史业务／采集／设置窗口套件，未评估用户商品的真实模型风格效果与服务计费；未读取真实用户库、执行安装／升级／卸载、打包、发布、Git提交或推送，应用manifest当时仍为0.4.8。随后已将本阶段功能打包并公开发布为0.5.0，追加验证见上方发布记录，旧0.4.8安装包保留原行为。下方2026-11-10的候选数字段严格返回规则为历史记录，已由本轮“候选数只由程序执行”的语义替代；模式严格校验仍保留。

## 规划候选数与模式一致性修复（2026-11-10，源码维护，未发布）

规划系统规则和每次任务指令将candidateCount与mode明确为冻结配置分配的固定值。返回字段必须分别严格等于candidatesPerType与defaultMode，不再静默补值、取整或替换模式。完整回复不一致时沿用一次纠正，重申两项配置并要求重写冲突的最终提示词；第二次仍不一致则失败。商品规划发布直接保留校验后的字段和提示词，不再覆盖成项目值掩盖冲突。此修改不涉及其他已发现的保存屏障、草稿、图片比例或套图工具指令问题。

- Agent与Backend两个包构建通过；未修改根配置、锁文件、数据库或IPC契约。
- [规划单元测试](.cache/planning-settings-fix-unit-20261110.json)：1文件38项通过，覆盖AI／手动模板／套图及两种模式、候选数严格相等、错误模式、完整方案纠正与最多两轮。
- [Backend专项](.cache/planning-settings-fix-backend-20261110.json)：4文件51项通过，包含新增5项真实Backend、SQLite、Pi、本机HTTP/SSE验证，以及既有商品规划、生命周期和执行器回归。新增场景验证正确方案一次发布、候选数／模式冲突分别纠正、完整错误回执重放不新增请求，以及断线UNKNOWN不进入纠正或发布。
- 合计5文件89项通过，无失败或跳过；全部使用隔离合成数据与假Provider，不代表真实模型质量或自然语言语义已被全面校验。

本轮未运行实际Electron窗口、全工作区测试、完整窗口验收或重新打包／发布。公开0.4.8安装包保持原有行为。Prompt版本会随规则变化，旧回执仍受原请求指纹约束，不因本次修改放宽重放或隐式重发。

## 0.4.8 Pi SDK、高级设置与首次 GitHub 发布（2026-11-09，已发布）

Pi Agent Core 与 Pi AI 精确升级为1.5.0，开发Node要求>=22.19.0，SDK随软件版本交付。模型配置增加推理超时、思考强度、最大输出Token及全局任务并发；新任务冻结推理参数，降低并发不取消在途任务。canonical v10→v11为应用设置补入AI默认值，保留旧任务快照和回执。两处帮写沿用单任务流程，活动商品描述任务阻止下方说明帮写；提交下方前等待并保存未保存描述，后端在建单事务中检查活动依赖。重挂不自动采用旧结果，结果读取失败提供重新读取入口。

旧冻结任务没有AI参数时，保留原promptVersion/session缓存身份，不添加新输出上限；新任务使用参数敏感的身份。实际SDK请求字段由专项测试验证，仍严格检查完整请求指纹，不清空COMPLETED/UNKNOWN证据。SDK升级不能据此承诺所有跨版本请求都能重放，其他实际请求差异仍会被拒绝。搜索调用保留独立超时，不让推理超时覆盖搜索配置。

[最终全工作区构建](.cache/pi-advanced-final-build-20261109-2.log)已通过。首次全量[测试报告](.cache/pi-advanced-tests-20261109-1.json)执行165文件1791项，1775项通过、16项失败，无跳过；旧控件名称、旧契约数量/版本断言、UNKNOWN夹具和显式输出上限断言已修正，保留失败报告。一个既有交互用例超时，未放宽时限或修改该用例；[完整失败文件及全部Agent复测](.cache/pi-advanced-tests-20261109-2.json)20文件241项全部通过。按每文件最新结果[去重汇总](.cache/pi-advanced-tests-final-20261109.json)为166文件1793项全部通过，无失败、无跳过，不能把重复轮次相加。Agent覆盖两种真实本机协议、七个业务入口、工具→搜索→模型链、EOF/回执屏障、取消、截断、禁止隐藏重试和离线重放；新增旧会话身份/实际SDK请求字段检查。第一次最终构建因测试夹具没有generationBatchId字段而失败，改为断言其实际jobId后再次全包构建通过。

| 检查 | 本轮最终结果与证据 |
| --- | --- |
| Source窗口 | [高级设置4场景21断言](.cache/pi-candidate-20261109-1-ai-source/result.json)＋[规划/编辑4场景42断言](.cache/pi-final-edit-source-20261109-4/result.json)，共8场景63断言通过 |
| 解包EXE窗口 | [高级设置4场景21断言](.cache/pi-candidate-20261109-3-ai-exe/result.json)＋[规划/编辑4场景42断言](.cache/pi-final-edit-exe-20261109-4/result.json)，同样8场景63断言通过 |
| 生成安装器 | [最终NSIS日志](.cache/pi-candidate-20261109-3-package.log)：从同一完成的win-unpacked打包，publish never，没有重建冻结编译 |
| 发布静态检查 | [13/13通过](.cache/pi-release-static-20261109-4.json)，ASAR内两项Pi依赖实际均为1.5.0 |
| 安装器内容 | [3843个应用文件逐个哈希一致](.cache/pi-installer-payload-20261109-4.json)，根Chromium debug.log单列，未执行最终安装器 |
| 编译与产物绑定 | [最终绑定](.cache/pi-release-binding-final-20261109.json)：287个编译文件、Source/EXE、ASAR/EXE/安装器哈希、latest.yml版本/大小/SHA-512及SDK版本相互核对 |
| 公开发布 | [正式v0.4.8](https://github.com/juccistar/pixelmuse-releases/releases/tag/v0.4.8)；[无需认证的公开核验](.cache/pi-public-release-verified-20261109-1.json)：stable/latest、三个附件名称/大小/服务端SHA-256摘要匹配，实际下载latest.yml并核对版本/大小/SHA-512 |

四份最终窗口报告编译指纹均为`8e16df70526c9a47611e16f70ad7b513f424406d81d49aef6cfbae97b719c8de`，rendererErrors与cleanupErrors均为空。实际Electron内置Node为24.22.2，满足Pi SDK的Node要求。已查看源码和EXE的高级设置、帮写状态/内容、批量删除、生成动画、失败黑图红色提示和真实V2截图。旧0.4.6安装器[哈希复核](.cache/pi-old-package-preserved-20261109.json)仍与冻结证据一致。

[0.4.8安装器](release/0.4.8/PixelMuse-0.4.8-x64-Setup.exe)为177,744,775字节，SHA-256为`76e86e05296361e2b23623da4c2b5826a78c9f28948db4c931750c85e14acace`。GitHub只上传安装器、latest.yml与blockmap；没有上传源码、测试数据或本地报告。没有创建源码Git提交或推送。

首轮打包在Windows写入解包EXE时失败，失败目录保留为`release/0.4.8-failed-20261109-1`；第二轮成功写入ASAR完整性，但NSIS报无法打开输出文件，失败NSIS产物保留为`release/0.4.8-nsis-failed-20261109-2`。第三轮从已完成的解包目录正常生成安装器，没有关闭完整性检查、停止无关程序或执行最终安装器。首次[EXE编辑专项](.cache/pi-candidate-20261109-3-edit-exe/result.json)未实际画出蒙版，重试后合法进入“需要补充”；驱动原先只等canvas尺寸，未等编辑会话及图像解码。补齐会话/图像/画布就绪、实际覆盖像素和请求hasEditMask断言后，Source/EXE该组均重新完整执行4场景42断言通过，未修改生产代码、放宽超时或伪造蒙版数据。最早Source编辑4场景38断言仍保留为早期报告，最终只采用上表两份42断言报告。

本轮未重跑历史64业务＋14采集工作空间＋5设置的完整窗口套件。窗口使用隔离userData、合成素材、本机假Provider和真实IPC/SQLite，不能等同真实模型质量、真实用户库升级、安装器安装、已安装路径运行、覆盖升级或卸载验收；上述范围均未实测，未配置Windows代码签名。canonical v11升级后不能用旧0.4.6打开同一数据库，原用户数据与旧安装包未改写。

## 0.4.8软件更新模块（2026-11-09，源码维护）

新增“设置 → 软件更新”，固定公开更新仓库为`juccistar/pixelmuse-releases`，检查时仓库公开且尚无正式Release（GitHub latest接口404）。主进程使用electron-updater6.8.11的独立网络session，renderer只调用具名application操作；更新地址、下载路径和安装命令不能由页面指定。显示版本、检查时间、纯文本说明、下载进度/速度，支持取消与失败重试；默认仅启动检查，不自动下载、普通退出不安装，不接受预发布或降级。检查错误区分未发布、缺少更新元数据与网络失败。源码/解包运行显示手动下载入口，自动安装限定Windows x64安装版；安装标记与本地NSIS模板的卸载器名称核对一致。

安装保护覆盖主进程已接受的原生操作、Backend已接受命令和持久队列，暂停新认领后再次检查QUEUED/RUNNING及工作空间迁移。繁忙保留已下载状态，关闭失败/超时禁止启动安装器；严格关闭要求closed确认和零退出码，超时不由更新路径强杀后台。恢复等待旧进程实际退出，取消维护采用有界幂等重试；恢复失败明确要求重启应用并保留保护。安装器沿用库校验、文件选择和参数，扩展启动确认，仅收到子进程spawn后退出应用；启动失败不把应用退出视为安装成功。进程spawn不代表UAC、安装或新版本启动成功。

| 检查 | 实际结果与证据 |
| --- | --- |
| 相关测试 | [最终逐文件汇总](.cache/software-update-final-20261109.json)：8文件58项全通过，按各文件最新结果去重，无跳过 |
| 更新服务与界面 | [首轮24项](.cache/software-update-ui-service-tests-20261109-1.json)覆盖状态查询、并发去重、偏好持久化、取消迟到回执、失败重试、固定公开提示、纯文本说明与设置草稿；[最终服务/安装器17项](.cache/software-update-installer-tests-20261109-1.json)补齐恢复失败和异步/同步启动确认 |
| 安装与工作空间 | [严格关闭及首轮](.cache/software-update-lifecycle-tests-20261109-1.json)、[最终Backend/工作空间24项](.cache/software-update-lifecycle-tests-20261109-2.json)，覆盖真实SQLite的接受中命令、维护取消、排队/运行拒绝、迁移繁忙、关闭确认及超时不杀进程 |
| 构建 | [依赖安装](.cache/software-update-dependency-20261109-1.log)、[全部非desktop工作区构建](.cache/software-update-backend-build-20261109-1.log)、[最终desktop类型检查/Electron构建](.cache/software-update-desktop-build-20261109-3.log)通过 |
| 实际窗口 | [最终Source第2轮](.cache/software-update-source-20261109-2/result.json)：1场景17断言通过，0个renderer错误，固定链接、参数拒绝、开关保存/切页与两次重启恢复通过；测试数据正常清理 |
| 实际下载组件 | [独立Electron下载夹具](.cache/software-update-source-20261109-2/updater-fixture.json)：真实NsisUpdater访问本机generic源，正确SHA-512文件实际下载成功，错误文件实际请求后以ERR_CHECKSUM_MISMATCH拒绝；所有安装、退出安装及重启钩子硬拒绝，未执行下载文件 |

已查看最终[软件更新页面](.cache/software-update-source-20261109-2/source-update-unsupported.png)及[重启后偏好](.cache/software-update-source-20261109-2/source-update-restarted.png)。Source编译指纹为`56d1383124636799eb4e9a3c3604442629d61a21b2124e60dd704e956e5529de`。实际窗口使用隔离userData和生产renderer/preload/main/Backend，下载夹具是独立测试进程与合成非可执行字节，不能等同GitHub安装包或覆盖升级验证。

早期失败证据保留：生命周期首轮27/29通过，一项新增测试返回缺少nextCursor，修正夹具；另一项既有工作空间真实进程测试在published阶段等待超时，未放宽超时，完整相关两文件复测24项通过。桌面首次类型检查发现测试Promise<void>/Promise<undefined>声明不匹配，修正注解后构建通过。[窗口首轮](.cache/software-update-source-20261109-1/result.json)在启动器阶段退出且未取得窗口/运行哈希，原因未确定；最终轮增加隔离启动诊断，并以普通入口完成后续两次重启，未修改生产代码去绕过首轮失败。

本轮按用户要求只做相关专项，未重跑完整测试或64业务+14采集工作空间+5设置套件。未新增SQLite结构版本，保留此前canonical v10。未生成0.4.8安装器、未上传GitHub资产、未创建或发布Release、未安装/覆盖升级/卸载、未配置代码签名、未提交或推送。应用dist脚本固定`--publish never`。旧0.4.6不包含更新入口，首个支持更新的版本仍需手动安装；发布与实际安装验收步骤见[软件更新说明](docs/software-updates.md)。

## 0.4.7规划预览、生成反馈与编辑失败修复（2026-11-09，源码维护）

图片规划卡片与检查器共享多图参考预览，打开预览不改变勾选。新增“删除所选”，直接处理全部所选需求，成功项移出选择，受保护或失败项保留选中并显示原因。成图任务通过公开storyboardItemId关联画面，QUEUED/RUNNING显示动态状态，再生成保留已有图；只读历史不参与当前忙碌和中断判断。编辑器在提交IPC前立即显示不可选择的版本占位，分别表示规划、生成、待确认与需补充；失败为黑色缩略图和红色感叹号，成功由实际产物替换，切换基图后重新读取的终态优先。

对实际用户库和已保存回执做了只读诊断：最近四个失败均发生在EDIT_PLAN，HTTP 200回执完整且哈希有效，JSON中的operation或executionMode使用了领域不支持的枚举；未进入图片生成。原提示只说明字段类型，未列举允许值，校验错误又被压成INTERNAL_ERROR。本次明确列出操作/执行方式及输入约束，保留严格校验；合法NEED_INPUT可带蒙版返回澄清且不生图。非法方案、空内容、未遵守选区采用固定安全错误码与中文提示，澄清内容从公开plan读取，私有输入及Provider原始错误不外露。

用户主动重试已确定无效的EDIT_PLAN时归档原完整MODEL回执，保留历史用量，新请求使用独立代次；有效回执仍重放，UNKNOWN仍不自动重发。旧INTERNAL_ERROR仅在可验证的完整OpenAI Chat SSE回执明确含非法枚举时归档，复用规划器JSON解析支持Markdown围栏，并支持结束后的独立usage块；其他协议、截断、不可解析和非枚举错误原样保留，不能据此宣称全部旧失败可恢复。诊断没有改写、升级用户库，没有保存或输出用户原文、素材或密钥，也未发起真实模型调用。

相关验证按各文件最新结果去重为10文件132项：后端/agent六文件84项，界面四文件48项，均通过。证据：[后端专项](.cache/edit-feedback-backend-tests-20261109-1.json)、[独立usage块补修后的执行器22项](.cache/edit-feedback-executors-tests-20261109-2.json)、[界面首轮](.cache/edit-feedback-ui-tests-20261109-1.json)、[编辑器与规划第二轮34项](.cache/edit-feedback-ui-tests-20261109-2.json)、[最终执行器23项与编辑器31项](.cache/edit-feedback-boundary-tests-20261109-3.json)。界面首轮40/42通过，发现提交失败的中文提示被占位处理覆盖，以及AntD测试固定标题ID影响预览重开查询；修正后对应两文件34项全通过，保留失败报告，不放宽超时。后端依赖、最终Backend与桌面类型检查/Electron构建通过，日志分别为[依赖构建](.cache/edit-feedback-backend-build-20261109-1.log)、[最终agent/Backend](.cache/edit-feedback-backend-build-20261109-3.log)、[最终桌面](.cache/edit-feedback-desktop-build-20261109-3.log)。契约目录重新生成，154公开操作、156目录条目。最终边界复核额外覆盖提交回执在A→B→A切换期间到达的6种时序（成功/失败/待确认），以及带Markdown围栏的旧无效回执。成图网格保持常规卡片宽度，避免单张卡片拉满页面而把加载提示挤出窗口。

[最终Source窗口第3轮](.cache/edit-feedback-source-20261109-3/result.json)4场景38断言全部通过，rendererErrors与cleanupErrors均为空；[最终逐文件汇总](.cache/edit-feedback-final-20261109.json)绑定132项测试、窗口结果和编译指纹`5d749e154665bdc03ed4feb28c36c05f0812bf677dab1af5c23be1209a036da6`。实际点击验证多图预览不改选择、两张一次删除且窗口最终仅剩未选目标、生成动画位于可视区并阻止重复提交、点击编辑立即占位、非法方案黑图红色感叹号、直接重试仅增加一个规划请求与一个图片请求、保留旧用量及原图、真实V2替代占位，以及带蒙版的NEED_INPUT没有图片请求。已查看最终[批量删除](.cache/edit-feedback-source-20261109-3/03-batch-delete.png)、[成图加载](.cache/edit-feedback-source-20261109-3/04-generation-pending.png)、[即时版本占位](.cache/edit-feedback-source-20261109-3/06-edit-planning-placeholder.png)、[失败黑图红色提示](.cache/edit-feedback-source-20261109-3/07-invalid-edit-plan.png)、[成功新版本](.cache/edit-feedback-source-20261109-3/09-retried-edit-result.png)和[需要补充](.cache/edit-feedback-source-20261109-3/10-masked-clarification.png)。

窗口早期报告保留：[首轮](.cache/edit-feedback-source-20261109-1/result.json)因AntD按钮加载图标改变可访问名称，自动化误等到失败后检查禁用状态；修正选择器，不移除防重复断言。首轮截图还发现单卡被拉满导致加载提示靠近屏幕底部，已改为保留常规网格列宽并增加可视区断言，同时等待删除后的窗口查询完成再截图。[第二轮](.cache/edit-feedback-source-20261109-2/result.json)前三场景通过，澄清界面已显示但驱动查询原图新建会话而非V2所属会话；改为从实际编辑产物读取会话身份，最终第三轮全通过。没有放宽超时或改写测试数据使任务伪装成功。

本轮未重跑完整测试或64业务+14采集工作空间+5设置套件，未打包、安装、提交或推送。已有0.4.6安装器与解包EXE不包含本轮修改；假Provider验证不代表真实模型质量、真实用户库升级或安装/升级/卸载验收。

## 0.4.7直接恢复任务（2026-11-08，源码维护）

中断任务改为直接点击“重试任务”或“结束任务”，移除逐请求核实表、依据填写、风险勾选及重试费用确认。项目任务详情提供“重试异常任务”和“结束中断任务”，覆盖项目全部符合条件的任务，不限当前页10条；部分任务无法处理时返回具体原因。单图编辑和图层识别/导出面板也能直接处理并重读结果。结束最后一个中断生成候选后，规划卡片按现有成图恢复为“已生成”或“已确认”，仍有活动候选则保留忙碌状态。

后台保留历史UNKNOWN及历史用量，记录用户的任务级重试/结束动作，不将其伪装成服务商确认失败。重试保留冻结输入、成功产物和有效回执，新增请求使用独立用量代次；结束不发送请求。批量重试仅允许目标与指纹独立的既有生成意图成组恢复，仍检查同画面活动任务、执行代次、关联身份及回执。canonical v9→v10替换中断处置约束，保留旧审计历史、密文、回执和游标；缺失错误code不能通过SQLite NULL逻辑绕过终结约束。当前源码为v10，旧0.4.6安装包为v9，不能用旧包打开已升级的库。

| 检查 | 实际结果与证据 |
| --- | --- |
| 相关测试 | [最终逐文件汇总与窗口绑定](.cache/direct-recovery-final-20261108.json)：10文件实际执行127项全部通过；按各文件最新运行去重，编辑器文件仅执行新增1项，其余20项跳过且不计入通过数量 |
| 数据与任务边界 | 包含SQLite升级、UNKNOWN历史保留、独立用量代次、完整回执重放、取消/重启/重试、13个批量候选中12个成功且1个损坏项保留、取消中的UNKNOWN纳入批量、跨项目隔离、同画面防重复执行、结束不覆盖已接管的编辑/生成任务 |
| 界面专项 | JobRecovery与JobRecords共19项、单图编辑1项、LayersPanel全文件7项通过，覆盖直接操作、提交中防重复、无核实/确认弹窗、批量及处理后重读 |
| 构建 | [业务依赖首次构建](.cache/direct-recovery-backend-build-20261108-1.log)、[core最终构建](.cache/direct-recovery-core-build-20261108-2.log)、[Backend最终构建](.cache/direct-recovery-backend-build-20261108-2.log)及[desktop最终类型检查/Electron构建](.cache/direct-recovery-desktop-build-20261108-3.log)通过 |
| Source实际窗口 | [最终第3轮](.cache/direct-recovery-source-0.4.7-20261108-3/result.json)：4场景46断言通过，0个renderer错误，隔离临时数据正常清理 |

实际窗口验证覆盖单个规划重试、批量生成重试、批量/单个结束、结束后重启，以及编辑器内图层识别重试与结束。检查了请求增量、原成功成图ID保留、另一个项目不受影响、重启不自动重发、SQLite完整性及外键约束。已查看最终[任务直接操作](.cache/direct-recovery-source-0.4.7-20261108-3/interrupted-task-actions.png)、[结束并重启后的卡片](.cache/direct-recovery-source-0.4.7-20261108-3/ended-tasks-after-restart.png)和[图层直接操作](.cache/direct-recovery-source-0.4.7-20261108-3/layer-interrupted-actions.png)。最终源码编译指纹为`1256c49875e9380cd726a77213bf9fe9d4c7aa1d148b932cbd699c863a0a85cd`。

首轮数据专项96/97通过，发现UNKNOWN终结触发器缺失错误code时受SQLite三值逻辑影响；修正为COALESCE后[该文件10项复核通过](.cache/direct-recovery-core-test-20261108-2.json)。[窗口首轮](.cache/direct-recovery-source-0.4.7-20261108-1/result.json)结束场景误复用了已完成生成意图，修正驱动传入新的regenerationKey。[第二轮](.cache/direct-recovery-source-0.4.7-20261108-2/result.json)4场景44断言通过，但查看截图发现结束后卡片仍显示生成中；补齐关联状态同步及已有成图/尚无成图/其他候选活动三项测试，最终第三轮额外验证状态与界面。失败报告及旧候选均保留，未放宽超时或删除业务断言。

本轮只验证上述相关范围，未重跑完整测试或64业务+14采集工作空间+5设置套件。真实窗口使用独立userData、本机假Provider、合成素材和真实IPC/SQLite，不代表真实模型质量、真实用户库升级、安装/覆盖升级/卸载已验证。未生成0.4.7安装包、未运行新的解包EXE，已有0.4.6包保持冻结且不含本轮改动；未提交、推送或外部发布。

## 0.4.6流程恢复与维护打包（2026-11-07）

本版包含此前三阶段项目工作台、任务抽屉外部关闭和卡片删除入口，并补齐待核实请求处理、单图编辑读取恢复、设置草稿保护、SKU目录冲突处理及持久历史。生成独立0.4.6安装包，保留原appId、EcomGen userData身份与旧版本目录；本轮没有安装、改写真实用户任务或创建Git提交。

待核实任务从“任务详情 → 核实请求”进入逐请求核实。尚未确定只保存审计记录；明确未执行或失败后结束该请求，全部未知请求核实后才原子结束任务，重新执行须另行点击。旧请求与显式重试分别保留用量代次，不伪造Token或费用。已有完整回执的本地恢复禁止发出新请求；编辑和流水线在重启后若可能推进付费后续任务，保留回执并等待明确继续。并发提前退出遗留的IN_FLIGHT、编辑隔离路径与大图片回执用量补偿也已修正。

常规设置和模型单价在切分类、切模型、切标签或全局离开时提供继续编辑、放弃、保存并继续；保存失败保留输入。单图编辑读取失败可重新读取或关闭重开，已有轮次和草稿保留。SKU冲突保留本地草稿，可读取最新目录对照，明确放弃后才载入，不自动覆盖；该路径由构造冲突专项验证，不宣称普通单实例操作已高频复现。花型Listing与模特定妆历史跨重启可回看，UNKNOWN页面状态与套图入库后的项目导航已统一。

| 检查 | 实际结果与证据 |
| --- | --- |
| 相关测试 | [最终逐文件汇总](.cache/flow-maintenance-tests-final-20261107.json)：14文件172项全部通过，按最新完整文件运行去重，不累加重复轮次 |
| 数据与任务边界 | 上述专项包含真实SQLite的v8→v9保留与旧版本增量迁移、UNKNOWN审计、请求代次、重启/取消/重试、本地零网络恢复、付费后续屏障、大回执用量补偿与历史分页 |
| 构建 | [9个业务依赖包](.cache/flow-backend-final-build-20261107.log)及[最终desktop类型检查/Electron构建](.cache/flow-desktop-final-build-20261107-2.log)通过；内置套图1173项 |
| Source实际窗口 | [最终第5轮](.cache/maintenance-flows-source-0.4.6-20261107-5/result.json)：3场景34断言通过，0个renderer错误，临时数据正常清理 |
| 安装器生成 | [NSIS x64打包日志](.cache/maintenance-package-0.4.6-20261107-1.log)：成功，publish never，未重建冻结编译 |
| 解包EXE实际窗口 | [最终EXE专项](.cache/maintenance-flows-exe-0.4.6-20261107-1/result.json)：相同3场景34断言通过，0个renderer错误，临时数据正常清理 |
| 发布静态检查 | [13/13通过](.cache/release-check-0.4.6-20261107.json)，实际版本、生产依赖、原生资源及数据卫生检查通过 |
| 安装器内容 | [3791个应用文件逐个哈希一致](.cache/installer-payload-0.4.6-20261107.json)，根Chromium debug.log单列；没有执行安装器 |
| 编译与产物绑定 | [最终汇总](.cache/maintenance-release-0.4.6-20261107.json)：Source/EXE的282个运行文件与编译指纹一致，最终EXE、ASAR和安装器重新计算哈希并绑定 |

Source/EXE均实际操作了设置草稿保存/放弃、UNKNOWN保存未确定结论后重启、明确失败核实不重发、单独点击重试成功、任务抽屉外部关闭、先取消再确认删除卡片，以及Listing和模特待核实历史重启回看。全部使用独立临时userData、合成素材、本机假Provider和真实IPC/SQLite。已查看EXE的[核实结果](.cache/maintenance-flows-exe-0.4.6-20261107-1/unknown-review-ended.png)、[删除后单卡列表](.cache/maintenance-flows-exe-0.4.6-20261107-1/planning-card-deletion.png)、[设置单价](.cache/maintenance-flows-exe-0.4.6-20261107-1/settings-draft-protection.png)、[Listing历史入口](.cache/maintenance-flows-exe-0.4.6-20261107-1/listing-history-result.png)与[模特核实窗口](.cache/maintenance-flows-exe-0.4.6-20261107-1/model-cast-persistent-unknown.png)。

早期专项失败报告保留：界面首轮72/75通过，修正旧控件名称和新增历史查询夹具；调度/用量首轮55/57通过，修正两个测试的事务夹具。设置单价组合交互曾超时，最终拆分独立场景并缩小到真实用量设置组件，保留业务断言、未放宽超时；[最终4项通过报告](.cache/flow-settings-final-20261107-3.json)。源码窗口前两轮发现系统减少动态效果时AntD菜单停在屏外，已改为通过组件库关闭动画；第三轮修正驱动的重复关闭按钮选择器，第四轮3场景33断言通过，第五轮再等待删除渲染完成并增加卡数断言，最终Source/EXE都在减少动态效果模式通过。所有旧候选报告均保留，最终绑定只采用上述第5轮Source及EXE报告。

打包时PowerShell子命令未找到pnpm，builder回退到依赖目录遍历并成功生成安装器；随后实际包的生产依赖图、EXE运行和安装器内容比对均通过，未修改依赖或绕过ASAR完整性。未重跑完整测试、64业务+14采集工作空间+5设置的历史完整套件；本次3个窗口场景不覆盖每个界面修复的全部分支，其他范围按相关组件/运行时测试记录，不继承0.4.0全测结论。

[0.4.6安装器](release/0.4.6/PixelMuse-0.4.6-x64-Setup.exe)为177,167,443字节，SHA-256为`ce96a4d5b00481d755c86dc747875b57bc8d238ff571c9deb9f53f2d955a6425`；[解包版PixelMuse.exe](release/0.4.6/win-unpacked/PixelMuse.exe)须连同完整win-unpacked目录运行。编译指纹为`ceb64fef96f8279992553eae2b87a583e76a4cb27ead2f949c85940025cc4d5d`。0.4.6为canonical v9，v8→v9只替换UNKNOWN审计触发器，保留密文、回执和游标；旧0.4.5安装包为v7，不应用来打开已升级的新库。

人工核实不是服务商完整回执，不能恢复服务端未知内容或补造真实用量。大回执补偿仍有每连接一次、游标/数量与256MiB单快照上限，不承诺全历史。真实模型质量、真实用户数据升级、安装器安装、已安装路径运行、覆盖升级、卸载均未实测，未配置代码签名；本轮没有提交、推送或外部发布。

## 任务详情收起与分镜删除入口（2026-11-07，源码维护）

任务详情恢复透明遮罩，外部首次点击关闭抽屉且不穿透执行底层操作；关闭按钮和 Escape 保留。分镜卡片底部增加常驻删除按钮，与卡片主体和勾选按钮独立，复用检查器的删除确认、草稿清理与目录刷新。已成图、生成中、规划执行中、未知生成结果及操作繁忙时仍禁止删除，并显示原因；后端删除和历史保护规则未改变。

[两个组件文件19项](.cache/planning-actions-tests-20261107-2.json)与[删除草稿子集2项](.cache/planning-actions-draft-tests-20261107-2.json)通过，共21项；后一文件其余23项未执行。覆盖受控/非受控抽屉外部关闭与重开、Escape/关闭按钮、删除取消/确认、选择保持与删除后清理、检查器/卡片两个入口的防抖草稿处理及原有删除保护。[桌面类型检查](.cache/planning-actions-types-20261107.log)和[Electron构建](.cache/planning-actions-build-20261107.log)通过。首轮测试启动发生原生Zone内存不足，未产生测试结论；保留[失败日志](.cache/planning-actions-tests-20261107.log)，随后降低进程内存上限并改为单线程运行通过，未放宽测试超时或停止无关进程。

[真实Electron专项](.cache/planning-actions-source-20261107-1/result.json)1场景8断言通过，0个renderer错误，临时数据正常清理。实际点击任务筛选不关闭、外部点击关闭、重开后Escape关闭，并在卡片上先取消再确认删除；真实SQLite仅移除所选规划，其他画面身份保留，期间没有额外模型请求。已查看[任务抽屉](.cache/planning-actions-source-20261107-1/task-drawer-open.png)、[卡片删除入口](.cache/planning-actions-source-20261107-1/planning-delete-entry.png)及[删除后列表](.cache/planning-actions-source-20261107-1/planning-after-delete.png)。使用隔离数据和本机假Provider准备场景，未删除真实用户分镜。

本次未重跑完整测试或64业务场景，未改依赖、版本与数据库结构，未打包、提交或推送。

## 三阶段项目工作台（2026-11-07，0.4.6打包前的开发记录）

按用户选定的 project-refactor-v2 四张图实施商品准备、图片规划、成图与修改及单图编辑。准备配置先保存再提交规划，复用原模型/模板/套图、上下文、队列与请求账本；规划改为卡片与固定检查器；采用、详情顺序及导出记录持久化，编辑输入变化阻止确认旧方案。该阶段canonical v8新增工作台状态，公开操作增至148项；当时应用manifest仍为0.4.5，已发布0.4.5安装器是v7且不含该阶段改动。

| 检查 | 实际结果与证据 |
| --- | --- |
| 构建与类型 | 9个业务包构建成功；[desktop TypeScript](.cache/project-v2-typecheck-20261107-2.log)及[最终 Electron 构建](.cache/project-v2-vite-final-build-20261107.log)通过 |
| 界面专项 | 分轮覆盖9文件77项全部通过；[逐项最终结果与来源](.cache/project-v2-ui-summary-20261107.json) |
| 数据与执行专项 | [11文件176项全部通过](.cache/project-v2-backend-final-20261107.json)，包括v7→v8保留/回滚、目录及采用CAS、模板/套图映射、来源失效、取消需求、冻结产物与接口目录 |
| 实施前基线 | [1809文件差异核对](.cache/project-v2-diff-summary-20261107.json)：无原文件缺失，根依赖、锁文件及应用manifest未变 |

[最终第四轮实际Electron](.cache/project-workflow-v2-source-20261107-4/result.json)6场景、36断言全部通过，0个renderer错误，临时数据正常清理。覆盖真实上传入口、一键规划且不提前生图、4画面/8候选生成、采用与详情顺序重启恢复、修改输入后拒绝确认旧方案、独立编辑后代、重启后导出查询和真实ZIP保存。编译指纹为`abd808a0c463ecfe0a44fa175125d001d4eb0909ad9f628892466abad1eb4ddd`。已查看最终[准备](.cache/project-workflow-v2-source-20261107-4/01-preparation.png)、[规划](.cache/project-workflow-v2-source-20261107-4/02-planning.png)、[成图](.cache/project-workflow-v2-source-20261107-4/03-results.png)与[单图编辑](.cache/project-workflow-v2-source-20261107-4/04-edit-preview.png)截图；1100×760窗口、130%缩放下实际点击卡片和检查器字段，复核[窄窗布局](.cache/project-workflow-v2-source-20261107-4/02-planning-small-130.png)。第三轮通过后发现的窄窗拥挤已修正，最终结论使用第四轮构建与证据。

首轮界面专项73/76通过，保留[原报告](.cache/project-v2-ui-final-20261107.json)。修正测试环境的AntD固定标题ID串名，并将超时的共享草稿组合测试拆为往返保存和重新进入恢复两项，保留全部业务断言且未放宽超时；[两文件复核](.cache/project-v2-ui-recheck-20261107.json)与[草稿两项](.cache/project-v2-ui-drafts-20261107.json)按最终测试名汇总。早期类型错误已修正，系统内存不足造成的构建OOM另保留失败日志；关闭本次开发窗口后串行检查通过，未停止无关用户进程。GUI前两轮因驱动误计候选任务数、缺少明确预期错误而失败，原报告保留，未修改业务来迁就断言。

最终重新启动开发窗口，并通过CDP实际点击项目导航、查看[启动截图](.cache/project-v2-started-final-20261107.png)，本地后台已连接；[启动检查](.cache/project-v2-live-final-20261107.json)。开发实例使用独立的.cache/project-v2-implementation-userdata-20261107，未复制原用户配置或凭据；生产构建的窗口验收与后续开发启动分别记录。

本轮仅检查相关范围，未重跑完整套件、64业务场景或EXE验收，未打包、未创建Git提交。窗口验证使用隔离userData、本机假Provider、合成素材和真实SQLite/ZIP；不代表真实模型质量、真实用户数据迁移、安装器安装/覆盖升级/卸载或签名已验证。历史栅格蒙版不重载为画布像素；恢复确认使用后台已保存方案/蒙版，重新规划使用当前画布。历史导出若未保存输出列表，不猜测其内容。

## 0.4.5商品图片规划与SKU维护重新打包（2026-11-07）

按用户要求，将已完成的主图/SKU图/详情图规划与SKU编辑功能生成独立0.4.5安装包，保留0.4.4及更早版本。应用manifest和builder输出目录同步升级，保留com.ecomgen.desktop、原EcomGen userData与卸载保留数据配置。全部运行包重新构建成功，随后冻结编译；打包与EXE验证之间没有重建out/dist。

| 检查 | 实际结果与证据 |
| --- | --- |
| 全包构建 | 通过；[日志](.cache/repackage-0.4.5-build-20261107.log) |
| 最终安装器生成 | pnpm生产依赖收集、NSIS x64、publish never；[最终打包日志](.cache/repackage-0.4.5-package-20261107-4.log) |
| 发布静态检查 | [13/13通过](.cache/release-check-0.4.5-20261107.json)，实际版本0.4.5，未打包用户数据/凭据或旧运行栈 |
| 最终解包EXE | [10/10场景、115断言通过](.cache/product-image-planning-exe-0.4.5-20261107-1/result.json)，0renderer错误、临时数据正常清理 |
| 安装器内容核对 | [3791个应用文件逐个哈希一致](.cache/installer-payload-0.4.5-20261107.json)，根Chromium debug.log单列 |
| 编译与产物绑定 | [最终汇总](.cache/repackage-0.4.5-20261107.json)：279个冻结运行文件与实际EXE一致，EXE/ASAR/安装器哈希及两份检查报告相互绑定，旧0.4.4三份产物未改 |

[0.4.5安装器](release/0.4.5/PixelMuse-0.4.5-x64-Setup.exe)为177,068,895字节，SHA-256为`a8c1a2c53a0ba8379ec50cfb7615e0e0f487b0b850e85f803d119eb1778a9748`。[解包版PixelMuse.exe](release/0.4.5/win-unpacked/PixelMuse.exe)须连同整个win-unpacked目录运行。统一编译指纹为`c3d03e750370049e8959733738fa8612a27566c5d574f7c99eb11b5e73f73c3a`。

EXE专项实际完成16画面/32候选生成、SKU草稿保存/取消、脏草稿设置导航、显式共图与6组合创建、局部更新、冻结旧SKU与ZIP导出、1000px窄窗/130%缩放，以及UNKNOWN阻止另开请求。已查看[EXE规划页](.cache/product-image-planning-exe-0.4.5-20261107-1/planning-16-scenes.png)与[130%抽屉](.cache/product-image-planning-exe-0.4.5-20261107-1/sku-editor-1000-1.3.png)。使用隔离userData、本机假Provider和合成图像，不代表真实模型质量。

本次没有重跑下节开发阶段的532项专项、完整测试或64业务场景。新构建相较开发阶段，仅内置套图SQLite文件的物理哈希改变，278个其他运行文件未变；[1173行与元数据逐项内容指纹](.cache/repackage-0.4.5-catalog-content-20261107.json)一致，[编译差异记录](.cache/repackage-0.4.5-runtime-diff-20261107.json)保留。旧EXE合成数据到源码的升级验证见下节，不能当作本次安装器升级验收。

打包前两轮在addWinAsarIntegrity打开生成的EXE时报UNKNOWN；独立复制品探针未复现，未确认系统根因。采用只在构建进程内、限定该EXE和调用栈的有界写入重试，保留原Buffer、默认截断语义、ASAR完整性及PE资源处理；23项隔离自测通过。第三轮直接CLI误用npm依赖收集，已主动停止并归档；最终第四轮恢复pnpm、EXE完整性写入首次成功。失败候选与日志保留在.cache，未作为交付；业务源码、依赖文件和系统防护未因此修改。

安装器只作静态提取与文件比对，未执行安装、安装路径启动、覆盖升级或卸载，未配置代码签名；本轮未创建Git提交或发布到外部服务。

## 商品图片规划与SKU维护（2026-11-07，开发阶段记录；随后打包为0.4.5）

本节记录商品图片规划与SKU维护的功能开发验证：主图/SKU图/详情图规划、SKU草稿编辑与批量组合、显式共图、ALL/STALE规划、分批请求和用途/SKU冻结输出，canonical v7与3项新IPC同时接入。当时源码manifest为0.4.4，冻结的0.4.4安装器不包含这些改动；功能完成后按用户要求另行生成0.4.5安装器，打包验证单独记录。

domain/contracts/core/agent/backend构建与[最终桌面TypeScript/Electron生产构建](.cache/product-image-planning-desktop-final-build-20261107.log)通过。后台最终[26文件396项专项](.cache/product-image-planning-data-final2-20261107.json)、界面最终[16文件136项专项](.cache/product-image-planning-ui-final-20261107.json)全部通过，共532项。覆盖目录CAS/归属/公开边界、v7升级、分批回执与原子发布、SKU真值子集、重试和旧图编辑屏障、生成中SKU变更、历史同键恢复、完整版本JSON、套图与运行时，以及数量/选择、SKU草稿/共图/焦点、规划意图跨卸载、分镜保存失败恢复、设置导航和长文件名边界。[最终Source实际Electron专项](.cache/product-image-planning-source-20261107-3/result.json)10场景、115项断言全部通过，0个renderer错误、临时数据正常清理。[0.4.4合成数据升级专项](.cache/product-image-planning-upgrade-20261107-1/result.json)也已通过，两份实际Electron结果使用同一源码编译指纹；[最终汇总](.cache/product-image-planning-final-summary-20261107.json)绑定全部结果。

首轮[数据272项](.cache/product-image-planning-data-tests-20261107.json)有16失败，[界面122项](.cache/product-image-planning-ui-tests-20261107.json)有6失败；另一次[整合396项](.cache/product-image-planning-data-final-20261107.json)有2失败，保留原记录。后台已修复无关套图造成的大快照耗时、旧普通规划排队变更兼容和生成中同意图重放，并按实际IN_FLIGHT状态增强测试。冻结任务只包含需要的套图定义；SUITE_FORGE保留碰撞检查所需目录，历史快照不改写。RuntimeStore只缓存schema校验程序，每次仍读取、解析和校验真实数据；未删除安全检查或增加超时。最终结论按本轮真实执行范围记录，不继承历史全测或发布证据。

Source窗口专项实际完成：5主图、6SKU显式共用3组、8详情共16画面；一个PLAN内5次有界规划；UI确认生成32张候选与实际文件，SKU修改仅更新受影响未成图目标，旧成图/ZIP仍保存生成时归属；UI批量创建6组合并明确确认3组。保存/取消、脏草稿进入设置的继续编辑/明确放弃、任务/SKU抽屉互斥、1000px窄窗和130%缩放的保存按钮与单行摘要、UNKNOWN阻止换键再生成均通过。已查看[规划页](.cache/product-image-planning-source-20261107-3/planning-16-scenes.png)、[SKU抽屉](.cache/product-image-planning-source-20261107-3/sku-editor-six-records.png)、[成图](.cache/product-image-planning-source-20261107-3/generated-purpose-and-sku.png)及[130%抽屉](.cache/product-image-planning-source-20261107-3/sku-editor-1000-1.3.png)。源码编译指纹为`e5c626ecab4d7bb9c97bc93910f335217ebff1a47abafad1b44fef164569f43b`。

GUI开发轮次保留[首轮](.cache/product-image-planning-source-20261107-1/result.json)和[第二轮](.cache/product-image-planning-source-20261107-2/result.json)：首轮先等倒序查询中的队尾任务，在其他候选仍执行时达到单任务时限；改为按队列认领顺序等待，未改变原时限。第二轮已生成32张并保存真实ZIP，但驱动把现有manifest的storyboard字段误写为outputs；修正读取位置，顺序/冻结SKU/隐私断言保留，最终全部10场景通过。没有为通过修改生产导出格式。

旧数据专项以冻结0.4.4解包EXE真实建立临时v6数据库、合成商品图、规划、输出和加密服务连接，正常退出后由当前Source打开同一测试数据，再保存显式SKU并重启。项目字段、素材身份/角色、输出哈希、请求记录与服务连接身份保留；旧图不补造SKU，新增目录重开一致，旧/新两个假Provider均无升级阶段新请求，临时数据正常清理。这里验证的是合成桌面数据由旧EXE到新源码的打开与迁移，不是安装器升级或实际用户数据迁移。

本轮只验证相关范围，未重跑完整套件或64业务场景。使用隔离userData、本机假Provider和合成素材；原生保存对话框仅在测试进程内选择临时位置，资源桥和文件复制真实执行。这不代表真实模型质量、安装器安装/覆盖升级/卸载或签名已验证。[冻结0.4.4基线哈希](.cache/product-image-planning-frozen-baseline-20261107.json)确认EXE与ASAR未被覆盖；该功能开发阶段没有打包或Git提交，后续0.4.5打包记录见上节。

## 0.4.4侧栏更新重新打包（2026-11-07）

按用户要求将收起侧栏外观微调打包为0.4.4，保留0.4.3和更早版本。应用包TypeScript与Electron生产构建通过，NSIS x64安装器生成成功；保留原appId、userData身份与卸载保留数据配置。

- [发布静态检查](.cache/release-check-0.4.4-20261107.json)：13/13通过。
- [安装器内容核对](.cache/installer-payload-0.4.4-20261107.json)：3791个应用文件逐个哈希一致，根Chromium debug.log单列。
- [解包EXE专项](.cache/packaged-sidebar-0.4.4-smoke-20261107/result.json)：实际运行版本0.4.4，确认68px收起栏、六个图标、深灰圆角选中态、底部展开按钮、展开后的调宽入口及设置返回；0次模型请求、0个renderer错误，临时数据正常清理。已查看[实际截图](.cache/packaged-sidebar-0.4.4-smoke-20261107/collapsed-0.4.4.png)。
- [打包汇总](.cache/repackage-0.4.4-20261107.json)：当前编译与实际EXE的270个运行文件一致，ASAR、EXE和安装器身份已绑定，原0.4.3安装器哈希未变。

[0.4.4安装器](release/0.4.4/PixelMuse-0.4.4-x64-Setup.exe)为176,931,386字节，SHA-256为`cd9474251d3ee3906b42d9db63fd0fbc6a1ccdabfae4a46275a2a30a32560942`；[解包EXE](release/0.4.4/win-unpacked/PixelMuse.exe)须连同完整目录运行。编译指纹为`24edcf25105b6b114809f58d50f4dc862cb6e11bd58fd6f25960e40c3072c5f4`。

打包阶段未重复运行完整测试；侧栏5项相关回归及Source实际窗口检查见下方开发记录，不当作重新执行的完整业务验收。安装器仅提取比对，未执行安装、安装路径启动、覆盖升级或卸载；未配置代码签名。

## 收起侧栏外观微调（2026-11-07，开发阶段记录；已打包为0.4.4）

收起时顶部仅保留24×26px标识，展开按钮移到底部、位于设置之后；导航使用40×40px按钮、20px图标与10px圆角，以短分隔线保留分组。选中态改为深灰底、白色图标和细标记，展开态保留原有米白选中样式。保留68px收起宽度、提示名称、导航守卫、独立偏好及展开后的拖动调宽。

桌面构建通过；[5项现有侧栏回归](.cache/sidebar-polish-tests-20261107.json)全部通过。[实际Electron专项](.cache/sidebar-polish-smoke-20261107/result.json)验证六个图标的尺寸与居中、底部按钮顺序、提示名称、设置返回、展开与调宽入口、刷新后的收起记忆，以及最小窗口130%缩放。无横向溢出，底部展开按钮可达，0次模型请求、0个renderer错误，临时数据正常清理。已查看[收起侧栏截图](.cache/sidebar-polish-smoke-20261107/collapsed-sidebar.png)和[130%截图](.cache/sidebar-polish-smoke-20261107/collapsed-130.png)。

本节记录开发阶段的相关检查，当时未运行完整测试、修改版本或重新打包；0.4.3安装器不包含此次外观微调。随后按用户要求将微调打包为0.4.4；下方0.4.3发布与运行文件一致性证据仍对应其原冻结构建，不能作为本次修改后的源码指纹。

## 0.4.3工作台布局与候选交互（2026-11-06）

成图画廊、分镜规划卡片和候选叠放沿用A版黑白风格，真实图片保留颜色。执行过程压缩为40px单行摘要，完整任务记录在右侧400px抽屉按项目ID分页读取；保留异常筛选、只读历史与原资源保存，UNKNOWN不提供重试或关闭失败提示。规划卡片仅用实际引用的项目图片作参考，缺失则显示编号规划占位；选择数量和确认生成保留在底栏。成图候选可展开缩略条，浏览与下载选择独立，单图再生成保留旧图。此前全局侧栏收起、拖动调宽和记忆功能一并纳入本版。

| 检查 | 实际结果与证据 |
| --- | --- |
| 桌面构建 | TypeScript及Electron生产构建通过；[最终日志](.cache/workbench-0.4.3-build-20261106-2.log) |
| 相关回归 | 6文件、27/27通过；[报告](.cache/workbench-0.4.3-targeted-tests-20261106-2.json)；覆盖摘要/抽屉、历史分页、规划确认、候选交互、编辑版本与侧栏 |
| Source实际窗口 | [最终报告](.cache/workbench-layout-0.4.3-source-20261106-6/result.json)通过同一组定向交互 |
| 解包EXE实际窗口 | [最终报告](.cache/workbench-layout-0.4.3-exe-20261106-1/result.json)通过同一组定向交互，实际运行版本0.4.3 |
| 发布静态检查 | 13/13通过；[报告](.cache/release-check-0.4.3-20261106.json) |
| 安装器内容 | 3791个应用文件逐个哈希一致；根Chromium debug.log单列；[报告](.cache/installer-payload-0.4.3-20261106.json) |
| 编译与产物绑定 | Source/EXE/当前编译的270个运行文件一致，ASAR、EXE和安装器身份已核对；[汇总](.cache/repackage-0.4.3-20261106.json) |

Source和EXE均验证：3个规划分镜只选择其中2个，确认当前版本后生成4张候选并合为2个叠层；箭头翻图、缩略条、预览与当前图片一致，浏览不改变下载选择；单张再生成只新增1张，原4张与原批次保留，提交期间按钮禁用，完成后新图置前。右抽屉完整进入窗口，切到设置时关闭且返回后不自动重开；1000px窄窗、侧栏收起和130%缩放时摘要保持40px一行、主文档无横向溢出，规划确认按钮可见。外部响应中断形成UNKNOWN，摘要保留待核实，异常记录无重试/关闭按钮，再次生成不增加模型请求。两次最终运行均为0个renderer错误、临时数据正常清理。

已查看解包EXE的[规划页](.cache/workbench-layout-0.4.3-exe-20261106-1/planning-standard.png)、[成图与候选](.cache/workbench-layout-0.4.3-exe-20261106-1/results-expanded-candidates.png)、[任务抽屉](.cache/workbench-layout-0.4.3-exe-20261106-1/task-drawer.png)和[130%成图](.cache/workbench-layout-0.4.3-exe-20261106-1/results-130.png)实际截图。驱动等待窗口尺寸、缩放和有限动画稳定后采集；窗口请求尺寸与实际viewport分别记录，不把原生截图像素当作CSS宽度。

首次专项26/27通过，新增规划测试的假响应缺少契约要求的reused字段；补齐夹具后27/27通过，没有削弱断言。GUI开发轮次保留原始失败记录：首轮窗口意外关闭、第二轮页面偏离测试目标，原因未确定；之后将隔离窗口移到屏幕外，修正“每候选一个任务”的计数，并等待抽屉关闭与缩放稳定。最终Source/EXE使用相同驱动、相同断言和原有时限通过。

已生成[0.4.3安装器](release/0.4.3/PixelMuse-0.4.3-x64-Setup.exe)及[解包EXE](release/0.4.3/win-unpacked/PixelMuse.exe)，保留0.4.2和更早版本。安装器176,930,837字节，SHA-256为`9d4612e98679066f9d7d392abfe779bdf89aad96a27402dedb02fc21affd25d8`。统一编译指纹为`83e1cd276f24a8e6da9eefe2b84b67300f7b06e9ba4b96db1671a2597ef12d4d`。

本轮仅做相关专项与上述实际窗口流程，未运行完整测试或64业务场景。使用合成素材、本机假Provider和隔离userData，不代表真实模型质量。未执行安装器、安装路径启动、安装器覆盖升级或卸载，未配置代码签名。

## 全局侧栏缩放（2026-11-06，开发阶段记录；已纳入0.4.3）

保留现有侧栏样式和菜单顺序，新增收起/展开按钮、68px图标栏及悬停/聚焦名称提示；展开后可拖动右边缘在172–320px之间调宽，默认仍遵循208/172px响应式宽度。键盘左右键按8px调整，Home/End到达边界；完成拖动才保存，取消/丢失捕获恢复原宽度。全局收起和宽度单独保存，不改变工作台内部配置栏偏好；内容区偏移与侧栏使用同一宽度变量。

桌面应用构建通过；[9项定向回归](.cache/sidebar-resize-targeted-tests-20261106-2.json)通过，涵盖新增5项交互与4项既有设置导航检查。首次8/9通过，既有返回编辑页用例在页面尚隐藏时读取了保留DOM；改为等待原有可见性断言成立后重跑，未改变断言或超时。

[实际Electron交互检查](.cache/sidebar-resize-smoke-20261106/result.json)通过响应式默认宽度、收起导航、设置返回、刷新记忆、鼠标拖动、键盘边界、最小窗口130%缩放。测得侧栏/内容起点同步为208px、68px和拖动后的258px，0次模型请求、0个renderer错误，临时数据正常清理；已查看实际截图。

此节记录开发阶段专项，当时未修改版本或单独打包；原0.4.2安装包不包含缩放功能，该功能随后随0.4.3一并打包。

## 侧栏分组设计落地（2026-11-06，开发阶段记录；已纳入0.4.3）

全局导航按工作台（项目、创作草稿）、素材（资产库、模特库）、创作工具（套图工坊、花型工坊）分组，设置固定底部，移除重复品牌签名。统一40px行高、米白选中态、深灰悬停态及键盘焦点描边；中间导航独立滚动。保留原路由、导航保护、设置来源及工作空间唯一入口。

仅运行桌面应用构建和[4项相关回归](.cache/sidebar-design-targeted-tests-20261106.json)，均通过；[实际Electron界面检查](.cache/sidebar-design-smoke-20261106/result.json)通过六个导航入口、设置返回、常规/窄窗口和短窗口130%缩放，0次模型请求、0个renderer错误，临时数据正常清理。已查看[常规窗口截图](.cache/sidebar-design-smoke-20261106/sidebar-1440-960-1.png)和[130%缩放截图](.cache/sidebar-design-smoke-20261106/sidebar-1000-600-1.3.png)；短窗口请求尺寸受应用最小窗口约束，实际viewport以报告geometry为准。

此节记录开发阶段专项，当时未修改产品版本或单独打包；下面0.4.2证据仍对应其原冻结构建，后续分组设计随0.4.3一并打包。

## 0.4.2交互更新与重新打包（2026-11-06）

最左侧全局导航重新分组与排布；工作台配置面板保持原样。结果图新增单图重新生成，同一批次与分镜的候选叠放显示，悬停/键盘聚焦可翻图。显式重新生成使用独立意图键，同键提交去重，生成中或存在未知外部请求时拒绝另开意图。

变更包构建通过；9项定向回归通过，报告见[结果交互专项](.cache/workbench-stack-targeted-tests-20261106-2.json)。[实际Electron交互冒烟](.cache/workbench-stack-smoke-20261106-5/result.json)通过：4张图片合为2个分镜叠层，切图/选择/预览对应当前图片；点击重新生成只新增1张，保留旧图且仍在原批次；提交后禁用按钮、完成后恢复；1440/1000窗口下导航和设置可达且无横向溢出。使用本机假Provider和隔离数据，已查看实际截图；首次脚本切页和公开字段读取问题修正后重跑，失败记录保留。这些专项属于功能开发阶段，重新打包时没有重复运行完整测试。以下0.4.1四份验收报告仍只对应原冻结构建，不混作0.4.2验收。

随后按用户要求生成[0.4.2安装器](release/0.4.2/PixelMuse-0.4.2-x64-Setup.exe)和[解包EXE](release/0.4.2/win-unpacked/PixelMuse.exe)，原0.4.1保留。安装器176,924,206字节，SHA-256为`e7de6ac868416f73adf02501b6b37f5cdd6939a368bf539ded959f83b6f6e0ff`。相关三个包构建通过；首次PATH格式错误修正后重建成功，失败记录保留。

- [打包汇总](.cache/repackage-0.4.2-20261106.json)：270个编译运行文件与ASAR逐项一致。
- [发布静态检查](.cache/release-check-0.4.2-20261106.json)：13/13通过。
- [安装器内容核对](.cache/installer-payload-0.4.2-20261106.json)：3791个应用文件逐个哈希一致，根Chromium debug.log单列。
- [解包EXE短启动检查](.cache/packaged-0.4.2-smoke-20261106/smoke-result.json)：隔离数据下启动、进入设置与关于页，实际显示0.4.2；运行指纹与当前编译一致，0次模型请求，0个renderer错误，临时数据正常清理；已查看[实际截图](.cache/packaged-0.4.2-smoke-20261106/about-0.4.2.png)。

本次打包未重跑完整测试或完整业务E2E；未执行安装器、安装器升级或卸载，未配置代码签名。

## 0.4.1维护版（2026-11-06）

本轮变更为项目分类整理、维护文档和工作空间位置入口精简。位置配置仅保留“设置 → 工作空间与数据”，使用WorkspacePanel；模型、任务、数据库、加密及媒体迁移业务没有新增功能。当前源码不能继承0.4.0冻结构建的全测结论。

| 检查 | 实际结果与证据 |
| --- | --- |
| 设置唯一入口、面板与首页专项 | 3文件、24测试通过；[报告](.cache/organization-ui-tests-20261106.json) |
| 全工作区构建 | 通过，修正测试类型错误后重新构建；当前编译包含0.4.1及WorkspacePanel |
| 源码Electron采集/工作空间 | 14/14通过；[本轮报告](.cache/e2e-full/source-pixelmuse-0.4.1-organization-20261106-1/pixelmuse-result.json) |
| 源码Electron设置 | 5/5通过；[本轮报告](.cache/e2e-full/source-settings-0.4.1-organization-20261106-1/result.json) |
| 解包EXE采集/工作空间 | 14/14通过；[本轮报告](.cache/e2e-full/exe-pixelmuse-0.4.1-organization-20261106-1/pixelmuse-result.json) |
| 解包EXE设置 | 单独重跑5/5通过；[最终报告](.cache/e2e-full/exe-settings-0.4.1-organization-20261106-2/result.json) |
| 场景覆盖检查 | e2e-full --check通过，64场景静态检查及missingAuthoredOperations无缺口；不等于本轮执行64业务场景 |
| 发布与历史证据检查器回归 | 111/111通过、0跳过；[日志](.cache/organization-checker-tests-20261106-2.log) |
| 0.4.1发布静态检查 | 13项通过；[报告](.cache/release-check-0.4.1-organization-20261106.json) |
| 安装器内应用字节 | 3791个不可变应用文件逐个哈希一致；根Chromium debug.log两端哈希单列，不计入一致文件数；[报告](.cache/installer-payload-0.4.1-organization-20261106-2.json) |
| 安装器比对工具边界 | 4项通过：根运行日志单列、应用字节差异拒绝、其他额外日志拒绝、报告不得写入独立解包目录；[报告](.cache/organization-payload-probes-20261106.json) |
| 独立只读复核 | 唯一入口、保留行为与23份历史归档哈希通过；[报告](.cache/organization-independent-review.json) |
| 清理清单 | 24文件及1个误建空目录树已可恢复归档，0永久删除；[清单](docs/cleanup-record-20261106.json) |

Source/EXE四份通过报告分别来自独立runId，均报告版本0.4.1，编译指纹相同：`f2c5ff7bda71660226203ca3b71f426ae839faefa549ced5d1460d8af6b83261`。最终一致性与文档链接核对结果见[汇总报告](.cache/organization-final-verification-20261106.json)。

实际查看了解包EXE的1440/1000宽度工作空间设置截图、关于页和原路径重连截图：侧栏只保留“设置”，位置选择按钮仅在工作空间与数据页出现；关于页显示PixelMuse 0.4.1。验收包括取消选择、繁忙拒绝、复制校验、失联重连、持久偏好、单价只影响后续请求以及离开/返回创作页的编辑保留。

### 首次失败与处理

- 第一次构建因Testing Library的getByRole误用exact选项而失败；移除不支持的选项后全构建通过，没有删行为断言。
- 第一次打包遇Windows UNKNOWN写入EXE错误；只读确认没有本轮EXE进程后原配置重试成功，没有停止旧进程。
- 首次发布检查器回归发现源码品牌测试写死0.4.0；改为产品manifest版本、输出目录及安装器文件名的一致性验证。真实发布静态检查仍固定expected-version 0.4.1。
- EXE设置首轮4/5通过，更新单价时定位控件超时，失败截图显示工作空间页；[首次失败报告](.cache/e2e-full/exe-settings-0.4.1-organization-20261106-1/result.json)保留。全部GUI验收结束后使用相同驱动、相同断言和时限单独重跑，5/5通过；尚不能据此确定首次页面变化原因。
- 安装器比对首次因根debug.log运行后追加内容而失败。维护版比对工具单列该根日志两端哈希，其他应用文件仍须逐个一致；没有改动安装器或解包应用文件。

### 产物与边界

[0.4.1安装器](release/0.4.1/PixelMuse-0.4.1-x64-Setup.exe)及[解包EXE](release/0.4.1/win-unpacked/PixelMuse.exe)已生成，解包版须保留完整目录。安装器SHA-256：`4dfa188be817ad7fc92498b308980fb8db20039b8736986e871dcfa0e9999cc3`。

本轮没有重新执行完整1450项根测试或64个原业务场景。验收使用隔离数据、合成素材和本机假Provider，不使用真实用户数据或真实模型；不把目录失联模拟当真实设备拔插验证。安装器未执行，安装路径启动、安装器覆盖升级、卸载及代码签名未验证；保留旧userData与安装身份不等于这些流程已经验收。

## 已发布0.4.0与更早版本（历史）

[完整冻结记录](docs/archive/validation-through-0.4.0.md)保留原文。0.4.0当时通过136文件/1450项测试、Source/EXE各64业务+14采集工作空间+5设置场景、13项发布检查和3792文件安装器比对；其编译哈希与当前维护版不同，不能混用证据。

历史0.4.0安装器SHA-256：`aff145af39356404f7c8cedd5842cc2cae27fa81449a285403013bc06abee5f6`。历史包及被引用的最终证据保留；归档原路径规则见[说明](docs/archive/README.md)。
