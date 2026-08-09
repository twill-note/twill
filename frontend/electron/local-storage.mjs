import fs from 'node:fs'
import path from 'node:path'

export const localStorageSnapshotFileName = 'desktop-local-storage.json'

const snapshotVersion = 1
const maxEntryCount = 1_000
const maxKeyLength = 1_024
const maxValueLength = 2 * 1024 * 1024
const maxSnapshotLength = 8 * 1024 * 1024

export function normalizeLocalStorageSnapshot(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {}

  const normalized = Object.create(null)
  let totalLength = 0
  let entryCount = 0
  for (const [key, value] of Object.entries(candidate)) {
    if (entryCount >= maxEntryCount || typeof value !== 'string') continue
    if (key.length > maxKeyLength || value.length > maxValueLength) continue
    if (totalLength + key.length + value.length > maxSnapshotLength) break
    normalized[key] = value
    totalLength += key.length + value.length
    entryCount += 1
  }
  return normalized
}

export function readLocalStorageSnapshot(filePath) {
  try {
    const document = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const values = document?.version === snapshotVersion ? document.values : document
    return normalizeLocalStorageSnapshot(values)
  } catch {
    return {}
  }
}

export function writeLocalStorageSnapshot(filePath, candidate) {
  const values = normalizeLocalStorageSnapshot(candidate)
  const directory = path.dirname(filePath)
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.mkdirSync(directory, { recursive: true })
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: snapshotVersion, values })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    try {
      fs.unlinkSync(temporaryPath)
    } catch {
      // 정상적인 rename 뒤에는 임시 파일이 이미 없다.
    }
  }
  return values
}
