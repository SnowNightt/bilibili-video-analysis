export {}

declare global {
  interface Window {
    desktop?: {
      isDesktop: true
      apiBaseUrl: string
      apiToken: string
      saveText(defaultName: string, content: string): Promise<boolean>
      exportPdf(defaultName: string): Promise<boolean>
      openDirectory(kind: 'data' | 'cache' | 'logs'): Promise<void>
      getVersion(): Promise<string>
    }
  }
}
