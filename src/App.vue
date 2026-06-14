<script setup lang="ts">
import AppModals from './components/AppModals.vue'
import AppSidebar from './components/AppSidebar.vue'
import { useAppState } from './composables/useAppState'
import HistoryView from './views/HistoryView.vue'
import ModelsView from './views/ModelsView.vue'
import NewAnalysisView from './views/NewAnalysisView.vue'
import ProgressView from './views/ProgressView.vue'
import ReportView from './views/ReportView.vue'

const app = useAppState()
</script>

<template>
  <div class="app-shell">
    <AppSidebar :app="app" />

    <main class="workspace">
      <header class="mobile-header">
        <button type="button" class="menu-button" @click="app.state.sidebarOpen = true">菜单</button>
        <button type="button" class="mobile-brand" @click="app.navigate('new')">省流看</button>
        <span>{{ app.currentPageTitle.value }}</span>
      </header>

      <NewAnalysisView v-if="app.state.currentView === 'new'" :app="app" />
      <ProgressView v-else-if="app.state.currentView === 'progress'" :app="app" />
      <HistoryView v-else-if="app.state.currentView === 'history'" :app="app" />
      <ModelsView v-else-if="app.state.currentView === 'models'" :app="app" />
      <ReportView v-else :app="app" />
    </main>

    <div v-if="app.state.toast" class="toast" :class="app.state.toast.tone" role="status">
      {{ app.state.toast.text }}
    </div>

    <AppModals :app="app" />
  </div>
</template>
