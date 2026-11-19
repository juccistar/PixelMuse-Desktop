# 软件更新与 GitHub Releases 发布

本文供 PixelMuse 的维护和发布人员使用。实际验证范围见 [VALIDATION.md](../VALIDATION.md)，没有正式 Release 时不将源码检查称为已完成在线升级。

## 更新源与使用方式

固定发布仓库为 [juccistar/pixelmuse-releases](https://github.com/juccistar/pixelmuse-releases)，使用公开、稳定版 Release。源码仓库可继续保持私有。客户端不保存 GitHub Token，不允许页面提供更新地址、安装文件路径或执行命令。

设置中的“软件更新”显示当前版本、可用版本、检查时间、更新说明及下载进度，提供检查、下载、取消和“重启并安装”。启动自动检查默认开启，只检查，不自动下载或在普通退出时安装；偏好保存在原 userData 的专用更新设置文件中。源码与解包运行显示手动下载入口，自动安装仅支持 Windows x64 NSIS 安装版。

无正式发布、缺少更新信息文件和网络错误分别显示提示，不伪装为最新版。下载取消及失败不影响创作任务。已有已下载文件时，繁忙拒绝保留安装入口；用户可完成任务后再次点击安装。

## 实现边界

- [application-updates.ts 契约](../packages/contracts/src/application-updates.ts) 定义应用更新操作、固定源和公开状态，沿用原生 application 白名单桥。主进程负责更新网络，renderer 不直接访问 GitHub。
- 主进程使用固定版本 electron-updater，关闭自动下载、退出自动安装、预发布及降级。更新网络使用独立 session，不放开 renderer 的网络限制；下载校验沿用更新库。
- 安装前暂停新业务入口和队列认领，等待已接受操作收敛并再次检查排队/执行任务。工作空间迁移、后台不可用或仍有任务时拒绝安装。严格关闭必须收到 Backend 关闭确认和零退出码，超时不启动安装器，也不因更新操作强杀任务。
- 普通用户退出不自动安装。安装器进程启动与实际安装结果属于不同阶段，进程启动不能证明安装已成功。安装版覆盖升级、签名、UAC 及后续启动应单独在隔离环境验证。
- 保留 `com.ecomgen.desktop`、原 EcomGen userData 和媒体工作空间。数据库继续采用当前版本迁移规则，更新功能不等于允许数据库降级。

## 当前发布：0.5.0

[PixelMuse 0.5.0](https://github.com/juccistar/pixelmuse-releases/releases/tag/v0.5.0)已于2026-11-12公开发布并设为最新稳定版，包含参考图驱动自主规划、套图镜头与数量绑定、候选独立调用及跨商品批量创作。输出保存在`release/0.5.0/`，保留旧0.4.8附件与证据。

本次上传`PixelMuse-0.5.0-x64-Setup.exe`、`latest.yml`及`PixelMuse-0.5.0-x64-Setup.exe.blockmap`三个附件。安装器为177,854,905字节，SHA-256为`59bee50adff6eac9267fdfbf662a6dfec5431f90b4f13cb72deea6117f87a42b`。[公开核验](../.cache/release-0.5.0-public-verified-20261112.json)确认stable/latest、附件名称／大小／服务端摘要与本地一致；通过无需认证的公开附件API下载更新清单并核对版本、大小和SHA-512。本机直接访问GitHub网页下载地址曾连接重置或超时，该路由未验证通过。

发布构建沿用开发阶段已通过的314项相关专项与相同业务编译指纹，在调整产品版本及输出目录后构建桌面应用并打包。新增13项发布静态检查、3843个安装器文件逐个哈希比对，以及实际解包EXE的3场景32断言，均通过；证据见[验证记录](../VALIDATION.md)。实际安装、覆盖升级、卸载及真实模型质量未实测，Windows代码签名尚未配置。升级到v12前退出应用并备份完整userData和媒体工作空间，升级后的同一数据库不能交给0.4.8或更旧版本打开。

发布标签仅包含发布仓库的README，没有推送本地原始工程；安装包包含运行所需的编译后JavaScript。本次未创建源码Git提交或推送。

## 首次发布：0.4.8（历史流程）

**0.4.8 已于2026-11-09正式发布：** [PixelMuse 0.4.8](https://github.com/juccistar/pixelmuse-releases/releases/tag/v0.4.8)。安装器、`latest.yml`及`.blockmap`已上传；无需认证的公开查询与元数据下载核验通过。源码与解包版各8场景63断言通过，安装器内容逐文件比对通过；实际安装、覆盖升级及卸载未实测，详细证据见[VALIDATION.md](../VALIDATION.md)。

以下为0.4.8当时采用的发布流程；版本号与文件名均为历史示例。后续发布应递增版本及tag，保留旧资产。构建和测试按实际改动选择：根依赖或公共配置实质变更才扩大到全工作区；若必要业务包已完成构建，仅调整产品版本及输出目录，可只构建desktop应用后执行应用包的`run dist`，不因发布自动重跑全量测试。

1. 完成构建、相关行为验证和实际窗口检查，确认版本及输出目录均为待发布版本。
2. 在工作区执行本地打包；应用的 dist 脚本已固定 `--publish never`，不会自动上传：

   ```powershell
   cd E:\EcomGen\desktop
   pnpm build
   pnpm --filter @ecomgen/desktop run dist
   ```

3. 在新输出目录核对以下文件，保留生成文件名：

   ```text
   latest.yml
   PixelMuse-0.4.8-x64-Setup.exe
   PixelMuse-0.4.8-x64-Setup.exe.blockmap
   ```

   `.blockmap` 如生成则一并上传；`latest.yml` 必须由同一次打包生成，不能手写或复用旧版本。应用内部的 `app-update.yml` 随安装包携带，不作为 Release 附件单独上传。

4. 在发布仓库创建草稿 Release，tag 为 `v0.4.8`，标题为 `PixelMuse 0.4.8`。填写更新说明并上传全部生成附件。不要将稳定版标为预发布。
5. 完成候选验证和安装器内容核对后，按已授权的发布范围显式发布 Release；发布操作不由构建步骤暗中执行。隔离安装、覆盖升级和卸载如未执行，必须在发布说明及验证记录中列为未实测，不能将解包 EXE 验证称为安装验收。
6. 旧 0.4.6 没有更新模块，用户需手动安装首个支持更新的版本。后续递增版本、创建新 Release，保留旧资产与证据。

GitHub 自动生成的 Source code ZIP/TAR 不是应用安装包。安装包不提交到源码仓库，GitHub 网页手动发布无需向客户端提供 Token。自动发布所用凭据如以后配置，只能保存在发布环境的 secret 中。

## 发布前检查

- 核对 package 版本、tag、安装包文件名、latest.yml 的版本和 SHA-512 来自同一候选。
- 用已安装的旧版本实际升级到候选版本，检查应用重启、数据库和素材保留；不能用源码窗口或解包 EXE 冒充覆盖升级。
- 验证检查失败、下载失败与取消、校验失败、任务繁忙、工作空间迁移、关闭失败、安装器启动失败。
- 当前未配置 Windows 代码签名。正式分发时配置签名并验证发布者；哈希校验不能替代签名验证。
- 不自动清理旧发布包或历史验证结果，不将本机模拟更新源测试写成 GitHub 正式升级成功。
