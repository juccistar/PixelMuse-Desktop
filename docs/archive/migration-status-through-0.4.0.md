# PixelMuse 开发与桌面迁移记录

## PixelMuse 0.4.0：本轮开发与验收完成（2026-11-06）

- 当前冻结构建 bg1yfzz8t：266编译文件，runtimeHash `7ffa33db954a881128f90d02bff67f6ee9f5b998738d509f5f2aa4f4376a050a`。六类设置与canonical v6已实现并经独立审查补修，生产代码在本轮验收期间未再改变。
- 当前 Source：原业务64/64（be7p89l6h、164106断言）、采集与工作空间14/14（bfdwtlvyp）、设置5/5（bqplefg0q）均通过，来自不同隔离运行并绑定同一编译哈希。
- 当前 EXE：原业务64/64（bev9dylgo、164110断言）、采集与工作空间14/14（by1n3j4n5）和设置5/5（b1d3y2lrc）全部通过。六份运行证据已统一核对通过，报告 `.cache/final-pixelmuse-verification-20261106-settings-1.json`；根测试第3轮 b2l3qicx1 为1449/1450通过，唯一旧执行器重试在默认1秒轮询到期时仍为RUNNING；测试同步已修正且独立复核无缺陷，专项18项通过、排队/执行阻塞正控通过、失败负控正确触发三项失败；生产/超时/业务断言不变。最终完整串行全测 bnvd7vsc7：136文件/1450项全部通过、0失败0跳过，编译哈希复核未变。
- 去重包 b4wscmf4t 已生成，静态13/13、3792个安装器应用文件逐个SHA-256一致。安装器176897372字节，SHA256 `aff145af39356404f7c8cedd5842cc2cae27fa81449a285403013bc06abee5f6`。未执行安装器、未访问真实用户数据、未新增提交或推送。
- 本轮处理的验收问题包括：旧Provider弹窗自动关闭的驱动竞态、首次启动写入lastWorkspaceRoute后的迁移快照时序、画布悬停轮廓影响严格PNG比较、Electron缩放时Playwright截图裁切。均保留行为断言，未增加超时或修改付费幂等约束。根测试先前三轮存在测试定位、DOM遍历和异步结算观测问题，限定回归与独立正负控通过后，最终完整串行1450项全部通过；未增加测试时限或改动生产执行语义。
- 首包因pnpm link/version身份重复收集三份相同domain包而被严格运行身份保护拦截；只读归档与builder调查确认字节相同，打包配置精确排除两份冗余路径，运行身份拒绝保护未改。第一次重包遇到Windows EXE写入UNKNOWN，确认无PixelMuse进程后重试成功，没有强行结束程序。详细结果和边界见 [VALIDATION.md](VALIDATION.md)。

### 设置重构前及实施阶段记录（历史）

- 用户选定 A 版 X/Twitter 黑白极简，品牌 PixelMuse，定位“商品视觉创作工作台”，授权完成全模块 UI、商品图片采集与本地工作空间。
- wf_cddcf398-d12 完成四个边界发现；wf_8d3e2683-ff5 四名唯一 writer 已完成 UI、Foundation/Workspace、Collection 和品牌发布工具，未提交或推送。
- 九页共享侧栏、主题与各工作流、真实原生采集接口、v4 来源表、受管媒体迁移/归档均已接通。main 保持原 userData 和安装身份；协调者补上安全采集错误投影、主窗口/辅助浏览窗口退出屏障及主进程内部集成依赖导出。
- 独立生产审查、驱动审查及全部补修已完成。最后 wf_b88bd735-311 的工作空间与URL残留经独立真实行为复核无剩余确认缺陷；Cookie尾点域经真实Chromium差分确认修复。完整细节与失败历史见 VALIDATION.md。
- 补修后统一全构建 bwo02r8rt 退出0。根全测 boyrw1x8e 为124文件/1263项，1261通过、2项等待任务终态超时；当时与Native Electron并行。未放宽时限，bx5rvks0j 以maxWorkers=2单独重跑全套中。
- Native Source 第5轮 bf2m7jef9：14/14通过、0失败0阻断、renderer错误0、清理及临时userData删除通过；实际0.3.0 EXE写入后升级、最小窗口、工作空间迁移/忙碌/重启/画布归档、目录失联拒绝与原路径重连、采集Cookie+Referer、popup来源、会话隔离/手动回退/来源持久化/主窗口关闭全部通过。使用原创LUMA商品插画，未读取真实用户素材；已查看实际截图。
- 上述采集/工作空间候选为设置重构前 v4 编译代码；其242文件哈希 `dbc08685d7749c6015fe83b3678830c52e4e26c68e1c3ffbfc85065adb25cd10` 仅绑定该轮历史运行。
- 用户随后批准六类设置中心和模型配置重构，现已实现常规、模型列表/服务连接/默认用途、请求用量与单价、工作空间、搜索与采集、关于及固定原生能力。全部实施和独立复核工作流已结束，确认缺陷及最后残留已修正；canonical v6显式保留原数据和合法恢复游标。149项core/usage回归通过，默认选择4项通过，其余设置/后台交互/影响确认与事件回归25项通过。
- 当前源码统一构建 bg1yfzz8t 已通过，普通根配置 bz9xmfekq 正在 maxWorkers=2、真实cwd desktop下单独全测。当前构建的原业务Source/EXE各64、采集与工作空间各14、设置各5，以及发布包、安装器内容哈希和六份证据汇总尚需完成。未改动历史release/0.3.0，未提交或推送。

## 0.3.0 历史交付：原版业务桌面迁移完成（2026-11-06）

以下为 0.3.0 交付时的结论，其后检查点与执行阶段保留历史过程；不能当作 PixelMuse 0.4.0 的通过证据，也不代表旧 writer 仍在活动。

- 全工作区构建 bfjcapzc8 通过；根普通配置 `pnpm test --maxWorkers=4`（bzbygu59s）111 文件/996 项全过。
- 源码 Electron ba0fn3ca4：64/64、164106 断言；解包 EXE b520igiqk：64/64、164104 断言。两份均无失败/阻断，131 原操作、29 家族、20 类任务加 Listing 无缺口，renderer/fixture错误0，owner/临时数据清理通过。最终结果位于 `.cache/e2e-full/{source,exe}-0.3.0-acceptance-20261106-2/`。
- 最新包 brqdv3amt 构建成功，静态11/11（bnaqklqp0）与3789应用文件逐个字节一致性（bmj5rt1yc）通过；报告 `.cache/release-check-0.3.0-20261106-final-2.json` 与 `.cache/installer-payload-0.3.0-20261106-2.json`。安装器176716427字节，SHA256 `a0ab49177b863ae55e87703b5c8267cdea2ea5085918a9a8406ef3ef60ceca8e`。
- 统一证据脚本 `../.workspace-tools/verify-final-desktop-evidence-20261106.mjs` 已成功执行，报告 `.cache/final-desktop-verification-20261106-2.json` 同时核对完整门槛、实际ASAR/安装器hash及payload绑定，status=passed。
- 保留九条原版页面和原暗色/琥珀风格，已查看本次Source及EXE工作台/模特/编辑画布/分层编排/花型图片。模型初始查询竞态、跨访问保存排序、透明失败回放、草稿补偿、来源指纹、导出证据、MIME、逻辑退休、CORS、自动套图目标、UNKNOWN契约、资源清理规模阻塞均已修复并验证。
- 脚本最终注册/语法/helpers检查 bvjf0viwm 通过；新生命周期隐私6/6/758canary及实际错误清理通过，严格原始类型/单次字段读取修正亦经独立隔离探针确认。无遗留活动修复工作流。
- 边界保持明确：以上调用均为本机假Provider与合成素材，不宣称真实模型质量/计费已验；未执行安装器、已安装路径运行、升级、卸载或Windows原生对话框UI；安装器未签名、默认图标。没有复制旧.env/真实凭据/旧Web用户库/素材，没有Git提交或推送；本轮新版验证未停止旧服务，也未为打包强行终止用户程序。

完整功能与验证摘要已同步根README/AGENTS及desktop README/ARCHITECTURE/VALIDATION。历史0.2记录、首轮失败、受控负向探针及中间候选hash保留，不能用于替代上述最终报告。

## 2026-11-06 最新检查点（整体未完成）

- SetupPanel 跨项目访问保存排序已交付并独立复核：现有 23 项及额外 5 个真实临时 SQLite 探针通过，包含延迟响应/延迟提交、A→B→A、新用户意图优先、合法离开前保存、不同字段和正常 AI 采纳；尚待统一应用构建后的 Electron 验证。
- 新 Backend 编译后的非 UI 子集：`.cache/e2e-full/backend-flows-20261106-1/result.json`，53 场景为 40 通过、11 失败、2 阻断，34,780 断言，清理通过，completion=false。失败涉及编辑临时参考去重夹具、PSD 解码夹具、Seedream 元素匹配、SOURCE 重跑步骤、模板输出契约、套图文档夹具、网络拦截探针和崩溃前同步；不能当作完整 64 场景验收。
- 模板查询实际返回额外内部字段，已在 commands/index.ts 使用现有 projectPublic 投影；流水线 UNKNOWN 的真实阻断原因需要与 TypeBox 枚举及 catalog 同步。修复源文件尚待统一构建。
- wf_2cd47eb3-ba6 原执行链及误恢复的两条同 ID 链已明确停止，再按更新所有权恢复为 wbx1dlecw；不再直接消息恢复活动 Workflow 代理。wf_05d1d2c3-b88 / w7olryd1t 独占恢复脚本修正及独立实测。
- 发布检查器回归命令 `node --test scripts/verify-release-test.mjs` 已退出 0；最终包仍是旧候选，待新源码统一构建、完整 Source/EXE 验收及重新打包。旧服务和用户窗口未因本轮验证被终止；未提交 Git。

2026-11-06 统一验证启动：全工作区 `pnpm build`（bd8pxb04f）退出 0，已更新新的 main/preload/renderer 和 Backend。根全测 `pnpm test --maxWorkers=4`（b070h8c9d）执行中；标准 `pnpm test:e2e:mock` 完整 64 场景（bymp2y2bc）执行中，使用新路径 `.cache/e2e-full/source-0.3.0-acceptance-20261106-1/`，不能提前记为通过。注册表/驱动检查 b4tooei0n 退出 0，发布检查器 byp9akgk0 为 61/61 通过。版本控制路径检查发现 3016 个已跟踪、1773 个未跟踪文件中均无凭据文件、业务数据库、ZIP/EXE、依赖或用户数据路径；没有执行提交。

限定补修 wf_2cd47eb3-ba6 / wbx1dlecw 已交付：编辑/分层实际 Electron 17 场景全部通过，145,504 断言，守卫、SQLite、清理均通过；补充不匹配 Seedream 名称仍 FAILED 的负向回归和 FAL/Seedream 软 alpha PNG/PSD 检查。SOURCE 实际按原入口恢复，已有完整回执通过 retryJob 续尾阶段；有效 TILE_CHECK 取消/重试保留，3 个流水线场景 84 断言通过，source-alias 两文件 10 项通过；domain 枚举及 catalog 的 6 处投影已同步 UNKNOWN 原因。模板公开投影真实默认 Backend 回归 1 项与既有命令 27 项通过，套图 CRUD/resource 13 断言通过。以上仍是限定证据。协调者核对最新 dist 已含模板 projectPublic 和 EXTERNAL_RESULT_UNKNOWN，contracts/dist 未再输出测试文件；并非代理报告中的旧 dist 状态。完整 64 场景继续运行。

统一验证更新：b070h8c9d 根测试已退出 0，109 文件/986 项全过；b6u9mwqta 新 NSIS/解包包已退出 0，候选目录检查时没有运行中的 EcomGen.exe，未终止用户程序。打包曾发生目录 rename 的 EPERM，builder 自行回退 copy+delete 后成功，无强行清理。b6wq3htpz 实际包检查 11/11 通过，报告 `.cache/release-check-0.3.0-20261106-final-1.json`；安装器为 176,707,189 字节，SHA-256 `01d29cae15e8189e6a6b98c0416ed34d5dd05455b71342238565afa285ae2352`，未签名。EXE 完整 64 场景 b8dj3zvcv 使用 `.cache/e2e-full/exe-0.3.0-acceptance-20261106-1/` 执行中。wf_fb3724a0-185 只读完整性核查已交付，无确认阻塞：131 原操作、20 执行器+Listing、29 家族、原 UI feature 对应与完成门槛均核对；不代替正在执行的两份完整验收，也不声称安装/升级/卸载或真实模型质量已验。已实际查看本次 Source 工作台、编辑画布、分层编排与花型工作区截图，暗色/琥珀主题和真实生成素材可见。

完整验收首轮已结束，不能交付为完成：Source `.cache/e2e-full/source-0.3.0-acceptance-20261106-1/` 为 58 通过、1 失败、5 阻断，164,006 断言；EXE `.cache/e2e-full/exe-0.3.0-acceptance-20261106-1/` 为 56 通过、2 失败、6 阻断，163,978 断言。两份均已观察到全部 20 任务类型及 Listing 成功，但操作缺口仍为 getHealth/cancelJob/retryJob，整体 completion=false；renderer/fixture 错误为 0，最后清理通过。两份都在 receipt-replay-download-failure 的应用重启时没有新窗口，45 秒后超时；后续恢复场景被阻断。EXE 另在新建模特持久化成功后侧栏没有显示新模特，ui-model-designer 点击超时并阻断 routes-theme。原始失败和截图保留。

已启动 wf_bea98280-897 / w5akjw98j，仅独占 harness/launcher 生命周期诊断与唯一恢复探针，先证明真实原因，不能加超时或伪造成功；wf_d1b50b0a-df5 / wdc1tfjtd 独占 useModels/ModelDesigner/ModelsPage 的窄保存刷新问题、唯一回归及 ui-model-designer 场景，不改变 UI 风格。没有降低完整 64 场景门槛。此前 build/test/静态包通过仍有效，但不能代替这两处阻塞的补修和完整复验。

安装器内容补充检查：新增独立 `.workspace-tools/verify-installer-payload-20261106.mjs`，在全新临时目录只解压嵌入的应用归档、逐个 SHA-256 比对，不运行安装器。第一次因解包 EXE 在运行后生成根目录 debug.log 而严格文件集断言失败；已明确只将这一已查看的 Chromium 运行日志列为 runtimeExtras，所有应用文件仍必须完全一致，不忽略其他文件。第二次 bnru2fpu4 退出 0，`.cache/installer-payload-0.3.0-20261106-1.json`：3,789 个应用文件、712,169,678 展开字节均与当前 win-unpacked 一致，含 EXE、ASAR、原生模块和只读套图库；提取目录已清理。此证据绑定当前安装器 SHA `01d29cae…ae2352`，后续重打包必须用新报告重查；不能据此声称安装/升级/卸载已执行。

模特刷新补修 wf_d1b50b0a-df5 / wdc1tfjtd 已交付并独立复核：确认首次 models 查询尚无缓存时，失效重查会复用旧 Promise，创建前的旧列表随后落入缓存；不是错误定位器。useCreateModel 现在先取消 exact models 列表查询，再等待原有 prefix 失效/重查，仍保留 portrait 子查询刷新，不直接注入列表状态。新增 ModelsPage.model-create-refresh-sol.test.tsx 五项，作者三文件15项通过；独立当前组件+默认 Backend/临时SQLite五探针通过，去掉取消语句的内存负向对照两项按预期失败。独立覆盖数据库重开、旧响应释放不覆盖新列表和选择、筛选/当前选择、参考脸→真实本机假Provider选角→选定。源码 noEmit 通过；旧编译 Electron 的3场景仅证明定位器与普通路径正确，不当作新修复已打包。协调者清理 hook 中旧 HTTP/multipart 注释后，全工作区新构建 ba2i8nx9i 退出0，当前根全测 bl7mkxcd2 执行中。wf_bea98280-897 重启诊断仍未交付；不提前声明根因或修复。现有安装器仍为前述旧候选，后续须重新打包、Source/EXE64及新静态/内容检查。

重启阻塞根因已由 wf_bea98280-897 作者实测交付：不是 CDP 断开预先中断退出（五个受控挂起 Backend 退出实验反驳此假设），而是 ResourceRegistry.performCleanup 对每个清理意图扫描所有其他资源，并反复经 LocalAssetStore.absolute 做同步 lstat/realpath。299 资源/1 意图：普通生产启动3666ms、清理和再次重开均过；299资源/41意图/0任务：普通生产直接复现无窗口/真实启动错误。完整复现前58过，profile126jobs299resources41intents，旧Backend15.13秒退出、新Backend约30秒退出分别撞到固定生命周期截止。证据目录 `.cache/e2e-full/lifecycle-cdx-cleanup-probe-RVk0HH/`、`lifecycle-cdx-full-diagnostic-BYgTSB/`。已补安全、有限、脱敏的 launcher/main.log/guard诊断，先保留再清理；不写密钥、响应体、数据库快照或原始utility stderr。诊断/关闭自测3/3、helpers8/8、混合记录恢复12/12、逐业务单次重开44/44均有证据，但这些较小工作量不能代替失败的大集合。

新补修 wf_bebe0204-c02 / w3y5z2mqt：生产 ResourceRegistry 批次路径比较开销与共享/链接/迟到引用安全，一名唯一 writer 加独立复核；另一个唯一 writer 修新增模型测试在普通4worker根运行中的确定性/渲染开销。刚结束的 bl7mkxcd2 根测试为110文件991项、989通过2失败（都在新模型测试：默认1秒找不到列表、复杂选角测试20秒超时），不能当通过；不提高全局超时、不删断言。待新生产修复交付后再统一构建、全测及完整Source/EXE。未重新打包或声称已完成。

重启诊断 wf_bea98280-897 / w5akjw98j 已独立复核结束：普通生产299资源/41意图继续失败；关闭41意图需15285ms、没有closed确认、owner锁保留，exit code0不代表正常清理；1意图关闭1633ms、闭合确认与释放锁正常。小混合数据26jobs74resources3intents的12场景全部过（回执恢复共1POST、额外重开0POST、5次关闭均closed且释放锁），证明不是回执自身逻辑缺项。资源生产优化已由后续wfbebe处理，未提高15s/30s截止。

独立复核另外发现新诊断的自由文本脱敏不够严格：未知假Key/私有快照 canary可穿过字符串脱敏器，写入已被探针拦截，没有将canary保存；实际106份诊断审计无已知secret/私有字段/原始输出，46个owned PID均已退出。一次工具自动审批拒绝某测试PID清理kill，随后只读确认进程已退出，最终无残留；没有绕过拒绝。已启动 wf_06447323-915 / wvin6jlh3，仅将新生命周期诊断改为严格结构白名单并独立验证；保留失败、时限和网络隔离，不复制任意stderr/错误/快照字符串。模型测试修复作者已交付4文件19项在4worker通过和有效负向对照，等待独立复核与最终根全测。所有完整门槛仍未满足，继续执行。

清理优化作者已交付 backend/src/runtime/resources.ts：只在单次清理内缓存已验证的路径比较键，不缓存资源/owner/历史/意图状态，不用比较缓存授权实际文件访问，删除前仍重新调用 storage.absolute。逐行重新读取意图，避免另一个删除 await 期间已被retain/release取消的旧队列快照继续删除。新增 cleanup-scale-security-cdx-20261106.test.ts 五项：299/41最多340次absolute、跨await新别名/owner/历史/取消意图、斜杠/大小写共享、RETIRING、逻辑退休、缓存后硬链接/junction替换与安全重试。源别名五项通过，既有runtime/history/commands加新回归12文件110项通过，Backend noEmit通过，直接源码299/41运行819ms、340次absolute、剩258资源0意图。扩展全源别名运行曾停滞并停止，不计通过。独立复核尚未交付；协调者新全构建 bfjcapzc8 执行中，完成后先跑普通生产299/41 Electron probe，再全测和完整Source/EXE。

模型测试等待/渲染成本补修已由作者交付4文件19项在4worker通过，新增具体查询/SQLite/任务SUCCEEDED等待，实际AntD事件不绕过处理器，完整创建上传选角选择case仅自身30s预算，实际18.56s；删除取消语句的no-cache对照、删除await失效的cached对照均仍失败。未改生产hook/全局超时，独立复核待完成。新诊断隐私白名单补修 wvin6jlh3 仍进行中。

wf_bebe0204-c02 / w3y5z2mqt 已全部独立复核交付，无确认阻塞。正常根配置5文件32项通过，全源依赖别名五项清理回归通过、Backend noEmit通过；真实LocalAssetStore/SQLite无FS mock 299/41清理1124ms/340次absolute，所有299个文件结果核对。默认源码Backend带积压启动1184ms、关闭29ms、owner锁移除且再次重开；启动后另排41意图的关闭929ms/340次absolute，保留258文件删除41文件，重开52ms。独立模型测试普通根选项4文件19项通过（复杂case19.13s），3个迟到旧响应探针通过，取消/await两种负向对照仍检测失败，无伪造query状态。

协调者全构建 bfjcapzc8 已退出0，根完整测试 bzbygu59s 执行中。实际普通生产 Electron 299资源/41意图 probe bdkxbl602 已退出0：首次启动7044ms、剩258资源/0意图、integrity ok/FK[]、退出owner锁不存在、再次重开成功、cleanup[]。证据 `.cache/e2e-full/lifecycle-cdx-cleanup-probe-EL34Sj/cleanup-probe-result.json`。确认无EcomGen.exe占用后新打包 bestx76wu 执行中；仍待完整Source64/EXE64及新静态/安装器内容报告，旧候选报告的hash不代表这次新包。最终统一证据脚本已预备改指新的 source/exe acceptance-20261106-2 与 final-2/payload-2 路径，未提前运行或宣称通过。

第二轮源码完整验收已通过：ba0fn3ca4 退出0，`.cache/e2e-full/source-0.3.0-acceptance-20261106-2/result.json` 为64通过/0失败/0阻断、164106断言、20任务类型加Listing无缺口、operationGaps[]，coverage为131/131操作、29/29家族且completion=true。renderer/fixture错误0，临时userData已清理。已查看本轮模特界面：新旧两位均在侧栏、新建者可选、参考脸与选定定妆图可见，原暗色琥珀风格正常。根完整测试 bzbygu59s 已退出0：111文件996项全过；新脚本注册/语法/helpers检查 bvjf0viwm 退出0。

新打包 bestx76wu 曾因Github构建资产连接ETIMEDOUT退出1；标准命令重试 brqdv3amt 退出0，没有更改构建配置、缓存来源或强删用户进程。新实际包 bnaqklqp0 为11/11通过，`.cache/release-check-0.3.0-20261106-final-2.json`；安装器176716427字节、SHA256 `a0ab49177b863ae55e87703b5c8267cdea2ea5085918a9a8406ef3ef60ceca8e`、未签名。新payload检查 bmj5rt1yc 通过，`.cache/installer-payload-0.3.0-20261106-2.json`：3789应用文件完全一致，runtimeExtras[]。EXE第二轮 b520igiqk/`.cache/e2e-full/exe-0.3.0-acceptance-20261106-2/` 仍执行中，不提前宣布完成。

诊断隐私 wf_06447323-915 已结束：普通JSON/日志716 canary场景通过，但独立复核发现Object.hasOwn对boxed enum隐式转换并保留对象、抛出toString可跳过launch清理。三个探针写入均被截获未保存。协调者已机械修正：读取原因/message/code/cleanupReason一次并捕获getter异常，只接受原始string枚举；harness仅复制安全结果，stage读取也捕获异常。新增boxed/proxy/throwing getter/flapping getter及真实launch coercion回归，修正新增case后报告计数为6；bb2id7dt1实际6/6、758canary通过、清理/closed/owner锁核对通过，证据 `.cache/e2e-full/lifecycle-privacy-cdx-QFSU1F/privacy-result.json`。独立Agent a95e619df67b87161 已用隔离临时内存sink重查准确回归，boxed/toJSON未调用、getter一次/异常容纳、实际序列化无泄漏，无确认阻塞。未进行新生产修改或额外构建。最终路径卫生检查已跟踪3016/未跟踪1794，均无敏感/用户数据/生成包路径；git diff --check通过，无Git提交。

## 目标与约束

用户最新指令：**“继续完成剩余迁移，全部迁移完毕再停止。”**

本次交付目标是旧版已实现业务的完整桌面迁移，不再以第一批纵向流程或源码复制作为完成条件。以 legacy 当前源码、界面和测试为基线；新版维持 Electron + React + utilityProcess Backend + SQLite，沿用旧版 UI 风格，不恢复 HTTP/Redis/BullMQ/SSE 运行兼容，不复制旧 .env、凭据、用户数据库或素材。

旧服务继续运行作对照，不为迁移或打包强行终止现有窗口/服务。所有自动验证只使用隔离数据、生成素材和假 Provider，不调用真实模型。

此前用户已明确授权删除 7 份具名项目许可证和自有 MIT 元数据，清理记录见 ../.workspace-tools/license-cleanup.json；第三方依赖/Electron 声明与上游来源记录保留。不要再次复制项目许可证。

## 已有基线

- desktop 0.2.0：项目素材、业务设置、Pi 规划/版本确认/单候选生成、文本分割、人工矩形 PSD、花型改色/验缝、内置套图目录/反推草稿。
- 全量构建通过，27 个测试文件、220 项测试通过。
- 最终解包 EXE 真实窗口验收通过，结果 .cache/e2e-packaged-0.2.0/result.json。
- 最终安装器 release/0.2.0/EcomGen-0.2.0-x64-Setup.exe，实际安装/升级/卸载尚未验收。
- 源码基线位于 ../.workspace-tools/baseline-desktop-0.2.0，1361 个受控源码/资源文件；不含依赖、构建产物、用户目录或凭据。
- 旧版首页、套图工坊、花型工坊、资产库、模特库、Provider 抽屉已通过真实 Chrome 只读导航采集，参考图在 ../legacy/.cache/migration-ui-reference；已查看关键工坊/模特布局，无页面运行错误。

## 执行阶段

1. **完整覆盖映射：完成。** workflow desktop-full-parity-map，runId wf_6ca4d780-b26，9 个映射/核对/汇总代理完成。结果已提取到 migration-discovery/map-1..4.json 和 ownership-plan.md；实施以 INTERFACES.md 的最终决定为准，不照搬与无旧运行兼容规则冲突的建议。
2. **完整实施：进行中。** workflow complete-desktop-business-migration，runId wf_2baf1911-a9d，task wyjpmuazo。阶段一 A 独占 core、B 独占 contracts/domain/runtime，完成接口后再并行 C 全领域命令、D 全执行器、E 原版完整 UI/宿主、F 外部网络/Pi 回执；最后串行整合与独立完整性核验。之前独立 foundation 工作流 wf_58d69c65-807 因重叠写入已停止，core 部分文件需 A 核对后统一，不能将其视作已完成。不要向工作流中的同 ID 代理直接发送恢复型消息，以免形成重叠写入链。非 Git 工作区，不使用工作树或伪造提交。原版 UI 依赖、renderer 测试依赖和 core workspace 链接已统一安装，jest-dom 已固定为稳定 6.9.1。Vitest 已纳入 TSX 与 renderer jsdom；最终统一构建/测试待实施稳定后执行。独立 workflow full-migration-fake-protocol-fixtures（wf_911fc562-79f / w5zbuef9p）已完成；交付 scripts/full-mock-* 与 backend/test/protocol-fixture.test.ts。代理报告 22 项实际适配器/Pi 集成测试、68 项集成自检、47 项独立 HTTP 协议检查及针对性严格类型检查通过；这些消费当时的 dist，不代表并发中的完整生产源码已经通过验证。A 的 core 阶段已交付，代理报告构建及 8 文件/98 项包内测试通过；B 与后续业务接入仍在进行。
3. **整合与独立审查：已编排、等待实施阶段完成。** 工作流阶段三串行接线，阶段四独立检查完整性。131 个旧操作（52 查询、79 变更）和20个JobType+Listing分支的离线基线在 migration-discovery/original-*-inventory.json；命令清单现已发布到 packages/contracts/command-catalog.json，可开始准备最终覆盖核对。先修复真实问题，再重跑受影响行为；不会把代理的自述当作验收证据。
4. **最终运行与打包验收：待整合。** 完整 UI、假 Provider 全流程、故障/未知请求/恢复、当前桌面数据迁移及最终 EXE 资源与依赖检查。独立验收脚本 workflow complete-desktop-acceptance-driver（wf_c44cd269-a86）独占 scripts/e2e-full* 与对应覆盖记录，使用真实 Electron 和本机假协议；尚未完成或运行全流程。本次候选版本设置为 0.3.0，输出独立目录 release/0.3.0；版本号不代表已通过完成门槛。

2026-11-05 会话恢复核对：旧 API /health 仍返回正常，未重复启动旧服务。主实施任务已从原 runId 恢复为 wl2194ov9，复用 A 已完成结果；完整验收脚本恢复为 wcd2y1oso，包检查脚本恢复为 wkpbfxtx9（wf_c5aa7b60-e2a，独占 scripts/verify-release*）。当前 git status 已能识别 main 分支及工作区变更；旧记录中的“非 Git”反映此前环境，不能继续当作当前事实。未创建提交或覆盖已有改动。

发布包检查器已交付 scripts/verify-release.mjs、verify-release-test.mjs 与 release-verification-spec.md；代理报告 11 项合成测试通过，缺失最终产物时如实退出 1。协调者已额外对真实内置 catalog 执行只读逐行/完整性/hash 验证：1173 套，totalHash efa91be50d012f35f38301d0fcc67697c7d73d94e0d365954c27a7856ff272b6，通过。尚未检查最终 0.3.0 包。根命令增加 test:release-checker 与 verify:release（需显式 --output 新报告路径）。冻结锁文件的离线安装验证通过，11 个工作区依赖已就绪。

共享基础阶段 B 已交付：134 个具名操作覆盖全部 131 个原操作身份；代理报告 contracts/backend 构建、domain 类型检查及 58 项针对性测试通过。主工作流已进入 C 全命令、D 全执行器、E 原版 UI/宿主、F 网络/Pi 回执四个并行实现阶段；这不代表完整应用已通过验收。

独立核心核查 wf_abbba8a5-fe0 已确认三项问题，均已安排限定文件修复：v2 删除已选 Provider 后无法升级、明确 NOT_SENT 的中断外部任务被误标 UNKNOWN（wf_7bca6ea0-2fd / wwz18q2u4，database.ts/database.test.ts/README），以及导出在目的目录准备阶段取消可能漏接信号并挂起（wf_293d80ca-a2c / wu200u730，仅 files.ts/files-boundaries.test.ts，不写 dist）。修复与独立复核仍待交付，原 98 项测试不能替代这些新增回归。

协调者对实际 0.2.0 发布目录运行新包检查器时退出 1；依赖图、编译入口和真实 catalog 通过，但原生资源检查及数据卫生发现需校准的判断：第三方 @tanstack 的 build/legacy 被误当作工作区旧运行目录，原生文件判断需按实际加载平台区分。初次诊断见 ../.workspace-tools/release-checker-baseline-0.2.0.json；修正与独立复核工作流 wf_8134c226-ac0 / wu8el0hbt 已启动，不修改实际发布目录，也不把失败记作通过。

2026-11-05 再次恢复：此前 C/D/E/F 与验收脚本因模型 API ECONNREFUSED 未交付完整报告，不能视为已完成。工作流已增加失败门槛，任一实施阶段返回空结果时不再进入整合/完整性审查。主实施按原检查点恢复为 wutmm3z7l，验收脚本为 wcrthm0g2，包检查修正为 wgdy2f61d，迁移修复独立复核为 wbl11qr5v；A/B 已完成结果复用。旧 API 再次健康检查通过，无重复启动。

导出取消窗口修复已交付，代理报告两个真实源码存储测试文件共 36 项通过，包含目的目录准备期间立即取消、保留既有幂等产物及迟到 producer rejection；未写 dist。两项 v2 升级问题修复已交付，代理报告 core noEmit 和 8 文件/109 项包内测试通过（其中迁移 20 项），独立复核尚待完成。为共享 Provider 协议配置，协调者已给 agent 包增加 providers workspace 依赖，离线安装成功；完整生产构建仍待各实施者交付后统一执行。

最新复核：wf_7bca6ea0-2fd 已完成，两项升级缺陷均被独立确认修复。复核再次通过 core 类型检查与 8 文件/109 项测试，并用实际发布过的数据库构造器额外验证 3 种 Provider 删除情况、150 个外部任务组合，保留历史、UNKNOWN/历史执行屏障、完整性、外键和重复迁移均通过。未改生产数据。全部 core 修复写入结束后，协调者已实际执行 core/tsconfig.json 的 emitting TypeScript 构建，退出 0，更新 dist 供后续消费者使用；尚未进行完整生产构建。

包检查器修正与独立审查已交付：实际 0.2.0 目录为 11/11 检查通过（作者曾误报 12/12，已由独立复核纠正）。证据 ../.workspace-tools/release-checker-baseline-0.2.0-corrected.json 与 release-checker-baseline-0.2.0-independent-20261105-d4f517ce.json，原始失败报告保留，ASAR 哈希相同。此前分类过严的两个误报来自第三方 TanStack build/legacy 与 SQLite 未选中平台 prebuild。

独立审查另外确认两个 sharp 加载器漏检，已加入失败回归：不被当前加载器引用的旧无版本插件可掩盖缺失的实际插件；CommonJS 目标错误使用 import 导出分支。当前校验器测试为 35 项、33 过/2 失败，不能视为最终可用验收工具。修复工作流 wf_beec5007-b40 / wr514qket 独占 verify-release 脚本/测试/规范，未修改发布目录。0.3.0 最终包尚未构建或验收。旧 Web 在配置的 http://localhost:5173 返回 200；127.0.0.1:5173 不监听，不能据此判断旧服务退出或重启一套。

F 网络/Pi 阶段已交付：复用 B 的唯一账本，SDK 直接注入 fetch，不使用 ALS/全局拦截；稳定前缀逐轮/候选/元素记账，完整回执先于解析与下载、UNKNOWN 不重发、支持离线回放及原业务的有界修复/压缩轮次。协调者已按 providers→agent 顺序实际构建两包，均退出 0；随后用普通根 Vitest 配置、不加源码 alias 执行 packages/providers/src 与 packages/agent/src，19 文件/178 项测试全部通过（7.83s）。这是 F 范围验证；C/D/E、串行整合和完整应用/EXE 验收仍待完成。

sharp 两项已确认漏检修复已交付（wf_beec5007-b40 / wr514qket）：按加载器实际引用的本地模板与 CommonJS exports 声明顺序解析，保留两条独立失败回归，补充 DLL/wrapper 检查；代理报告 61/61 测试、实际 0.2.0 的 11/11 静态检查通过。新证据 ../.workspace-tools/release-checker-baseline-0.2.0-sharp-fixed.json。对比发布目录 3792 文件的大小/mtime/SHA256 未变。此结果仅确认检查器校准，不代表 0.3.0 包验收。

已安排旧桌面 16 项集成行为迁到 canonical 命令/新快照：wf_37a8da8e-b28 / wt56gu11f，独占 backend/test/backend.test.ts、business.test.ts、可选 desktop-regression-helpers.ts 与覆盖说明。C/D 测试子目录不受影响，串行整合者按 INTERFACES.md 避免重叠写入。测试需保留安全、取消/恢复、文件字节、Pi/SAM/PSD 等实际断言，不能恢复旧运行 API 或静默跳过失败。该测试迁移尚未交付。

完整 Electron 验收脚本已交付（wf_c44cd269-a86 / wcrthm0g2）：scripts/e2e-full.mjs 与配套模块，64 个场景覆盖 29 个原版业务族、131 操作、20 JobType + Listing 分支。代理报告静态/注册表检查和 8 项脚本自测通过；全部应用集成仍 unrun/blocked、completion=false。根 test:e2e:mock 已指向新脚本，增加 test:e2e:check；旧 e2e-mock.mjs 保留作 0.2 历史验证参考，不是新生产兼容。

该脚本确认两个输入阻塞，已安排 wf_ec7e6441-b69 / wwledg3vm 限域修复：ByteImport 缺 AVIF/TIFF，以及 createPatternExtractJob.file 仍为旧 multipart binary string。按 INTERFACES 保留已发布图片导入格式，转换为有界字节契约，同步离线 catalog，不改 C/D/E 源码，交付后需构建 domain→contracts。另有原功能回归：F 的完整 SSE 缓冲会把旧套图反推 onShotProgress 推迟到 EOF；wf_b190f017-bfa / wt4j8d53g 限域恢复实时观察进度，同时要求成功返回/下一付费轮次必须等待完整持久回执。该工作流写 providers request-evidence/reasoning-probe 和 agent runtime/stream/对应证据测试；交付前串行整合者避免重叠修改。此前 178 项通过不代表这一新修复已经验证。

图片输入修复者已实际复现另一项完整性问题：12×10 PNG 截断到 79/99 字节仍能读取 metadata，但像素解码报 libpng read error。core.inspectImage 与 C 的 readImageInput 当时仅查 metadata。已安排 wf_a2e95138-ecc / w86ew38d1 限定修改 core/files.ts 的 inspectImage 与新 image-validation.test.ts，要求先限字节/像素再验证完整解码、避免无界 raw Buffer；不改 C 的活动文件。C/串行整合者仍需让 readImageInput 使用完整验证。AVIF/TIFF 的实际 Sharp 编解码已由输入修复者验证可用；相关正式回归尚待其交付。

图片输入修复已交付，协调者已实际按 domain→contracts 构建，两者退出 0；普通根 Vitest 运行 image-input-parity.test.ts 为 41/41 通过。完整解码修复已交付：新增 25 项图片验证、19 项既有存储边界回归及 core noEmit 通过，涵盖截断 PNG/JPEG、多页 TIFF 第二页截断与像素上限先检查；协调者已再构建 core，退出 0。原生 stats 解码期间取消需等待有界 libvips 完成，不声称立即中止。C 的无 context 图片 helper 仍需串行整合。

协调者已实际执行新根命令 test:e2e:check：通过，64 场景，无 missingAuthoredOperations；integration=unrun、completion=false。最新静态报告 .cache/e2e-full/2026-11-05T14-50-12-797Z/coverage.json。

旧集成测试迁移已交付（wf_37a8da8e-b28），实际 canonical 注册/真实执行器下 19 项曾跑到 15 过/4 失败，耗时165s：当时 AVIF/TIFF 两项仍用旧声明、需在上述生产者构建后重测；另外两个是真正生成去重缺陷（成功重复/UNKNOWN重开后未复用）。确认为 commands/storyboard.ts 指纹含 item.updatedAt，而执行器修改该时间戳。INTERFACES 已给 C/串行整合者标记必修，保留两个失败断言，禁止删除/跳过。该测试迁移未改生产；所有完整集成需在 C/D/E 交付且固定稳定指纹后重跑。

实时 SSE 观察修复及独立复核已完成（wf_b190f017-bfa）：分镜正进度在服务端 EOF 前出现，期间账本保持 IN_FLIGHT；Agent/探测终态、搜索工具与下一付费轮次均等待完整回执持久化。新增 RecordedRequestFetch.settled()/settleRecordedFetch，每个 fetch 独立结算。协调者已按 providers→agent 实际构建成功，并用普通根配置跑两包 19 文件/195 项测试，全部通过（10.63s），没有源码 alias。原 D 报告中 transient 的 MAX_IMAGE_TRANSPORT_BYTES、settleRecordedFetch/stream 类型问题已有相应生产者构建与本轮类型检查/运行覆盖，仍需最终 Backend 统一检查。

发现 C/D 外层工作流未登记终态，但两个代理实际上已调用 StructuredOutput 并获工具“Structured output provided successfully”：C 在 14:28:42Z，D 在 14:47:57Z。接受的原文已从各自 transcript 的 structured_output 附件恢复为 migration-discovery/recovered-C-report.json、recovered-D-report.json，保留 provenance；没有伪造 journal/checkpoint。C 报告127领域+7运行时处理器覆盖134操作、28命令测试过；D 报告20任务+Listing全注册、13文件106项执行测试过。两者不是整应用验收结果。原 agent ID TaskStop 均返回 No task found，未重启/重新指派同 ID。

据已接受 C 交付，协调者安排 wf_28d530fe-7ce / wmk1lw31s 限域修复 commands/storyboard/support/patterns/patternDrafts 与新增回归：稳定生成指纹及 context 完整图片验证。INTERFACES 已保留其所有权，旧串行整合者需避开。E 的 apps 源码仍由原代理完成；单次后台事件监听 bmh3h8f88 等待 E 的 accepted structured_output 或失败，20分钟超时只表示未交付，不代表成功。待 E 交付后需停止旧主工作流并从已恢复报告编排无 schema 的串行整合，避免重复 A/B/C/D 或停在未返回的 StructuredOutput 包装器；没有完成全部业务前不能直接进入发布。

生成指纹与命令完整解码修复已交付（wf_28d530fe-7ce / wmk1lw31s）：按实际提示词/素材身份哈希角色/有效模型配置及候选意图计算稳定指纹，排除执行时间戳、状态、compiledPrompt 等运行字段；扩增候选仅补缺失，不重付已成功候选。readImageInput/readSingleImageInput 全部要求 storage/signal context，提取/花型上传/草稿入口已转中央完整解码。代理报告原 canonical backend11+business8 全部通过且断言未改；新增8回归+原命令28+图片25合计4文件61测试全过；commands/backend noEmit 均通过。此前19项中的4个失败现由修复回归覆盖，仍需最终统一执行。

为不阻塞在仍活动的 E，另行开展生产 Backend 预整合：wf_3865e249-ceb / wnzrk3vp6，限 index/business/runtime、必要契约输出与新 integration 测试，接默认真实 C/D 注册及 v1/v2 历史资源；不改 apps，INTERFACES 已保留范围。E 于 15:27:55Z 仍在修改 renderer autosave 测试，非死任务。旧 UI report watchdog bmh3h8f88 20分钟超时而未交付；已替换为 b8ue83azm 的30分钟单次观察器，接受 structured_output 时通知，若超时仍不能视完成。待 E 交付后停止旧 wutmm3z7l，恢复 E 报告，再结合这个预整合结果完成宿主/完整构建与64场景源版及EXE验收，避免旧串行整合者与当前预整合重叠。

E 的 accepted StructuredOutput 已被单次观察器检出，原主工作流 wutmm3z7l 已明确停止，避免潜在旧串行阶段与新的 Backend 预整合重叠。报告保留在 recovered-E-report.json：九条 memory-router 路由、111 个直接具名绑定、TypeScript 与25文件143测试通过，真实 Electron 假IPC九页 smoke 通过；这不等于真实Backend业务验收。E 明确剩余接口为生产默认注册、公开Output.revision（仅generationSnapshot.revision，不能整份快照外泄）。已写入 INTERFACES。E 的所有 apps 文件现已交付，后续宿主整合可接管；不再恢复原 wf_2baf1911-a9d。

追加安全回归 wf_676a0b0d-446 / wjh3gem0r：D 对 revision='retry' 不改提示词，C 却把这个标记当新指纹，需确保不能用它绕过既有 UNKNOWN；限 storyboard.ts 与 commands/regressions.test.ts。尚待交付，不影响已通过的旧19项但必须在最终验证中覆盖。

2026-11-06：协调者已启动 app 单包生产构建 bk6y7p9qh（尚待结果），验证交付的原版UI/main/preload真实构建配置；Backend 预整合仍在进行，单包成功也不能替代全工作区构建与真实IPC/64场景验收。

生产 Backend 预整合已交付：createBackend 默认注册127领域+7运行时命令、20执行器；显式测试注入仍保留。v1/v2 history 通过 getJob/listJobs 公开白名单结果/资源可用性，getResource/host.resolveResource 惰性登记 ASSET/EXPORT/LAYER_PSD，不造 Output/Pattern、不执行旧载荷，保留缺失/变更不可用及历史 owner。代理报告72个不同测试有通过证据（组合69、最终47有重叠），不是整体验收。新的 history DTO/声明需统一构建，已由下述全构建完成。

revision='retry' 语义归一化已交付（wf_676a0b0d-446）：初始 absent/retry 两向重复在 UNKNOWN/完成后均复用，相同失败才可新安全意图；3条真实回归先失败后通过。该变化揭露旧测试用 retry 强造新任务的夹具问题，不能为了旧夹具恢复危险指纹。

协调者实际全量 pnpm build 已通过（b0xdj0a7b）；随后普通根 pnpm test --maxWorkers=4 的首轮为87文件/825测试，84文件与818测试通过、7失败，250.04s。3项是重试夹具旧假设；4项 default-backend 超根20s（局部配置原60s），需诊断而非盲抬超时。wf_7444d06e-10c / wru98f65r 专修既有三份测试/必要helpers，保留原结果/付费计数/恢复断言。

最后历史与 revision UI 接缝由 wf_f78d4fce-979 / wr2pha96j 负责：apps、必要输出DTO/离线输出投影与命令公开投影、新回归，不改生成调度/既有失败测试。INTERFACES 已划分两者边界。当前编译产物已固定，另以 b525johpg 启动实际 Electron 64场景完整验收，使用 mkdtemp数据与本机假协议；尚待结果。本轮运行的是上一稳定构建，后续 UI接缝完成须重建并重跑，不能直接视作最终通过。

首轮全测7失败已由 wru98f65r 限域修复：新任务夹具改为真实candidate2并选择新job，保留旧成功/UNKNOWN/不重发/快照/ZIP差异断言；默认生产4条含真实Pi规划的流程明确设60s（局部原配置已60s），实测规划12.833–26.847s，后续生成/重放/PSD/ZIP均≤277ms，无死锁证据。普通根配置+4workers定向3文件25项全部通过，141.83s。未改生产或全局超时，仍需在UI接缝完成后重跑全量。

首轮实际Electron b525johpg 因启动测试守卫未加载而64场景全BLOCKED，passed=0、completion=false；未开始任何模型任务，不可记作应用通过。已安排 wf_62c02e2d-790 / wglcbfo35 独占 e2e-full-harness/network/guard/selftest 与专用guardhelpers修正实际Electron45Source/packaged启动隔离，不能关闭 fail-closed。主程序Source全构建已成功，这次是验收隔离装载阻塞；修正须证明browser与当前utility PID均已安装guard，再开始业务。当前测试产物只代表旧稳定编译，UI接缝后仍要重建、完整源版与EXE重跑。

已确认另一项需整合的契约位置问题：apps/desktop/src/shared/native-contracts.ts 目前手写 PickFilesSchema/ClipboardTextSchema/GeneratedFileSchema，违反 packages/contracts 作为通信契约唯一手写真相源的目录规则。待当前 wr2pha96j 的 apps/contracts 输出接缝写入结束后，协调者可等价移动这些schema/派生类型至contracts，apps仅重导出，避免与活动writer改index冲突；保持sandbox preload只有Electron运行依赖、main验证行为与原生限额不变。

wru98f65r 已完成：只改5份既有测试/helpers，普通根配置4workers定向3文件25项通过；新的候选2夹具保留各原安全断言。60s仅标在4条实际Pi多阶段流程，实测总流程16.355–29.169s、规划12.833–26.847s，局部原配置本已60s。原7失败需在其后全量重跑确认，不将定向25作为全量通过。

守卫修复者已确认 playwright-core1.64.1 的 coreBundle.js 会无条件删除传入 env.NODE_OPTIONS，因此旧验收隔离从未装载。正在改实际Electron显式CLI preload，browser已证明可加载，utility初次尚失败，需继续修。其孤立探测进程 app.close 曾挂起，自动审批拒绝 standalone process.kill(16788)；修复者改用停止自己 bzdjiel33 工具任务，未绕过审批、未终止用户应用/旧服务。不要让其它代理或父进程替其执行被拒绝的PID操作；若后续真受阻，再说明审批原由并由用户决定。b525旧验收已输出64BLOCKED/0业务通过，不能当作真实业务失败或通过证据。

独立后端业务完整性/持久安全审查已启动 wf_9802c0fd-901 / wtns2s4p5：两个只读维度各自核查旧源码→新命令/执行器，发现后独立反证；排除正活动的UI revision/history与验收guard事项，不添加可选新功能。使用纯文本报告避免早先StructuredOutput包装器停滞；尚待结果。

历史/输出 UI 接缝 wr2pha96j 已完成：Output.revision 仅取持久 generationSnapshot.revision，全部 get/list/project/edit 输出一致；历史 JobRecords 用完整项目job-ID列表逐条getJob，10条/页，501记录回归覆盖越过listJobs500上限，显示只读状态/文本/资源可用性，资源保存发现变更会转不可用。同步修复无分镜时null及可选模型字符串不传null。代理报告29文件157项通过、原命令39与历史8项有通过证据（有重叠），app/backend source noEmit通过；未写dist。后续需生产者重建与完整真实IPC/EXE验证。

上述writer结束后，协调者已等价把 apps/shared/native-contracts 的3份schema及派生接口移至 packages/contracts/src/native.ts，index导出并让DesktopApi.pickFiles复用派生类型，apps仅重导出；保持值/边界/sandbox preload行为。contracts普通tsc --noEmit已实际通过，尚未写新dist，避免干扰活动guard原生探测；待其稳定后统一重建/全测。

守卫修复进展：dev显式CLI require已安装browserguard；utility execArgv require不生效，改测试专用ESM utility入口先装guard再导入真实backend。baseline0.2 EXE忽略CLI require，正在验证inspect-brk入点前注入，不能据dev结果宣称packaged可用。修复者已报告清理有界且无遗留探测PID；full64尚未重跑。

## 2026-11-06 当前整合阻塞

独立业务/持久审核 wf_9802c0fd-901 已完成并经过反证；完整证据在 migration-discovery/verified-business-review.json。五类唯一确认问题为：不同起稿来源任务误复用一条流水线；正式起稿/变体透明失败后候选存在使重试伪成功；导出以最新分镜提示词冒充旧 Output 的真实提示词；失败草稿槽位补偿创建新任务导致完整回执未复用、额外发送生图 POST；活动批次补偿转移槽位使其它已返回结果被整体 fencing 拒绝。后两项原回执仍保存，并非物理丢失；普通同 jobId 重试已能复用，缺陷限定补偿入口。均只用合成数据和假网络复现，未验证真实账单。

修复/独立复核工作流 wf_70087a1e-023（wrb98xbok）已启动：四个明确不重叠 writer 按 INTERFACES 的最新范围分别处理流水线、透明判定、逐 Output 证据和两项草稿恢复。当前修复和最终统一构建/全测均未完成。

守卫工作流 wf_62c02e2d-790 已真实交付11/11测试通过：Source0.3与原baseline0.2 ASAR的browser/utility guard、当前PID/token gate、隔离profile、入点前失败及启动清理；未改生产fuses或包。只证明启动测试隔离，不证明64业务场景或最终0.3 EXE。原guard作者继续限定修复 ctx.inspect 在 Playwright evaluate 中 dynamic import 无回调的问题，并补真实检查回归；交付前不启动完整验收。

守卫作者后续交付 ctx.inspect 修复：受限数据库检查函数在真实 ESM 守卫上下文定义，由 app.evaluate 调用固定函数，避免 Playwright 动态 import 回调缺失。最终11/11测试同时覆盖真实 Source v3 与 baseline0.2/v2完整性检查；仍没有完整业务通过结论。协调者的新版 driver --check 已实际退出0，64场景、missingAuthoredOperations=[]，报告 .cache/e2e-full/2026-11-05T17-27-15-367Z/coverage.json；integration=unrun。contracts 含 native schema 的 emitting build 已退出0。当前先重建 apps 以检查真实界面整合，Backend 仍为修复前编译基线，任何探索结果不能替代修复后的统一重建/验收。

README/ARCHITECTURE 的 wf_a153e9b0-30f 已交付当前0.3源码范围描述，继续明确整体验收pending。作者另外报告规划写回尚未证明有 planningRevision CAS；原源码也未见此比较，当前文档不承诺这一能力，不能把未复现的关切当已确认新缺陷。

原生契约移动后，主进程 native-files/request-boundary 定向回归 bgx2iejyd 实际2文件26项通过（根配置、2workers），未新增低价值镜像测试。apps-only build bq281dwlz 已退出0，未重编活动Backend修复源码。随后标准 `pnpm run test:e2e:mock` 探索任务 b6mna45p6 在场景开始前因 Playwright waitForLine 的未处理 `Process failed to launch!` 退出1，未形成完整业务结果；此前11项守卫自测不足以证明标准入口可运行。原守卫作者已接手复现 pnpm 环境/重建后main及失败报告清理，继续仅写原脚本范围；统一源码构建和完整验收仍待所有修复交付。

wf_70087a1e-023 已有真实中间交付：流水线来源修复5条回归通过，独立 public Backend 并发/重开复现1项通过，source noEmit通过；独立审查未发现来源身份残留问题。透明恢复作者34项、独立复核40项（含6条新增）通过，保留失败/成功候选、回执与ID，重复 opaque 重试仍失败且不推进流水线。逐 Output 提示词/实际附件证据及导出allowlist已实现，作者22项通过，独立复核仍在进行。草稿作者25项通过，但独立复核还需检查完整 HTTP400 明确拒绝的失败槽位是否仍可显式补偿，不能用完整成功回执下载失败的策略误锁这类请求。

独立来源审查发现既有 commands.test.ts 的补偿夹具把 scheduler.retry 固定抛错，且仍假设必须新建任务。协调者仅修该既有测试，改为真实但未启动的 PersistentScheduler/registerExecutors，断言原job/原快照/成功槽位保留、失败槽位排队以及 UNKNOWN仍拒绝；根配置1worker定向 bj0zfogzv 实际27/27通过。未改生产以迁就旧夹具。整个工作流和统一全量仍未完成。

wf_70087a1e-023 已整体交付8/8。输出证据独立复核22项+2条额外探针通过（后者临时文件已删除），含Gemini真实inline字节和双候选编辑本地失败后的回放，无该范围剩余确认阻塞。草稿原始两项恢复缺陷通过25项，但原复核与一次意外恢复的同ID复核链额外确认：HTTP400完整拒绝不能显式补偿；补偿会复活已删除成功候选；混合来源批次定稿取最后batch job，导致sourceJobId错误。复核新文件同名碰撞后立即停止该文件写入，生产未因此改写，后续探针用唯一名字；不再消息恢复活动工作流代理。保留 draft-compensation-independent.test.ts、draft-compensation-codex-backend.test.ts、draft-compensation-codex-provenance.test.ts 的真实失败断言。后续 wf_5e53b688-a89 在吸收第三项后先明确停止 wdoax6dlb，再修改脚本并以 wxvpx4upk 恢复，单writer处理三项，避免重叠写入；尚未交付。

守卫作者已完成标准入口故障修复：直接管理测试桥并以真实 Node inspector/Chromium CDP 连接，避免 Playwright _electron.launch 的未处理兄弟reject；在Chromium端点准备后才释放初始debugger，防原生退出。12/12守卫回归、5次标准pnpm --startup-only探测成功，故障启动也输出正常失败报告与清理。主线程已实际打开 .cache/e2e-full/2026-11-05T17-49-37-147Z/run-startup.png，确认原版暗色琥珀首页完整可见且Backend已连接。

随后 ble0sz2rk 的完整探索（仍用修复前Backend dist）实际启动成功，但provider首场景误将fal空JSON的400校验探测算作付费分割，另独立v2测试启动器超时；结果2FAILED/62BLOCKED、completion=false，报告 .cache/e2e-full/2026-11-05T17-56-46-662Z/result.json。不是完整业务失败/通过证明。wf_d6ef9c67-0ad / w4x83uz9x 已分派两个脚本限定writer：修正按实际请求输入区分探测/模型执行，并将独立v2合成库的创建接到已ready的受守卫真实main，保留真实生产迁移断言，避免额外Electron启动。仅scripts，不改生产Provider、断言计数或覆盖门槛。尚待结果；不要在当前脚本writer交付前重跑完整64。

草稿后续 wf_5e53b688-a89 已完整交付并独立复核：HTTP400明确拒绝只替换该槽位、完整成功回执只续本地、删除/定稿状态保留、真实槽位来源、冻结配置、UNKNOWN/IN_FLIGHT及回滚均通过。独立68个不同测试通过（27命令另以source aliases复跑一次，不重复加总）；无该限定范围确认残留。全部生产业务writer已释放。

修复后根全量 b3wptlf34 已实际退出0：100文件、884项全部通过（固定Node22、普通根配置4workers）。其间协调者仅额外修 main/index.ts 的已确认退出竞态：loadFile因正常退出取消时，仅在 !quitting 才弹启动错误框，避免退出被误报模态框阻塞；尚需重建后真实取消加载检查，该分支不由上述单元测试证明。统一全工作区 build b23ylja3k 已启动，等待结果。

脚本修复 wf_d6ef9c67-0ad 已交付：probe accounting14项+真实provider首场景52断言通过；空fal/Gitee请求仅经输入校验400/422，不是有效图像模型输入，真实带图/injected400/缺记录仍拒绝，未改变endpoint计数。v2合成库由ready main固定loader创建；只在源临时profile正常退出后复制最小DPAPI保护的os_crypt.encrypted_key到全新子profile Local State（wx），不复制明文密钥或真实用户数据。真实升级原37断言、原库不变/重复种子拒绝/0网络/PID清理通过，路径 .cache/e2e-full/v2-seed-2026-11-05T18-16-40-359Z/result.json。完整64仍未通过。

额外 launcher 复核未发现独立关闭缺陷；等待loadFile完成的5次真实source/迁移profile关闭、15 PID退出、Backend退出码0均通过，新增 e2e-full-startup-guard-close-selftest.mjs。守卫作者收到末尾消息后只补退出加载回归并交接，不再修改生产或启动完整场景。所有一般脚本writer已释放；统一build后完整source64→独立0.3打包→EXE64/实际artifact检查仍为下一步。

统一完整 build b23ylja3k 已退出0。当前source完整64 byfjhqq90 已结束：17PASSED、17FAILED、30BLOCKED，375断言、rendererErrors=0、fixtureCallbackErrors=0、cleanup通过；.cache/e2e-full/source-0.3.0-final-20261106-1/result.json。真实回执下载恢复、UNKNOWN防重发、取消、部分草稿补偿、v2升级等通过。失败包括脚本的泛化拒绝消息正则、MANUAL误带targetImageCount、原UI定位/虚拟列表控件选择、MODEL_FACE猜modelId而未用公开hash身份、矩形mask被正确trim后误期待透明像素；另确认印刷包JSON资源在commands与execution用不同MIME导致RESOURCE_CONFLICT，已分派真实生产修复。完整迁移仍未通过。

wf_d7c46efa-a1c / wttvdygjg 已交付harness/business辅助修复：真实Electron证实contextBridge丢失Error.code，改在renderer捕获桥错误并与Playwright传输异常分离，保留明确域消息和显式模式；MANUAL不再自动塞AI数量，图片请求也记录安全marker观察。14辅助项与真实6场景139断言通过。其保留的两项失败：project-lifecycle删除后getResource仍可读；分镜更新后oldVersion+1已有效。协调者修后者，取currentBoard、验证旧版拒绝并以currentBoard确认生成；b6idcxyom真实provider/project/storyboard三场景已退出0，证据 .cache/e2e-full/storyboard-cas-20261106-1/result.json。未放宽删除资源断言。

当前 wf_35196ff4-1ff / w0docbjmy 三独占writer处理 commands/resources.ts MIME一致性、patterns脚本身份/真实alpha夹具及原版UI驱动定位。另 wf_fc2a1aaa-2ae / w6shdgcai 限定 runtime/resources.ts 验证并修复无owner待GC资源的逻辑退休，保留物理GC和仍有引用的文件。生产/source及脚本后续仍待这些交付再统一重建/复验，具体所有权见INTERFACES。

主线程完整关闭文件 b0x18mkjf 为2过/1失败：正常/迁移profile关闭及真正启动错误过；退出加载案例因窗口先销毁没捕获native-fail事件失败。原作者仅修确定性测试观察器，以短暂before-quit延期观察真实导航失败后再退出，未改production/launcher；实际新两项2/2通过，0误报/1真启动错误、所有PID退出。当前main的 !quitting 源码修复已真实验证。

0.3候选打包 b0ulgyvol 已退出0，release/0.3.0 已实际存在。静态checker b1be0obb1退出0，报告 .cache/release-check-0.3.0-candidate-20261106-1.json；候选EXE --startup-only bviap8q37退出0，真实原版首页/本地Backend/SQLite正常，主线程已实际打开 .cache/e2e-full/exe-0.3.0-candidate-startup-20261106-1/run-startup.png。均不能代表EXE完整业务验收；包包含尚未修复的MIME/退休旧编译，必须后续重打包并用全新证据重验。安装器未执行安装/升级/卸载，未签名。

wf_35196ff4-1ff 已整体交付：commands/resources.ts 补 JSON/AVIF/TIFF MIME，三个真实Backend/流水线/身份约束新回归通过；扩展93/94中蒙版编辑子任务默认vi.waitFor仅1秒而偶发RUNNING，单独复跑过，未改生产调度。协调者仅将该已有测试等待改为f.run一致15秒的明确终态等待（失败终态仍立即断言），bekwpr2v3 定向执行中。图像输入/命令另52项过。patterns脚本现消费公开MODEL_FACE hash URL，并用带孔/软alpha夹具逐像素核对裁剪后RGB和alpha（5968断言）；真实提取两模式过。模特仍因harness每张image-edit固定hue140返回相同字节被合法内容去重，只需在当前error-code harness writer结束后让合成候选字节随请求变化，不能删除两候选断言或改仓库去重。

UI驱动脚本已按真实控件/AntD虚拟选择/阶段/自动保存/画布动作修正，8个UI场景及2前置真实通过，证据 .cache/e2e-full/ui-subset-sol-20261106-9/result.json。另三个实际生产问题保留：匿名图片 Origin:file:// 被资源协议拒绝403导致canvas断言失败；延迟AI商品文案无条件覆盖已保存人工编辑；套图自动targetShotCount:undefined被commands.lifecycle字符串化为'undefined'而拒绝。wf_06f6b9d0-dca / wkoo4xftd 已以三不重叠writer分别处理main资源CORS、SetupPanel晚结果guard、createSuiteForgeJob可选值归一化/自动目标脚本；每项独立复核，未交付。

wf_fc2a1aaa-2ae 已交付并独立确认：无owner且已持久排队清理的资源在resolve前/哈希后均拒绝公开与host读取，物理GC仍延后；历史/任务引用、共享别名和retain/register恢复不受影响。9个新回归及7文件83项通过，额外真实Backend删除/reopen探针过、source noEmit过。生产resources修复尚未 emitting。

Error.code丢失已实际影响产品而非仅脚本：PatternDraft isConflict、Storyboard CONFLICT、Layers NOT_FOUND 都依赖code；renderer/client 当前会变UNKNOWN。wf_48999e9f-54e / w1hizybj8 正修contracts TypeBox错误传输/沙箱preload/renderer重建/harness解码及真实Electron边界，保持preload唯一运行依赖electron、干净用户消息和成功API；未交付，不可在源码未稳定时统一build。

候选0.3静态实际检查已过，隔离EXE --startup-only也过，主线程已实际查看原版首页截图；均completion=false，仅启动/ABI和静态证据，不能充当完整EXE业务。当前 release/0.3.0 会在上述生产修复后重新打包，不将旧候选标为最终结果。

## 必须覆盖的业务族

- 项目创建/编辑/归档/恢复/删除、商品事实与禁用宣称、平台/市场/语言、规划配置快照、素材角色及引用。
- Provider 多模型与能力、推理/图片/分割协议、非计费连通性探测、搜索来源与视觉研究审计。
- 模板目录、用户模板管理、套图目录/筛选/导入/编辑/确认、反推草稿完整工坊。
- 分镜规划/编辑/确认/版本、批量与多候选生成、稳定产物、审核、文案、ZIP/长图导出。
- 编辑会话/分支/回合/引用、涂抹蒙版/保护蒙版、改图规划与确认、输出谱系与记忆。
- 自动元素识别、文本/框提示 SAM 分层、Seedream 分层、透明 PNG/PSD、源像素与空 mask 约束。
- 独立花型库、上传/提取/起稿/变体/调色/验缝、印刷规格包/示意图/Listing。
- 花型草稿的 media/batch/slot/candidate、幂等键、派生/编辑/去底/接缝处理、失败槽位补偿与显式入库。
- 花型成包流水线的步骤持久化、阻塞/人工决策、恢复和后续步骤原子衔接。
- 模特库/定妆候选与选中状态、全局资产库、已有 Pi 领域工作流的全部实际入口。
- 全部任务的取消、显式重试、未知外部结果保护、结果/文件原子提交与崩溃恢复。

## 完成门槛

- 每个旧版已实现业务入口对应新版契约、真实 Backend 执行、持久化与原版风格 UI；不能有空按钮、硬编码成功或仅复制的未接通模块。
- 通信使用命名 TypeBox IPC 操作；生产无 HTTP/SSE/Redis/BullMQ，renderer 不访问 Node、Provider、数据库或任意路径。
- 保持单一状态真相；当前桌面 v1/v2 数据通过显式新版本迁移保留，不从旧 Web 数据库导入。
- 所有付费协议窗口持久化；不确定结果不自动重发，多步骤/候选补偿不能重生成已成功产物。
- 对照原版测试和实际界面逐项勾验，所有缺项、跳过与验收证据记录在本文件或最终验证文档。
- 全量构建/必要契约检查/行为测试通过，真实 Electron 使用假 Provider 驱动完整业务，最终打包 EXE 再验一次。
- README/ARCHITECTURE/VALIDATION 与实际状态一致，未验证项目如实记录；全部授权工作未完成前不以阶段性交付结束任务。
