<script setup lang="ts">
import { NAV_ITEMS } from '../constants/app'
import type { AppController } from '../composables/useAppState'

const { app } = defineProps<{ app: AppController }>()
const { state, activeJobs } = app
</script>

<template>
  <aside class="sidebar" :class="{ 'sidebar--open': state.sidebarOpen }">
    <div class="brand-block">
      <button class="brand" type="button" @click="app.navigate('new')">省流看</button>
      <span class="local-indicator"><i></i>本地运行</span>
    </div>

    <nav class="primary-nav" aria-label="主导航">
      <button
        v-for="item in NAV_ITEMS"
        :key="item.id"
        type="button"
        :class="{ active: state.currentView === item.id || (state.currentView === 'report' && item.id === 'history') }"
        @click="app.navigate(item.id)"
      >
        <span class="nav-mark">{{ item.eyebrow }}</span>
        <span>{{ item.label }}</span>
        <b v-if="item.id === 'progress' && activeJobs.length">{{ activeJobs.length }}</b>
      </button>
    </nav>

    <div class="sidebar-note">
      <strong>隐私优先</strong>
      <p>凭据交由本地后端安全保存，任务结束后应清理媒体临时文件。</p>
    </div>
  </aside>

  <button
    class="mobile-scrim"
    :class="{ visible: state.sidebarOpen }"
    type="button"
    aria-label="关闭导航"
    @click="state.sidebarOpen = false"
  ></button>
</template>
