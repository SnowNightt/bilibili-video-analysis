const { randomBytes } = require('node:crypto')
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')

async function run() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bva-api-smoke-'))
  const legacyReportId = '00000000-0000-4000-8000-000000000001'
  process.env.BVA_DATA_DIR = dataDir
  process.env.BVA_RUNTIME_DIR = path.join(dataDir, 'runtime')
  process.env.BVA_REPORT_ASSETS_DIR = path.join(dataDir, 'report-assets')
  process.env.BVA_SECRET_KEY = randomBytes(32).toString('base64')

  await writeFile(
    path.join(dataDir, 'analysis-reports.json'),
    JSON.stringify([
      {
        id: legacyReportId,
        jobId: '00000000-0000-4000-8000-000000000002',
        video: {
          bvid: 'BV1xx411c7mD',
          url: 'https://www.bilibili.com/video/BV1xx411c7mD',
          title: '旧报告迁移测试',
          coverUrl: 'https://example.com/cover.jpg',
          ownerName: '测试作者',
          publishedAt: '2026-01-01 00:00:00',
          duration: 60,
          description: '用于 API smoke test。',
          isPublic: true,
          parts: [{ cid: 1, page: 1, title: '测试分 P', duration: 60 }],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        summary: '这是迁移测试摘要。',
        overview: '这是迁移测试概览。',
        chapters: [{ title: '测试章节', startSeconds: 0, summary: '章节摘要。' }],
        keyPoints: [{ title: '要点一', detail: '要点详情。' }],
        facts: ['应被迁移清理的事实。'],
        conclusion: '应被迁移清理的结论。',
        screenshots: [],
        recommendedSegments: [],
        confidenceNotes: '测试可信度说明。',
      },
    ]),
    'utf8',
  )

  const { bootstrapApi } = require('../dist/bootstrap')
  const api = await bootstrapApi({ port: 0, corsOrigin: false })
  try {
    const health = await fetch(`${api.url}/api/health`).then((response) => response.json())
    const jobs = await fetch(`${api.url}/api/analysis/jobs`).then((response) => response.json())
    if (!health.ok || !Array.isArray(jobs)) throw new Error('API smoke test failed')

    const report = await fetch(`${api.url}/api/analysis/reports/${legacyReportId}`).then((response) => response.json())
    if ('facts' in report || 'conclusion' in report) {
      throw new Error('Legacy report fields leaked through the API')
    }

    const storedReports = JSON.parse(await readFile(path.join(dataDir, 'analysis-reports.json'), 'utf8'))
    if ('facts' in storedReports[0] || 'conclusion' in storedReports[0]) {
      throw new Error('Legacy report fields were not removed from storage')
    }

    const repairedReport = await fetch(
      `${api.url}/api/analysis/reports/${legacyReportId}/screenshots/repair`,
      { method: 'POST' },
    ).then((response) => response.json())
    if (!Array.isArray(repairedReport.screenshots)) {
      throw new Error('Screenshot repair endpoint returned an invalid report')
    }

    const summaryAnswer = await fetch(`${api.url}/api/analysis/reports/${legacyReportId}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '请总结主要内容' }),
    }).then((response) => response.json())
    if (!summaryAnswer.text?.includes('要点一')) {
      throw new Error('Fallback summary answer did not use key points')
    }

    const generalAnswer = await fetch(`${api.url}/api/analysis/reports/${legacyReportId}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '报告里还有什么？' }),
    }).then((response) => response.json())
    if (!generalAnswer.text?.includes('要点梳理')) {
      throw new Error('Fallback general answer still references removed report fields')
    }

    process.stdout.write(`API smoke test passed at ${api.url}\n`)
  } finally {
    await api.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
