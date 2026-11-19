import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const workspace = fileURLToPath(new URL('../../../', import.meta.url));
export default defineConfig({
  resolve: { alias: Object.fromEntries(['core','domain','contracts','agent','providers','ecom-skill','ecom-suite'].map(name=>[`@ecomgen/${name}`,`${workspace}${name}/src/index.ts`])) },
  test: { include:['packages/backend/test/execution/**/*.test.ts'],testTimeout:30000,hookTimeout:30000 },
});
