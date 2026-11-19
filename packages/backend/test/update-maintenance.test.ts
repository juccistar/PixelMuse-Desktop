import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createBackend } from '../src/index.js';

it('drains accepted requests, blocks new requests, and resumes after cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pixelmuse-update-'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const backend = await createBackend({ dataDir: root, masterKey: randomBytes(32).toString('base64'), version: 'test' }, undefined, {
    commands: { listProjects: async () => { await gate; return { items: [], nextCursor: null }; } },
  });
  try {
    const accepted = backend.invoke('listProjects', {});
    let prepared = false;
    const preparation = backend.invokeHost('host.prepareUpdateInstall', {}).then(() => { prepared = true; });
    await expect(backend.invoke('getHealth', {})).rejects.toMatchObject({ code: 'UPDATE_MAINTENANCE' });
    await expect(backend.invokeHost('host.workspaceChoose', { directory: root })).rejects.toMatchObject({ code: 'UPDATE_MAINTENANCE' });
    let cancelled = false;
    const cancellation = backend.invokeHost('host.cancelUpdateInstall', {}).then(() => { cancelled = true; });
    expect(prepared).toBe(false);
    expect(cancelled).toBe(false);
    release(); await accepted; await preparation; await cancellation;
    await expect(backend.invoke('getHealth', {})).resolves.toBeDefined();
    await backend.invokeHost('host.prepareUpdateInstall', {});
    await backend.close();
    await expect(backend.invoke('getHealth', {})).rejects.toMatchObject({ code: 'CLOSING' });
  } finally {
    release(); await backend.close(); await rm(root, { recursive: true, force: true });
  }
});
