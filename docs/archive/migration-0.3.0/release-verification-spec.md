# 最终桌面发布包静态验收

脚本：`desktop/scripts/verify-release.mjs`。本脚本只做只读产物检查；它不会启动应用或安装器，不会打开业务数据库，不会调用 Provider，不会修改现有应用、用户目录、源码或发布产物。唯一持久写入是调用者通过 `--output` 指定的新 JSON 报告。输出文件必须不存在，且不能位于被检查的 release 目录内。

## 调用

工作目录可任意，以下用绝对路径举例：

```sh
"C:/Users/Administrator/AppData/Local/EcomGenRuntime/node-download-20261105/node-v22.23.4-win-x64/node.exe" E:/EcomGen/desktop/scripts/verify-release.mjs --output E:/EcomGen/.workspace-tools/release-0.3.0-artifacts.json
```

默认期望版本来自 `desktop/apps/desktop/package.json`，当前为 `0.3.0`；默认目录是 `desktop/release/<期望版本>`。检查其他路径或显式固定版本：

```sh
node E:/EcomGen/desktop/scripts/verify-release.mjs --release-dir E:/artifacts/0.3.0 --expected-version 0.3.0 --output E:/reports/ecomgen-0.3.0.json
```

`--output` 必填；`--help` 显示用法。需要当前工作区已安装的构建工具。`@electron/asar` 经应用的 `electron-builder` → `app-builder-lib` 解析，不增加依赖；TypeScript AST 解析器使用工作区现有 TypeScript。SQLite 使用 Node 22 的内置 `node:sqlite`，避免加载 Electron ABI 的原生插件。该 Node 版本可能打印实验性 SQLite 提示。

## 必须通过的检查

| JSON check id | 检查内容 |
| --- | --- |
| `required-inputs` | 存在 `win-unpacked/resources/app.asar`、`app.asar.unpacked`、`win-unpacked/EcomGen.exe` 和 `EcomGen-<version>-x64-Setup.exe`。缺少任何最终产物即失败。 |
| `inspection-tooling` | 能加载已有 ASAR 和 TypeScript 检查工具。SQLite 不可用会使实际 catalog 检查失败。 |
| `asar-readable` | ASAR 可索引，非空，记录字节数与 SHA256；stat 路径使用 `path.normalize`。 |
| `application-version` | 包名为 `@ecomgen/desktop`，版本符合期望，主入口为 `out/main/index.js`。 |
| `production-dependency-graph` | 枚举实际打包的模块 manifest 和版本；从每个 manifest 位置按 Node 祖先 `node_modules` 规则解析必需 dependency，处理 ASAR 包内链接；可选第三方依赖允许平台性缺失，所有 `@ecomgen/*` 边必须存在且身份正确；工作区包必须有编译入口。禁止打入 fastify、bullmq、ioredis、openapi-fetch、旧 `@ecomgen/api/jobs/worker/web` 包或声明对这些包的运行依赖。 |
| `compiled-artifacts-and-imports` | main、utilityProcess Backend、preload、renderer HTML 与所引用 JS/CSS 产物存在；Backend 入口确实引用 `@ecomgen/backend`；扫描全部自有打包 JS/CJS/MJS 的 AST literal import/export/require，检查工作区导出、相对文件和外部模块解析，拒绝明确旧依赖与 legacy 目录导入；自有非 Provider/Agent 脚本中的 `new EventSource` 也会失败。 |
| `unpacked-native-resources` | 从已打包 package manifest 入口沿 literal 本地模块边读取 SQLite/sharp 加载器，不执行第三方代码；识别实际 win32-x64 选择路径。SQLite 的平台 prebuild 优先于 Debug/Release；sharp 从可达加载器的实际 `require` 模板推导本地 build（带版本或不带版本均只接受加载器明确引用的一种），并解析 `@img/sharp-win32-x64` 的 `sharp.node` export；CommonJS 条件按 manifest 声明顺序处理 `require` / `node` / `node-addons` / `default`，跳过 `import` / `types`；数组、其他条件及未知结构保守失败。wrapper 必须是单条 `module.exports = require('./…node')`，不能由 ES import 或未导出的 require 代替。必需插件必须是文件；全部 `.node` 及 sharp/@img 实体文件必须 unpacked、存在、非空且大小符合 ASAR。仅识别到 SQLite 平台加载器时，其准确 `prebuilds/{darwin,linux,linuxmusl}-{arm64,x64}.node` 与 `prebuilds/win32-arm64.node` 记为未选中的第三方资源，免除 Windows x64 PE 要求；仍检查解包和大小。实际选中插件、其他 `.node` 以及 sharp 自有目录 / `@img/sharp-win32-x64` 内的 `.dll` 必须是 Windows x64 PE，报告选中插件的物理路径、字节数和 machine。未知加载器失败。 |
| `builtin-sqlite-catalog` | 恰有一个规范 `@ecomgen/ecom-suite/dist/builtin-suites.db`，必须 unpacked；以只读 SQLite 连接运行 integrity_check；仅有 suites/meta 两个业务表；从当前 `src/suites/*.suite.json` 独立推导排序、摘要列、原始 data、每行 SHA256 与整体 totalHash，逐字段逐行匹配，并验证 metadata。预期 count/hash 不使用旧版本报告或硬编码成功值。 |
| `packaged-data-hygiene` | 检查 ASAR 和整个 win-unpacked；拒绝 .env、自有 legacy 目录、其他数据库及数据库 WAL/SHM/journal 副本、ZIP/PSD 等归档与导出、自有 userData/uploads/exports/backups/secrets 等目录、明显密钥状态文件和编译 renderer assets 以外的自有用户媒体；检查 unpacked 中没有未登记文件或文件系统链接。按每个 legacy 路径段的最近 node_modules 包判断归属，第三方（含 pnpm/嵌套布局）`build/legacy` 不等同旧版工作区；根 `legacy/node_modules/*` 及自有包内 legacy 仍失败。此豁免不绕过 .env、数据库等独立规则。内置 catalog、第三方必要资源及 notices 保留。 |
| `own-license-removal` | 原六个自有 workspace LICENSE 和 `legacy/LICENSE` 共七个文件没有回来；ASAR 的自有包无 LICENSE 文件，应用及所有自有包 manifest 无自称 MIT 的 license/licenses 元数据。第三方 Electron/node_modules LICENSE、NOTICE 和 UPSTREAM 来源说明不被当作违规。 |
| `installer-identity` | 安装器文件名对应期望版本，非空且有 PE 和 NSIS NullsoftInst 签名，记录实际字节数、SHA256、PE machine；Windows 下通过只读 PowerShell 查询 Authenticode 与版本资源，存在的 ProductName/ProductVersion 必须匹配。签名分别报告 signed/unsigned/unverified，工具不可用不会伪造已签名，也不会因无法验证签名而强制要求签名。 |

HTTP 字样、第三方 HTTP 客户端以及外部模型协议的 SSE 解析都不是禁止项。检查模块导入与明确运行构造，不用全文搜索 `http` 来判断是否恢复旧服务端。

## 报告与退出码

报告 `schemaVersion: 1`，`scope: "artifact-inspection-only"`，包含期望版本、绝对 releaseDir、生成时间、各 check 的 passed/failed/blocked 和证据或错误。只有全部必须检查通过，顶层 status 才为 passed。输入缺失使输入检查 failed，并使无法执行的后续检查 blocked；不能把 blocked 当作可选跳过或通过。

- `0`：全部静态检查通过，或请求 `--help`。
- `1`：产物检查失败/阻塞，已写出失败 JSON。
- `2`：命令行、输出路径或写报告错误，例如没有 `--output`、重复选项、输出文件已存在。

## 测试

```sh
"C:/Users/Administrator/AppData/Local/EcomGenRuntime/node-download-20261105/node-v22.23.4-win-x64/node.exe" --test E:/EcomGen/desktop/scripts/verify-release-test.mjs
```

测试只在 OS 临时目录生成并清理合成 ASAR/PE/SQLite 树；覆盖成功静态检查、Windows stat 路径、ASAR 链接和嵌套模块解析、依赖缺失、禁止依赖/导入、MIT 元数据回归、目录/资源允许规则、未知 unpacked 文件、真实 SQLite 与源内容不符、版本错误、缺失输入、失败 JSON 和非零退出码。真实基线误报的回归包含两个 TanStack `build/legacy`、pnpm/嵌套包归属、根及自有 legacy 仍被拒绝、第三方 legacy 下的 .env/数据库仍被拒绝、SQLite 七种未选中平台 prebuild、两个必需插件的路径/PE 证据、缺失/损坏/未解包/错误架构/目录伪装、未选中资源的存在与大小、未知或不可达加载器、Debug/Release 选择次序、sharp wrapper 越界及有上限的具体路径诊断。sharp 另外覆盖未引用的无版本本地插件不能掩盖缺失的版本化插件、保留 import 目标但删除 require 目标、与 `createRequire.resolve` 对照的条件声明顺序和嵌套/回退、null 阻断、数组/未知条件保守拒绝、ES import/非转发 wrapper 拒绝、由实际模板选择无版本插件、未知本地模板/不可达 CommonJS 入口，以及 Windows sharp DLL 的 PE/架构/解包完整性。合成 `.node` 和安装器只用于文件结构检查，不是可执行应用验收证据。

## 证据边界

静态通过不证明 GUI、安装、升级、退出与恢复、受管资源行为、Electron ABI 原生插件加载或真实业务结果；这些必须由其他实际运行验收提供。报告明确列出这些排除项。

AST 检查不声称证明任意计算型 import/require 的运行时结果；原生加载器只支持脚本中明确识别的源结构和 literal 本地模块边（每包至多 256 个脚本），结构未知即失败。sharp 仅接受一个可识别的本地平台 require 模板；存在需要选择的本地 WASM fallback 时保守失败。CommonJS export 数组及 `module-sync` 等未支持条件即使 Node 本身可能支持也会被保守拒绝。模式匹配不证明任意控制流，也不证明业务传入 SQLite `nativeBinding` 自定义覆盖值后的加载结果。未选中平台 prebuild 只验证解包、存在与大小，不验证其外部平台 ABI；没有把任意第三方 `.node` 或同名目录统一放行。Windows x64 PE 静态检查不证明 Electron ABI、DLL 依赖或插件初始化可用。安装器身份检查不解包或执行安装器，也不证明安装器内嵌 payload 与 win-unpacked 内容相等。数据卫生按已知路径与文件类型判断，不能鉴定伪装成合法编译资源或第三方目录的任意字节的真实来源；不做任意日志内容或字节级密钥扫描。签名验证 unavailable/invalid 时保持 unverified 并保留实际状态，不等价于 signed。

## 0.2.0 实际基线复核（2026-11-05）

保留原证据 `E:/EcomGen/.workspace-tools/release-checker-baseline-0.2.0.json`，未覆盖。原报告仅两项失败：原生资源的无文件名 MZ 错误，以及卫生检查 308 条告警（全部属于 `@tanstack/query-core` / `@tanstack/react-query` 的第三方 `build/legacy`）。实际 `.node` 索引中两个运行插件是 Windows x64 PE；另外七个为 SQLite 未选中的 darwin/linux/linuxmusl/Windows arm64 prebuild，因此原生失败是平台分类误报。

使用上述 Node 22.23.4 执行：

```sh
"C:/Users/Administrator/AppData/Local/EcomGenRuntime/node-download-20261105/node-v22.23.4-win-x64/node.exe" E:/EcomGen/desktop/scripts/verify-release.mjs --release-dir E:/EcomGen/desktop/release/0.2.0 --expected-version 0.2.0 --output E:/EcomGen/.workspace-tools/release-checker-baseline-0.2.0-corrected.json
```

退出码 `0`，11/11 检查 passed（先前文字中的 12/12 是计数错误；原 JSON 及独立复核 JSON 实际均为 11 项）；ASAR SHA256 与原报告相同。必需 SQLite 为 `app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node`（1,989,632 bytes），sharp 为 `app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.5.node`（443,904 bytes），两者 PE machine 均为 `0x8664`；共核对 56 个 unpacked 原生相关文件。catalog 1173 行与当前源逐字段匹配。安装器真实签名状态仍为 `unsigned` / `NotSigned`，按现有规则如实记录，不是已签名证明。本轮没有遗留的必需静态检查失败。

前一轮合成测试为 16 个顶层用例、33 项测试全部通过。独立复核证据 `E:/EcomGen/.workspace-tools/release-checker-baseline-0.2.0-independent-20261105-d4f517ce.json` 的实际静态检查数同样为 11/11；但新增两个 sharp 回归后曾出现 35 项测试中 33 通过、2 失败，说明先前静态通过未发现两类缺失运行插件的漏洞。

本次修正加载路径与 CommonJS export 解析后，使用同一 Node 22.23.4 重跑完整 `node --test`：22 个顶层用例、61 项测试全部通过，退出码 `0`；独立新增的两个回归断言原样保留。再次对实际 0.2.0 运行上面的 CLI，仅把 `--output` 改为新的 `E:/EcomGen/.workspace-tools/release-checker-baseline-0.2.0-sharp-fixed.json`，退出码 `0`，11/11 静态检查 passed。此前报告均未覆盖。选中的两枚插件、七个未选中的 SQLite 平台资源、56 个 unpacked 原生相关文件和 1173 行 catalog 均通过；签名仍如实为 `unsigned` / `NotSigned`。

本次检查前后逐文件对比 `desktop/release/0.2.0` 的 3,792 个文件（共 779,191,842 bytes）的大小、mtime 与 SHA256，全部一致。ASAR SHA256 仍为 `475eec2a24e570ce380e2ec34ed9620a15f530e76d38a78301323ad438bafb3c`。未运行应用、安装器、打包 JS/插件或真实 Provider，未访问用户数据。`0.2.0` 基线通过不代表 `0.3.0` 发布通过：本次未构建或验收最终 `0.3.0`，最终产物构建结束后必须生成新的实际报告；GUI/安装/升级结果由负责真实运行验收的流程另行记录。
