import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { StorageService } from './storage.service';

interface EncryptedSecret {
  iv: string;
  tag: string;
  ciphertext: string;
}

type SecretVault = Record<string, EncryptedSecret>;

@Injectable()
export class SecretsService {
  private key?: Buffer;
  private readonly keyFile = 'app-secret.key';
  private readonly vaultFile = 'model-secrets.json';

  constructor(private readonly storage: StorageService) {}

  async saveApiKey(configId: string, apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    const vault = await this.storage.readJson<SecretVault>(this.vaultFile, {});
    vault[configId] = await this.encrypt(trimmed);
    await this.storage.writeJson(this.vaultFile, vault);
  }

  async getApiKey(configId: string): Promise<string | undefined> {
    const vault = await this.storage.readJson<SecretVault>(this.vaultFile, {});
    const secret = vault[configId];
    if (!secret) return undefined;
    return this.decrypt(secret);
  }

  async deleteApiKey(configId: string): Promise<void> {
    const vault = await this.storage.readJson<SecretVault>(this.vaultFile, {});
    if (!vault[configId]) return;
    delete vault[configId];
    await this.storage.writeJson(this.vaultFile, vault);
  }

  private async encryptionKey(): Promise<Buffer> {
    if (this.key) return this.key;
    const filePath = this.storage.dataPath(this.keyFile);
    try {
      this.key = Buffer.from((await readFile(filePath, 'utf8')).trim(), 'base64');
      if (this.key.length === 32) return this.key;
    } catch {
      // The key is created lazily on first use.
    }

    this.key = randomBytes(32);
    await this.storage.ensureDir(this.keyFile);
    await writeFile(filePath, this.key.toString('base64'), 'utf8');
    return this.key;
  }

  private async encrypt(value: string): Promise<EncryptedSecret> {
    const key = await this.encryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  private async decrypt(secret: EncryptedSecret): Promise<string> {
    const key = await this.encryptionKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(secret.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
