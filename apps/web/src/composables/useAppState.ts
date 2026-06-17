import { computed, onScopeDispose, reactive } from 'vue'
import {
  CAPABILITY_LABELS,
  DEPTH_LABELS,
  JOB_STATUS_LABELS,
  MODE_LABELS,
  VIEW_TITLES,
  estimateDuration,
} from '../constants/app'
import {
  askReportQuestion,
  cancelAnalysisJob,
  createAnalysisJob,
  deleteStoredJob,
  fetchAnalysisReport,
  listStoredJobs,
  refreshAnalysisJob,
} from '../services/analysisService'
import {
  deleteModelConfig,
  fetchModelConfigs,
  listModelConfigs,
  testAndSaveModelConfig,
} from '../services/modelService'
import { fetchVideoInfo, isValidBvidInput } from '../services/videoService'
import type {
  AnalysisDepth,
  AnalysisJob,
  AnalysisMode,
  AnalysisReport,
  ConversationMessage,
  JobStatus,
  ModelCapability,
  ModelConfig,
  ModelConfigDraft,
  ToastMessage,
  VideoInfo,
  ViewName,
} from '../types/domain'

const ACTIVE_JOB_STATUSES: JobStatus[] = [
  'waiting',
  'fetching_video',
  'fetching_subtitle',
  'extracting_audio',
  'transcribing',
  'extracting_frames',
  'analyzing',
  'generating_report',
]

export function useAppState() {
  const state = reactive({
    currentView: 'new' as ViewName,
    sidebarOpen: false,
    bvidInput: '',
    inputTouched: false,
    videoLoading: false,
    currentVideo: null as VideoInfo | null,
    selectedMode: 'subtitle' as AnalysisMode,
    selectedDepth: 'standard' as AnalysisDepth,
    screenshotsEnabled: true,
    timestampsEnabled: true,
    selectedPartCids: [] as number[],
    outputLanguage: '简体中文',
    maxScreenshots: 12,
    selectedModelIds: {} as Partial<Record<ModelCapability, string>>,
    modelConfigs: listModelConfigs(),
    jobs: listStoredJobs(),
    currentJob: null as AnalysisJob | null,
    currentReport: null as AnalysisReport | null,
    conversation: [] as ConversationMessage[],
    question: '',
    searchQuery: '',
    statusFilter: 'all',
    modelProviderFilter: 'all',
    showStartConfirm: false,
    showAdvanced: false,
    showModelModal: false,
    editingModel: null as ModelConfig | null,
    deletingJobId: null as string | null,
    busy: false,
    toast: null as ToastMessage | null,
  })

  let toastTimer: number | undefined
  let pollingTimer: number | undefined

  const isValidBvid = computed(() => isValidBvidInput(state.bvidInput))
  const currentPageTitle = computed(() => VIEW_TITLES[state.currentView])
  const modeLabel = computed(() => MODE_LABELS[state.selectedMode])
  const depthLabel = computed(() => DEPTH_LABELS[state.selectedDepth])
  const estimate = computed(() => estimateDuration(state.selectedMode, state.selectedDepth))
  const activeJobs = computed(() => state.jobs.filter((job) => ACTIVE_JOB_STATUSES.includes(job.status)))
  const completedJobs = computed(() => state.jobs.filter((job) => job.status === 'completed'))
  const filteredJobs = computed(() => {
    const query = state.searchQuery.trim().toLowerCase()
    return state.jobs.filter((job) => {
      const matchesQuery =
        !query ||
        job.video.title.toLowerCase().includes(query) ||
        job.bvid.toLowerCase().includes(query)
      const matchesStatus = state.statusFilter === 'all' || job.status === state.statusFilter
      return matchesQuery && matchesStatus
    })
  })
  const filteredModels = computed(() => {
    if (state.modelProviderFilter === 'all') return state.modelConfigs
    return state.modelConfigs.filter((model) => model.provider === state.modelProviderFilter)
  })
  const requiredCapabilities = computed<ModelCapability[]>(() => {
    if (state.selectedMode === 'multimodal') return ['video']
    return state.screenshotsEnabled ? ['text', 'asr', 'image'] : ['text', 'asr']
  })
  const missingCapabilities = computed(() =>
    requiredCapabilities.value.filter((capability) => !state.selectedModelIds[capability]),
  )
  const canStartAnalysis = computed(
    () => Boolean(state.currentVideo) && missingCapabilities.value.length === 0 && !state.busy,
  )

  function notify(text: string, tone: ToastMessage['tone'] = 'neutral') {
    state.toast = { text, tone }
    if (toastTimer) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      state.toast = null
    }, 3200)
  }

  function navigate(view: ViewName) {
    state.currentView = view
    state.sidebarOpen = false
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function resetVideo() {
    state.currentVideo = null
    state.selectedPartCids = []
  }

  async function loadVideo() {
    state.inputTouched = true
    if (!isValidBvid.value) {
      resetVideo()
      notify('请输入合法的 BV 号或 Bilibili 视频地址。', 'warning')
      return
    }

    state.videoLoading = true
    resetVideo()
    try {
      const video = await fetchVideoInfo(state.bvidInput)
      state.currentVideo = video
      state.bvidInput = video.bvid
      state.selectedPartCids = video.parts.map((part) => part.cid)
      notify('视频信息读取完成。', 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : '视频信息读取失败。', 'warning')
    } finally {
      state.videoLoading = false
    }
  }

  function selectAllParts(selected: boolean) {
    if (!state.currentVideo) return
    state.selectedPartCids = selected ? state.currentVideo.parts.map((part) => part.cid) : []
  }

  function togglePart(cid: number) {
    state.selectedPartCids = state.selectedPartCids.includes(cid)
      ? state.selectedPartCids.filter((item) => item !== cid)
      : [...state.selectedPartCids, cid]
  }

  function syncDefaultModels() {
    for (const capability of requiredCapabilities.value) {
      const selected = state.selectedModelIds[capability]
      const selectedStillExists = state.modelConfigs.some(
        (model) => model.id === selected && model.capability === capability,
      )
      if (selectedStillExists) continue
      const fallback =
        state.modelConfigs.find((model) => model.capability === capability && model.isDefault) ??
        state.modelConfigs.find((model) => model.capability === capability)
      if (fallback) state.selectedModelIds[capability] = fallback.id
      else delete state.selectedModelIds[capability]
    }
  }

  function upsertModelConfig(config: ModelConfig) {
    state.modelConfigs = [
      config,
      ...state.modelConfigs
        .filter((item) => item.id !== config.id)
        .map((item) =>
          config.isDefault && item.capability === config.capability
            ? { ...item, isDefault: false }
            : item,
        ),
    ]
  }

  async function refreshModelConfigs(showError = false) {
    try {
      state.modelConfigs = await fetchModelConfigs()
      syncDefaultModels()
    } catch (error) {
      if (showError) {
        notify(error instanceof Error ? error.message : '模型配置同步失败。', 'warning')
      }
    }
  }

  function requestStartAnalysis() {
    syncDefaultModels()
    if (!state.currentVideo) {
      notify('请先读取视频信息。', 'warning')
      return
    }
    if (state.selectedPartCids.length === 0) {
      notify('请至少选择一个分 P。', 'warning')
      return
    }
    if (missingCapabilities.value.length > 0) {
      const names = missingCapabilities.value.map((item) => CAPABILITY_LABELS[item]).join('、')
      notify(`请先配置并选择${names}模型。`, 'warning')
      return
    }
    state.showStartConfirm = true
  }

  async function startAnalysis() {
    if (!state.currentVideo || !canStartAnalysis.value) return
    state.busy = true
    try {
      const job = await createAnalysisJob(state.currentVideo, {
        mode: state.selectedMode,
        depth: state.selectedDepth,
        generateScreenshots: state.screenshotsEnabled,
        keepTimestamps: state.timestampsEnabled,
        outputLanguage: state.outputLanguage,
        maxScreenshots: state.maxScreenshots,
        selectedPartCids: state.selectedPartCids,
        modelProfileIds: { ...state.selectedModelIds },
      })
      state.showStartConfirm = false
      state.currentJob = job
      upsertJob(job)
      navigate('progress')
      startPolling()
    } catch (error) {
      notify(error instanceof Error ? error.message : '分析任务创建失败。', 'warning')
    } finally {
      state.busy = false
    }
  }

  function upsertJob(job: AnalysisJob) {
    state.jobs = [job, ...state.jobs.filter((item) => item.id !== job.id)]
  }

  function startPolling() {
    stopPolling()
    if (!state.currentJob || !ACTIVE_JOB_STATUSES.includes(state.currentJob.status)) return
    pollingTimer = window.setInterval(() => void refreshCurrentJob(), 2000)
  }

  function stopPolling() {
    if (pollingTimer) window.clearInterval(pollingTimer)
    pollingTimer = undefined
  }

  async function refreshCurrentJob() {
    if (!state.currentJob) return
    try {
      const job = await refreshAnalysisJob(state.currentJob.id)
      state.currentJob = job
      upsertJob(job)
      if (!ACTIVE_JOB_STATUSES.includes(job.status)) {
        stopPolling()
        if (job.status === 'completed') notify('报告已生成。', 'success')
      }
    } catch (error) {
      stopPolling()
      notify(error instanceof Error ? error.message : '任务状态更新失败。', 'warning')
    }
  }

  async function cancelCurrentJob() {
    if (!state.currentJob) return
    state.busy = true
    try {
      const job = await cancelAnalysisJob(state.currentJob.id)
      state.currentJob = job
      upsertJob(job)
      stopPolling()
      notify('任务已取消。', 'neutral')
    } catch (error) {
      notify(error instanceof Error ? error.message : '任务取消失败。', 'warning')
    } finally {
      state.busy = false
    }
  }

  async function openJob(job: AnalysisJob) {
    state.currentJob = job
    if (ACTIVE_JOB_STATUSES.includes(job.status)) {
      navigate('progress')
      startPolling()
      return
    }
    if (job.status !== 'completed' || !job.reportId) {
      navigate('progress')
      return
    }

    state.busy = true
    try {
      state.currentReport = await fetchAnalysisReport(job.reportId)
      state.conversation = []
      navigate('report')
    } catch (error) {
      notify(error instanceof Error ? error.message : '报告读取失败。', 'warning')
    } finally {
      state.busy = false
    }
  }

  function reanalyze(job: AnalysisJob) {
    state.bvidInput = job.bvid
    state.currentVideo = job.video
    state.selectedMode = job.options.mode
    state.selectedDepth = job.options.depth
    state.screenshotsEnabled = job.options.generateScreenshots
    state.timestampsEnabled = job.options.keepTimestamps
    state.outputLanguage = job.options.outputLanguage
    state.maxScreenshots = job.options.maxScreenshots
    state.selectedPartCids = [...job.options.selectedPartCids]
    state.selectedModelIds = { ...job.options.modelProfileIds }
    navigate('new')
  }

  function confirmDeleteJob(id: string) {
    state.deletingJobId = id
  }

  function deleteJob() {
    if (!state.deletingJobId) return
    deleteStoredJob(state.deletingJobId)
    state.jobs = state.jobs.filter((item) => item.id !== state.deletingJobId)
    if (state.currentJob?.id === state.deletingJobId) state.currentJob = null
    state.deletingJobId = null
    notify('历史记录已删除。', 'success')
  }

  function openModelEditor(model?: ModelConfig) {
    state.editingModel = model ?? null
    state.showModelModal = true
  }

  async function submitModel(draft: ModelConfigDraft) {
    state.busy = true
    try {
      const saved = await testAndSaveModelConfig(draft)
      upsertModelConfig(saved)
      state.showModelModal = false
      state.editingModel = null
      syncDefaultModels()
      notify('连接测试通过，模型配置已保存。', 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : '模型连接测试失败。', 'warning')
    } finally {
      state.busy = false
    }
  }

  async function removeModel(id: string) {
    state.busy = true
    try {
      await deleteModelConfig(id)
      state.modelConfigs = state.modelConfigs.filter((item) => item.id !== id)
      for (const capability of Object.keys(state.selectedModelIds) as ModelCapability[]) {
        if (state.selectedModelIds[capability] === id) delete state.selectedModelIds[capability]
      }
      notify('模型配置已删除。', 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : '模型配置删除失败。', 'warning')
    } finally {
      state.busy = false
    }
  }

  async function submitQuestion() {
    const value = state.question.trim()
    if (!value || !state.currentReport) return
    const userMessage: ConversationMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: value,
      createdAt: new Date().toISOString(),
    }
    state.conversation.push(userMessage)
    state.question = ''
    state.busy = true
    try {
      const answer = await askReportQuestion(state.currentReport.id, value)
      state.conversation.push(answer)
    } catch (error) {
      notify(error instanceof Error ? error.message : '追问失败。', 'warning')
    } finally {
      state.busy = false
    }
  }

  function exportCurrentReport() {
    const report = state.currentReport
    if (!report) return
    const chapterText = report.chapters
      .map((chapter) => `${chapter.title}\n${chapter.summary}`)
      .join('\n\n')
    const pointsText = report.keyPoints.map((point) => `${point.title}\n${point.detail}`).join('\n\n')
    const content = [
      report.video.title,
      report.video.url,
      '',
      '一句话省流',
      report.summary,
      '',
      '内容概览',
      report.overview,
      '',
      '章节时间线',
      chapterText,
      '',
      '核心观点',
      pointsText,
      '',
      '可信度提示',
      report.confidenceNotes,
    ].join('\n')
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${report.video.title}-分析报告.txt`
    link.click()
    URL.revokeObjectURL(url)
  }

  function printCurrentReport() {
    if (!state.currentReport) return
    window.print()
  }

  onScopeDispose(() => {
    stopPolling()
    if (toastTimer) window.clearTimeout(toastTimer)
  })

  syncDefaultModels()
  void refreshModelConfigs()
  const initialActiveJob = state.jobs.find((job) => ACTIVE_JOB_STATUSES.includes(job.status))
  if (initialActiveJob) {
    state.currentJob = initialActiveJob
    startPolling()
    void refreshCurrentJob()
  }

  return {
    state,
    isValidBvid,
    currentPageTitle,
    modeLabel,
    depthLabel,
    estimate,
    activeJobs,
    completedJobs,
    filteredJobs,
    filteredModels,
    requiredCapabilities,
    missingCapabilities,
    canStartAnalysis,
    statusLabel: (status: JobStatus) => JOB_STATUS_LABELS[status],
    notify,
    navigate,
    loadVideo,
    selectAllParts,
    togglePart,
    syncDefaultModels,
    requestStartAnalysis,
    startAnalysis,
    refreshCurrentJob,
    cancelCurrentJob,
    openJob,
    reanalyze,
    confirmDeleteJob,
    deleteJob,
    openModelEditor,
    submitModel,
    removeModel,
    refreshModelConfigs,
    submitQuestion,
    exportCurrentReport,
    printCurrentReport,
  }
}

export type AppController = ReturnType<typeof useAppState>
