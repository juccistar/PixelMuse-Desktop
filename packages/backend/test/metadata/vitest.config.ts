import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../../../../vitest.config.js';
// 仅为本次 DTO 接缝验证使用源码契约，避免写入由协调者统一构建的 dist。
export default mergeConfig(base, defineConfig({ resolve: { alias: {
  '@ecomgen/contracts': fileURLToPath(new URL('../../../contracts/src/index.ts', import.meta.url)),
} } }));
