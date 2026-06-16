import type {
  AnalysisJob,
  AnalysisOptions,
  AnalysisReport,
  ConversationMessage,
  VideoInfo,
} from '../types/domain'
import { requestJson } from './http'
import { readCollection, writeCollection } from './storage'

const JOBS_KEY = 'streamwise-analysis-jobs-v2'

export function listStoredJobs(): AnalysisJob[] {
  return readCollection<AnalysisJob>(JOBS_KEY)
}

function persistJob(job: AnalysisJob): void {
  const jobs = listStoredJobs()
  const next = [job, ...jobs.filter((item) => item.id !== job.id)]
  writeCollection(JOBS_KEY, next)
}

export async function createAnalysisJob(
  video: VideoInfo,
  options: AnalysisOptions,
): Promise<AnalysisJob> {
  const job = await requestJson<AnalysisJob>('/api/analysis/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video, options }),
  })
  persistJob(job)
  return job
}

export async function refreshAnalysisJob(id: string): Promise<AnalysisJob> {
  const job = await requestJson<AnalysisJob>(`/api/analysis/jobs/${encodeURIComponent(id)}`)
  persistJob(job)
  return job
}

export async function cancelAnalysisJob(id: string): Promise<AnalysisJob> {
  const job = await requestJson<AnalysisJob>(`/api/analysis/jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  })
  persistJob(job)
  return job
}

export async function fetchAnalysisReport(reportId: string): Promise<AnalysisReport> {
  return requestJson<AnalysisReport>(`/api/analysis/reports/${encodeURIComponent(reportId)}`)
}

export async function askReportQuestion(
  reportId: string,
  question: string,
): Promise<ConversationMessage> {
  return requestJson<ConversationMessage>(
    `/api/analysis/reports/${encodeURIComponent(reportId)}/questions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    },
  )
}

export function deleteStoredJob(id: string): void {
  writeCollection(
    JOBS_KEY,
    listStoredJobs().filter((item) => item.id !== id),
  )
}
