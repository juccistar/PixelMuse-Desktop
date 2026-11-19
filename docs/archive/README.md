# 历史归档

本目录保存迁移、验收和旧驱动的来源材料。它不是当前运行依赖，也不是当前缺口清单。

| 分类 | 内容 |
| --- | --- |
| migration-status-through-0.4.0.md | 原MIGRATION_STATUS完整原文，含0.3.0和0.4.0实施过程 |
| validation-through-0.4.0.md | 原VALIDATION完整原文，含各历史版本及冻结包证据 |
| migration-0.3.0/ | 原迁移分工、接口讨论、分析映射、恢复报告及独立审查 |
| tools-0.2.0/ | 旧e2e-mock及mock-provider一组参考，增加.txt后缀，避免误作当前驱动 |

本目录与工具归档中的23份历史文件保存原始字节，未把其中旧待办改写成当前结论。整理清单另有desktop/ARCHITECTURE.md → docs/architecture.md：它是分类后继续更新的现行维护正文，不属于不可变历史文件，其清单哈希代表移动时的原始字节。原文内路径、相对链接和行号以归档前位置为基准；新旧路径与SHA-256见[整理清单](../cleanup-record-20261106.json)。当前文档使用有效的新路径，历史引用按清单追溯。

原始位置映射：

- desktop/MIGRATION_STATUS.md → 本目录migration-status-through-0.4.0.md。
- desktop/VALIDATION.md → 本目录validation-through-0.4.0.md。
- desktop/migration-discovery中的旧分析 → 本目录migration-0.3.0/同名文件。
- desktop/scripts/e2e-mock.mjs及两个mock-provider文件 → tools-0.2.0/对应文件.txt。

最终发布包、升级基线及被引用的最终.cache证据仍在原处。仍被当前工具读取的原操作/任务/功能基线留在migration-discovery，不能整体移走或删除。

8个一次性失效脚本已从活动目录移到工作区`.workspace-tools/archive/obsolete-tools-20261106/`，不纳入当前维护脚本。自动审批拒绝永久删除并要求逐文件批准，因此本轮没有永久删除；归档可按清单恢复。正在被旧审查进程使用的缓存路径没有修改。
