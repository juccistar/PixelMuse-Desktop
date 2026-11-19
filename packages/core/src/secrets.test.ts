import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from './secrets.js';

describe('SecretBox', () => {
  it('只接收 main 提供的 32 字节 Buffer，独立复制主密钥', () => {
    expect(() => new SecretBox(Buffer.alloc(31))).toThrow('32 key bytes');
    expect(() => new SecretBox(new Uint8Array(32) as Buffer)).toThrow('32 key bytes');
    expect(() => new SecretBox('legacy-master-string' as unknown as Buffer)).toThrow('32 key bytes');
    const key=Buffer.alloc(32,5), box=new SecretBox(key);
    const encrypted=box.encrypt('密钥内容'); key.fill(0);
    expect(box.decrypt(encrypted)).toBe('密钥内容');
    expect(box.encrypt('密钥内容')).not.toBe(encrypted);
  });

  it('解密真实桌面 v2 IV/tag/ciphertext 格式并检测密文、标签和错误主密钥', () => {
    const key=randomBytes(32), iv=randomBytes(12);
    const cipher=createCipheriv('aes-256-gcm',key,iv);
    const encrypted=Buffer.concat([cipher.update('fake-provider-secret','utf8'),cipher.final()]);
    const payload=Buffer.concat([iv,cipher.getAuthTag(),encrypted]);
    const box=new SecretBox(key);
    expect(box.decrypt(payload.toString('base64'))).toBe('fake-provider-secret');
    for(const position of [0,12,28]) {
      const changed=Buffer.from(payload); changed[position]^=1;
      expect(() => box.decrypt(changed.toString('base64'))).toThrow();
    }
    expect(() => new SecretBox(randomBytes(32)).decrypt(payload.toString('base64'))).toThrow();
    for(const invalid of ['', 'not-base64!', Buffer.alloc(27).toString('base64')]) expect(() => box.decrypt(invalid)).toThrow('Invalid encrypted secret');
  });
});
