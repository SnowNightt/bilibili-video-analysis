<script setup lang="ts">
import { DEPTH_LABELS, JOB_STATUS_LABELS, MODE_LABELS } from '../constants/app'
import type { AppController } from '../composables/useAppState'
import { formatDuration } from '../utils/format'
import EmptyState from '../components/EmptyState.vue'

const { app } = defineProps<{ app: AppController }>()
const { state, filteredJobs } = app
</script>

<template>
  <section class="page page-history">
    <header class="page-heading">
      <div><p class="eyebrow">LOCAL ARCHIVE</p><h1>历史报告</h1><p>这里只展示用户真实创建并保存在本机的任务。</p></div>
      <el-button class="primary-button compact" native-type="button" @click="app.navigate('new')">新建分析</el-button>
    </header>

    <div class="toolbar">
      <label class="search-field"><span class="sr-only">搜索报告</span><el-input v-model="state.searchQuery" placeholder="搜索标题或 BV 号" /></label>
      <el-select v-model="state.statusFilter" class="status-filter" aria-label="状态筛选">
        <el-option label="全部状态" value="all" />
        <el-option v-for="(label, value) in JOB_STATUS_LABELS" :key="value" :label="label" :value="value" />
      </el-select>
      <span>{{ filteredJobs.length }} 条记录</span>
    </div>

    <div v-if="filteredJobs.length" class="history-list">
      <article v-for="job in filteredJobs" :key="job.id">
        <div class="history-date"><span>{{ job.createdAt.split('T')[0] || job.createdAt }}</span><small>{{ job.createdAt.split('T')[1]?.slice(0, 5) }}</small></div>
        <div class="history-content"><h2>{{ job.video.title }}</h2><p>{{ job.bvid }} · {{ MODE_LABELS[job.options.mode] }} · {{ DEPTH_LABELS[job.options.depth] }} · {{ formatDuration(job.video.duration) }}</p></div>
        <span class="status-dot" :class="JOB_STATUS_LABELS[job.status]">{{ JOB_STATUS_LABELS[job.status] }}</span>
        <div class="row-actions">
          <el-button native-type="button" @click="app.openJob(job)">{{ job.status === 'completed' ? '查看' : '详情' }}</el-button>
          <el-button native-type="button" @click="app.reanalyze(job)">重新分析</el-button>
          <el-button class="danger-link" native-type="button" @click="app.confirmDeleteJob(job.id)">删除</el-button>
        </div>
      </article>
    </div>

    <EmptyState
      v-else
      :title="state.jobs.length ? '没有匹配的记录' : '还没有分析记录'"
      :description="state.jobs.length ? '调整搜索词或状态筛选后再试。' : '完成一次分析后，任务和报告会出现在这里。'"
      :action-label="state.jobs.length ? undefined : '新建分析'"
      @action="app.navigate('new')"
    />
  </section>
</template>
