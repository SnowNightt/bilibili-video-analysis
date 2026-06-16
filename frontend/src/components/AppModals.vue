<script setup lang="ts">
import { reactive, watch } from 'vue'
import { CAPABILITY_LABELS, MODEL_PROVIDERS } from '../constants/app'
import type { AppController } from '../composables/useAppState'
import type { ModelCapability, ModelConfigDraft } from '../types/domain'

const { app } = defineProps<{ app: AppController }>()
const { state, modeLabel, depthLabel, estimate } = app

const modelDraft = reactive<ModelConfigDraft>({
  name: '',
  provider: '',
  baseUrl: '',
  apiKey: '',
  modelName: '',
  capability: 'text',
  timeoutSeconds: 900,
  maxConcurrency: 1,
  isDefault: false,
})

watch(
  () => state.showModelModal,
  (visible) => {
    if (!visible) return
    const model = state.editingModel
    Object.assign(modelDraft, {
      id: model?.id,
      name: model?.name ?? '',
      provider: model?.provider ?? '',
      baseUrl: model?.baseUrl ?? '',
      apiKey: '',
      modelName: model?.modelName ?? '',
      capability: model?.capability ?? 'text',
      timeoutSeconds: model?.timeoutSeconds ?? 900,
      maxConcurrency: model?.maxConcurrency ?? 1,
      isDefault: model?.isDefault ?? false,
      apiKeyConfigured: model?.apiKeyConfigured ?? false,
    })
  },
)

function selectedModelName(capability: ModelCapability): string {
  const id = state.selectedModelIds[capability]
  return state.modelConfigs.find((model) => model.id === id)?.name ?? '未选择'
}

function closeModelModal() {
  state.showModelModal = false
  state.editingModel = null
}
</script>

<template>
  <div v-if="state.showStartConfirm" class="modal-layer" role="presentation" @click.self="state.showStartConfirm = false">
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="start-title">
      <p class="eyebrow">CONFIRM COST</p><h2 id="start-title">确认开始分析</h2>
      <p>本次将使用“{{ modeLabel }}”与“{{ depthLabel }}分析”，预计处理 {{ estimate }}。系统不会在失败后自动切换模式。</p>
      <dl v-if="state.currentVideo">
        <div><dt>视频</dt><dd>{{ state.currentVideo.title }}</dd></div>
        <div><dt>分 P 数量</dt><dd>{{ state.selectedPartCids.length }}</dd></div>
        <div v-for="capability in app.requiredCapabilities.value" :key="capability"><dt>{{ CAPABILITY_LABELS[capability] }}</dt><dd>{{ selectedModelName(capability) }}</dd></div>
      </dl>
      <div class="modal-actions"><button class="secondary-button" type="button" @click="state.showStartConfirm = false">返回调整</button><button class="primary-button" type="button" :disabled="state.busy" @click="app.startAnalysis">{{ state.busy ? '提交中…' : '确认并开始' }}</button></div>
    </section>
  </div>

  <div v-if="state.showModelModal" class="modal-layer" role="presentation" @click.self="closeModelModal">
    <section class="modal model-modal" role="dialog" aria-modal="true" aria-labelledby="model-title">
      <p class="eyebrow">MODEL PROFILE</p><h2 id="model-title">{{ state.editingModel ? '编辑模型配置' : '添加模型配置' }}</h2>
      <form id="model-form" class="form-grid" @submit.prevent="app.submitModel({ ...modelDraft })">
        <label>配置名称<input v-model.trim="modelDraft.name" required /></label>
        <label>模型厂商<select v-model="modelDraft.provider" required><option value="" disabled>请选择厂商</option><option v-for="provider in MODEL_PROVIDERS" :key="provider">{{ provider }}</option></select></label>
        <label class="full">API Base URL<input v-model.trim="modelDraft.baseUrl" type="url" required /></label>
        <label class="full">API Key<input v-model="modelDraft.apiKey" type="password" :required="!modelDraft.apiKeyConfigured" autocomplete="new-password" :placeholder="modelDraft.apiKeyConfigured ? '已配置；留空表示不更换' : '密钥只发送给本地后端'" /></label>
        <label>模型名称<input v-model.trim="modelDraft.modelName" required /></label>
        <label>模型能力<select v-model="modelDraft.capability" required><option v-for="(label, capability) in CAPABILITY_LABELS" :key="capability" :value="capability">{{ label }}</option></select></label>
        <label>请求超时（秒）<input v-model.number="modelDraft.timeoutSeconds" type="number" min="10" required /></label>
        <label>最大并发数<input v-model.number="modelDraft.maxConcurrency" type="number" min="1" max="20" required /></label>
        <label class="checkbox-field"><input v-model="modelDraft.isDefault" type="checkbox" />设为该能力的默认模型</label>
      </form>
      <p class="credential-help">保存前会调用本地后端测试地址、密钥和模型可用性。前端不会持久化 API Key。</p>
      <div class="modal-actions"><button class="secondary-button" type="button" @click="closeModelModal">取消</button><button class="primary-button" type="submit" form="model-form" :disabled="state.busy">{{ state.busy ? '测试中…' : '测试连接并保存' }}</button></div>
    </section>
  </div>

  <div v-if="state.deletingJobId" class="modal-layer" role="presentation" @click.self="state.deletingJobId = null">
    <section class="modal small-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title"><h2 id="delete-title">删除历史记录？</h2><p>本地保存的任务快照将被删除。后端媒体与报告文件的清理由分析服务负责。</p><div class="modal-actions"><button class="secondary-button" type="button" @click="state.deletingJobId = null">取消</button><button class="primary-button danger-button" type="button" @click="app.deleteJob">确认删除</button></div></section>
  </div>
</template>
