const DYNAMIC_MEMORY_EVENT_LIMIT = 3
const MOMENT_WRITEBACK_IMPORTANCE_VALUES = ['medium', 'high']

const normalizeText = (value = '') => String(value || '').trim()

function formatLocalDateTime(raw) {
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hours}:${minutes}`
}

function formatMemoryAge(timestamp = 0, nowTs = Date.now()) {
  const ts = Number(timestamp || 0)
  if (!ts) return ''

  const diff = Math.max(0, Number(nowTs || Date.now()) - ts)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return '刚刚整理'
  if (diff < hour) return `${Math.floor(diff / minute)}分钟前整理`
  if (diff < day) return `${Math.floor(diff / hour)}小时前整理`
  return `${Math.floor(diff / day)}天前整理`
}

function formatEventKind(kind) {
  const rawKind = normalizeText(kind)
  if (!rawKind) return 'event'
  return rawKind
    .replace(/[^\w-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'event'
}

function normalizeEventType(kind) {
  const safeKind = formatEventKind(kind)
  if (safeKind.includes('call') || safeKind.includes('phone')) return 'phone_call'
  if (safeKind.includes('offline') || safeKind.includes('invite') || safeKind.includes('meet')) return 'offline_event'
  if (safeKind.includes('block') || safeKind.includes('friend')) return 'relationship_change'
  if (safeKind.includes('schedule') || safeKind.includes('status')) return 'status_change'
  if (safeKind.includes('moment')) return 'social_event'
  return safeKind || 'event'
}

function normalizeMomentImportance(value = '') {
  const importance = normalizeText(value)
  return MOMENT_WRITEBACK_IMPORTANCE_VALUES.includes(importance) ? importance : 'medium'
}

function normalizeEventMemoryItem(item) {
  if (!item || typeof item !== 'object') return null
  const sourceKind = formatEventKind(item.sourceKind || item.kind || item.type)
  const summary = normalizeText(item.summary)
  const timestamp = Number(item.timestamp || item.ts || 0)
  if (!summary) return null
  const rawImportance = normalizeText(item.importance)
  const sourcePostId = normalizeText(item.sourcePostId)
  const sourceSessionId = normalizeText(item.sourceSessionId)
  const id = normalizeText(item.id || item.memoryId)
  const nextItem = {
    type: normalizeEventType(item.type || sourceKind),
    sourceKind: sourceKind || 'event',
    summary,
    timestamp
  }
  if (id) nextItem.id = id
  if (rawImportance) nextItem.importance = normalizeMomentImportance(rawImportance)
  if (sourcePostId) nextItem.sourcePostId = sourcePostId
  if (sourceSessionId) nextItem.sourceSessionId = sourceSessionId
  const lastRetrievedAt = Number(item.lastRetrievedAt || item.lastUsedAt || 0)
  const lastMentionedAt = Number(item.lastMentionedAt || 0)
  const mentionCount = Math.max(0, Number(item.mentionCount || item.useCount || item.usageCount || 0))
  if (lastRetrievedAt) nextItem.lastRetrievedAt = lastRetrievedAt
  if (lastMentionedAt) nextItem.lastMentionedAt = lastMentionedAt
  if (mentionCount) nextItem.mentionCount = mentionCount
  return nextItem
}

function normalizeRawRecentEvent(item) {
  if (!item || typeof item !== 'object') return null
  const summary = normalizeText(item.text || item.summary)
  if (!summary) return null
  const sourceKind = formatEventKind(item.kind || item.sourceKind || item.type)
  const timestamp = Number(item.ts || item.timestamp || 0)
  return {
    type: normalizeEventType(sourceKind),
    sourceKind: sourceKind || 'event',
    summary,
    timestamp
  }
}

function normalizeBuilderEventItem(item) {
  return normalizeEventMemoryItem(item) || normalizeRawRecentEvent(item)
}

function normalizeMemoryDedupText(value = '') {
  return normalizeText(value)
    .replace(/[\s，。！？、；：,.!?;:｜|（）()【】[\]“”"'`~…-]+/g, '')
    .toLowerCase()
}

function isDuplicateMemoryText(value = '', existingValues = []) {
  const current = normalizeMemoryDedupText(value)
  if (!current) return true
  return (Array.isArray(existingValues) ? existingValues : [])
    .map((item) => normalizeMemoryDedupText(item))
    .filter(Boolean)
    .some((item) => (
      item === current ||
      (current.length >= 12 && item.includes(current)) ||
      (item.length >= 12 && current.includes(item))
    ))
}

export function formatEventMemoryCompact(events = [], limit = DYNAMIC_MEMORY_EVENT_LIMIT, options = {}) {
  const nowTs = Number(options.nowTs || Date.now())
  const includeTimeContext = options.includeTimeContext === true
  const excludeTexts = Array.isArray(options.excludeTexts) ? options.excludeTexts : []
  const emittedTexts = []
  return (Array.isArray(events) ? events : [])
    .map((event) => {
      const safeEvent = normalizeBuilderEventItem(event)
      if (!safeEvent) return ''
      if (isDuplicateMemoryText(safeEvent.summary, [...excludeTexts, ...emittedTexts])) return ''
      emittedTexts.push(safeEvent.summary)
      const absoluteTime = formatLocalDateTime(safeEvent.timestamp) || '时间未记住'
      const age = includeTimeContext ? formatMemoryAge(safeEvent.timestamp, nowTs) : ''
      return `${age ? `${age}｜` : ''}${absoluteTime}｜${safeEvent.summary}`
    })
    .filter(Boolean)
    .slice(0, Math.max(1, Number(limit || DYNAMIC_MEMORY_EVENT_LIMIT)))
    .join('；')
}
