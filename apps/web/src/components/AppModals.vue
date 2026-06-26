<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
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

const canSubmitModel = computed(
  () =>
    Boolean(modelDraft.name.trim()) &&
    Boolean(modelDraft.provider) &&
    Boolean(modelDraft.baseUrl.trim()) &&
    Boolean(modelDraft.modelName.trim()) &&
    Boolean(modelDraft.capability) &&
    Boolean(modelDraft.apiKeyConfigured || modelDraft.apiKey.trim()) &&
    Number(modelDraft.timeoutSeconds) >= 10 &&
    Number(modelDraft.maxConcurrency) >= 1 &&
    Number(modelDraft.maxConcurrency) <= 20,
)

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

function handleModelModalUpdate(visible: boolean) {
  if (visible) state.showModelModal = true
  else closeModelModal()
}

function handleDeleteModalUpdate(visible: boolean) {
  if (!visible) state.deletingJobId = null
}

function submitModelDraft() {
  if (!canSubmitModel.value) return
  void app.submitModel({ ...modelDraft })
}
</script>

<template>
  <el-dialog
    v-model="state.showStartConfirm"
    class="app-dialog"
    width="min(540px, calc(100vw - 40px))"
    :show-close="false"
    align-center
  >
    <section aria-labelledby="start-title">
      <p class="eyebrow">CONFIRM COST</p><h2 id="start-title">确认开始分析</h2>
      <p>本次将使用“{{ modeLabel }}”与“{{ depthLabel }}分析”，预计处理 {{ estimate }}。系统不会在失败后自动切换模式。</p>
      <el-descriptions v-if="state.currentVideo" class="confirm-descriptions" :column="2">
        <el-descriptions-item label="视频">
          <el-tooltip :content="state.currentVideo.title" placement="top" effect="dark">
            <span class="tooltip-ellipsis">{{ state.currentVideo.title }}</span>
          </el-tooltip>
        </el-descriptions-item>
        <el-descriptions-item label="分 P 数量">{{ state.selectedPartCids.length }}</el-descriptions-item>
        <el-descriptions-item
          v-for="capability in app.requiredCapabilities.value"
          :key="capability"
          :label="CAPABILITY_LABELS[capability]"
        >
          <span class="tooltip-ellipsis">{{ selectedModelName(capability) }}</span>
        </el-descriptions-item>
      </el-descriptions>
      <div class="modal-actions">
        <el-button class="secondary-button" native-type="button" @click="state.showStartConfirm = false">返回调整</el-button>
        <el-button class="primary-button" native-type="button" :loading="state.busy" :disabled="state.busy" @click="app.startAnalysis">{{ state.busy ? '提交中…' : '确认并开始' }}</el-button>
      </div>
    </section>
  </el-dialog>

  <el-dialog
    :model-value="state.showModelModal"
    class="app-dialog model-dialog"
    width="min(660px, calc(100vw - 40px))"
    :show-close="false"
    align-center
    @update:model-value="handleModelModalUpdate"
  >
    <section aria-labelledby="model-title">
      <p class="eyebrow">MODEL PROFILE</p><h2 id="model-title">{{ state.editingModel ? '编辑模型配置' : '添加模型配置' }}</h2>
      <form id="model-form" class="form-grid" @submit.prevent="submitModelDraft">
        <label>配置名称<el-input v-model.trim="modelDraft.name" required /></label>
        <label>
          模型厂商
          <el-select v-model="modelDraft.provider" placeholder="请选择厂商" required>
            <el-option v-for="provider in MODEL_PROVIDERS" :key="provider" :label="provider" :value="provider" />
          </el-select>
        </label>
        <label class="full">API Base URL<el-input v-model.trim="modelDraft.baseUrl" type="url" required /></label>
        <label class="full">
          API Key
          <el-input
            v-model="modelDraft.apiKey"
            type="password"
            :required="!modelDraft.apiKeyConfigured"
            autocomplete="new-password"
            :placeholder="modelDraft.apiKeyConfigured ? '已配置；留空表示不更换' : '密钥只发送给本地后端'"
            show-password
          />
        </label>
        <label>模型名称<el-input v-model.trim="modelDraft.modelName" required /></label>
        <label>
          模型能力
          <el-select v-model="modelDraft.capability" required>
            <el-option
              v-for="(label, capability) in CAPABILITY_LABELS"
              :key="capability"
              :label="label"
              :value="capability"
            />
          </el-select>
        </label>
        <label>请求超时（秒）<el-input-number v-model="modelDraft.timeoutSeconds" :min="10" :controls="false" required /></label>
        <label>最大并发数<el-input-number v-model="modelDraft.maxConcurrency" :min="1" :max="20" :controls="false" required /></label>
        <div class="checkbox-field"><el-checkbox v-model="modelDraft.isDefault">设为该能力的默认模型</el-checkbox></div>
      </form>
      <p class="credential-help">保存前会调用本地后端测试地址、密钥和模型可用性。前端不会持久化 API Key。</p>
      <div class="modal-actions">
        <el-button class="secondary-button" native-type="button" @click="closeModelModal">取消</el-button>
        <el-button class="primary-button" native-type="submit" form="model-form" :loading="state.busy" :disabled="state.busy || !canSubmitModel">{{ state.busy ? '测试中…' : '测试连接并保存' }}</el-button>
      </div>
    </section>
  </el-dialog>

  <el-dialog
    :model-value="Boolean(state.deletingJobId)"
    class="app-dialog small-dialog"
    width="min(430px, calc(100vw - 40px))"
    :show-close="false"
    align-center
    @update:model-value="handleDeleteModalUpdate"
  >
    <section aria-labelledby="delete-title">
      <h2 id="delete-title">删除历史记录？</h2>
      <p>本地保存的任务快照将被删除。后端媒体与报告文件的清理由分析服务负责。</p>
      <div class="modal-actions">
        <el-button class="secondary-button" native-type="button" @click="state.deletingJobId = null">取消</el-button>
        <el-button class="primary-button danger-button" native-type="button" @click="app.deleteJob">确认删除</el-button>
      </div>
    </section>
  </el-dialog>
</template>
