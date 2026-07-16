const { randomBytes } = require('node:crypto')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')

async function run() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bva-api-smoke-'))
  process.env.BVA_DATA_DIR = dataDir
  process.env.BVA_RUNTIME_DIR = path.join(dataDir, 'runtime')
  process.env.BVA_REPORT_ASSETS_DIR = path.join(dataDir, 'report-assets')
  process.env.BVA_SECRET_KEY = randomBytes(32).toString('base64')

  const { bootstrapApi } = require('../dist/bootstrap')
  const api = await bootstrapApi({ port: 0, corsOrigin: false })
  try {
    const health = await fetch(`${api.url}/api/health`).then((response) => response.json())
    const jobs = await fetch(`${api.url}/api/analysis/jobs`).then((response) => response.json())
    if (!health.ok || !Array.isArray(jobs)) throw new Error('API smoke test failed')
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
