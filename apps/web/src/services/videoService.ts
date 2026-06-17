import type { VideoInfo } from '../types/domain'
import { ApiError, requestJson } from './http'

interface BilibiliViewResponse {
  code: number
  message: string
  data?: {
    bvid: string
    title: string
    pic: string
    pubdate: number
    duration: number
    desc: string
    rights: { is_cooperation?: number }
    owner: { name: string }
    pages: Array<{ cid: number; page: number; part: string; duration: number }>
  }
}

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

  const response = await requestJson<BilibiliViewResponse>(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
  )
  if (response.code !== 0 || !response.data) {
    throw new ApiError(response.message || '未能读取该视频的信息。')
  }

  const data = response.data
  return {
    bvid: data.bvid,
    url: `https://www.bilibili.com/video/${data.bvid}`,
    title: data.title,
    coverUrl: data.pic.replace(/^http:/, 'https:'),
    ownerName: data.owner.name,
    publishedAt: new Date(data.pubdate * 1000).toLocaleString('zh-CN', { hour12: false }),
    duration: data.duration,
    description: data.desc,
    isPublic: true,
    parts: data.pages.map((part) => ({
      cid: part.cid,
      page: part.page,
      title: part.part,
      duration: part.duration,
    })),
  }
}
