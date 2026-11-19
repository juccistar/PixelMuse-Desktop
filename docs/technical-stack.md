# PixelMuse 技术栈与维护基线

基线核对日期：2026-11-09；规划来源、v12数据结构及批次边界更新于2026-11-12，外部依赖版本未因此调整。后续架构或依赖变化时同步更新本页及对应证据。

本文供开发升级和维护时查找技术选型、运行边界及验证入口。业务目标和交付标准见[需求文档](requirements.md)，当前进度见[项目进度](project-status.md)，实际验证证据和未实测范围见[验证记录](../VALIDATION.md)。

详细实现以[架构文档](architecture.md)、[目录地图](directory-map.md)及当前源码为准；依赖和素材来源见[来源文档](code-and-resource-origins.md)。本文版本是当前仓库快照，更新依赖后同步核对，不代表上游最新版本。

## 版本与开发环境

- 产品显示名为 PixelMuse，产品版本以 [apps/desktop/package.json](../apps/desktop/package.json) 为准，当前为 **0.5.0**，已于2026-11-12公开发布。
- 根 workspace 当前为 **0.1.0**；内部 `@ecomgen/*` 包的版本属于工作区管理，不是产品版本，无需为了对齐产品号批量修改。
- 开发环境为 Windows x64、Node.js **>=22.19.0** 和 pnpm **11.19.0**；根 manifest 指定包管理器与 Node 要求。
- 应用固定 Electron **45.2.3**，安装包使用 Electron 内置 Node/Chromium，不依赖用户另装 Node。[验证记录](../VALIDATION.md)中 0.4.8 发布包实际内置 Node **24.22.2**；未来 Electron 版本须重新核实，不能沿用此数值。
- 全仓使用 TypeScript ESM 与严格类型检查。系统能力、业务状态和页面分别在不同进程中维护，不用旧版 Web 运行栈。

各包 `package.json` 中的 `^`、`~` 是允许的声明范围，精确版本声明才是固定约束；下表为 [pnpm-lock.yaml](../pnpm-lock.yaml) 当前解析快照，不以本机 `node_modules` 推断，也不表示未来重新解析仍相同。升级时同时检查相关包 manifest 和锁文件。

| 层次 | 当前锁定版本 | 用途 |
| --- | --- | --- |
| 桌面运行与构建 | Electron 45.2.3、electron-vite 6.0.0、Vite 7.3.7、electron-builder 26.18.0 | 窗口宿主、编译及 Windows NSIS 打包 |
| 更新 | electron-updater 6.8.11 | 主进程检查和调度受支持安装版的软件更新 |
| 语言 | TypeScript 5.8.3 | 类型检查与编译；根包声明 `~5.8.3` |
| 界面与路由 | React / React DOM 19.3.1、react-router 7.18.5 | 组件与 memory router |
| 查询状态 | TanStack Query 5.105.3 | 查询缓存、失效与重查 |
| 界面组件 | Ant Design 6.7.0、motion 13.5.1、lucide-react 1.68.0 | 控件、动效与图标 |
| 图片列表 | react-photo-album 3.6.2、react-virtuoso 4.18.20 | 图片布局与虚拟列表 |
| 通信契约 | TypeBox 0.34.52 | schema、公开 DTO 与运行时校验 |
| 存储 | better-sqlite3 13.0.3 | Backend 的同步 SQLite 连接及事务 |
| 图像与归档 | sharp 0.35.5、ag-psd 31.0.3、archiver 7.0.1、fflate 0.8.3 | 图像处理、PSD 与 ZIP |
| 业务 Agent | `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai` 均为 1.5.0 | 嵌入式业务推理；两项依赖精确固定并随软件更新交付 |
| 域名解析 | tldts 7.4.19 | 商品采集的站点与 Cookie 边界辅助 |
| 测试 | Vitest 3.2.7、jsdom 24.1.3、playwright-core 1.64.1、Testing Library React 16.3.3 | 单元、DOM 和真实 Electron 驱动 |

## 进程与通信

```text
React renderer → preload 白名单 → Electron main → utilityProcess Backend
                                                      ├─ SQLite 与受管媒体
                                                      └─ Provider、搜索与 Pi 工作流
```

| 进程或层 | 职责与边界 |
| --- | --- |
| Electron main | 窗口与生命周期、系统选择器和剪贴板、资源协议、safeStorage、Backend 宿主及更新。 |
| preload | 仅向页面暴露固定白名单；业务类型从契约复用，不能开放任意 IPC 或 Node 能力。 |
| renderer | React 页面、交互、查询缓存、浏览器内画布与导出；不直接访问 Node、数据库、Provider 或任意本地路径。 |
| utilityProcess Backend | 拥有业务数据库、媒体存储、持久调度、领域命令、Provider/搜索访问和嵌入式 Pi；长任务不占用主进程。 |
| 隔离采集窗口 | 在独立非持久会话访问商品页面；用户主动采集后，候选经受控宿主检查和导入，不能自动成为商品真值。 |

`packages/contracts` 的 TypeBox schema 是通信契约唯一手写来源；新增操作需同时遵循输入、输出及主进程与 Backend 的校验。原生能力也使用契约白名单和可信 frame 校验，普通业务 DTO 不暴露私有文件路径。

查询结果是状态真相，变更事件只触发相关查询失效和重查；RPC 超时不自动重发命令。生产 renderer 启用 sandbox、contextIsolation 和 CSP，禁用 Node、webview、任意外部导航、新窗口、权限与普通下载；Vite 开发服务不属于生产业务服务。

新版不依赖旧 Web 的 HTTP 业务服务、Redis、BullMQ 或 SSE 事件服务。外部 Provider 自身的 SSE 流是后台协议；商品采集使用的临时本机受限代理也不是业务 API。

## 数据、任务与密钥

- `packages/core` 管理 canonical SQLite，当前 `user_version=11`；Backend 以同一业务连接执行仓储、运行时和账本事务。升级需保留历史、密文和已保存的请求证据。
- 持久队列直接从 SQLite 认领已冻结任务，记录 attempt 和 runToken；任务状态与结果以持久数据为准，不另建 Redis 队列。
- 命令在事务中创建任务及关联记录并冻结执行快照；网络与文件 I/O 不跨 `await` 持有 SQLite 事务。发布结果时重新检查执行代次、取消状态和领域归属。
- RequestLedger 记录每次外部请求的稳定身份、状态与完整加密回执；已保存回执可按规则本地重放。发出后结果未知的请求不自动重发，中断任务可由用户直接重试或结束，后台保留原 UNKNOWN 审计。
- 新任务冻结有效模型、素材及推理设置；已冻结任务不随设置修改。全局并发当前默认 2，可设置 1–16，影响后续认领，降低上限不取消已运行任务。
- 用户数据固定在原 `<appData>/EcomGen` userData，以保持安装与密钥身份。业务库、日志和主密钥封装位于该位置；媒体默认在 data 目录，也可通过“设置 → 工作空间与数据”配置独立媒体根。
- 主进程生成随机主密钥，以系统 safeStorage 保护；Backend 用 AES（256 位 GCM 模式）加密 Provider/搜索密钥和完整外部回执。凭据不回传页面、不写日志、不导出或提交。
- 备份前退出应用，同时保存完整 userData 和当前独立媒体空间。safeStorage 受系统账户/设备环境约束，完整复制也不保证跨环境解密。

媒体使用受管资源身份与哈希寻址，renderer 获得资源引用而非私有路径。工作空间切换需等待活动操作退出并验证复制结果，失联时通过原路径重连，不能静默创建空白替身。详细事务、恢复和迁移规则见[架构文档](architecture.md)。

## Provider、Pi 与图像处理

`packages/providers` 实现推理、图片和分割服务协议；`packages/agent` 将 Pi 嵌入规划、文案、编辑方案、元素识别和套图反推等有限业务流程。Pi 工具读取受控领域资料或配置的搜索来源，不开放通用 shell、任意本地文件或通用聊天代理。

推理、图片生成、分割与搜索均按对应工作流使用受控外部请求和账本；不能把 Pi 推理能力等同于图片生成或分割 API，也不能将外部搜索内容视为已核验商品事实。视觉模型自动识别、人工选区和模型分割是不同能力；实际模型质量及远端能力需单独验证。

本地图像处理主要使用 sharp，客户端处理画布与 PSD 编排；真实素材颜色、编辑/保护蒙版和领域约束需保持。源像素保障只适用于架构文档列明的本地算法，远端生成不承诺逐像素一致。

## 界面与项目目录

页面采用 React、Ant Design 中文主题、CSS Modules 和设计 token，沿用 PixelMuse 黑白界面；真实图片和蒙版保留其语义与颜色。业务页面通过 hooks 调用具名 IPC，memory router 避免依赖服务端路由。

| 相对 `desktop/` 的路径 | 维护职责 |
| --- | --- |
| `apps/desktop/src/main` | 窗口、系统能力、采集、安全边界和 Backend 宿主 |
| `apps/desktop/src/preload` | 页面可用的受控桥接 |
| `apps/desktop/src/renderer` | 路由、共享 UI、业务页面、样式和客户端工具 |
| `packages/contracts`、`packages/domain` | 通信 schema、领域模型、约束与端口 |
| `packages/core` | 数据库迁移、仓储、受管存储、密钥和纯服务 |
| `packages/backend` | 业务命令、持久调度、执行器与工作空间迁移 |
| `packages/providers`、`packages/agent` | 外部协议适配及受控 Pi 工作流 |
| `packages/ecom-skill`、`packages/ecom-suite`、`packages/ecom-suite-forge` | 模板、套图目录、提示编译与反推资源 |
| `scripts`、`docs` | 维护与验证脚本、当前文档及历史归档 |
| `release/<version>`、`.cache` | 按版本保留的打包产物、临时与验证证据；不是运行源码 |

新版商品规划冻结`planningVersion: 2`，通过显式`MODEL_DIRECT`／`SUITE`来源执行，不将未知模板降级为自主提示词。套图镜头保存在项目配置JSON中，数量由镜头派生；canonical v12新增来源列、批次关联和共享修订结果。跨商品批次关联已有任务，任务状态仍由唯一持久队列管理。分类模板资源保留给明确模板与历史来源等现存职责，不参与新自主／套图模型上下文。

`legacy/` 仅作为业务迁移参考，不作为新版运行依赖，也不复制旧环境文件、凭据或数据库。

## 构建、测试和发布

在 `desktop/` 工作目录执行，具体步骤与验证脚本参数见[维护流程](maintenance.md)。常用命令如下：

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 构建 Backend 依赖并启动 Electron 开发环境 |
| `pnpm build` | 构建 workspace 各包并执行相应类型检查 |
| `pnpm test --pool=threads --maxWorkers=1 --minWorkers=1` | 单 worker 运行 Vitest；推荐与 Electron/打包分开执行 |
| `pnpm test:e2e:check` | 检查业务驱动注册和覆盖计划，不等于实际业务验收 |
| `pnpm test:e2e:mock` | 真实 Electron 驱动原业务场景，使用隔离数据和假 Provider |
| `pnpm test:e2e:pixelmuse` / `pnpm test:e2e:settings` | 分别验证采集工作空间和设置中心场景 |
| `pnpm run pack` | 先构建，再生成解包应用；不同于生成 npm tarball 的 `pnpm pack` |
| `pnpm run dist` | 先构建，再生成 Windows x64 NSIS 安装器；应用脚本固定 `--publish never` |
| `pnpm test:release-checker` / `pnpm verify:release` | 分别测试发布检查器、按参数检查指定版本产物 |

打包使用 ASAR；原生 `.node`、sharp 相关资源和内置 `builtin-suites.db` 按配置解包。better-sqlite3、sharp 等原生模块必须匹配 Electron 架构与 ABI，普通 Node 下可加载不能证明最终 EXE 可运行；改变原生依赖、Electron 或打包配置后应检查实际资源并运行对应 EXE。

更新由 main 中的 electron-updater 使用固定 GitHub 更新仓库，页面不能指定更新地址或安装命令；更新流程和附件要求见[软件更新说明](software-updates.md)。构建与发布是独立步骤：`dist` 不自动上传，公开发布需明确执行上传和 Release 操作。为新版本使用独立输出目录，保留已有升级基线和冻结证据。

| 改动范围 | 相应验证 |
| --- | --- |
| 小范围 UI/文案 | 按需运行相关检查；UI 修改执行构建并在实际 Electron 中渲染和操作，不为简单排版新增测试，也不自动全测或重打包。 |
| 契约、业务或 Provider | 检查 schema 与调用边界，运行相关真实行为测试；涉及外部请求时覆盖回执、失败和未知状态。 |
| 数据库、队列、取消或恢复 | 使用真实 SQLite 验证迁移、事务、并发、重试和重启恢复等受影响行为。 |
| 根配置或锁文件 | 按项目规则运行 `pnpm build` 和 `pnpm test`，并检查原生模块兼容性。 |
| Electron、原生依赖或发布配置 | 补充实际 Electron、解包 EXE、打包资源及相关发布检查；安装、升级和卸载须分别实际验证。 |
| 完整发布验收 | 按发布范围绑定同一编译和最终产物执行 Source/EXE 场景、静态检查与安装器内容比对，记录未覆盖项。 |

测试使用假 Provider 时，只能证明受控环境中的行为，不能证明真实模型质量、计费或远端去重。历史版本的全量结果不能替代当前改动的验证；每次如实记录实际执行范围和限制。

不要提交真实密钥、SQLite、用户素材、生成产物、安装包或依赖目录。分发的 Electron 应用包含可提取的编译 JavaScript，不能依赖客户端代码不可见来保护凭据或敏感逻辑。
