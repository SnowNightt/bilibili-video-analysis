import type { ModelConfig, ModelConfigDraft } from '../types/domain'
import { requestJson } from './http'
import { readCollection, writeCollection } from './storage'

const STORAGE_KEY = 'streamwise-model-configs-v2'

export function listModelConfigs(): ModelConfig[] {
  return readCollection<ModelConfig>(STORAGE_KEY)
}

export function saveModelConfig(draft: ModelConfigDraft): ModelConfig {
  const configs = listModelConfigs()
  const now = new Date().toISOString()
  const existing = draft.id ? configs.find((item) => item.id === draft.id) : undefined
  const config: ModelConfig = {
    id: existing?.id ?? crypto.randomUUID(),
    name: draft.name.trim(),
    provider: draft.provider,
    baseUrl: draft.baseUrl.trim(),
    modelName: draft.modelName.trim(),
    capability: draft.capability,
    timeoutSeconds: draft.timeoutSeconds,
    maxConcurrency: draft.maxConcurrency,
    isDefault: draft.isDefault,
    status: existing?.status ?? 'untested',
    apiKeyConfigured: Boolean(draft.apiKey || draft.apiKeyConfigured),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  const next = existing
    ? configs.map((item) => (item.id === config.id ? config : item))
    : [...configs, config]
  writeCollection(STORAGE_KEY, next)
  return config
}

export function deleteModelConfig(id: string): void {
  writeCollection(
    STORAGE_KEY,
    listModelConfigs().filter((item) => item.id !== id),
  )
}

export async function testModelConnection(draft: ModelConfigDraft): Promise<void> {
  await requestJson<{ ok: true }>('/api/model-configs/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  })
}
