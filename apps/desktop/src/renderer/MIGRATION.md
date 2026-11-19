# PixelMuse 渲染层接入

生产入口为 main.tsx → app/App.tsx，业务页面通过 AppShell 与 memory router 接入，使用 CSS Modules、PixelMuse A版黑白设计 token、AntD 与中文 locale，以及 MotionConfig reducedMotion=user。保留原业务、真实图片颜色与编辑蒙版语义，不运行旧 Web 服务。当前 Source/EXE 完整业务与设置验收见[验证记录](../../../../VALIDATION.md)；下方标为历史的段落仅保留原迁移交接过程。

## 页面与操作

| 路由 | 页面 | 具名操作族 |
| --- | --- | --- |
| / | 项目画廊、创建、归档、恢复、删除 | listProjects/createProject/updateProject/deleteProject/listProviders |
| /projects/:projectId | setup/storyboard/results 工作台 | 项目/素材/规划快照/分镜/生成/文案/编辑/分层/导出 |
| /library | 七类资产、筛选分页、加入项目、保存 | listLibraryAssets/copyLibraryAssetToProject |
| /suite-forge | 源图、反推任务、结果编辑与入库 | listSuiteForgeJobResults/createSuiteForgeJob/getSuiteForgeResult/commitSuiteForgeResult |
| /models | 身份设计、参考脸、候选、选中与删除 | listModels/createModel/updateModel/deleteModel/*ModelReferenceFace/*ModelPortrait* |
| /patterns | 花型墙、提取、上传、起稿 | listPatterns/createPatternExtractJob/uploadPattern/createPatternForgeJob |
| /patterns/:patternId | 衍生、平铺验缝、规格包、Listing、成包流水线 | *PatternDerive*/*PatternVariant*/*PatternTileCheck*/*PrintPack*/*PatternListing*/*PatternPipeline* |
| /pattern-drafts | 草稿创建、归档、恢复、删除 | listPatternDrafts/createPatternDraft/updatePatternDraft/deletePatternDraft |
| /pattern-drafts/:draftId | CAS 自动保存/离开前 flush、媒体、批次/槽位/候选、标注与接缝画布、比较、定稿 | getPatternDraft/updatePatternDraft/*DraftMedia/*DraftBatch/*DraftCandidate* |

设置中心位于 `/settings/:section`，包含常规、模型配置、用量、工作空间、搜索采集与关于。模型配置保留多模型、能力、发现/测试和粘贴连接信息，以服务连接管理地址和加密密钥；全局默认只作用于新创作。业务调用统一 api/client.ts 的 invoke<K extends Operation>(operation:K,input:Input<K>):Promise<Output<K>>；不解释 method/path，不使用 openapi-fetch。

编辑工作区直接调用 createEditSession/getEditSession/updateEditSessionMemory/selectEditSessionOutput/listEditReferenceAssets/uploadEditReferenceAsset/deleteEditReferenceAsset/promoteEditReferenceAsset/createEditTurn/getEditTurn/approveEditTurn。蒙版用 ByteImport，批注和引用选择使用契约声明的 JSON 字符串字段。分层直接调用 getLayerPlan/createLayerPlan/getLayerExport/createLayerExport/listLayerExports。图层显隐/排序、PNG/ZIP/PSD 合成仍在原版客户端逻辑中，PSD 编码使用 module worker。

IPC 事件只失效查询；全局 DesktopChanges 合并刷新，项目订阅筛选 projectId。查询结果保持状态真相，任务失败和 UNKNOWN 不被转成成功或自动重试。

## 宿主边界

main/preload 使用 DesktopApi 与 host.resolveResource。资源 URL 只编码 ResourceRef 的 kind/id/index，canvas fetch 集中于 lib/resource.ts 且拒绝其他协议。main 验证 trusted 主 frame、TypeBox 输入/输出，sandbox/contextIsolation 开启；外部导航、窗口、权限和浏览器下载被拒绝。safeStorage 主密钥仍仅在 main 解封并传至 utilityProcess。

原生图片选择 pickFiles 有数量、单文件 50MiB、总量 128MiB 限制，读取拒绝链接/特殊文件并检测读取期间变化。拖入/粘贴/画布入口先检查容量再编码，后台继续验证真实解码。saveArtifact 接收资源引用和可选的有界建议文件名，由后台解析资源、校正真实扩展名后显示保存对话框；renderer 不提供保存路径。packages/contracts 声明受限的 readClipboardText/writeClipboardText（64KiB）及 saveGeneratedFile（64MiB；PNG/PSD/ZIP/JSON 签名/扩展名检查）；应用信息、固定目录、白名单诊断和有界CSV保存也通过具名原生契约提供，这些能力不接收任意路径。预加载运行时只有 Electron 导入，业务契约仅作编译时类型，适配 Electron sandbox。

## 迁移阶段依赖记录（历史）

沿用协调者已添加的 react/react-dom、react-router、@tanstack/react-query、antd、@ant-design/icons、lucide-react、motion、react-photo-album、react-virtuoso、ag-psd、fflate、hero-patterns、@ecomgen/contracts、@ecomgen/domain、@ecomgen/ecom-skill、@sinclair/typebox。测试需要 @testing-library/react、@testing-library/user-event、@testing-library/jest-dom（固定 6.9.1）、jsdom、vitest。公共字体放在 apps/desktop/public/fonts。未改 package manifest、锁文件、构建配置或根脚本。

## 迁移阶段共享契约交接（历史）

以下是原迁移阶段的分工记录，不能当作当前仍未接线的清单。当前默认 Backend 已接入完整命令与执行器，公开结果以 contracts 的现行 DTO 为准；不得重新添加网络兼容接口。

图片契约已在并行整合中修正：ByteImportSchema 同源于 domain 的 ImageByteImportSchema，支持 PNG/JPEG/WebP/AVIF/TIFF；createPatternExtractJob 接收同源字节对象。宿主与 renderer 均以真实文件头选择这五种 MIME，不隐式转码；pngInput 单独维持编辑/保护蒙版的 PNG 类型。

1. public-schema.ts 删除整个 generationSnapshot；原版结果页需要其中安全的 revision 来显示重新生成标记/批次重试计数。应给 Output 的公开 DTO 增加脱敏 revision（不回传原执行快照），并在 C 的投影填充。renderer 的 outputMetadata.ts 已准备只读公开 revision；缺失时无法可靠显示历史重试标记。
2. main/backend-entry.ts 继续只调用 createBackend；协调者需在 C/D 就绪后注入完整 CommandHandlers 与 ExecutorMap，或由 B 在统一入口完成默认整合。未注入时后台会真实报 COMMAND_UNAVAILABLE，不能据界面渲染声称业务已全量通过。

## 当前验证入口

在 desktop 实际工作目录运行；Vitest 的 --root 不会替子进程切换 cwd：

```powershell
cd E:\EcomGen\desktop
pnpm build
pnpm test --maxWorkers=1
pnpm test:e2e:mock
pnpm test:e2e:pixelmuse
pnpm test:e2e:settings
```

完整根测试与 Electron 驱动分开运行。三种实际应用驱动分别覆盖64个原业务、14个采集/工作空间、5个设置场景；通过 ECOMGEN_E2E_EXECUTABLE 指定解包 EXE。它们使用隔离 userData、合成素材和本机假 Provider，驱动生产 renderer/preload/main/Backend，不以假 IPC 窗口替代最终应用验收。

旧 window-smoke.mjs 是迁移阶段的隔离 UI 夹具，使用 TypeBox 校验的假具名 IPC，只证明 UI 接线与渲染，不能替代当前三种 Source/EXE 验收。
