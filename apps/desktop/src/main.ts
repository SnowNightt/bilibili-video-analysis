import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  Notification,
  powerSaveBlocker,
  protocol,
  safeStorage,
  session,
  shell,
  utilityProcess,
  type UtilityProcess,
} from 'electron'
import log from 'electron-log/main'
import squirrelStartup from 'electron-squirrel-startup'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
])

const ACTIVE_STATUSES = new Set([
  'waiting',
  'fetching_video',
  'fetching_subtitle',
  'extracting_audio',
  'transcribing',
  'extracting_frames',
  'analyzing',
  'generating_report',
])

interface DesktopJob {
  id: string
  status: string
  video: { title: string }
}

interface ApiMessage {
  type: 'ready' | 'error'
  url?: string
  message?: string
}

let mainWindow: BrowserWindow | null = null
let apiProcess: UtilityProcess | null = null
let apiUrl = ''
let apiStopped = false
let closeApproved = false
let monitorTimer: NodeJS.Timeout | undefined
let powerBlockerId: number | undefined
let lastJobStates = new Map<string, string>()

function resourcesPath(...segments: string[]): string {
  return path.join(process.resourcesPath, ...segments)
}

function userPath(...segments: string[]): string {
  return path.join(app.getPath('userData'), ...segments)
}

function rendererRoot(): string {
  return app.isPackaged ? resourcesPath('web') : path.resolve(__dirname, '../../web/dist')
}

function validateSender(url: string): boolean {
  return url.startsWith('app://renderer/') || url.startsWith('http://127.0.0.1:5173/')
}

async function registerRendererProtocol(): Promise<void> {
  const root = rendererRoot()
  await protocol.handle('app', async (request) => {
    const requestedUrl = new URL(request.url)
    const relative = decodeURIComponent(requestedUrl.pathname === '/' ? '/index.html' : requestedUrl.pathname)
    const filePath = path.resolve(root, `.${relative}`)
    if (!filePath.startsWith(`${root}${path.sep}`)) return new Response('Not Found', { status: 404 })
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

async function desktopSecretKey(): Promise<string> {
  const keyPath = userPath('secure', 'master-key.bin')
  await mkdir(path.dirname(keyPath), { recursive: true })
  try {
    const encrypted = await readFile(keyPath)
    return (await safeStorage.decryptStringAsync(encrypted)).result
  } catch {
    const key = randomBytes(32).toString('base64')
    await writeFile(keyPath, await safeStorage.encryptStringAsync(key))
    return key
  }
}

async function startApi(): Promise<void> {
  const token = randomBytes(32).toString('hex')
  const secretKey = await desktopSecretKey()
  const utilityPath = path.join(__dirname, 'api', 'utility.js')
  const ffmpegPath = app.isPackaged
    ? resourcesPath('ffmpeg', 'ffmpeg.exe')
    : path.resolve(__dirname, '../resources/ffmpeg/ffmpeg.exe')

  process.env.BVA_API_TOKEN = token
  process.env.BVA_SECRET_KEY = secretKey
  process.env.BVA_DATA_DIR = userPath('data')
  process.env.BVA_REPORT_ASSETS_DIR = userPath('report-assets')
  process.env.BVA_RUNTIME_DIR = path.join(app.getPath('temp'), '省流看', 'runtime')
  process.env.BVA_FFMPEG_PATH = ffmpegPath
  process.env.BVA_DESKTOP = '1'

  apiProcess = utilityProcess.fork(utilityPath, [], {
    env: { ...process.env },
    stdio: 'pipe',
    serviceName: '省流看本地分析服务',
  })
  apiProcess.stdout?.on('data', (chunk) => log.info(`[api] ${String(chunk).trimEnd()}`))
  apiProcess.stderr?.on('data', (chunk) => log.error(`[api] ${String(chunk).trimEnd()}`))

  await new Promise<void>((resolve, reject) => {
    apiProcess!.on('message', (message: ApiMessage) => {
      if (message.type === 'ready' && message.url) {
        apiUrl = message.url
        process.env.BVA_API_URL = apiUrl
        resolve()
      }
      if (message.type === 'error') reject(new Error(message.message))
    })
    apiProcess!.once('exit', (code) => {
      if (!apiUrl) reject(new Error(`本地分析服务退出，代码 ${code}`))
    })
  })
}

async function shutdownApi(): Promise<void> {
  if (!apiProcess || apiStopped) return
  await new Promise<void>((resolve) => {
    apiProcess!.once('exit', () => resolve())
    apiProcess!.postMessage({ type: 'shutdown' })
  })
  apiStopped = true
  apiProcess = null
}

async function fetchJobs(): Promise<DesktopJob[]> {
  const response = await fetch(`${apiUrl}/api/analysis/jobs`, {
    headers: { 'x-bva-token': process.env.BVA_API_TOKEN! },
  })
  return (await response.json()) as DesktopJob[]
}

async function monitorJobs(): Promise<void> {
  const jobs = await fetchJobs()
  const active = jobs.filter((job) => ACTIVE_STATUSES.has(job.status))

  if (active.length > 0 && powerBlockerId === undefined) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  } else if (active.length === 0 && powerBlockerId !== undefined) {
    powerSaveBlocker.stop(powerBlockerId)
    powerBlockerId = undefined
  }

  for (const job of jobs) {
    if (lastJobStates.get(job.id) !== 'completed' && job.status === 'completed') {
      new Notification({ title: '分析完成', body: job.video.title }).show()
    }
  }
  lastJobStates = new Map(jobs.map((job) => [job.id, job.status]))
}

function registerNativeHandlers(): void {
  ipcMain.handle('desktop:save-text', async (event, payload: { defaultName: string; content: string }) => {
    if (!validateSender(event.senderFrame?.url ?? '')) throw new Error('无效的调用来源。')
    const result = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('documents'), payload.defaultName),
      filters: [{ name: '文本报告', extensions: ['txt'] }],
    })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, payload.content, 'utf8')
    return true
  })

  ipcMain.handle('desktop:export-pdf', async (event, payload: { defaultName: string }) => {
    if (!validateSender(event.senderFrame?.url ?? '')) throw new Error('无效的调用来源。')
    const result = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('documents'), payload.defaultName),
      filters: [{ name: 'PDF 报告', extensions: ['pdf'] }],
    })
    if (result.canceled || !result.filePath) return false
    const pdf = await event.sender.printToPDF({ printBackground: true, pageSize: 'A4' })
    await writeFile(result.filePath, pdf)
    return true
  })

  ipcMain.handle('desktop:open-directory', async (event, kind: 'data' | 'cache' | 'logs') => {
    if (!validateSender(event.senderFrame?.url ?? '')) throw new Error('无效的调用来源。')
    const target = {
      data: userPath('data'),
      cache: path.join(app.getPath('temp'), '省流看', 'runtime'),
      logs: app.getPath('logs'),
    }[kind]
    await mkdir(target, { recursive: true })
    await shell.openPath(target)
  })

  ipcMain.handle('desktop:get-version', (event) => {
    if (!validateSender(event.senderFrame?.url ?? '')) throw new Error('无效的调用来源。')
    return app.getVersion()
  })
}

function installNavigationGuards(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('app://renderer/') || url.startsWith('http://127.0.0.1:5173/')) return
    event.preventDefault()
    if (url.startsWith('https://')) void shell.openExternal(url)
  })
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#f7f4ed',
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })

  installNavigationGuards(mainWindow)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', async (event) => {
    if (closeApproved) return
    event.preventDefault()
    const jobs = await fetchJobs()
    const hasActiveJobs = jobs.some((job) => ACTIVE_STATUSES.has(job.status))
    if (hasActiveJobs) {
      const result = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        buttons: ['继续分析', '关闭并中断任务'],
        defaultId: 0,
        cancelId: 0,
        title: '分析任务仍在进行',
        message: '关闭应用会中断当前分析任务。',
      })
      if (result.response === 0) return
    }
    closeApproved = true
    app.quit()
  })

  const developmentUrl = process.env.BVA_DEV_SERVER_URL
  await mainWindow.loadURL(developmentUrl ?? 'app://renderer/index.html')
}

function createApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          { label: '打开数据目录', click: () => void shell.openPath(userPath('data')) },
          { label: '打开日志目录', click: () => void shell.openPath(app.getPath('logs')) },
          { type: 'separator' },
          { role: 'quit', label: '退出' },
        ],
      },
      { label: '编辑', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '视图', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }] },
      { label: '帮助', submenu: [{ role: 'about', label: '关于省流看' }] },
    ]),
  )
}

async function launch(): Promise<void> {
  app.setName('省流看')
  app.setAppLogsPath()
  log.initialize()
  await mkdir(app.getPath('logs'), { recursive: true })
  log.transports.file.resolvePathFn = () => path.join(app.getPath('logs'), 'main.log')

  await registerRendererProtocol()
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  registerNativeHandlers()
  createApplicationMenu()
  app.setAboutPanelOptions({
    applicationName: '省流看',
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: '省流看',
  })

  await startApi()
  await createWindow()
  if (app.isPackaged && process.env.BVA_UPDATE_URL) {
    autoUpdater.setFeedURL({ url: process.env.BVA_UPDATE_URL })
    autoUpdater.on('error', (error) => log.error('Auto update failed', error))
    autoUpdater.on('update-downloaded', () => {
      new Notification({ title: '更新已下载', body: '退出应用后将自动安装新版本。' }).show()
    })
    void autoUpdater.checkForUpdates()
  }
  await monitorJobs()
  monitorTimer = setInterval(() => void monitorJobs(), 5000)
}

const hasSingleInstanceLock = !squirrelStartup && app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => void launch())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && apiUrl) void createWindow()
  })
  app.on('before-quit', (event) => {
    if (apiStopped) return
    event.preventDefault()
    if (monitorTimer) clearInterval(monitorTimer)
    void shutdownApi().then(() => app.quit())
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
