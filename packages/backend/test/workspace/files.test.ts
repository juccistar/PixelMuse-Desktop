import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedInventory } from '../../src/workspace/files.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe('commit metadata fences', () => {
  it.each(['changed', 'deleted', 'added', 'replaced'] as const)('rejects a %s destination after its content digest has finished', async mutation => {
    const root = await mkdtemp(join(tmpdir(), 'pixelmuse-fence-')); roots.push(root);
    await mkdir(join(root, 'assets'));
    const first = join(root, 'assets', 'a-first.txt'); await writeFile(first, 'before');
    const snapshot = await verifiedInventory(root, [], new AbortController().signal);
    // 另一侧清点或配置 fsync 期间发生的同大小编辑/路径集合变化也不能越过提交屏障。
    if (mutation === 'changed') await writeFile(first, 'edited');
    else if (mutation === 'deleted') await rm(first);
    else if (mutation === 'added') await writeFile(join(root, 'assets', 'new-file.txt'), 'new');
    else {
      await rename(first, join(root, 'assets', 'old-file.txt'));
      await writeFile(first, 'before');
    }
    expect(() => snapshot.assertUnchanged()).toThrowError(expect.objectContaining({ code: 'INVALID_WORKSPACE' }));
  });
  it('ignores configuration temp files while accepting unchanged source and destination media', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pixelmuse-fence-')); roots.push(root);
    await mkdir(join(root, 'assets')); await writeFile(join(root, 'assets', 'media.txt'), 'unchanged');
    const source = await verifiedInventory(root, [], new AbortController().signal);
    await writeFile(join(root, 'workspace-config.json.pending.tmp'), '{}');
    expect(() => source.assertUnchanged()).not.toThrow();
  });
});
