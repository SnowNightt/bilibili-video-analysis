<script setup lang="ts">
import { computed } from 'vue'
import { CAPABILITY_LABELS } from '../constants/app'
import type { AppController } from '../composables/useAppState'
import EmptyState from '../components/EmptyState.vue'

const { app } = defineProps<{ app: AppController }>()
const { state, filteredModels } = app
const providers = computed(() => [...new Set(state.modelConfigs.map((model) => model.provider))])
</script>

<template>
  <section class="page page-models">
    <header class="page-heading">
      <div><p class="eyebrow">LOCAL CREDENTIALS</p><h1>模型管理</h1><p>统一管理厂商、模型能力和任务默认配置。</p></div>
      <el-button class="primary-button compact" native-type="button" @click="app.openModelEditor()">添加配置</el-button>
    </header>

    <div class="security-notice">
      <strong>API Key 不写入前端存储</strong>
      <p>配置保存时只保留非敏感元数据；密钥应由本地后端写入操作系统凭据库。</p>
      <div v-if="state.isDesktop" class="row-actions">
        <el-button native-type="button" @click="app.openDesktopDirectory('data')">打开数据目录</el-button>
        <el-button native-type="button" @click="app.openDesktopDirectory('cache')">打开缓存目录</el-button>
        <el-button native-type="button" @click="app.openDesktopDirectory('logs')">打开日志目录</el-button>
      </div>
    </div>

    <div v-if="state.modelConfigs.length" class="toolbar model-toolbar">
      <el-select v-model="state.modelProviderFilter" class="provider-filter" aria-label="模型厂商筛选">
        <el-option label="全部厂商" value="all" />
        <el-option v-for="provider in providers" :key="provider" :label="provider" :value="provider" />
      </el-select>
      <span>{{ filteredModels.length }} 个配置</span>
    </div>

    <div v-if="filteredModels.length" class="model-list">
      <article v-for="model in filteredModels" :key="model.id">
        <div class="model-main"><div><span class="capability-label">{{ CAPABILITY_LABELS[model.capability] }}</span><h2>{{ model.name }}</h2></div><span v-if="model.isDefault" class="default-tag">默认</span></div>
        <dl><div><dt>厂商</dt><dd>{{ model.provider }}</dd></div><div><dt>模型</dt><dd>{{ model.modelName }}</dd></div><div><dt>API 地址</dt><dd>{{ model.baseUrl }}</dd></div><div><dt>API Key</dt><dd>{{ model.apiKeyConfigured ? '已安全配置' : '未配置' }}</dd></div></dl>
        <div class="model-status"><span class="status-dot" :class="model.status === 'available' ? '已完成' : '已取消'">{{ model.status === 'available' ? '可用' : model.status === 'unavailable' ? '不可用' : '未测试' }}</span><el-button native-type="button" @click="app.openModelEditor(model)">编辑</el-button><el-button class="danger-link" native-type="button" @click="app.removeModel(model.id)">删除</el-button></div>
      </article>
    </div>

    <EmptyState
      v-else
      title="尚未配置模型"
      description="添加文本、ASR、图片或视频理解模型后，才能创建对应模式的分析任务。"
      action-label="添加模型配置"
      @action="app.openModelEditor()"
    />
  </section>
</template>
