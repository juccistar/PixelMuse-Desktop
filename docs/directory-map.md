# 目录与文件职责

以下路径以工作区`E:/EcomGen`为根。源码按现有运行边界保留；分类整理优先移动历史资料，避免为形式整齐改变运行导入路径。

```text
EcomGen/
├─ AGENTS.md / README.md             工作区规则与入口
├─ desktop/
│  ├─ apps/desktop/
│  │  ├─ src/main/                   窗口、原生能力、采集、Backend宿主
│  │  ├─ src/preload/                白名单桥
│  │  ├─ src/shared/                 宿主共享类型/重导出
│  │  ├─ src/renderer/
│  │  │  ├─ app/                    路由、Provider和全局配置
│  │  │  ├─ api/                    具名IPC、hooks与失效通知
│  │  │  ├─ components/             AppShell、导航守卫等共享UI
│  │  │  ├─ features/               按业务模块组织页面
│  │  │  ├─ design/ styles/ assets/  token、主题、字体与品牌资源
│  │  │  └─ lib/ test/              客户端工具与测试基础设施
│  │  ├─ build/                     安装图标等构建输入
│  │  └─ out/                       生成的Electron运行文件
│  ├─ packages/                     领域/契约/存储/队列/协议/技能包
│  ├─ scripts/                      当前验收与发布工具
│  ├─ migration-discovery/          仍被工具读取的原操作/任务/功能基线
│  ├─ docs/                         当前维护手册、归档与整理清单
│  ├─ release/<version>/            按版本保留的EXE和安装器
│  └─ .cache/                       忽略的临时文件与验证证据
├─ legacy/                          旧版归档，只作来源参考
└─ .workspace-tools/                一次性整理记录、旧基线与工具归档
```

## 包的职责

| 包 | 职责 |
| --- | --- |
| domain | 领域类型、限制与纯约束 |
| contracts | TypeBox通信契约、公开DTO和原生能力 |
| core | canonical SQLite、显式迁移、仓储、存储、密钥、目录和纯服务 |
| backend | commands、execution、runtime及工作空间迁移 |
| providers | 文本/图像/分割服务协议 |
| agent | Pi限定业务工作流 |
| ecom-skill | 模板、Prompt编译及来源记录 |
| ecom-suite | 套图JSON、只读目录与DB生成 |
| ecom-suite-forge | 反推技能、规范与静态manifest |

## 工具分类

当前脚本索引见[scripts/README.md](../scripts/README.md)。保留有效脚本的现有位置：动态启动路径、环境注入路径、源码指纹和类型声明也可能引用它们，不能只查import就移动。

`migration-discovery`保留`original-api-inventory.json`、`original-job-inventory.json`、`map-4.json`以及生成的覆盖记录；原分析/分工/审查资料已进入[历史归档](archive/migration-0.3.0/)。

## 生成文件和历史资料

- node_modules、dist、out、release、.cache不是运行源码分类；忽略规则不等于“可以全部删掉”。
- release/0.3.0仍是升级验收基线；历史版本、当前0.5.0和已引用的最终证据保留，旧0.4.8未覆盖。release/按版本保存产物，2026-11-09清理涉及的失败候选诊断元数据位于`.workspace-tools/archive/cleanup-20261109/`。
- 2026-11-06的一次性移动/重写脚本归档见[历史整理清单](cleanup-record-20261106.json)，该轮没有永久删除。
- 2026-11-09清理失败构建运行副本、写入试验EXE和Vitest内部结果缓存，共15,222文件、187目录、约4.08GB；失败报告与日志保留，11份诊断文件按原始字节归档。原路径、去向、大小与哈希见[本轮清理记录](cleanup-record-20261109.json)。
- `.cache`的分类与保留说明见[目录说明](../.cache/README.md)。最终/失败验收报告、截图、源码对照快照、开发userData、设计参考及当前工具仍保留；旧报告中的失败包路径按清理记录追溯。
- 正在使用的缓存、未知归属文件和被占用路径不强制处理。本轮进程检查确认`adversarial-verify-20261106`仍被引用，保留该树；没有停止无关程序或读取用户数据库内容。
- 根ARCHITECTURE/MIGRATION_STATUS/VALIDATION是稳定入口，不再堆叠维护正文和全部过程日志。
