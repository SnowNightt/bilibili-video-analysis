export class ApiError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    const desktop = window.desktop
    const resolvedInput = desktop && typeof input === 'string' && input.startsWith('/api')
      ? `${desktop.apiBaseUrl}${input}`
      : input
    const headers = new Headers(init?.headers)
    if (desktop) headers.set('x-bva-token', desktop.apiToken)
    response = await fetch(resolvedInput, { ...init, headers })
  } catch {
    throw new ApiError('无法连接到本地服务，请确认后端服务已经启动。')
  }

  if (!response.ok) {
    let message = `请求失败（${response.status}）`
    try {
      const payload = (await response.json()) as { message?: string }
      if (payload.message) message = payload.message
    } catch {
      // Non-JSON error responses use the status message above.
    }
    throw new ApiError(message, response.status)
  }

  return (await response.json()) as T
}

export function resolveApiAssetUrl(url: string): string {
  return window.desktop && url.startsWith('/api') ? `${window.desktop.apiBaseUrl}${url}` : url
}
