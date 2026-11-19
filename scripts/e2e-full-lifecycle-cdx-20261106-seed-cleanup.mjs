// Runs only under the development Electron's Node ABI against a closed,
// explicitly supplied synthetic profile. No Provider/client modules are loaded.
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const [filename, fixture, imageFile, countArg = '41'] = process.argv.slice(2);
const cleanupCount = Number(countArg);
if (!Number.isSafeInteger(cleanupCount) || cleanupCount < 0 || cleanupCount > 299) throw Error('Bounded synthetic cleanup count required');
if (!filename?.startsWith(fixture + '/') && !filename?.startsWith(fixture + '\\')) throw Error('Synthetic fixture database required');
if (existsSync(join(filename, '../backend.lock'))) throw Error('Closed owner required');
const { readFileSync } = await import('node:fs');
const bytes = readFileSync(imageFile), hash = createHash('sha256').update(bytes).digest('hex');
const Database = createRequire(new URL('../packages/backend/package.json', import.meta.url))('better-sqlite3');
const db = new Database(filename, { fileMustExist: true });
try {
  mkdirSync(join(filename, '../assets'), { recursive: true });
  db.transaction(() => {
    for (let index = 0; index < 299; index++) {
      const id = randomUUID(), key = `ASSET:${id}`, relativePath = `assets/${id}.png`;
      writeFileSync(join(filename, '..', relativePath), bytes);
      db.prepare('INSERT INTO desktop_resources(id,payload,updated_at) VALUES(?,?,?)').run(key,
        JSON.stringify({ version: 1, ref: { kind: 'ASSET', id }, relativePath, mimeType: 'image/png', hash,
          owners: index < cleanupCount ? [] : [`synthetic:${id}`], publication: 'PUBLISHED' }), new Date().toISOString());
      if (index < cleanupCount) db.prepare('INSERT INTO desktop_cleanup_queue(id,payload,created_at) VALUES(?,?,?)').run(key,
        JSON.stringify({ version: 1, resourceId: key, attempts: 0 }), new Date().toISOString());
    }
  })();
  console.log(JSON.stringify({ resources: 299, cleanupIntents: cleanupCount }));
} finally { db.close(); }
