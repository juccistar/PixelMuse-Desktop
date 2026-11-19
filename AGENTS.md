# PixelMuse Desktop

本目录是独立的 Windows 桌面源码仓库，根目录即 pnpm workspace，当前位置为 E:/PixelMuse-Desktop。E:/PixelMuse 是软件安装目录，不在其中存放源码或构建输出。旧项目留在 E:/EcomGen/legacy，仅作业务迁移参考，不作为运行依赖。

- TypeScript ESM、严格类型检查；公开导出使用简洁中文 JSDoc，注释解释原因。
- Electron main 负责系统能力和 Backend 生命周期；preload 只暴露契约白名单；renderer 不访问 Node、数据库、Provider 或任意本地路径。
- packages/backend 独占 SQLite 和业务存储；长任务在持久化队列执行，不能阻塞主进程。
- packages/contracts 的 TypeBox schema 是通信契约唯一手写真相源。查询结果是状态真相，事件仅触发重新查询。
- 不保留 HTTP、Redis、BullMQ、旧 .env 或旧数据库的运行时兼容。
- Provider Key 使用随机主密钥通过 AES（256 位 GCM 模式）加密，主密钥通过系统 safeStorage 保护；不回传、记录或导出凭据。
- 规划/生成及后续聚合必须保留请求指纹、外部请求未知时不自动重试、模板校验、PIXEL_PROTECTED/PRODUCT_TRUTH 以及稳定产物标识等领域不变量。UI 按用户选定的 PixelMuse A 版黑白极简风格统一，定位为“商品视觉创作工作台”；保留完整业务、真实图片颜色与编辑/蒙版语义，未经用户要求不得另换风格。
- 不伪造尚未迁入的能力；README 中明确已实现与待迁移内容。

## 维护入口

- 维护资料统一从 docs/README.md 进入，架构、技术栈、来源、目录、设计与模块地图随实现更新；docs/archive/保存历史原文，不当作当前待办。
- 工作空间位置只在“设置 → 工作空间与数据”配置，侧栏不增加重复入口；保留迁移进度、取消、繁忙拒绝和原路径重连。
- 历史工具可恢复归档，按 docs/cleanup-record-20261106.json 追溯；保留有效升级基线、最终证据和当前脚本依赖，不能按日期批量删除。

## 验证

- 根配置/锁文件改动运行 pnpm build 和 pnpm test。
- 持久化队列、取消、重试、重启恢复与 IPC 边界必须有真实行为测试。
- UI 通过构建及实际 Electron 渲染/操作验证；不为简单排版新增测试。
- pnpm test:e2e:mock 驱动真实 Electron 的64个原业务场景；test:e2e:pixelmuse 验证14个品牌升级、采集与工作空间场景；test:e2e:settings 验证5个设置中心场景，均使用隔离数据和假 Provider。完整发布的Source/EXE六份结果须绑定同一编译哈希和最终发布包，不复用历史候选。小范围维护明确实际执行的专项与未重跑的完整套件；0.4.1本轮范围见VALIDATION.md，不继承0.4.0全测结论。
- 禁止提交真实密钥、用户数据、生成产物和安装包。仅在用户明确要求时创建Git提交或推送，不声称执行了未实际完成的提交。
- 目录独立过程、原Git历史映射及全新仓库初始化见docs/project-relocation-20261119.md；当前仓库以main为默认分支，不继承旧提交历史，未配置远程，后续如需发布源码，由用户明确指定目标仓库。
