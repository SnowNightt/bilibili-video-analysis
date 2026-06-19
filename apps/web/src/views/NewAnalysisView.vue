<script setup lang="ts">
import { computed } from 'vue'
import {
  ANALYSIS_DEPTHS,
  ANALYSIS_MODES,
  CAPABILITY_LABELS,
  DEPTH_LABELS,
  MODE_LABELS,
} from '../constants/app'
import type { AppController } from '../composables/useAppState'
import type { ModelCapability } from '../types/domain'
import { formatDuration } from '../utils/format'
import EmptyState from '../components/EmptyState.vue'

const { app } = defineProps<{ app: AppController }>()
const {
  state,
  isValidBvid,
  estimate,
  requiredCapabilities,
  missingCapabilities,
  completedJobs,
} = app

const allPartsSelected = computed(
  () =>
    Boolean(state.currentVideo?.parts.length) &&
    state.currentVideo?.parts.every((part) => state.selectedPartCids.includes(part.cid)),
)

function modelsFor(capability: ModelCapability) {
  return state.modelConfigs.filter((model) => model.capability === capability)
}
</script>

<template>
  <section class="page page-new">
    <header class="page-heading">
      <div>
        <p class="eyebrow">NEW ANALYSIS</p>
        <h1>新建视频分析</h1>
        <p>粘贴 Bilibili 公开视频链接或 BV 号，生成一次深度分析。</p>
      </div>
      <button class="text-button" type="button" @click="app.navigate('models')">管理模型</button>
    </header>

    <div class="video-input-row">
      <label class="input-wrap" :class="{ invalid: state.inputTouched && !isValidBvid }">
        <span class="sr-only">Bilibili 视频链接或 BV 号</span>
        <input
          v-model="state.bvidInput"
          type="text"
          placeholder="输入 BV 号或完整视频地址"
          @input="state.inputTouched = false"
          @keyup.enter="app.loadVideo"
        />
        <span v-if="isValidBvid" class="input-status valid">格式正确</span>
        <span v-else-if="state.inputTouched" class="input-status error">格式不正确</span>
      </label>
      <button class="primary-button read-button" type="button" :disabled="state.videoLoading" @click="app.loadVideo">
        {{ state.videoLoading ? '读取中…' : '读取视频' }}
      </button>
    </div>
    <p class="input-help">支持 B 站 BV 号或完整视频链接；仅处理公开且免登录的视频。</p>

    <div v-if="state.videoLoading" class="loading-video" role="status">
      <span></span><p>正在从 Bilibili 读取视频信息…</p>
    </div>

    <div v-else-if="state.currentVideo" class="analysis-layout">
      <section class="video-column" aria-labelledby="video-title">
        <div class="cover-wrap">
          <img
            :src="state.currentVideo.coverUrl"
            :alt="`${state.currentVideo.title}视频封面`"
            referrerpolicy="no-referrer"
          />
          <span class="duration-badge">{{ formatDuration(state.currentVideo.duration) }}</span>
        </div>
        <h2 id="video-title">{{ state.currentVideo.title }}</h2>
        <dl class="metadata-line">
          <div><dt>UP 主</dt><dd>{{ state.currentVideo.ownerName }}</dd></div>
          <div><dt>时长</dt><dd>{{ formatDuration(state.currentVideo.duration) }}</dd></div>
          <div><dt>发布</dt><dd>{{ state.currentVideo.publishedAt }}</dd></div>
          <div><dt>状态</dt><dd class="public-state">{{ state.currentVideo.isPublic ? '公开' : '不可用' }}</dd></div>
        </dl>
        <p class="video-description">{{ state.currentVideo.description || '该视频没有提供简介。' }}</p>

        <fieldset class="part-picker">
          <legend>分 P 选择</legend>
          <div>
            <button type="button" :class="{ active: allPartsSelected }" @click="app.selectAllParts(!allPartsSelected)">
              全部（{{ state.currentVideo.parts.length }}P）
            </button>
            <button
              v-for="part in state.currentVideo.parts"
              :key="part.cid"
              type="button"
              :class="{ active: state.selectedPartCids.includes(part.cid) }"
              @click="app.togglePart(part.cid)"
            >
              P{{ part.page }} {{ part.title }} · {{ formatDuration(part.duration) }}
            </button>
          </div>
        </fieldset>
      </section>

      <section class="config-column" aria-label="分析配置">
        <div class="config-section">
          <div class="section-title-row"><h3>分析模式</h3><span class="help-dot" title="失败后不会自动切换模式">?</span></div>
          <div class="mode-grid">
            <label
              v-for="mode in ANALYSIS_MODES"
              :key="mode.id"
              :class="{ selected: state.selectedMode === mode.id }"
            >
              <input v-model="state.selectedMode" type="radio" :value="mode.id" @change="app.syncDefaultModels" />
              <span class="radio-ui"></span>
              <span><strong>{{ mode.title }}</strong><small>{{ mode.description }}</small></span>
            </label>
          </div>
        </div>

        <div class="config-section depth-section">
          <div class="section-title-row"><h3>分析深度</h3><span class="help-dot" title="深度越高，耗时和调用成本通常越高">?</span></div>
          <div class="depth-grid">
            <label
              v-for="depth in ANALYSIS_DEPTHS"
              :key="depth.id"
              :class="{ selected: state.selectedDepth === depth.id }"
            >
              <input v-model="state.selectedDepth" type="radio" :value="depth.id" />
              <span class="radio-ui"></span>
              <span><strong>{{ depth.title }}</strong><small>{{ depth.description }}</small></span>
            </label>
          </div>
        </div>

        <div class="config-section option-section">
          <div class="section-title-row"><h3>分析选项</h3><span class="help-dot" title="关闭截图可减少处理步骤">?</span></div>
          <div class="switch-grid">
            <label>
              <span><strong>生成关键截图</strong><small>提取关键画面辅助理解</small></span>
              <input v-model="state.screenshotsEnabled" type="checkbox" @change="app.syncDefaultModels" /><span class="switch-ui"></span>
            </label>
            <label>
              <span><strong>保留时间戳</strong><small>报告内容关联原始时间位置</small></span>
              <input v-model="state.timestampsEnabled" type="checkbox" /><span class="switch-ui"></span>
            </label>
          </div>
        </div>

        <div class="config-section model-section">
          <div class="section-title-row">
            <div><h3>本次使用模型</h3><p>从“模型管理”中已保存的配置里选择。</p></div>
            <button class="text-button small" type="button" @click="app.navigate('models')">管理模型</button>
          </div>
          <div v-if="state.modelConfigs.length === 0" class="inline-empty">
            尚未配置模型。开始分析前需要添加对应能力的模型配置。
          </div>
          <div v-for="capability in requiredCapabilities" :key="capability" class="model-row model-row--single">
            <label :for="`model-${capability}`">{{ CAPABILITY_LABELS[capability] }}</label>
            <select :id="`model-${capability}`" v-model="state.selectedModelIds[capability]">
              <option value="">请选择模型</option>
              <option v-for="model in modelsFor(capability)" :key="model.id" :value="model.id">
                {{ model.name }} · {{ model.modelName }}
              </option>
            </select>
          </div>
          <p v-if="missingCapabilities.length" class="field-warning">
            尚缺：{{ missingCapabilities.map((item) => CAPABILITY_LABELS[item]).join('、') }}
          </p>
          <button class="advanced-toggle" type="button" @click="state.showAdvanced = !state.showAdvanced">
            {{ state.showAdvanced ? '收起高级设置' : '展开高级设置' }}
          </button>
          <div v-if="state.showAdvanced" class="advanced-grid">
            <label>输出语言<select v-model="state.outputLanguage"><option>简体中文</option><option>English</option></select></label>
            <label>最大截图数量<input v-model.number="state.maxScreenshots" type="number" min="0" max="20" /></label>
          </div>
        </div>

        <div class="estimate-panel">
          <div class="estimate-number"><span>预计耗时</span><strong>{{ estimate }}</strong><small>根据模式与深度粗略估算</small></div>
          <div class="cost-note"><strong>模型消耗提醒</strong><p>实际费用由所选模型和视频长度决定。系统不会自动切换模式或产生未经确认的额外调用。</p></div>
        </div>

        <div class="action-row">
          <button class="primary-button" type="button" @click="app.requestStartAnalysis">确认并开始分析</button>
        </div>
      </section>
    </div>

    <EmptyState
      v-else
      title="等待视频"
      description="输入公开的 Bilibili 视频地址或 BV 号后，这里会展示真实的视频信息和分析配置。"
    />

    <section class="recent-section">
      <div class="section-heading"><h2>最近完成的报告</h2><button type="button" class="text-button" @click="app.navigate('history')">查看全部历史报告</button></div>
      <div v-if="completedJobs.length" class="table-wrap">
        <table>
          <thead><tr><th>视频</th><th>模式</th><th>深度</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="job in completedJobs.slice(0, 3)" :key="job.id">
              <td><strong>{{ job.video.title }}</strong></td>
              <td>{{ MODE_LABELS[job.options.mode] }}</td>
              <td>{{ DEPTH_LABELS[job.options.depth] }}</td>
              <td><span class="status-dot 已完成">已完成</span></td>
              <td>{{ job.createdAt }}</td>
              <td><button type="button" class="table-link" @click="app.openJob(job)">查看报告</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="inline-empty">还没有已完成的分析报告。</div>
    </section>
  </section>
</template>
