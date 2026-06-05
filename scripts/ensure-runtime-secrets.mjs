import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const SECRET_SPECS = [
  {
    name: 'WECHAT_ILINK_STATE_SECRET',
    value: process.env.WECHAT_ILINK_STATE_SECRET || randomBytes(32).toString('base64url')
  },
  {
    name: 'PERSONAL_RUNTIME_DATA_SECRET',
    value: process.env.PERSONAL_RUNTIME_DATA_SECRET || randomBytes(32).toString('base64url')
  }
]

const require = createRequire(import.meta.url)
const wranglerCli = require.resolve('wrangler/wrangler-dist/cli.js')

const runWrangler = (args = []) => {
  return spawnSync(process.execPath, [wranglerCli, ...args], {
    encoding: 'utf8',
    shell: false
  })
}

const parseSecretList = (stdout = '') => {
  const text = String(stdout || '').trim()
  if (!text) return []
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end < start) return []
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
}

const listResult = runWrangler(['secret', 'list'])
if (listResult.stdout) process.stdout.write(listResult.stdout)
if (listResult.stderr) process.stderr.write(listResult.stderr)
if (listResult.error) {
  console.error(listResult.error.message)
  process.exit(1)
}
const listErrorText = `${listResult.stdout || ''}\n${listResult.stderr || ''}`.toLowerCase()
const canIgnoreMissingWorker = listResult.status !== 0 && (
  listErrorText.includes('script_not_found')
  || listErrorText.includes('not found')
  || listErrorText.includes('does not exist')
)
if (listResult.status !== 0 && !canIgnoreMissingWorker) {
  console.error(`Unable to list Worker secrets. Wrangler exited with code ${listResult.status || 1}.`)
  process.exit(listResult.status || 1)
}
if (canIgnoreMissingWorker) {
  console.log('Worker secrets not found yet, treating this deploy as first-time setup.')
}

const existingSecretNames = new Set(
  (canIgnoreMissingWorker ? [] : parseSecretList(listResult.stdout))
    .map((item) => String(item?.name || '').trim())
    .filter(Boolean)
)
const missingSecrets = SECRET_SPECS.filter((item) => !existingSecretNames.has(item.name))

if (!missingSecrets.length) {
  console.log('Runtime secrets already configured.')
  process.exit(0)
}

const tempDir = mkdtempSync(join(tmpdir(), 'ai-phone-personal-runtime-secrets-'))
const secretFile = join(tempDir, 'worker-secrets.json')

try {
  writeFileSync(
    secretFile,
    `${JSON.stringify(Object.fromEntries(missingSecrets.map((item) => [item.name, item.value])), null, 2)}\n`,
    'utf8'
  )
  console.log(`Uploading missing Worker secrets: ${missingSecrets.map((item) => item.name).join(', ')}`)
  const bulkResult = runWrangler(['secret', 'bulk', secretFile])
  if (bulkResult.stdout) process.stdout.write(bulkResult.stdout)
  if (bulkResult.stderr) process.stderr.write(bulkResult.stderr)
  if (bulkResult.error) {
    console.error(bulkResult.error.message)
    process.exit(1)
  }
  if (bulkResult.status !== 0) {
    console.error(`Unable to upload Worker secrets. Wrangler exited with code ${bulkResult.status || 1}.`)
    process.exit(bulkResult.status || 1)
  }
  console.log('Runtime secrets configured.')
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
