# Backend 运行时接线契约

生产 `createBackend` 默认注册实际领域 commands 和全部 execution；网络证据由 execution 绑定实际 Provider/Agent。宿主、renderer 和执行器已完成整应用接线，PixelMuse 0.4.0 的 Source/EXE 各64业务场景及设置/采集验收结果见[验证记录](../../../../VALIDATION.md)。本目录单元测试不单独代表完整应用验收，不得恢复旧简化 business/workflows 或 HTTP 路由分派。

## 共享入口

`createBackend(options, onChange?, integrations?)` 创建唯一 owner、唯一 core EcomRepository/SQLite、LocalAssetStore、SecretBox、SuiteCatalog、RuntimeStore、ResourceRegistry、RequestLedger 和 PersistentScheduler。省略 `integrations` 即接入原127个领域命令、7个运行时命令、新增8项应用设置/用量操作和 `registerExecutors` 的20类任务（含 COPYWRITE/LISTING 分支）。两项注册器及 `createExecutionSnapshot` 均从 Backend 包入口公开导出。`integrations.commands` 可显式替换为 `CommandHandlers` 或 `(context: CommandContext) => CommandHandlers`；`integrations.executors` 可显式替换为完整 `ExecutorMap` 或 `(context: CommandContext) => ExecutorMap`。显式命令替换不补入生产处理器，缺少的命令报 COMMAND_UNAVAILABLE，便于隔离运行时测试；执行器仍必须完整注册。

端口唯一手写真相在 `ports.ts`；contracts 的 `operations`/`Input<K>`/`Output<K>` 是142项具名白名单（原134项及8项应用设置/用量操作），原 operationId 保留。旧来源路径只出现在离线 `contracts/command-catalog.json` 及离线生成工具，生产没有路径映射。旧 noopPatternsPost 不作为能力迁入；旧 subscribeEvents 改为 DesktopApi.onChanged。

## C：命令

处理器签名 `handler(context, input) => output | Promise<output>`。Backend 总是先校验输入、await 处理器、再校验公开输出。DTO 不含存储路径、密钥、执行快照或响应回执。publicSchema 从原领域 schema 派生投影；不要直接返回仓库完整行。Job 必须保留 projectId:null 和 UNKNOWN。

`context.transaction(() => { createJob; createTurn/Slot/Step/Export 等全部关联; context.scheduler.freeze(jobId, snapshot); })` 同步完成后再调用 `context.scheduler.enqueue(jobId)`。freeze 要求已处在同一连接事务；snapshot 的完整结构为 `{version:1, jobId,type,createdAt,input,effective,resources:[{ref,hash}]}`。input 是原领域业务输入的冻结副本；effective 必须冻结实际 project/model/credential revision 或密文/素材与hash/模板文档/事实/提示词/有效参数/算法版本等完整执行依赖。D 的 snapshotSchema 校验整个 snapshot。所有 freeze 所列资源须先登记；运行时为它们增加 `job:<id>` 历史引用，终态不自动丢弃历史输入。

transaction/checkpoint/settle 回调不得返回 Promise；运行时拒绝异步结算并回滚其同步写入，不得跨 await 持有事务。领域 retry 必须在同一事务内返回已冻结 READY 的 QUEUED 意图，校验失败回滚全部关联改动。events.publish 只发送 `{topic,projectId?,aggregateId?,revision?}`。使用 context.transaction 的通知在成功提交后发送，回滚会丢弃该事务的通知。

## D：执行

`ExecutorMap` 必须完整枚举 ports.ts 的 20 个 JobType，COPYWRITE 内部分 LISTING。每个条目 `{snapshotSchema, execute(context), settle?, retry?}`；没有未知类型默认 EXPORT。execute 只能读取 context.snapshot 的冻结业务依赖，不能重新读取当前项目/Provider 作为实际发送配置。仓库实时读取仅用于 CAS/取消/归属/已完成产物和谱系检查。context.external 为当前 job 的窄网络作用域；context.signal 传给全部网络与长本地计算。

`context.checkpoint(() => ...)` 在同一 SQLite 事务重新检查 RUNNING+attempt+runToken+取消。发布 Output/Candidate、槽位成功、产物引用、turn 更新等必须通过它；旧 attempt 迟到写入会被拒绝。所有产物使用稳定 candidate/slot/element 键，不能按已有数量推算下一项。

execute 完成后，运行时在事务内根据逐请求账本决定 UNKNOWN > CANCELLED > SUCCEEDED，并同步 Job、分层、规格包、导出、未成功槽位和失败/取消流水线等关联；已成功产物不被失败覆盖。`settle(context,job,status,runtime)` 也在此事务内执行，D 在其中完成成功流水线步骤/风险闸门/下一 Job 创建及 freeze、编辑自动子任务等领域推进；不要在该钩子中 await。下一队列唤醒可在该同步事务内 enqueue（仅安排后续扫描，回滚不会执行已撤销任务）。

领域关联重试必须提供 retry 或由领域命令实现。通用 retry 对草稿/编辑/流水线没有兜底；UNKNOWN 和任何 IN_FLIGHT 都拒绝。安全本地重试保留完整回执，只重放本地尾阶段，原快照与 preservedHistory 不变。显式新任务的关联创建、attempt 更新与 freeze 仍在同一事务内。

## F：网络与 Agent

纯契约位于 domain/src/external-requests.ts。每模型轮次/候选/元素/搜索调用使用稳定 RequestDescriptor `{requestKey,fingerprint,purpose,model?:{providerId,modelId}}`，fingerprint 为实际公开请求配置和附件hash的 SHA256。必须在真正发送前调用 `scope.begin`；它必须处于业务事务之外，外层事务未提交时会拒绝 begin/fetch，防止 SAVEPOINT 被误认为持久提交。IN_FLIGHT/UNKNOWN 禁止重发，COMPLETED 返回完整回执供本地续跑。

优先向 SDK 注入 `(input,init)=>scope.fetch(descriptor,input,init)`。它先持久 IN_FLIGHT，再发唯一一次 fetch，完整读取并用 SecretBox 加密存储 status/headers/bodyBase64 后，才把新 Response 交给 SDK 解码或下载。当前实现安全缓冲完整 SSE，之后可重放给模型解析器；不会在响应未完整持久化时伪造 COMPLETED。若 F 自己观察 live SSE，必须 begin 后捕获每字节，EOF 完整持久化后才声明完成；可用 scope.complete 保存完整 ResponseReceipt。断流/超时/取消且无完整回执调用 unknown。禁止任何自动重试。CDN 下载是已完成回执的本地尾阶段，不能重新 POST。

`scope.committed(requestKey)` 只在领域产物提交事务内调用；它不改写响应回执。签名 URL、响应 headers/body、Provider task id 仅保留在加密回执内。公开 getJobRequests 只有 requestKey/state/localState。不提供自动 UNKNOWN 清除或变更指纹绕过的入口。

## E：资源与宿主

contracts.ResourceRefSchema 是有界 kind/id/index 联合；Renderer 不传路径。ByteImportSchema 限定 PNG/JPEG/WebP/AVIF/TIFF 和单文件64MiB传输容量，普通文件入口另限50MiB。Backend decodeByteImport 校验真实字节长度及类型，领域入口通过存储检查完整图片解码。main 文件选择需限制数量/大小/实际 MIME，画布/粘贴用同一字节契约。

资源写入后在发布领域行的 checkpoint/transaction 中调用 resources.register({ref,relativePath,mimeType,hash,owners})。owners 包含领域拥有者、历史快照；相同 ref 不能换 hash/path。主进程验证调用来源后才可调用 invokeHost('host.resolveResource',{ref})，得到内部受管绝对路径；随后用原生保存对话框保存。公开 getResource 仅返回 ResourceHandle，不暴露路径。preview/resourceUrl 只能编码此联合，不能接任意 URL。

清理先 release 明确引用、scheduleCleanup，再由 ResourceRegistry.cleanup 执行持久可重入意图。仍有引用拒绝回收；RETIRING 期间禁止新增引用或同文件的新资源别名；Windows 上路径大小写及分隔符别名按同一实际路径处理。失败意图保留供重启重试。缩略图自身 hash 必须是 WebP 字节 hash，不能以原图hash代替文件校验和。

## 运行表与恢复

队列与资源运行时沿用 schema v3 引入的 desktop_job_runtime(job_id,payload,updated_at)、desktop_resources(id,payload,updated_at)、desktop_cleanup_queue(id,payload,created_at)，其 payload TypeBox schema 在 state.ts/resources.ts。应用设置、价格、用量及恢复游标由 core 的 canonical v6 统一创建和显式升级；runtime 不自行建表或另开连接。完整有效快照与 preservedHistory 不可变，requests/phase/attempt/runToken 可变。

恢复将无未知请求的中断任务恢复为 READY，已发出请求必须有完整回执才能重放本地尾阶段；IN_FLIGHT 收敛为 UNKNOWN 并同步关联，即使任务行因不一致仍为 QUEUED 也不能绕过。流水线步骤为 UNKNOWN、流水线为 AWAITING_INPUT + EXTERNAL_RESULT_UNKNOWN；领域显式处理前不能重跑。损坏/缺失运行证据的 RUNNING 任务保留为不可重试 UNKNOWN，原 JSON 不覆盖。preservedHistory任务在恢复和认领查询中均排除，禁止通用重试，不读取旧执行 decoder，也不改原始input或fingerprint。

`DesktopHistoryResources` 通过同一连接的 `DesktopHistoryRepository` 生成 `getJob` 和 `listJobs` 的可选 `history`：来源版本/原状态/原请求状态、`executable:false`、白名单结果及带 `available` 的文件句柄。旧生成结果保持真实 ASSET 身份，`listOutputs` 不伪造 Output；旧归档使用 EXPORT/jobId，旧PSD使用 LAYER_PSD/jobId。Renderer可将其中ref直接交给getResource、资源协议或原生保存能力，无须新增操作或任意路径能力。

历史文件按需读取和登记，不在启动扫描素材字节。ASSET按原hash校验；旧ZIP/PSD没有原始hash，首次读取现存文件时固定hash，之后包括重开均不可更改，因此不能检测首次登记前仍保持有效格式的归档替换。历史引用及job引用独立于聚合owner，启动清理也会保护已有登记的历史资源。缺失或校验不符的文件显示available:false，仍保留原任务/结果；getResource/宿主访问返回安全的RESOURCE_UNAVAILABLE/RESOURCE_CHANGED。结果无法安全投影则显示resultStatus:UNAVAILABLE，原JSON保持不变。输入、原任务行、原错误、密文和回执不公开。

关闭先拒绝新调用、取消队列，再等待全部已接受命令和执行器退出，最后执行清理并关闭唯一连接/释放owner。清理只发生在启动接受命令前及关闭等待完成后，不能在命令异步文件准备期间并发运行。
