import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;

export class SecretBox {
  private readonly key: Buffer;

  /** 主进程提供经系统密钥存储解封的 32 字节密钥；不读取环境变量。 */
  public constructor(key: Buffer) {
    if (!Buffer.isBuffer(key) || key.byteLength !== 32) throw new Error("SecretBox requires exactly 32 key bytes");
    this.key = Buffer.from(key);
  }

  public encrypt(plainText: string): string {
    // 每个密文使用独立 IV；输出同时携带 IV、GCM tag 和密文，便于持久化后完整校验。
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString("base64");
  }

  public decrypt(cipherText: string): string {
    if (typeof cipherText !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cipherText)) throw new Error('Invalid encrypted secret');
    const payload = Buffer.from(cipherText, "base64");
    if (payload.byteLength < IV_BYTES + 16) throw new Error('Invalid encrypted secret');
    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(IV_BYTES, IV_BYTES + 16);
    const encrypted = payload.subarray(IV_BYTES + 16);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }
}
