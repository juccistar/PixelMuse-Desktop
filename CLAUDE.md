# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 工作范围与现行文档

PixelMuse 是 Windows 本地“商品视觉创作工作台”。本仓库根目录即 pnpm workspace，源码位于 `E:/PixelMuse-Desktop`，先遵循 [AGENTS.md](AGENTS.md)。安装程序位于独立的 `E:/PixelMuse`，不要将源码、依赖或构建输出写入安装目录。旧项目归档位于 `E:/EcomGen/legacy`，仅供业务迁移参考，其规则和运行栈不适用于当前项目；构建与运行不依赖旧工作区。

需求、依赖和交付状态分别以 [requirements.md](docs/requirements.md)、[technical-stack.md](docs/technical-stack.md)、[project-status.md](docs/project-status.md) 为入口。维护索引是 [docs/README.md](docs/README.md)，实际验证范围记录在 [VALIDATION.md](VALIDATION.md)。区分当前源码、已发布安装包、历史冻结证据和待实施建议；[docs/archive/](docs/archive/README.md) 的旧待办不能当作当前开发清单。

## 构建、开发与测试命令

要求 Windows x64、Node.js >=22.19.0、pnpm 11.19.0。以下命令均在本仓库根目录执行；Vitest 的 `--root` 不会替测试子进程切换 cwd。

```sh
cd E:/PixelMuse-Desktop
pnpm install
pnpm dev
```

`pnpm dev` 先构建 Backend 及其 workspace 依赖，再启动 Electron 和 renderer 热更新。修改 renderer 以外的包后，重新运行开发命令以更新编译结果。内部包通过 `dist` 导出，仅修改源码后直接测试其他包，可能仍加载旧编译文件。

```sh
# 全工作区构建；已构建应用启动
pnpm build
pnpm start

# Backend 及其依赖构建（共享包发生修改时使用）
pnpm --filter @ecomgen/backend... build

# 单包构建／类型检查；依赖需已构建
pnpm --filter @ecomgen/agent build
pnpm --filter @ecomgen/backend typecheck
pnpm --filter @ecomgen/desktop build

# 全工作区 Vitest，单 worker
pnpm test --pool=threads --maxWorkers=1 --minWorkers=1

# 单文件，以及按测试名称筛选
pnpm exec vitest run packages/agent/src/planner.test.ts --pool=threads --maxWorkers=1 --minWorkers=1
pnpm exec vitest run packages/agent/src/planner.test.ts -t "模式" --pool=threads --maxWorkers=1 --minWorkers=1
```

当前没有独立 `lint` 脚本。各包构建执行 TypeScript 检查；Backend 另提供 `typecheck`，不要假定存在 `pnpm lint` 或根 `typecheck` 命令。TypeScript 使用 ESM、严格类型检查，源码模块导入沿用 `.js` 后缀。

| 命令 | 用途 |
| --- | --- |
| `pnpm test:e2e:check` | 检查 Electron 驱动注册及覆盖计划，不运行实际业务验收 |
| `pnpm test:e2e:mock` | 真实 Electron 的原业务场景，使用隔离数据与本机假 Provider |
| `pnpm test:e2e:pixelmuse` | 品牌、采集、媒体工作空间场景 |
| `pnpm test:e2e:settings` | 设置中心场景 |
| `pnpm test:release-checker` | 发布检查器自身的回归测试 |
| `pnpm run pack` | 先构建，再生成解包应用；`pnpm pack` 是 npm tarball，含义不同 |
| `pnpm run dist` | 先构建，再生成 Windows x64 NSIS 安装器；应用脚本固定 `--publish never` |

Electron 驱动使用新建的空 `ECOMGEN_E2E_ARTIFACTS` 结果目录；`ECOMGEN_E2E_EXECUTABLE` 可指定解包 EXE。隔离运行的整个 userData 可通过 `ECOMGEN_DESKTOP_DATA_DIR` 指定绝对路径，必须在启动前设置。驱动前提与基线包要求见 [scripts/README.md](scripts/README.md)。

**默认只执行与实际改动对应的最小充分验证，不因小版本迭代、版本号递增或一次维护提交自动运行全量测试、完整Electron验收、全工作区构建或重新打包。**

- 文档、开发说明或纯版本元数据更新：检查内容、链接及相关配置一致性，不据此启动应用全测或打包。
- 局部UI修改：构建受影响的应用包，检查相关交互并在实际Electron中操作；不为简单排版新增测试，不扩展到无关业务套件。
- 提示词、Agent或局部Backend逻辑修改：构建必要的包及依赖，只运行受影响的规划、参数、协议或业务专项；不默认连带全工作区回归。
- 队列、取消、重试、重启恢复、IPC等改动：补充对应的真实行为测试，范围围绕被修改的边界。
- 根依赖、锁文件、构建／运行公共配置发生实质变化时，按AGENTS要求执行全构建和测试；仅修改产品版本号不等同于依赖或公共运行配置变化。用户明确要求完整验收、或影响确实跨越多个边界时，再扩大验证，并说明扩大原因和实际覆盖范围。

每次完成后说明实际执行的检查及未覆盖项；专项通过不表述为全量通过。全测、Electron驱动和打包串行运行。Node下原生模块可加载不代表Electron／EXE可运行，变更Electron、better-sqlite3、sharp或打包配置时分别核对运行环境。

## 进程架构与代码所有权

```text
React renderer → preload 白名单 → Electron main → utilityProcess Backend
                                                       ├─ SQLite / 受管媒体
                                                       └─ Pi / Provider / 搜索
```

- [apps/desktop/src/main/](apps/desktop/src/main/) 负责窗口、系统对话框、safeStorage、资源协议、采集和更新；[backend-host.ts](apps/desktop/src/main/backend-host.ts) 管理唯一 Backend 子进程及 RPC。必须等旧进程退出后才能启动替代实例。
- [preload/](apps/desktop/src/preload/) 只暴露具名白名单。[renderer/](apps/desktop/src/renderer/) 使用 React、TanStack Query、Ant Design、CSS Modules 和 memory router；不直接访问 Node、SQLite、Provider 或任意本地路径。查询是状态真相，变更事件只触发查询失效与重查；RPC 超时不能视为命令未提交。
- [contracts/](packages/contracts/src/) 的 TypeBox schema 是通信契约唯一手写来源，组合公开输入／输出与操作白名单；[domain/](packages/domain/src/) 提供业务模型、纯约束和端口。新增操作需同时接入契约、Backend 注册和 renderer hook，原生能力还需 main／preload 白名单与可信 frame 校验。
- [core/](packages/core/src/) 管理 canonical SQLite、显式迁移、仓储、受管文件、SecretBox 与纯服务；[createBackend](packages/backend/src/index.ts) 在同一数据库连接上组装仓储、资源登记、请求账本和调度器。不得为同一业务另建数据库或第二套任务状态真相。
- [providers/](packages/providers/src/) 实现外部协议与请求证据注入；[agent/](packages/agent/src/) 使用嵌入式 Pi 完成有限业务工作流。Pi 推理与图片／分割 Provider 是不同层，Pi 没有通用 shell 或任意文件工具。Pi SDK 精确版本以相关包 manifest 为准，随应用统一交付，不独立热更新。

生产业务不保留 HTTP、Redis、BullMQ 或旧 SSE 事件服务。开发 Vite、Provider 自身的 SSE、商品采集的临时受限代理是不同用途，不应据此恢复旧 Web 架构。

## Backend 命令、执行与恢复

Backend 的三个层次应保持分离：

1. [commands/](packages/backend/src/commands/) 校验归属、能力及 revision，创建 Job 和伴随业务记录。[runCommandFlow](packages/backend/src/commands/support.ts) 在同步事务内完成写入和冻结，事务提交后才唤醒执行；网络／文件 I/O 放在事务外，不能跨 `await` 持有 SQLite 事务。
2. [execution/](packages/backend/src/execution/) 消费提交时的 [snapshot](packages/backend/src/execution/snapshot.ts) 和 [冻结上下文](packages/backend/src/execution/context.ts)，执行业务并发布结果。不能在认领任务时换用最新项目、模型、模板或素材配置；实时读取只用于取消、归属、发布新鲜度等必要检查。
3. [runtime/](packages/backend/src/runtime/) 管理持久认领、attempt／runToken、逐请求回执、资源和恢复。发布产物必须经过当前执行代次的 checkpoint。generationKey、候选／槽位身份保持稳定，不能按已完成数量推算新身份；旧代次迟到结果不能覆盖新结果或推进已替换步骤。

每次外部调用必须进入现有 RequestLedger：发送前持久登记 `IN_FLIGHT`，读完响应／SSE EOF 后保存完整加密回执，再允许工具执行、下一轮调用或业务成功。`COMPLETED` 表示回执完整，`localState=COMMITTED` 表示本地产物已提交，二者不能混同。

已发送但没有完整回执的请求保留 `UNKNOWN`，禁止自动重发。用户可直接重试或结束中断任务，并可按项目批量处理；不增加逐请求核实表、风险勾选或重试费用确认。完整回执优先安全重放；不能通过改请求键、清空账本、改模型或重置槽位绕过未知窗口。编辑／流水线可能产生后续付费任务，重启恢复不能隐式推进。Prompt／SDK 变化仍需遵守真实请求指纹，不关闭指纹校验来“兼容”旧回执。

## 商品规划与图像语义

项目主流程为商品准备 → 分镜规划 → 用户确认 → 生图 → 独立编辑版本。保存 SKU／图片数量不调用模型，规划成功也不自动生图。画面数与每画面候选数独立，主图／SKU／详情按显式目录解析；SKU 共图只能来自用户明确建立的组。商品规划一个 PLAN 内按用途／SKU 分批，单批最多12画面、合计最多96画面，全部成功并通过新鲜度检查后原子发布。

关键调用链为 [job-plan.ts](packages/backend/src/execution/job-plan.ts) → [agent/planner.ts](packages/agent/src/planner.ts) → [job-generation.ts](packages/backend/src/execution/job-generation.ts)；编辑由 [job-edit.ts](packages/backend/src/execution/job-edit.ts) 编排。规划返回的 `promptInstruction` 是最终生图提示词，生成时按实际附件追加角色与句柄说明。

- 每画面只有一份最终提示词。候选数只在本地配置、快照和调度中使用，不进入规划模型提示词、JSON上下文、输出schema或生图提示词，不要求模型返回 `candidateCount`。配置2候选时程序发起2次独立图片模型调用，每次1张，提示词、附件和有效参数相同；修订提示词先完成一次并持久保存，同批候选共享该结果。用户显式调整单张候选数仍受支持。
- 新主流程冻结 `planningVersion: 2`，自主分镜使用显式 `MODEL_DIRECT` 来源，套图使用带版本和镜头身份的 `SUITE` 来源；两者不依赖分类skill或模板选型。历史未标明新来源的模板仍精确校验，不能把未知模板静默降级。`mode` 必须严格等于冻结的 `defaultMode`，完整回复不一致最多纠正一次并重写冲突提示词，再次失败不发布。
- 套图镜头清单是数量唯一来源，主图／详情数量与每SKU组镜头数由它派生；增删镜头保留其他镜头身份。跨商品批次只组织独立项目任务，逐商品冻结事实和素材；规划后必须用户明确确认生图，重启不自动推进。
- `PRODUCT_TRUTH` 属于本项目商品真值；SKU 只使用目标显式选择的商品子集。参考图、采集来源和搜索结果不能自动成为商品事实。模板与套图必须通过现有解析／校验，不把未知模板降级为普通提示词。
- `PIXEL_PROTECTED` 要求真实商品输入，但远端整图生成不保证逐像素不变。硬蒙版局部合成、自然融合、扩图各有不同的本地边界；人工画框、视觉识别、模型分割不能混称。编辑后代保留父／根输出、冻结 SKU 归属及分支记忆。
- 商品描述与补充说明帮写保留既有顺序：上方描述帮写及采用／保存过程阻止下方帮写，下方提交前等待并保存描述。推理高级参数提交时冻结，全局并发只控制后续任务认领；不要把它解释为每个 Provider 的请求速率限制。

模板源与生成资源分属 [ecom-skill](packages/ecom-skill/package.json)、[ecom-suite](packages/ecom-suite/package.json)、[ecom-suite-forge](packages/ecom-suite-forge/package.json)。修改相应源资源后使用以下命令，不直接编辑生成 DB：

```sh
pnpm --filter @ecomgen/ecom-skill gen:templates
pnpm --filter @ecomgen/ecom-suite gen:suites
pnpm --filter @ecomgen/ecom-suite-forge gen:forge-skill
```

## 安装身份、媒体与发布

产品版本以 [apps/desktop/package.json](apps/desktop/package.json) 为准；内部 workspace 版本不必与产品版本对齐。保持 `com.ecomgen.desktop` 安装身份及原 `<appData>/EcomGen` userData。业务库与 safeStorage 主密钥留在 userData，媒体可通过“设置 → 工作空间与数据”迁移到独立根；该设置是唯一的位置配置入口。renderer 通过 `ResourceRef` 和 `ecomgen-resource:` 预览，不能把私有路径放进普通业务 DTO。

数据库版本升级由 core 的 canonical schema／迁移负责；备份包含完整 userData 和当前媒体空间，升级后的库不能交给旧版本程序降级打开。媒体迁移复制并核验后才切换，原目录失联时须原路径重连，不创建空白替身或静默回退。

界面沿用 PixelMuse A 版黑白设计，保留真实图片颜色和蒙版语义，设计约束见 [design-system.md](docs/design-system.md)。

打包输出由 [electron-builder.yml](apps/desktop/electron-builder.yml) 控制；构建和公开发布是独立操作。按版本保留输出，发布流程见 [software-updates.md](docs/software-updates.md)。假 Provider、静态检查、解包 EXE、安装器内容比对、真实安装／升级／卸载及真实模型质量分别记录，历史全测不自动覆盖新源码。

`.cache/`、`release/` 和 `.workspace-tools/` 包含有效升级基线、最终证据及脚本输入，Git 忽略不代表可整目录删除。清理按 [directory-map.md](docs/directory-map.md) 与清理清单追溯，不重跑旧版一次性搬迁脚本，不按日期批量删除。
