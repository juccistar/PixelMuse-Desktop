import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const packages = fileURLToPath(new URL('../../../', import.meta.url));
export default defineConfig({
  resolve: { alias: Object.fromEntries(['core','domain','contracts','agent','providers','ecom-skill','ecom-suite'].map(name => [`@ecomgen/${name}`, `${packages}${name}/src/index.ts`])) },
  test: { include: ['packages/backend/test/integration/**/*.test.ts', 'packages/backend/test/runtime/**/*.test.ts', 'packages/backend/test/backend.test.ts', 'packages/backend/test/business.test.ts'], testTimeout: 60000, hookTimeout: 30000 },
});
