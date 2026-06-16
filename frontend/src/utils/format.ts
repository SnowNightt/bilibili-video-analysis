export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)
  const base = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return hours > 0 ? `${hours}:${base}` : base
}

export function timestampUrl(videoUrl: string, seconds: number): string {
  const separator = videoUrl.includes('?') ? '&' : '?'
  return `${videoUrl}${separator}t=${Math.floor(seconds)}`
}
