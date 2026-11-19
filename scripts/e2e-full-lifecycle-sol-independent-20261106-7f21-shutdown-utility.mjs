// Test fixture injection uses only the real Backend's own connection and files.
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = join(dirname(process.env.ECOMGEN_E2E_APP_PACKAGE), '../..');
const { ResourceRegistry } = await import(pathToFileURL(join(root, 'packages/backend/dist/runtime/resources.js')));
let registry, dataDir;
const cleanup = ResourceRegistry.prototype.cleanup;
ResourceRegistry.prototype.cleanup = function (...args) { registry = this; return cleanup.apply(this, args); };
process.parentPort.on('message', ({ data }) => {
  if (data.type === 'init') dataDir = data.options.dataDir;
  if (data.type !== '__sol-cleanup-seed') return;
  if (!registry || !dataDir || data.token !== process.env.ECOMGEN_E2E_GUARD_TOKEN) throw Error('Ready owned Backend required');
  const count = Number(data.cleanupCount);
  if (![1, 41].includes(count)) throw Error('Bounded synthetic cleanup count required');
  const bytes = readFileSync(process.env.ECOMGEN_SOL_SEED_IMAGE);
  const hash = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(join(dataDir, 'assets'), { recursive: true });
  registry.store.db.transaction(() => {
    for (let index = 0; index < 299; index++) {
      const id = randomUUID(), key = `ASSET:${id}`, relativePath = `assets/${id}.png`;
      writeFileSync(join(dataDir, relativePath), bytes);
      registry.store.db.prepare('INSERT INTO desktop_resources(id,payload,updated_at) VALUES(?,?,?)').run(key,
        JSON.stringify({ version: 1, ref: { kind: 'ASSET', id }, relativePath, mimeType: 'image/png', hash, owners: index < count ? [] : [`synthetic:${id}`], publication: 'PUBLISHED' }), new Date().toISOString());
      if (index < count) registry.store.db.prepare('INSERT INTO desktop_cleanup_queue(id,payload,created_at) VALUES(?,?,?)').run(key, JSON.stringify({ version: 1, resourceId: key, attempts: 0 }), new Date().toISOString());
    }
  })();
  process.parentPort.postMessage({ type: '__sol-seeded', counts: { resources: 299, cleanupIntents: count, jobs: registry.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n } });
});
await import(pathToFileURL(process.env.ECOMGEN_SOL_REAL_ENTRY));
