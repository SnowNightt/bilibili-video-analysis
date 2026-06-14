export function readCollection<T>(key: string): T[] {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

export function writeCollection<T>(key: string, value: T[]): void {
  window.localStorage.setItem(key, JSON.stringify(value))
}
