# 开发与维护流程

## 环境与启动

要求Windows x64、开发Node>=22.19.0和pnpm11.19.0。在独立源码仓库根目录执行：

```powershell
cd E:\PixelMuse-Desktop
pnpm install
pnpm dev
```

非renderer包修改后重启dev。生产源码运行使用`pnpm build`再`pnpm start`。Vitest的`--root`不会替测试子进程改变cwd。

## 修改功能的顺序

1. 找到[模块地图](modules.md)和现行domain/contracts schema，复用现有操作。
2. 需要持久化时修改core仓储与版本化迁移，保持唯一连接、事务回滚、旧数据及密文保留。
3. 同步命令创建意图/关联/冻结快照，网络和文件异步阶段放事务外；长任务进入execution/runtime。
4. 外部请求必须走RequestLedger；UNKNOWN/IN_FLIGHT不自动重发，稳定指纹反映真实业务输入。
5. renderer通过具名IPC与hooks接入。事件只失效查询，不能替代持久状态。
6. 原生能力需要contracts、preload和main可信frame白名单校验，不接收任意路径。
7. 按改动范围补真实行为验证并更新模块、来源、设计和验证说明。

Pi agent-core/pi-ai均精确固定为1.5.0，随软件更新一起交付，不单独进行npm热更新。模型高级设置的推理参数提交时冻结到新任务，旧快照继续使用原默认行为；全局并发影响后续认领，调低不会取消运行中的任务。推理探测保持轻量，搜索使用独立超时。

0.5.0已发布到[GitHub Releases](https://github.com/juccistar/pixelmuse-releases/releases/tag/v0.5.0)。相关专项22文件314项、Source/EXE各3场景32断言、13项发布静态检查与3843个安装器文件比对通过，公开附件摘要及latest.yml已核验。本轮没有重跑全工作区测试或历史完整窗口套件；0.4.8的166文件1793项等记录属于该版本历史证据。实际范围和未实测边界见[验证记录](../VALIDATION.md)。以下列出可选验证命令，按改动选择。

## 测试分层

默认执行与改动对应的最小充分验证。下列命令分别用于不同验证层级，不是每次维护的必执行清单；纯版本元数据或文档更新不自动全测。根依赖、锁文件或公共构建／运行配置发生实质变化时执行全工作区构建和测试；队列、恢复、迁移与IPC改动补相应真实行为专项，UI修改构建应用并操作相关Electron页面。

```powershell
pnpm build
pnpm test --maxWorkers=1
pnpm test:e2e:check
pnpm test:e2e:mock
pnpm test:e2e:pixelmuse
pnpm test:e2e:settings
pnpm test:release-checker
```

- 全测与Electron/打包分开运行。文件级串行不取消测试内部的并发和故障行为检查。
- `test:e2e:check`仅检查注册、脚本语法和覆盖计划，不证明业务通过。
- 三个真实Electron驱动分别为64个原业务、14个采集/工作空间、5个设置场景。通过`ECOMGEN_E2E_ARTIFACTS`指定新的空结果目录。
- `ECOMGEN_E2E_EXECUTABLE`指定最终解包EXE；不设置则运行源码构建。采集驱动需要0.3.0基线EXE，可用`PIXELMUSE_BASELINE_EXECUTABLE`覆盖。
- 缺少前提应失败或阻断，不跳过关键检查、不延长时限掩盖问题、不用假成功替代真实Provider失败。
- 小范围维护应明确实际执行的专项及未重跑的完整套件；旧版本的全测和冻结包结果不是新源码证据。

## 数据库和工作空间

当前0.5.0的业务库canonical v12由core统一创建/升级，v6→v7新增SKU目录和分镜用途/过期/替代字段，v7→v8新增项目采用状态及详情顺序，v8→v9替换UNKNOWN审计触发器，v9→v10加入任务级中断处置约束，v10→v11为应用设置补入AI默认值且不改写旧任务快照，v11→v12新增规划来源、套图批次关联及共享修订结果，保留旧密文、请求回执、审计历史、有效用量恢复游标及原产物。旧0.4.8安装包为v11、0.4.6为v9、0.4.5为v7、0.4.4为v6。Backend runtime不临时建表。旧桌面任务可作为不可执行历史保留，不恢复旧Web数据库或载荷decoder。升级前退出并备份完整userData与媒体空间，升级后不使用0.4.8或更旧安装包打开同一v12数据库。

工作空间只从“设置 → 工作空间与数据”操作。复制并逐文件校验完成后切换配置，源副本保留。排队/运行任务或尚未结束的操作应阻止切换；目录失联时停止媒体读写，通过原路径重连，不建立空替身。设置/用量等SQLite操作仍可访问。

备份前退出应用，同时备份完整userData与当前媒体目录。只复制媒体不足以恢复项目；safeStorage绑定系统环境，复制整目录不保证跨设备解密。不要把真实库、密钥、素材和导出提交到Git。

## 资源生成

- 模板：修改ecom-skill源JSON，执行该包`gen:templates`。
- 反推技能：修改ecom-suite-forge/skill，执行`gen:forge-skill`。
- 套图：修改ecom-suite/src/suites，执行`gen:suites`或该包build生成只读DB。

生成manifest和内容哈希用于固定依赖；不要直接修生成DB或绕过模板校验。

## 构建与发布

产品版本位于apps/desktop/package.json，输出目录位于electron-builder.yml。保持appId、userData和系统主密钥身份；新版本单独输出，避免覆盖已验证包。0.5.0安装器和解包版位于release/0.5.0，已发布到固定GitHub仓库；应用打包命令仍固定publish never，上传与发布为独立步骤。实际检查和边界见[验证记录](../VALIDATION.md)，GitHub更新源与附件发布步骤见[软件更新说明](software-updates.md)。旧0.4.8和有效升级基线继续保留；以下示例用于0.5.0，每次须选择新的报告路径，后续版本使用独立目录。

`pnpm run pack`和`pnpm run dist`会先构建；`pnpm pack`是npm tarball。冻结编译后若只打包，可执行应用包的`run dist`（应用脚本已固定`--publish never`），不要在Source/EXE验收之间重建out/dist。

```powershell
pnpm verify:release --release-dir release/0.5.0 --expected-version 0.5.0 --output .cache/release-check-new.json
```

检查器报告路径必须新建且位于发布目录外。验证实际ASAR/EXE/安装器哈希，解包内容逐文件比较不等于执行安装器。签名、安装路径、安装器升级/卸载另列验证范围。

安装器内容比对使用稳定工具入口；7za通过参数、PIXELMUSE_7ZA或PATH配置，不固定某台电脑的用户路径：

```powershell
node scripts/verify-installer-payload.mjs release/0.5.0/PixelMuse-0.5.0-x64-Setup.exe release/0.5.0/win-unpacked .cache/payload-new.json --seven-zip C:/Tools/7za.exe
```

工具先检查归档路径、链接与容量，再提取到新建临时目录并比较全部应用文件。根目录Chromium debug.log会在运行时追加，单列两端哈希，不计入不可变应用文件；其他文件必须逐个相同。原始安装器和解包目录不修改，只清理工具自己创建的临时提取目录。

`verify-pixelmuse-acceptance.mjs`当前是0.4.0完整六运行证据的冻结核对器，明确锁定0.4.0。不要把它的旧通过报告用于0.4.6或其他维护版本；后续版本需建立对应版本和范围的独立证据。当前驱动的预期产品版本读取应用manifest，0.3.0基线版本仍固定。

## 常见排查

| 现象 | 首先检查 |
| --- | --- |
| COMMAND_UNAVAILABLE/契约失败 | contracts操作注册、公开投影、输入输出schema；不新增兼容HTTP接口 |
| UNKNOWN/已中断 | 使用任务级重试/结束或项目批量处理；后台保留未知请求历史，不填核实表、不清库解锁 |
| 媒体不可用 | 设置页原目录/身份、设备路径和资源hash；不改回旧副本 |
| 页面旧数据 | topic失效映射、query key和异步保存顺序；不把事件当状态真相 |
| 重试测试偶发仍RUNNING | 调度认领与真实settlement同步；不要靠增加一秒轮询时限 |
| EXE身份拒绝重复包 | ASAR中的实际workspace根和编译hash；不要关闭混包拒绝保护 |
| 缩放截图裁切 | 原生capturePage、控件边界及实际点击；不要只信Playwright截图 |

归档操作及永久删除限制见[整理清单](cleanup-record-20261106.json)；当前结果见[验证记录](../VALIDATION.md)。
