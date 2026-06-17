import type {
  AnalysisDepth,
  AnalysisMode,
  JobStatus,
  ModelCapability,
  ViewName,
} from '../types/domain'

export const NAV_ITEMS: Array<{ id: ViewName; label: string; eyebrow: string }> = [
  { id: 'new', label: '新建分析', eyebrow: 'NEW' },
  { id: 'progress', label: '进行中', eyebrow: 'JOBS' },
  { id: 'history', label: '历史报告', eyebrow: 'ARCHIVE' },
  { id: 'models', label: '模型管理', eyebrow: 'MODELS' },
]

export const VIEW_TITLES: Record<ViewName, string> = {
  new: '新建视频分析',
  progress: '任务进度',
  history: '历史报告',
  models: '模型管理',
  report: '分析报告',
}

export const ANALYSIS_MODES: Array<{
  id: AnalysisMode
  title: string
  description: string
}> = [
  {
    id: 'subtitle',
    title: '字幕优先 + ASR',
    description: '优先使用公开字幕，缺失时调用 ASR 补全，适合语言信息密集的视频。',
  },
  {
    id: 'multimodal',
    title: '整段视频多模态',
    description: '综合画面、字幕和音频进行理解，适合操作演示与视觉信息密集内容。',
  },
]

export const ANALYSIS_DEPTHS: Array<{
  id: AnalysisDepth
  title: string
  description: string
}> = [
  { id: 'quick', title: '快速', description: '提取结论与章节结构' },
  { id: 'standard', title: '标准', description: '平衡分析速度与内容质量' },
  { id: 'deep', title: '深度', description: '生成更全面的理解与洞察' },
]

export const MODE_LABELS: Record<AnalysisMode, string> = {
  subtitle: '字幕优先 + ASR',
  multimodal: '整段视频多模态',
}

export const DEPTH_LABELS: Record<AnalysisDepth, string> = {
  quick: '快速',
  standard: '标准',
  deep: '深度',
}

export const CAPABILITY_LABELS: Record<ModelCapability, string> = {
  text: '文本总结',
  asr: 'ASR 识别',
  image: '图片理解',
  video: '视频理解',
}

export const MODEL_PROVIDERS = [
  '硅基流动',
  '阿里云百炼',
  '火山方舟',
  'DeepSeek',
  '智谱 AI',
  'Moonshot',
  '自定义 OpenAI 兼容接口',
]

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  waiting: '等待处理',
  fetching_video: '获取视频信息',
  fetching_subtitle: '获取字幕',
  extracting_audio: '提取音频',
  transcribing: '语音转写',
  extracting_frames: '提取关键帧',
  analyzing: '模型分析',
  generating_report: '生成报告',
  completed: '已完成',
  failed: '已失败',
  cancelled: '已取消',
}

export const PROGRESS_STEPS: Array<{ status: JobStatus; label: string }> = [
  { status: 'fetching_video', label: '获取视频信息' },
  { status: 'fetching_subtitle', label: '获取公开字幕' },
  { status: 'transcribing', label: '语音转写补全' },
  { status: 'extracting_frames', label: '提取关键帧' },
  { status: 'analyzing', label: '模型分析' },
  { status: 'generating_report', label: '生成结构化报告' },
  { status: 'completed', label: '分析完成' },
]

export function estimateDuration(mode: AnalysisMode, depth: AnalysisDepth): string {
  const estimates: Record<AnalysisMode, Record<AnalysisDepth, string>> = {
    subtitle: { quick: '3–5 分钟', standard: '8–12 分钟', deep: '18–25 分钟' },
    multimodal: { quick: '6–9 分钟', standard: '16–24 分钟', deep: '30–45 分钟' },
  }
  return estimates[mode][depth]
}
