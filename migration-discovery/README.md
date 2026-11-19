# 有效迁移基线

本目录保留当前验收/测试仍直接读取的历史基线：

- original-api-inventory.json：原操作清单，e2e-full与后端catalog测试使用。
- original-job-inventory.json：原任务清单，完整覆盖与自测使用。
- map-4.json：功能分配与原路径来源映射。
- e2e-full-coverage.json：当前检查工具的生成覆盖记录，不是仅凭存在即可判通过的业务证据。

其余分工、接口讨论、旧分析和恢复报告已分类到[docs/archive/migration-0.3.0](../docs/archive/migration-0.3.0/)。原路径与哈希在[整理清单](../docs/cleanup-record-20261106.json)中。

不要把当前基线整体视为废弃资料，也不要把旧分析中的未接线结论当作新版待办。当前维护入口见[docs](../docs/README.md)。
