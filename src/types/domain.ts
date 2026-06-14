export type ViewName = 'new' | 'progress' | 'history' | 'models' | 'report'
export type AnalysisMode = 'subtitle' | 'multimodal'
export type AnalysisDepth = 'quick' | 'standard' | 'deep'
export type JobStatus =
  | 'waiting'
  | 'fetching_video'
  | 'fetching_subtitle'
  | 'extracting_audio'
  | 'transcribing'
  | 'extracting_frames'
  | 'analyzing'
  | 'generating_report'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type ModelCapability = 'text' | 'asr' | 'image' | 'video'
export type ModelStatus = 'available' | 'untested' | 'unavailable'
export type ToastTone = 'success' | 'warning' | 'neutral'

export interface VideoPart {
  cid: number
  page: number
  title: string
  duration: number
}

export interface VideoInfo {
  bvid: string
  url: string
  title: string
  coverUrl: string
  ownerName: string
  publishedAt: string
  duration: number
  description: string
  isPublic: boolean
  parts: VideoPart[]
}

export interface ModelConfig {
  id: string
  name: string
  provider: string
  baseUrl: string
  modelName: string
  capability: ModelCapability
  timeoutSeconds: number
  maxConcurrency: number
  isDefault: boolean
  status: ModelStatus
  apiKeyConfigured: boolean
  createdAt: string
  updatedAt: string
}

export interface ModelConfigDraft {
  id?: string
  name: string
  provider: string
  baseUrl: string
  apiKey: string
  modelName: string
  capability: ModelCapability
  timeoutSeconds: number
  maxConcurrency: number
  isDefault: boolean
  apiKeyConfigured?: boolean
}

export interface AnalysisOptions {
  mode: AnalysisMode
  depth: AnalysisDepth
  generateScreenshots: boolean
  keepTimestamps: boolean
  outputLanguage: string
  maxScreenshots: number
  selectedPartCids: number[]
  modelProfileIds: Partial<Record<ModelCapability, string>>
}

export interface AnalysisJob {
  id: string
  bvid: string
  video: VideoInfo
  options: AnalysisOptions
  status: JobStatus
  progress: number
  currentStage: string
  errorMessage?: string
  createdAt: string
  completedAt?: string
  reportId?: string
}

export interface ReportChapter {
  title: string
  startSeconds: number
  summary: string
}

export interface ReportPoint {
  title: string
  detail: string
}

export interface ReportScreenshot {
  url: string
  timestampSeconds: number
  description: string
}

export interface AnalysisReport {
  id: string
  jobId: string
  video: VideoInfo
  createdAt: string
  summary: string
  overview: string
  chapters: ReportChapter[]
  keyPoints: ReportPoint[]
  facts: string[]
  conclusion: string
  screenshots: ReportScreenshot[]
  recommendedSegments: ReportChapter[]
  confidenceNotes: string
}

export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string
}

export interface ToastMessage {
  text: string
  tone: ToastTone
}
