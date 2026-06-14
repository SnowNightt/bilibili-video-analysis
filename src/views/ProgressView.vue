<script setup lang="ts">
import { computed } from 'vue'
import { PROGRESS_STEPS } from '../constants/app'
import type { AppController } from '../composables/useAppState'
import { formatDuration } from '../utils/format'
import EmptyState from '../components/EmptyState.vue'

const { app } = defineProps<{ app: AppController }>()
const { state } = app

const activeStepIndex = computed(() => {
  if (!state.currentJob) return -1
  const index = PROGRESS_STEPS.findIndex((step) => step.status === state.currentJob?.status)
  return index >= 0 ? index : state.currentJob.status === 'completed' ? PROGRESS_STEPS.length - 1 : -1
})

const isActive = computed(() =>
  state.currentJob
    ? !['completed', 'failed', 'cancelled'].includes(state.currentJob.status)
    : false,
)
</script>

<template>
  <section class="page page-progress">
    <header class="page-heading">
      <div><p class="eyebrow">ANALYSIS JOB</p><h1>任务进度</h1><p>状态由本地分析服务持续更新。</p></div>
      <button class="text-button" type="button" @click="app.navigate('new')">返回新建分析</button>
    </header>

    <template v-if="state.currentJob">
      <div class="progress-hero">
        <img :src="state.currentJob.video.coverUrl" :alt="`${state.currentJob.video.title}视频封面`" />
        <div>
          <span class="job-kicker">{{ state.currentJob.bvid }} · {{ app.statusLabel(state.currentJob.status) }}</span>
          <h2>{{ state.currentJob.video.title }}</h2>
          <p>{{ state.currentJob.currentStage || '等待分析服务返回当前阶段。' }}</p>
          <small>视频时长 {{ formatDuration(state.currentJob.video.duration) }}</small>
        </div>
        <strong class="progress-percent">{{ state.currentJob.progress }}%</strong>
      </div>

      <div class="progress-bar" aria-label="任务进度"><span :style="{ width: `${state.currentJob.progress}%` }"></span></div>

      <ol class="steps-list">
        <li
          v-for="(step, index) in PROGRESS_STEPS"
          :key="step.status"
          :class="{ done: index < activeStepIndex || state.currentJob.status === 'completed', active: activeStepIndex === index && isActive }"
        >
          <span>{{ String(index + 1).padStart(2, '0') }}</span>
          <div><strong>{{ step.label }}</strong><small>{{ index < activeStepIndex ? '已完成' : index === activeStepIndex ? app.statusLabel(state.currentJob.status) : '等待处理' }}</small></div>
        </li>
      </ol>

      <div v-if="state.currentJob.errorMessage" class="job-error">
        <strong>任务未完成</strong><p>{{ state.currentJob.errorMessage }}</p>
      </div>

      <div class="progress-actions">
        <button v-if="isActive" class="secondary-button danger" type="button" :disabled="state.busy" @click="app.cancelCurrentJob">取消任务</button>
        <button v-if="state.currentJob.status === 'completed'" class="primary-button" type="button" @click="app.openJob(state.currentJob)">阅读分析报告</button>
        <button v-if="state.currentJob.status === 'failed' || state.currentJob.status === 'cancelled'" class="primary-button" type="button" @click="app.reanalyze(state.currentJob)">重新配置分析</button>
      </div>
    </template>

    <EmptyState
      v-else
      title="没有进行中的任务"
      description="提交分析任务后，可以在这里查看服务返回的实时阶段、进度和错误信息。"
      action-label="新建分析"
      @action="app.navigate('new')"
    />
  </section>
</template>
