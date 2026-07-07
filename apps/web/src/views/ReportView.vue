<script setup lang="ts">
import type { AppController } from '../composables/useAppState'
import { formatDuration, timestampUrl } from '../utils/format'
import EmptyState from '../components/EmptyState.vue'

const { app } = defineProps<{ app: AppController }>()
const { state } = app
</script>

<template>
  <section class="page page-report">
    <template v-if="state.currentReport">
      <header class="report-header">
        <div><el-button class="back-link" native-type="button" @click="app.navigate('history')">返回历史报告</el-button><p class="eyebrow">ANALYSIS REPORT</p><h1>{{ state.currentReport.video.title }}</h1><p>生成于 {{ state.currentReport.createdAt }}</p></div>
        <div class="report-actions"><el-button class="secondary-button" native-type="button" @click="app.exportCurrentReport">导出 TXT</el-button><el-button class="primary-button" native-type="button" @click="app.printCurrentReport">导出 PDF</el-button></div>
      </header>

      <div class="report-layout">
        <aside class="report-toc"><strong>报告目录</strong><a href="#summary">一句话省流</a><a href="#overview">内容概览</a><a href="#chapters">章节时间线</a><a href="#points">核心观点</a><a href="#screenshots">关键截图</a><a href="#evidence">事实与案例</a><a href="#confidence">可信度提示</a></aside>
        <article class="report-body">
          <img
            class="report-cover"
            :src="state.currentReport.video.coverUrl"
            :alt="`${state.currentReport.video.title}视频封面`"
            referrerpolicy="no-referrer"
          />
          <section id="summary" class="report-lead"><span>一句话省流</span><h2>{{ state.currentReport.summary }}</h2></section>
          <section id="overview"><h2>内容概览</h2><p>{{ state.currentReport.overview }}</p></section>
          <section id="chapters"><h2>章节时间线</h2><ol class="chapter-list"><li v-for="chapter in state.currentReport.chapters" :key="`${chapter.startSeconds}-${chapter.title}`"><a :href="timestampUrl(state.currentReport.video.url, chapter.startSeconds)" target="_blank">{{ formatDuration(chapter.startSeconds) }}</a><div><strong>{{ chapter.title }}</strong><p>{{ chapter.summary }}</p></div></li></ol></section>
          <section id="points"><h2>核心观点</h2><ul class="point-list"><li v-for="point in state.currentReport.keyPoints" :key="point.title"><strong>{{ point.title }}</strong><p>{{ point.detail }}</p></li></ul></section>
          <section id="screenshots" v-if="state.currentReport.screenshots.length"><h2>关键截图</h2><div class="screenshot-grid"><figure v-for="screenshot in state.currentReport.screenshots" :key="`${screenshot.timestampSeconds}-${screenshot.url}`"><img :src="screenshot.url" :alt="screenshot.description" referrerpolicy="no-referrer" /><figcaption><a :href="timestampUrl(state.currentReport.video.url, screenshot.timestampSeconds)" target="_blank">{{ formatDuration(screenshot.timestampSeconds) }}</a><span>{{ screenshot.description }}</span></figcaption></figure></div></section>
          <section id="evidence"><h2>重要事实与案例</h2><ul class="fact-list"><li v-for="fact in state.currentReport.facts" :key="fact">{{ fact }}</li></ul><p v-if="!state.currentReport.facts.length">报告没有提取到可确认的事实或案例。</p></section>
          <section v-if="state.currentReport.conclusion"><h2>作者结论或立场</h2><p>{{ state.currentReport.conclusion }}</p></section>
          <section id="confidence" class="confidence-box"><h2>内容可信度提示</h2><p>{{ state.currentReport.confidenceNotes }}</p></section>
        </article>
        <aside class="qa-panel"><div class="qa-heading"><strong>继续追问</strong><span>依据当前视频回答</span></div><div class="conversation"><div v-for="message in state.conversation" :key="message.id" :class="['message', message.role]"><span>{{ message.role === 'user' ? '你' : '省流看' }}</span><p>{{ message.text }}</p></div><p v-if="!state.conversation.length" class="conversation-empty">尚未开始追问。</p></div><form @submit.prevent="app.submitQuestion"><el-input v-model="state.question" class="qa-textarea" type="textarea" :rows="3" placeholder="输入关于当前视频的问题" /><el-button class="primary-button" native-type="submit" :disabled="state.busy">发送问题</el-button></form></aside>
      </div>
    </template>

    <EmptyState
      v-else
      title="没有可显示的报告"
      description="请选择一条已完成且包含报告的分析记录。"
      action-label="返回历史报告"
      @action="app.navigate('history')"
    />
  </section>
</template>
