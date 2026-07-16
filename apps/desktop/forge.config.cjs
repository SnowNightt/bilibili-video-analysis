const path = require('node:path')

module.exports = {
  packagerConfig: {
    asar: true,
    electronZipDir: process.env.ELECTRON_ZIP_DIR,
    prune: false,
    ignore: [/node_modules/, /^\/out($|\/)/, /^\/resources($|\/)/],
    icon: path.join(__dirname, 'assets', 'icon'),
    executableName: '省流看',
    extraResource: [
      path.join(__dirname, 'resources', 'web'),
      path.join(__dirname, 'resources', 'ffmpeg'),
    ],
    win32metadata: {
      CompanyName: '省流看',
      FileDescription: 'Bilibili 视频分析桌面工具',
      ProductName: '省流看',
      InternalName: 'BilibiliVideoAnalysis',
      OriginalFilename: '省流看.exe',
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'BilibiliVideoAnalysis',
        authors: '省流看',
        description: '本地运行的 Bilibili 视频分析桌面工具',
        setupIcon: path.join(__dirname, 'assets', 'icon.ico'),
        iconUrl: path.join(__dirname, 'assets', 'icon.ico'),
        certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
        certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
      },
    },
    { name: '@electron-forge/maker-zip', platforms: ['win32'] },
  ],
  plugins: [{ name: '@electron-forge/plugin-auto-unpack-natives', config: {} }],
}
