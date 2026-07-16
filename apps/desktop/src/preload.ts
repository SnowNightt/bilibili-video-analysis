import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  apiBaseUrl: process.env.BVA_API_URL,
  apiToken: process.env.BVA_API_TOKEN,
  saveText: (defaultName: string, content: string) =>
    ipcRenderer.invoke('desktop:save-text', { defaultName, content }) as Promise<boolean>,
  exportPdf: (defaultName: string) =>
    ipcRenderer.invoke('desktop:export-pdf', { defaultName }) as Promise<boolean>,
  openDirectory: (kind: 'data' | 'cache' | 'logs') =>
    ipcRenderer.invoke('desktop:open-directory', kind) as Promise<void>,
  getVersion: () => ipcRenderer.invoke('desktop:get-version') as Promise<string>,
})
