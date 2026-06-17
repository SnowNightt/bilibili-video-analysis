import type { ModelConfig, ModelConfigDraft } from '../types/domain'
import { requestJson } from './http'
import { readCollection, writeCollection } from './storage'

const STORAGE_KEY = 'streamwise-model-configs-v2'

export function listModelConfigs(): ModelConfig[] {
  return readCollection<ModelConfig>(STORAGE_KEY)
}

function persistModelConfig(config: ModelConfig): ModelConfig {
  const configs = listModelConfigs()
  const next = [
    config,
    ...configs
      .filter((item) => item.id !== config.id)
      .map((item) =>
        config.isDefault && item.capability === config.capability ? { ...item, isDefault: false } : item,
      ),
  ]
  writeCollection(STORAGE_KEY, next)
  return config
}

export async function deleteModelConfig(id: string): Promise<void> {
  await requestJson<{ ok: true }>(`/api/model-configs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  writeCollection(
    STORAGE_KEY,
    listModelConfigs().filter((item) => item.id !== id),
  )
}

export async function testAndSaveModelConfig(draft: ModelConfigDraft): Promise<ModelConfig> {
  const result = await requestJson<{ ok: true; config: ModelConfig }>('/api/model-configs/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  })
  return persistModelConfig(result.config)
}
