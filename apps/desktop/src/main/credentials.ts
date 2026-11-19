import { safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 系统加密只保护主密钥；Provider 凭据由 Backend 使用主密钥加密。 */
export function loadMasterKey(configDir: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥保护不可用，无法打开 Provider 凭据。');
  const filename = join(configDir, 'master-key.enc');
  if (existsSync(filename)) {
    const key = safeStorage.decryptString(readFileSync(filename));
    if (Buffer.from(key, 'base64').length !== 32) throw new Error('主密钥文件无效，请从备份恢复。');
    return key;
  }
  const key = randomBytes(32).toString('base64');
  writeFileSync(filename, safeStorage.encryptString(key), { flag: 'wx', mode: 0o600 });
  return key;
}
