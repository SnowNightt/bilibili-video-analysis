import type {
  AnalysisJob,
  AnalysisOptions,
  AnalysisReport,
  ConversationMessage,
  VideoInfo,
} from '../types/domain'
import { requestJson, resolveApiAssetUrl } from './http'

export function listAnalysisJobs(): Promise<AnalysisJob[]> {
  return requestJson<AnalysisJob[]>('/api/analysis/jobs')
}

export function createAnalysisJob(video: VideoInfo, options: AnalysisOptions): Promise<AnalysisJob> {
  return requestJson<AnalysisJob>('/api/analysis/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video, options }),
  })
}

export function refreshAnalysisJob(id: string): Promise<AnalysisJob> {
  return requestJson<AnalysisJob>(`/api/analysis/jobs/${encodeURIComponent(id)}`)
}

export function cancelAnalysisJob(id: string): Promise<AnalysisJob> {
  return requestJson<AnalysisJob>(`/api/analysis/jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  })
}

function resolveReportAssetUrls(report: AnalysisReport): AnalysisReport {
  return {
    ...report,
    screenshots: report.screenshots.map((screenshot) => ({
      ...screenshot,
      url: resolveApiAssetUrl(screenshot.url),
    })),
  }
}

export async function fetchAnalysisReport(reportId: string): Promise<AnalysisReport> {
  const report = await requestJson<AnalysisReport>(`/api/analysis/reports/${encodeURIComponent(reportId)}`)
  return resolveReportAssetUrls(report)
}

export async function repairAnalysisReportScreenshots(reportId: string): Promise<AnalysisReport> {
  const report = await requestJson<AnalysisReport>(
    `/api/analysis/reports/${encodeURIComponent(reportId)}/screenshots/repair`,
    { method: 'POST' },
  )
  return resolveReportAssetUrls(report)
}

export function askReportQuestion(reportId: string, question: string): Promise<ConversationMessage> {
  return requestJson<ConversationMessage>(
    `/api/analysis/reports/${encodeURIComponent(reportId)}/questions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    },
  )
}

export async function deleteAnalysisJob(id: string): Promise<void> {
  await requestJson<{ ok: true }>(`/api/analysis/jobs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}
