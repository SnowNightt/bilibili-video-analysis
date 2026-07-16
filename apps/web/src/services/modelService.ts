import type { ModelConfig, ModelConfigDraft } from '../types/domain'
import { requestJson } from './http'

export function listModelConfigs(): ModelConfig[] {
  return []
}

export function fetchModelConfigs(): Promise<ModelConfig[]> {
  return requestJson<ModelConfig[]>('/api/model-configs')
}

export async function deleteModelConfig(id: string): Promise<void> {
  await requestJson<{ ok: true }>(`/api/model-configs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export async function testAndSaveModelConfig(draft: ModelConfigDraft): Promise<ModelConfig> {
  const result = await requestJson<{ ok: true; config: ModelConfig }>('/api/model-configs/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  })
  return result.config
}
