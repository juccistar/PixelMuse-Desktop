# 代码与资源来源

本页用于维护追溯。代码来源、格式验证、业务能力和授权状态是不同信息，不能互相替代。

## 自有代码的来源分层

| 类别 | 当前位置 | 来源与维护方式 |
| --- | --- | --- |
| 业务、原界面交互与算法 | renderer/features、backend/commands与execution | 从legacy业务迁移并接入桌面契约；legacy仅作归档参考，不是运行依赖 |
| 桌面基础设施 | main、preload、core、backend/runtime、contracts | Electron系统边界、SQLite显式迁移、持久队列、回执账本及资源引用等新版实现 |
| 品牌与界面 | renderer/design、styles、assets、apps/desktop/build | 用户选定PixelMuse A版黑白方向；CSS token与本地图形为实际实现 |
| 原操作与任务映射 | migration-discovery的3份有效基线 | 保留原业务操作/任务清单；部分旧分析已归档，不能据旧待办判断当前缺口 |

代码迁移前的材料位于工作区[legacy](../../legacy/)。不要从中复制.env、用户库、Key或素材来运行新版。

## 模板、技能与套图

### 电商模板

[packages/ecom-skill/UPSTREAM.md](../packages/ecom-skill/UPSTREAM.md)记录来源为[liangdabiao/ecom-details-image](https://github.com/liangdabiao/ecom-details-image)，固定commit `1ec867b743179af3598db55388f65287c4e04de1`，原路径为`.claude/skills/ecom-details-image/`。模板JSON与技能说明内置到本包，category_tips存在本地增强。

模板内容修改后生成静态manifest和SHA-256；运行时不读取外部skill目录或Git。现有上游记录未提供LICENSE，不能把它描述成已确认MIT。

### 套图反推技能

[packages/ecom-suite-forge/UPSTREAM.md](../packages/ecom-suite-forge/UPSTREAM.md)记录原仓库`.agents/skills/ecom-suite-forge`来源。`skill/`和生成manifest属于构建输入/输出，没有独立的外部版本号。维护来源记录，不能虚构外部仓库URL或授权结论。

### 品类与内置套图

- 品类来自TrendLens《品类采集清单》一次性快照：24大类、169中类。486个leaf并未全部内置，实际叶类可由识图和用户提示形成自由文本。
- 内置套图源为[packages/ecom-suite/src/suites](../packages/ecom-suite/src/suites/)，当前构建生成1173套只读目录。JSON经过规范化与内容哈希校验后生成`dist/builtin-suites.db`。
- `builtin-suites.db`是构建生成的只读资源，不是用户业务数据库；不得直接改生成DB作为维护方式。
- 套图JSON中的provenance字段保留来源集、源图数量和剥离原品牌等加工说明；不能据此自动推导全部素材授权或真实模型质量。

## 第三方依赖

下列仓库地址来自本次锁定依赖的package元数据；不是完整依赖或授权审计。版本快照见[技术栈](technical-stack.md)。

| 依赖 | 包元数据中的仓库 |
| --- | --- |
| Electron | https://github.com/electron/electron |
| React | https://github.com/react/react.git |
| Ant Design | https://github.com/ant-design/ant-design |
| better-sqlite3 | https://github.com/WiseLibs/better-sqlite3 |
| sharp | https://github.com/lovell/sharp |
| Pi agent-core / pi-ai | https://github.com/earendil-works/pi |
| Vite | https://github.com/vitejs/vite |
| Vitest | https://github.com/vitest-dev/vitest |

其他依赖先以workspace manifest及锁文件定位，再查看该锁定包的repository/homepage信息；不要从名称猜上游、版本或许可。

## 字体、图标与设计参考

字体配置使用本机`local()`和系统回退，没有随包交付字体二进制或在线字体请求。Lucide提供界面图标，PixelMuse标识与安装图标在本地assets/build目录。黑白视觉方向由用户选定，参考X/Twitter的简洁信息组织；这不表示引用了其实现代码或资源。

历史自有许可证清理记录保留在工作区工具清单中，不代表第三方声明或上游授权已被替代。本轮整理不新增许可证结论。
