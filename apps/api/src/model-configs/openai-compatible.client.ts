import { Injectable } from '@nestjs/common';
import { Blob } from 'node:buffer';
import { FormData } from 'undici';
import type { ModelConfig, ModelConfigDraft } from '../common/domain';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
}

interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json_object';
}

interface FetchJsonOptions {
  method?: string;
  apiKey: string;
  timeoutSeconds: number;
  body?: unknown | FormData;
}

@Injectable()
export class OpenAiCompatibleClient {
  async testConnection(draft: ModelConfigDraft, apiKey: string): Promise<void> {
    if (draft.capability === 'asr') {
      await this.testTranscription(draft, apiKey);
      return;
    }

    if (draft.capability === 'video') {
      try {
        await this.checkModelsEndpoint(draft, apiKey);
        return;
      } catch {
        // Some OpenAI-compatible vendors do not expose /models. Fall back to a
        // tiny chat call so users with compatible gateways can still proceed.
      }
    }

    if (draft.capability === 'image') {
      await this.chat(
        draft,
        apiKey,
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Return ok.' },
              {
                type: 'image_url',
                image_url: {
                  url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
                },
              },
            ],
          },
        ],
        { maxTokens: 8 },
      );
      return;
    }

    await this.chat(
      draft,
      apiKey,
      [{ role: 'user', content: 'Return ok.' }],
      { maxTokens: 8 },
    );
  }

  async chat(
    config: Pick<ModelConfig, 'baseUrl' | 'modelName' | 'timeoutSeconds'>,
    apiKey: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<string> {
    const payload = await this.fetchJson<Record<string, unknown>>(
      this.endpoint(config.baseUrl, 'chat/completions'),
      {
        method: 'POST',
        apiKey,
        timeoutSeconds: config.timeoutSeconds,
        body: {
          model: config.modelName,
          messages,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 1024,
          ...(options.responseFormat ? { response_format: { type: options.responseFormat } } : {}),
        },
      },
    );

    const choice = (payload.choices as Array<Record<string, unknown>> | undefined)?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((item) =>
          item && typeof item === 'object' && 'text' in item ? String(item.text ?? '') : '',
        )
        .join('\n')
        .trim();
    }
    throw new Error('模型响应格式不兼容，请检查模型是否支持 OpenAI Chat Completions。');
  }

  async transcribe(
    config: Pick<ModelConfig, 'baseUrl' | 'modelName' | 'timeoutSeconds'>,
    apiKey: string,
    audio: Buffer,
    fileName: string,
  ): Promise<string> {
    const form = new FormData();
    form.append('model', config.modelName);
    form.append('file', new Blob([audio], { type: 'audio/mp4' }), fileName);

    const payload = await this.fetchJson<Record<string, unknown>>(
      this.endpoint(config.baseUrl, 'audio/transcriptions'),
      {
        method: 'POST',
        apiKey,
        timeoutSeconds: config.timeoutSeconds,
        body: form,
      },
    );

    const text = payload.text;
    if (typeof text === 'string' && text.trim()) return text.trim();
    throw new Error('ASR 模型响应格式不兼容，请检查模型是否支持 OpenAI Audio Transcriptions。');
  }

  private async testTranscription(
    config: Pick<ModelConfigDraft, 'baseUrl' | 'modelName' | 'timeoutSeconds'>,
    apiKey: string,
  ): Promise<void> {
    const form = new FormData();
    form.append('model', config.modelName);
    form.append('file', new Blob([this.silentWav()], { type: 'audio/wav' }), 'asr-test.wav');

    await this.fetchJson<Record<string, unknown>>(this.endpoint(config.baseUrl, 'audio/transcriptions'), {
      method: 'POST',
      apiKey,
      timeoutSeconds: config.timeoutSeconds,
      body: form,
    });
  }

  private async checkModelsEndpoint(draft: ModelConfigDraft, apiKey: string): Promise<void> {
    const payload = await this.fetchJson<Record<string, unknown>>(this.endpoint(draft.baseUrl, 'models'), {
      method: 'GET',
      apiKey,
      timeoutSeconds: draft.timeoutSeconds,
    });
    const data = payload.data;
    if (!Array.isArray(data)) return;
    const hasModel = data.some((item) => {
      if (!item || typeof item !== 'object') return false;
      const id = (item as { id?: unknown }).id;
      return typeof id === 'string' && id === draft.modelName;
    });
    if (!hasModel && data.length > 0) {
      throw new Error('模型名称不存在，请检查模型配置。');
    }
  }

  private async fetchJson<T>(url: string, options: FetchJsonOptions): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(options.timeoutSeconds, 10) * 1000);
    const isFormData = options.body instanceof FormData;
    const body = isFormData ? options.body : options.body ? JSON.stringify(options.body) : undefined;
    try {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          ...(!isFormData ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body as BodyInit | undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(await this.messageForResponse(response));
      }
      return (await response.json()) as T;
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') {
        throw new Error('模型服务请求超时，请检查网络、服务地址或调高超时时间。');
      }
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      if (cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
        throw new Error('模型服务连接超时，请检查 Node 后端代理或网络连通性。');
      }
      if (cause?.code === 'ENOTFOUND' || cause?.code === 'EAI_AGAIN') {
        throw new Error('模型服务域名解析失败，请检查 DNS、代理或网络设置。');
      }
      const message = error instanceof Error ? error.message : '';
      if (message && message !== 'fetch failed') throw new Error(message);
      if (cause?.message) throw new Error(`模型服务无法连接：${cause.message}`);
      throw new Error('模型服务无法连接，请检查 API Base URL。');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async messageForResponse(response: Response): Promise<string> {
    const providerMessage = await this.providerErrorMessage(response);
    if (providerMessage) return providerMessage;

    const status = response.status;
    if (status === 401 || status === 403) return 'API Key 无效或没有访问该模型的权限。';
    if (status === 404) return '模型名称不存在或接口路径不正确。';
    if (status === 408 || status === 504) return '模型服务请求超时。';
    if (status === 429) return '模型服务触发限流，请稍后重试或调整并发。';
    if (status >= 500) return '模型服务暂时不可用，请稍后重试。';
    return '模型连接测试失败，请检查 API Key、模型名称或服务地址。';
  }

  private async providerErrorMessage(response: Response): Promise<string> {
    const text = (await response.text()).trim();
    if (!text) return '';

    try {
      const parsed = JSON.parse(text) as unknown;
      const message = this.extractErrorText(parsed);
      if (message) return message;
    } catch {
      // Fall through to a bounded plain-text message.
    }

    return text.slice(0, 300);
  }

  private extractErrorText(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const source = value as Record<string, unknown>;
    const nested = this.extractErrorText(source.error);
    if (nested) return nested;
    for (const key of ['message', 'msg', 'detail', 'error']) {
      const candidate = source[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 300);
    }
    return '';
  }

  private silentWav(): Buffer {
    const sampleRate = 16000;
    const durationSeconds = 1;
    const channels = 1;
    const bitsPerSample = 16;
    const dataSize = sampleRate * durationSeconds * channels * (bitsPerSample / 8);
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
    buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    return buffer;
  }

  private endpoint(baseUrl: string, suffix: 'chat/completions' | 'models' | 'audio/transcriptions'): string {
    let base = baseUrl.trim().replace(/\/+$/, '');
    if (suffix === 'chat/completions' && /\/chat\/completions$/i.test(base)) return base;
    if (suffix === 'audio/transcriptions' && /\/audio\/transcriptions$/i.test(base)) return base;
    if (suffix === 'models' && /\/chat\/completions$/i.test(base)) {
      base = base.replace(/\/chat\/completions$/i, '');
    }
    if (suffix === 'audio/transcriptions' && /\/chat\/completions$/i.test(base)) {
      base = base.replace(/\/chat\/completions$/i, '');
    }
    return `${base}/${suffix}`;
  }
}
