# 验收与发布脚本索引

本目录保留当前工具的稳定路径。除了import，部分脚本还通过字符串、环境变量、子进程和目录发现引用支持文件；不能按日期后缀判断是否过期。

## 常用入口

| 入口 | 用途 | 根package命令 |
| --- | --- | --- |
| e2e-full.mjs | 64个原业务场景；--check仅静态/覆盖检查 | test:e2e:mock / test:e2e:check |
| pixelmuse-acceptance.mjs | 14个品牌升级、采集、媒体迁移/重连场景 | test:e2e:pixelmuse |
| settings-acceptance.mjs | 5个设置场景，含唯一工作空间入口与实际页面操作 | test:e2e:settings |
| product-image-planning-acceptance.mjs | 商品图片规划与SKU目录专项，含分批规划、草稿、共图、过期更新、生成、导出与未知请求屏障 | node scripts/product-image-planning-acceptance.mjs 新空证据目录 |
| reference-led-planning-acceptance.mjs | 新版自主规划、套图镜头与数量、保存套图草稿、跨商品批次确认与重开专项 | node scripts/reference-led-planning-acceptance.mjs 新空证据目录 |
| product-image-planning-upgrade-smoke.mjs | 以0.4.4解包EXE创建合成数据，再由当前Source打开并验证目录升级与旧图/请求保留；不是安装器升级 | node scripts/product-image-planning-upgrade-smoke.mjs 新空证据目录 |
| verify-release.mjs | 当前版本发布目录、资源、依赖与安装器静态检查 | verify:release |
| verify-release-test.mjs | 发布检查器自身的失败/正向回归 | test:release-checker |
| verify-installer-payload.mjs | 静态提取安装器并逐文件比较应用字节；不执行安装器 | 直接Node执行，--help查看参数 |
| verify-pixelmuse-acceptance.mjs | 明确锁定0.4.0的六份冻结证据核对 | 直接Node执行，参数见源码 |
| verify-pixelmuse-acceptance-test.mjs | 六份证据核对器自身回归 | node --test |

## 场景与基础设施

- e2e-full-{business,edit-layers,patterns,additional,recovery,ui}.mjs：业务场景。
- e2e-full-registry.mjs：场景、前置依赖与覆盖汇总。
- e2e-full-{harness,support,network,persistence}.mjs：运行/请求/检查与隔离数据。
- e2e-full-startup-guard-*.mjs：可信测试启动、外连限制、utility与关闭证据。
- full-mock-{provider,images,replies}：本机假服务与合成字节，部分后端/agent测试也依赖它们。
- pixelmuse-product-fixture / runtime-identity：合成商品站点与运行文件指纹。
- fixtures/desktop-v2-database.ts.fixture：升级测试的旧桌面结构来源。

带cdx/sol/日期的diagnostic、model-extraction、UI artifact等文件中，有些是当前驱动的动态依赖。它们保留在原处，关联关系见整理审计；专项*selftest、隐私/退出/错误码/协议回归也是有效工具，不作为过期文件批量清理。

## 运行规则

在desktop实际cwd执行；为每轮指定新的空ECOMGEN_E2E_ARTIFACTS目录。设置ECOMGEN_E2E_EXECUTABLE可驱动最终解包EXE。采集升级需要0.3.0基线包，不存在则失败，不跳过。

本轮维护改动已将工作空间导航统一到设置页，预期产品版本从应用manifest读取；0.3.0基线仍固定。0.4.0冻结核对器不用于验证0.4.1，旧报告不能混作新版本结果。

全测不要与Electron/打包并行；不能把脚本语法检查、假IPC窗口或仅启动当成真实业务验收。完整规则见[维护手册](../docs/maintenance.md)。

## 归档

旧e2e-mock.mjs及mock-provider两文件只属于0.2.0历史参考，已移到[归档](../docs/archive/tools-0.2.0/)，以.txt保存。当前`pnpm test:e2e:mock`一直指向e2e-full.mjs，不依赖这组旧接口。
