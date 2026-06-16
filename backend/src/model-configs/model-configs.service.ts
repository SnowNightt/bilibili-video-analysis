import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  MODEL_CAPABILITIES,
  type ModelCapability,
  type ModelConfig,
  type ModelConfigDraft,
} from '../common/domain';
import { OpenAiCompatibleClient } from './openai-compatible.client';
import { SecretsService } from '../storage/secrets.service';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class ModelConfigsService {
  private readonly fileName = 'model-configs.json';

  constructor(
    private readonly client: OpenAiCompatibleClient,
    private readonly secrets: SecretsService,
    private readonly storage: StorageService,
  ) {}

  async list(): Promise<ModelConfig[]> {
    return this.storage.readJson<ModelConfig[]>(this.fileName, []);
  }

  async testAndSave(draft: ModelConfigDraft): Promise<ModelConfig> {
    this.validateDraft(draft);
    const existing = draft.id ? await this.find(draft.id) : undefined;
    const apiKey = draft.apiKey?.trim() || (existing ? await this.secrets.getApiKey(existing.id) : undefined);
    if (!apiKey) {
      throw new BadRequestException({ message: '请填写 API Key。' });
    }

    try {
      await this.client.testConnection(draft, apiKey);
    } catch (error) {
      throw new BadRequestException({
        message:
          error instanceof Error && error.message
            ? error.message
            : '模型连接测试失败，请检查 API Key、模型名称或服务地址。',
      });
    }

    const now = new Date().toISOString();
    const config: ModelConfig = {
      id: existing?.id ?? draft.id ?? randomUUID(),
      name: draft.name.trim(),
      provider: draft.provider.trim(),
      baseUrl: draft.baseUrl.trim(),
      modelName: draft.modelName.trim(),
      capability: draft.capability,
      timeoutSeconds: Number(draft.timeoutSeconds),
      maxConcurrency: Number(draft.maxConcurrency),
      isDefault: Boolean(draft.isDefault),
      status: 'available',
      apiKeyConfigured: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (draft.apiKey?.trim()) {
      await this.secrets.saveApiKey(config.id, draft.apiKey);
    }
    await this.saveConfig(config);
    return config;
  }

  async delete(id: string): Promise<void> {
    const configs = await this.list();
    const next = configs.filter((item) => item.id !== id);
    if (next.length === configs.length) throw new NotFoundException({ message: '模型配置不存在。' });
    await this.storage.writeJson(this.fileName, next);
    await this.secrets.deleteApiKey(id);
  }

  async getConfigWithApiKey(id: string, capability?: ModelCapability): Promise<{ config: ModelConfig; apiKey: string }> {
    const config = await this.find(id);
    if (!config) throw new BadRequestException({ message: '模型配置不存在，请重新选择模型。' });
    if (capability && config.capability !== capability) {
      throw new BadRequestException({ message: '模型能力与当前分析模式不匹配。' });
    }
    const apiKey = await this.secrets.getApiKey(config.id);
    if (!apiKey) throw new BadRequestException({ message: '模型配置缺少 API Key，请重新保存配置。' });
    return { config, apiKey };
  }

  private async find(id: string): Promise<ModelConfig | undefined> {
    return (await this.list()).find((item) => item.id === id);
  }

  private async saveConfig(config: ModelConfig): Promise<void> {
    const configs = await this.list();
    const next = configs
      .filter((item) => item.id !== config.id)
      .map((item) =>
        config.isDefault && item.capability === config.capability ? { ...item, isDefault: false } : item,
      );
    next.unshift(config);
    await this.storage.writeJson(this.fileName, next);
  }

  private validateDraft(draft: ModelConfigDraft): void {
    if (!draft || typeof draft !== 'object') {
      throw new BadRequestException({ message: '模型配置不能为空。' });
    }
    if (!draft.name?.trim()) throw new BadRequestException({ message: '配置名称不能为空。' });
    if (!draft.provider?.trim()) throw new BadRequestException({ message: '模型厂商不能为空。' });
    if (!draft.modelName?.trim()) throw new BadRequestException({ message: '模型名称不能为空。' });
    if (!MODEL_CAPABILITIES.includes(draft.capability)) {
      throw new BadRequestException({ message: '模型能力不受支持。' });
    }
    try {
      const url = new URL(draft.baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid');
    } catch {
      throw new BadRequestException({ message: 'API Base URL 必须是合法 URL。' });
    }
    const timeoutSeconds = Number(draft.timeoutSeconds);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 10) {
      throw new BadRequestException({ message: '请求超时时间不得小于 10 秒。' });
    }
    const maxConcurrency = Number(draft.maxConcurrency);
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 20) {
      throw new BadRequestException({ message: '最大并发数必须在 1 到 20 之间。' });
    }
  }
}
