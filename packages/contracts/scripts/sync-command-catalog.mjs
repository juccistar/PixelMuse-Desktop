import { readFile, writeFile } from 'node:fs/promises';
import * as contracts from '../dist/index.js';

// 公开离线索引由已构建的唯一契约生成，原迁移入口的来源标记保持不变。
const path = new URL('../command-catalog.json', import.meta.url);
const catalog = JSON.parse(await readFile(path, 'utf8'));
const previous = new Map(catalog.operations.map(entry => [entry.operation, entry]));
const current = Object.entries(contracts.operations).map(([operation, contract]) => ({
  ...(previous.get(operation) ?? { operation, source: null, disposition: 'named IPC command' }),
  input: contract.input, output: contract.output,
}));
const retired = catalog.operations.filter(entry => entry.input === null && !Object.hasOwn(contracts.operations, entry.operation));
catalog.operations = [...current, ...retired];
// schemas 保留迁移时的历史来源快照；可执行操作的完整输入/输出以上面的canonical契约为准。
catalog.operationCount = current.length;
await writeFile(path, JSON.stringify(catalog, null, 2) + '\n');
console.log(`command-catalog: ${current.length} executable operations; ${retired.length} retired migration entries retained`);
