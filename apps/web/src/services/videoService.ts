import type { VideoInfo } from '../types/domain'
import { ApiError, requestJson } from './http'

export function extractBvid(input: string): string | null {
  const match = input.trim().match(/BV[0-9A-Za-z]{10}/i)
  return match?.[0] ?? null
}

export function isValidBvidInput(input: string): boolean {
  const trimmed = input.trim()
  if (/^BV[0-9A-Za-z]{10}$/i.test(trimmed)) return true
  return /^https?:\/\/(?:www\.)?bilibili\.com\/video\/BV[0-9A-Za-z]{10}/i.test(trimmed)
}

export async function fetchVideoInfo(input: string): Promise<VideoInfo> {
  const bvid = extractBvid(input)
  if (!bvid || !isValidBvidInput(input)) throw new ApiError('请输入合法的 BV 号或 Bilibili 视频地址。')

  return requestJson<VideoInfo>(
    `/api/analysis/videos/${encodeURIComponent(bvid)}`,
  )
}
