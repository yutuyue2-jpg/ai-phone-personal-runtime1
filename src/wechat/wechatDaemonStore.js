import fs from 'node:fs/promises'
import path from 'node:path'

const STORE_VERSION = 1
const DEFAULT_STORE_RELATIVE_PATH = path.join('data', 'wechat-daemon-store.json')
const THREAD_CONTEXT_MESSAGE_LIMIT = 80
const THREAD_CONTEXT_MOMENT_LIMIT = 12
const THREAD_CONTEXT_EVENT_LIMIT = 20
const THREAD_CONTEXT_STICKER_LIMIT = 24
const THREAD_CONTEXT_AVATAR_LIMIT = 24
const THREAD_CONTEXT_WORLD_BOOK_LIMIT = 48
const RECENT_INBOUND_UPDATE_LIMIT = 40

const normalizeText = (value = '') => String(value || '').trim()
const normalizeIdentity = (value = '') => normalizeText(value) === 'sub' ? 'sub' : 'main'

const normalizeBoolean = (value, fallback = false) => {
  if (value === undefined) return fallback
  return value === true
}

const normalizeInteger = (value, fallback = 0, min = 0, max = 86400) => {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

const normalizeAutoReplyState = (value = '') => {
  const state = normalizeText(value)
  return ['idle', 'waiting_quiet', 'ready', 'processing'].includes(state)
    ? state
    : 'idle'
}

const normalizeTimestamp = (value = 0) => {
  const parsed = Number(value || 0)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return parsed < 100000000000 ? parsed * 1000 : parsed
}

const normalizeInboundUpdate = (update = {}) => {
  const safe = update && typeof update === 'object' ? update : {}
  return {
    id: normalizeText(safe.id || safe.messageId || safe.msgId),
    type: normalizeText(safe.type || 'text') || 'text',
    content: normalizeText(safe.content || safe.text || safe.message),
    from: normalizeText(safe.from),
    contextToken: normalizeText(safe.contextToken || safe.context_token),
    createdAt: normalizeTimestamp(safe.createdAt),
  }
}

const normalizeInboundUpdates = (updates = []) => Array.isArray(updates)
  ? updates
    .map((item) => normalizeInboundUpdate(item))
    .filter((item) => item.id || item.content)
  : []

const mergeInboundUpdates = (existing = [], incoming = []) => {
  const map = new Map()
  normalizeInboundUpdates(existing).forEach((item) => {
    const key = item.id || `${item.from}:${item.createdAt}:${item.content}`
    if (key) map.set(key, item)
  })
  normalizeInboundUpdates(incoming).forEach((item) => {
    const key = item.id || `${item.from}:${item.createdAt}:${item.content}`
    if (key) map.set(key, item)
  })
  return Array.from(map.values())
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
    .slice(-100)
}

const mergeRecentInboundUpdates = (existing = [], incoming = []) => mergeInboundUpdates(existing, incoming)
  .slice(-RECENT_INBOUND_UPDATE_LIMIT)

const resolveAutoReplyStateFromPending = ({
  pendingCount = 0,
  quietSeconds = 0,
  quietUntilAt = 0,
  now = Date.now()
} = {}) => {
  const safePendingCount = Math.max(0, Number(pendingCount || 0))
  if (safePendingCount <= 0) return 'idle'
  const safeQuietSeconds = Math.max(0, Number(quietSeconds || 0))
  if (safeQuietSeconds <= 0) return 'ready'
  return Number(quietUntilAt || 0) > now ? 'waiting_quiet' : 'ready'
}

const clone = (value) => JSON.parse(JSON.stringify(value))

const normalizeThreadContextMessage = (message = {}) => {
  const safe = message && typeof message === 'object' ? message : {}
  return {
    id: normalizeText(safe.id),
    role: normalizeText(safe.role),
    type: normalizeText(safe.type || 'text') || 'text',
    text: normalizeText(safe.text),
    originalText: normalizeText(safe.originalText),
    translatedText: normalizeText(safe.translatedText),
    transcript: normalizeText(safe.transcript),
    description: normalizeText(safe.description),
    url: normalizeText(safe.url || safe.mediaUrl),
    mediaUrl: normalizeText(safe.mediaUrl || safe.url),
    caption: normalizeText(safe.caption),
    timestamp: Math.max(0, Number(safe.timestamp || 0)),
    amount: normalizeText(safe.amount),
    status: normalizeText(safe.status),
    source: normalizeText(safe.source)
  }
}

const buildThreadContextMessageKey = (message = {}) => [
  normalizeText(message?.id),
  normalizeText(message?.role),
  normalizeText(message?.type),
  normalizeText(
    message?.id
    || message?.originalText
    || message?.text
    || message?.translatedText
    || message?.transcript
    || message?.description
    || message?.id
  ),
  Math.max(0, Number(message?.timestamp || 0)),
  normalizeText(message?.amount),
  normalizeText(message?.status)
].join('|')

const mergeThreadContextMessages = (existing = [], incoming = []) => {
  const merged = []
  const existingKeys = new Set()
  ;[...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]
    .map((item) => normalizeThreadContextMessage(item))
    .filter((item) => item.id || item.originalText || item.text || item.transcript || item.description)
    .forEach((item) => {
      const key = buildThreadContextMessageKey(item)
      if (!key || existingKeys.has(key)) return
      existingKeys.add(key)
      merged.push(item)
    })
  return merged
    .sort((left, right) => Number(left?.timestamp || 0) - Number(right?.timestamp || 0))
    .slice(-THREAD_CONTEXT_MESSAGE_LIMIT)
}

const normalizeThreadContextEvent = (event = {}) => {
  const safe = event && typeof event === 'object' ? event : {}
  return {
    kind: normalizeText(safe.kind || safe.type),
    type: normalizeText(safe.type || safe.kind),
    text: normalizeText(safe.text),
    ts: Math.max(0, Number(safe.ts || safe.timestamp || 0)),
    timestamp: Math.max(0, Number(safe.timestamp || safe.ts || 0)),
    trigger: normalizeText(safe.trigger),
    commentText: normalizeText(safe.commentText),
    privateMessageText: normalizeText(safe.privateMessageText),
    replyToName: normalizeText(safe.replyToName),
    socialTargetMode: normalizeText(safe.socialTargetMode)
  }
}

const normalizeThreadContextContact = (contact = {}) => {
  const safe = contact && typeof contact === 'object' ? contact : {}
  return {
    id: normalizeText(safe.id),
    name: normalizeText(safe.name),
    remarkName: normalizeText(safe.remarkName),
    intro: normalizeText(safe.intro),
    persona: normalizeText(safe.persona),
    textLanguage: normalizeText(safe.textLanguage),
    voiceLanguage: normalizeText(safe.voiceLanguage),
    injectGroupContext: safe.injectGroupContext !== false,
    allowAiNudge: safe.allowAiNudge === true,
    allowMoments: safe.allowMoments === true,
    timeAware: safe.timeAware === true,
    chatTimeAwareness: safe.chatTimeAwareness !== false,
    timezoneAwareness: safe.timezoneAwareness === true,
    weatherAwareness: safe.weatherAwareness === true,
    roleTimeZone: normalizeText(safe.roleTimeZone),
    contextMessageCount: Math.max(0, Number(safe.contextMessageCount || 0)),
    contextEventCount: Math.max(0, Number(safe.contextEventCount || 0)),
    minReplyCount: Math.max(0, Number(safe.minReplyCount || 0)),
    maxReplyCount: Math.max(0, Number(safe.maxReplyCount || 0)),
    sessionAccountId: normalizeText(safe.sessionAccountId),
    sessionChatId: normalizeText(safe.sessionChatId),
    wechatIdentityId: normalizeText(safe.wechatIdentityId || 'main') || 'main',
    wechatIdentityDisplayName: normalizeText(safe.wechatIdentityDisplayName),
    wechatIdentityAccountDescription: normalizeText(safe.wechatIdentityAccountDescription),
    wechatIdentityInstruction: normalizeText(safe.wechatIdentityInstruction),
    lastMomentPostedAt: Math.max(0, Number(safe.lastMomentPostedAt || 0)),
    lastMomentAt: Math.max(0, Number(safe.lastMomentAt || 0)),
    aiImageSettings: safe.aiImageSettings && typeof safe.aiImageSettings === 'object'
      ? {
          enabled: safe.aiImageSettings.enabled === true,
          portraitPrompt: normalizeText(safe.aiImageSettings.portraitPrompt),
          basePrompt: normalizeText(safe.aiImageSettings.basePrompt)
        }
      : { enabled: false, portraitPrompt: '', basePrompt: '' },
    memory: safe.memory && typeof safe.memory === 'object'
      ? clone(safe.memory)
      : {},
    recentEvents: Array.isArray(safe.recentEvents)
      ? safe.recentEvents.map((item) => normalizeThreadContextEvent(item)).slice(0, THREAD_CONTEXT_EVENT_LIMIT)
      : []
  }
}

const normalizeThreadContextMomentPost = (post = {}) => {
  const safe = post && typeof post === 'object' ? post : {}
  return {
    id: normalizeText(safe.id),
    createdAt: Math.max(0, Number(safe.createdAt || 0)),
    updatedAt: Math.max(0, Number(safe.updatedAt || 0)),
    isMe: safe.isMe === true,
    postOwnerId: normalizeText(safe.postOwnerId || safe.authorId),
    authorId: normalizeText(safe.authorId || safe.postOwnerId),
    name: normalizeText(safe.name),
    text: normalizeText(safe.text),
    originalText: normalizeText(safe.originalText),
    translatedText: normalizeText(safe.translatedText),
    imageDesc: normalizeText(safe.imageDesc),
    likes: Array.isArray(safe.likes) ? safe.likes.slice(0, 12).map((item) => (
      typeof item === 'string' ? normalizeText(item) : { name: normalizeText(item?.name) }
    )) : [],
    comments: Array.isArray(safe.comments) ? safe.comments.slice(0, 12).map((item) => ({
      name: normalizeText(item?.name),
      replyTo: normalizeText(item?.replyTo),
      text: normalizeText(item?.text),
      originalText: normalizeText(item?.originalText),
      translatedText: normalizeText(item?.translatedText)
    })) : []
  }
}

const normalizeThreadContextSticker = (item = {}) => {
  const safe = item && typeof item === 'object' ? item : {}
  const mediaUrl = normalizeText(safe.mediaUrl || safe.imageUrl || safe.url || safe.src || safe.previewUrl)
  return {
    id: normalizeText(safe.id),
    name: normalizeText(safe.name),
    title: normalizeText(safe.title || safe.name),
    label: normalizeText(safe.label || safe.name),
    desc: normalizeText(safe.desc),
    description: normalizeText(safe.description || safe.desc),
    category: normalizeText(safe.category),
    url: mediaUrl,
    imageUrl: mediaUrl,
    mediaUrl,
    previewUrl: normalizeText(safe.previewUrl || mediaUrl)
  }
}

const normalizeThreadContextAvatarPreset = (item = {}) => {
  const safe = item && typeof item === 'object' ? item : {}
  return {
    id: normalizeText(safe.id),
    title: normalizeText(safe.title),
    desc: normalizeText(safe.desc)
  }
}

const normalizeThreadContextWorldBookEntry = (item = {}) => {
  const safe = item && typeof item === 'object' ? item : {}
  return {
    id: normalizeText(safe.id),
    title: normalizeText(safe.title),
    content: normalizeText(safe.content).slice(0, 2400),
    keys: Array.isArray(safe.keys) ? safe.keys.map((key) => normalizeText(key)).filter(Boolean).slice(0, 24) : []
  }
}

const normalizeThreadContextSettingsStore = (settings = {}) => {
  const safe = settings && typeof settings === 'object' ? settings : {}
  return {
    baseUrl: normalizeText(safe.baseUrl),
    model: normalizeText(safe.model),
    modelTemperatureSettings: safe.modelTemperatureSettings && typeof safe.modelTemperatureSettings === 'object'
      ? clone(safe.modelTemperatureSettings)
      : {}
  }
}

const normalizeThreadContextSnapshot = (snapshot = {}) => {
  const safe = snapshot && typeof snapshot === 'object' ? snapshot : {}
  return {
    updatedAt: Math.max(0, Number(safe.updatedAt || Date.now())),
    backgroundDeviceId: normalizeText(safe.backgroundDeviceId || safe.deviceId),
    deviceId: normalizeText(safe.deviceId || safe.backgroundDeviceId),
    accountName: normalizeText(safe.accountName),
    wechatAccountName: normalizeText(safe.wechatAccountName || safe.accountName),
    settingsStore: normalizeThreadContextSettingsStore(safe.settingsStore),
    userTimeZone: normalizeText(safe.userTimeZone),
    userInfo: safe.userInfo && typeof safe.userInfo === 'object'
      ? clone(safe.userInfo)
      : {},
    contact: normalizeThreadContextContact(safe.contact),
    messages: Array.isArray(safe.messages)
      ? safe.messages.map((item) => normalizeThreadContextMessage(item)).slice(-THREAD_CONTEXT_MESSAGE_LIMIT)
      : [],
    momentPosts: Array.isArray(safe.momentPosts)
      ? safe.momentPosts.map((item) => normalizeThreadContextMomentPost(item)).slice(0, THREAD_CONTEXT_MOMENT_LIMIT)
      : [],
    customStickers: Array.isArray(safe.customStickers)
      ? safe.customStickers.map((item) => normalizeThreadContextSticker(item)).slice(0, THREAD_CONTEXT_STICKER_LIMIT)
      : [],
    avatarPresets: Array.isArray(safe.avatarPresets)
      ? safe.avatarPresets.map((item) => normalizeThreadContextAvatarPreset(item)).slice(0, THREAD_CONTEXT_AVATAR_LIMIT)
      : [],
    worldBookEntries: Array.isArray(safe.worldBookEntries)
      ? safe.worldBookEntries.map((item) => normalizeThreadContextWorldBookEntry(item)).slice(0, THREAD_CONTEXT_WORLD_BOOK_LIMIT)
      : [],
    replyStrategyContext: safe.replyStrategyContext && typeof safe.replyStrategyContext === 'object'
      ? clone(safe.replyStrategyContext)
      : null,
    scheduleContext: safe.scheduleContext && typeof safe.scheduleContext === 'object'
      ? clone(safe.scheduleContext)
      : null,
    directVisionMessage: safe.directVisionMessage && typeof safe.directVisionMessage === 'object'
      ? clone(safe.directVisionMessage)
      : null,
    daemonDebug: safe.daemonDebug && typeof safe.daemonDebug === 'object'
      ? clone(safe.daemonDebug)
      : null
  }
}

const resolveStorePath = (env = process.env) => {
  const configured = normalizeText(env.WECHAT_DAEMON_STORE_FILE)
  return path.resolve(configured || DEFAULT_STORE_RELATIVE_PATH)
}

export const buildWechatDaemonThreadKey = ({
  accountId = '',
  roleId = '',
  identity = 'main',
  chatId = ''
} = {}) => {
  const safeAccountId = normalizeText(accountId)
  const safeRoleId = normalizeText(roleId)
  const safeIdentity = normalizeIdentity(identity)
  const safeChatId = normalizeText(chatId)
  if (safeChatId) return safeChatId
  return [safeAccountId, safeRoleId, safeIdentity].filter(Boolean).join(':')
}

export const normalizeWechatDaemonThreadMeta = (threadMeta = {}) => {
  const safe = threadMeta && typeof threadMeta === 'object' ? threadMeta : {}
  const roleId = normalizeText(safe.roleId)
  const accountId = normalizeText(safe.accountId)
  const identity = normalizeIdentity(safe.identity)
  const chatId = normalizeText(safe.chatId)
  return {
    roleId,
    accountId,
    identity,
    chatId,
    threadKey: buildWechatDaemonThreadKey({ accountId, roleId, identity, chatId }),
    wechatReplyTriggersAi: normalizeBoolean(safe.wechatReplyTriggersAi, true),
    pwaChatToWechat: normalizeBoolean(safe.pwaChatToWechat, false),
    quietSeconds: normalizeInteger(safe.quietSeconds, 0, 0, 3600)
  }
}

const createEmptyStoreData = () => ({
  version: STORE_VERSION,
  updatedAt: Date.now(),
  bindings: []
})

const normalizeBindingRecord = (record = {}) => {
  const safe = record && typeof record === 'object' ? record : {}
  const threadMeta = normalizeWechatDaemonThreadMeta(safe.threadMeta || safe)
  return {
    threadKey: threadMeta.threadKey,
    roleId: threadMeta.roleId,
    accountId: threadMeta.accountId,
    identity: threadMeta.identity,
    chatId: threadMeta.chatId,
    wechatReplyTriggersAi: threadMeta.wechatReplyTriggersAi,
    pwaChatToWechat: threadMeta.pwaChatToWechat,
    quietSeconds: threadMeta.quietSeconds,
    status: normalizeText(safe.status) || 'unbound',
    bridgeType: normalizeText(safe.bridgeType) || 'ilink',
    bridgeUrl: normalizeText(safe.bridgeUrl),
    bindingId: normalizeText(safe.bindingId),
    remoteBindingId: normalizeText(safe.remoteBindingId || safe.bindingId),
    sessionId: normalizeText(safe.sessionId),
    externalAccountId: normalizeText(safe.externalAccountId),
    externalAccountName: normalizeText(safe.externalAccountName),
    lastError: normalizeText(safe.lastError),
    lastLoginStartedAt: Math.max(0, Number(safe.lastLoginStartedAt || 0)),
    lastStatusCheckedAt: Math.max(0, Number(safe.lastStatusCheckedAt || 0)),
    lastSyncedAt: Math.max(0, Number(safe.lastSyncedAt || 0)),
    lastSentAt: Math.max(0, Number(safe.lastSentAt || 0)),
    lastInboundAt: Math.max(0, Number(safe.lastInboundAt || 0)),
    lastInboundFrom: normalizeText(safe.lastInboundFrom),
    lastInboundContextToken: normalizeText(safe.lastInboundContextToken),
    quietUntilAt: Math.max(0, Number(safe.quietUntilAt || 0)),
    autoReplyState: normalizeAutoReplyState(safe.autoReplyState),
    lastAutoReplyReadyAt: Math.max(0, Number(safe.lastAutoReplyReadyAt || 0)),
    lastAutoReplyStartedAt: Math.max(0, Number(safe.lastAutoReplyStartedAt || 0)),
    lastAutoReplyQueuedAt: Math.max(0, Number(safe.lastAutoReplyQueuedAt || 0)),
    lastAutoReplyCompletedAt: Math.max(0, Number(safe.lastAutoReplyCompletedAt || 0)),
    nextAutoReplyAttemptAt: Math.max(0, Number(safe.nextAutoReplyAttemptAt || 0)),
    autoReplyAttemptCount: Math.max(0, Number(safe.autoReplyAttemptCount || 0)),
    autoReplyLastError: normalizeText(safe.autoReplyLastError),
    threadContextSnapshot: normalizeThreadContextSnapshot(safe.threadContextSnapshot),
    threadContextUpdatedAt: Math.max(
      0,
      Number(safe.threadContextUpdatedAt || safe.threadContextSnapshot?.updatedAt || 0)
    ),
    recentInboundUpdates: mergeRecentInboundUpdates(safe.recentInboundUpdates),
    pendingInboundUpdates: normalizeInboundUpdates(safe.pendingInboundUpdates),
    pendingInboundCount: normalizeInboundUpdates(safe.pendingInboundUpdates).length,
    processingInboundUpdates: normalizeInboundUpdates(safe.processingInboundUpdates),
    processingInboundCount: normalizeInboundUpdates(safe.processingInboundUpdates).length,
    updatedAt: Math.max(0, Number(safe.updatedAt || Date.now())),
    createdAt: Math.max(0, Number(safe.createdAt || Date.now()))
  }
}

async function ensureParentDir(filePath = '') {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

function hasD1Store(env = process.env) {
  return Boolean(env?.DB && typeof env.DB.prepare === 'function')
}

const parseJson = (value, fallback) => {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const boolToInt = (value) => value === true ? 1 : 0

const rowToBindingRecord = (row = {}) => normalizeBindingRecord({
  threadKey: row.thread_key,
  roleId: row.role_id,
  accountId: row.account_id,
  identity: row.identity,
  chatId: row.chat_id,
  wechatReplyTriggersAi: row.wechat_reply_triggers_ai !== 0,
  pwaChatToWechat: row.pwa_chat_to_wechat === 1,
  quietSeconds: row.quiet_seconds,
  status: row.status,
  bridgeType: row.bridge_type,
  bridgeUrl: row.bridge_url,
  bindingId: row.binding_id,
  remoteBindingId: row.remote_binding_id,
  sessionId: row.session_id,
  externalAccountId: row.external_account_id,
  externalAccountName: row.external_account_name,
  lastError: row.last_error,
  lastLoginStartedAt: row.last_login_started_at,
  lastStatusCheckedAt: row.last_status_checked_at,
  lastSyncedAt: row.last_synced_at,
  lastSentAt: row.last_sent_at,
  lastInboundAt: row.last_inbound_at,
  lastInboundFrom: row.last_inbound_from,
  lastInboundContextToken: row.last_inbound_context_token,
  quietUntilAt: row.quiet_until_at,
  autoReplyState: row.auto_reply_state,
  lastAutoReplyReadyAt: row.last_auto_reply_ready_at,
  lastAutoReplyStartedAt: row.last_auto_reply_started_at,
  lastAutoReplyQueuedAt: row.last_auto_reply_queued_at,
  lastAutoReplyCompletedAt: row.last_auto_reply_completed_at,
  nextAutoReplyAttemptAt: row.next_auto_reply_attempt_at,
  autoReplyAttemptCount: row.auto_reply_attempt_count,
  autoReplyLastError: row.auto_reply_last_error,
  threadContextSnapshot: parseJson(row.snapshot_json, {}),
  threadContextUpdatedAt: row.thread_context_updated_at || row.context_updated_at,
  recentInboundUpdates: parseJson(row.recent_inbound_updates_json, []),
  pendingInboundUpdates: parseJson(row.pending_inbound_updates_json, []),
  processingInboundUpdates: parseJson(row.processing_inbound_updates_json, []),
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const selectBindingSql = `
  SELECT
    b.*,
    c.snapshot_json,
    c.updated_at AS context_updated_at
  FROM wechat_daemon_bindings b
  LEFT JOIN wechat_thread_contexts c ON c.thread_key = b.thread_key
`

const readD1BindingRecord = async (env = process.env, threadKey = '') => {
  const safeThreadKey = normalizeText(threadKey)
  if (!safeThreadKey) return null
  const row = await env.DB
    .prepare(`${selectBindingSql} WHERE b.thread_key = ?`)
    .bind(safeThreadKey)
    .first()
  return row ? rowToBindingRecord(row) : null
}

const listD1BindingRecords = async (env = process.env) => {
  const result = await env.DB
    .prepare(`${selectBindingSql} ORDER BY b.updated_at DESC`)
    .all()
  return (result?.results || []).map((row) => rowToBindingRecord(row)).filter((item) => item.threadKey)
}

const upsertD1BindingRecord = async (env = process.env, record = {}) => {
  const binding = normalizeBindingRecord(record)
  if (!binding.threadKey) return null
  await env.DB.prepare(`
    INSERT INTO wechat_daemon_bindings (
      thread_key, role_id, account_id, identity, chat_id,
      wechat_reply_triggers_ai, pwa_chat_to_wechat, quiet_seconds,
      status, bridge_type, bridge_url, binding_id, remote_binding_id, session_id,
      external_account_id, external_account_name, last_error,
      last_login_started_at, last_status_checked_at, last_synced_at, last_sent_at,
      last_inbound_at, last_inbound_from, last_inbound_context_token,
      quiet_until_at, auto_reply_state, last_auto_reply_ready_at, last_auto_reply_started_at,
      last_auto_reply_queued_at, last_auto_reply_completed_at, next_auto_reply_attempt_at,
      auto_reply_attempt_count, auto_reply_last_error, thread_context_updated_at,
      recent_inbound_updates_json, pending_inbound_updates_json, pending_inbound_count,
      processing_inbound_updates_json, processing_inbound_count, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(thread_key) DO UPDATE SET
      role_id = excluded.role_id,
      account_id = excluded.account_id,
      identity = excluded.identity,
      chat_id = excluded.chat_id,
      wechat_reply_triggers_ai = excluded.wechat_reply_triggers_ai,
      pwa_chat_to_wechat = excluded.pwa_chat_to_wechat,
      quiet_seconds = excluded.quiet_seconds,
      status = excluded.status,
      bridge_type = excluded.bridge_type,
      bridge_url = excluded.bridge_url,
      binding_id = excluded.binding_id,
      remote_binding_id = excluded.remote_binding_id,
      session_id = excluded.session_id,
      external_account_id = excluded.external_account_id,
      external_account_name = excluded.external_account_name,
      last_error = excluded.last_error,
      last_login_started_at = excluded.last_login_started_at,
      last_status_checked_at = excluded.last_status_checked_at,
      last_synced_at = excluded.last_synced_at,
      last_sent_at = excluded.last_sent_at,
      last_inbound_at = excluded.last_inbound_at,
      last_inbound_from = excluded.last_inbound_from,
      last_inbound_context_token = excluded.last_inbound_context_token,
      quiet_until_at = excluded.quiet_until_at,
      auto_reply_state = excluded.auto_reply_state,
      last_auto_reply_ready_at = excluded.last_auto_reply_ready_at,
      last_auto_reply_started_at = excluded.last_auto_reply_started_at,
      last_auto_reply_queued_at = excluded.last_auto_reply_queued_at,
      last_auto_reply_completed_at = excluded.last_auto_reply_completed_at,
      next_auto_reply_attempt_at = excluded.next_auto_reply_attempt_at,
      auto_reply_attempt_count = excluded.auto_reply_attempt_count,
      auto_reply_last_error = excluded.auto_reply_last_error,
      thread_context_updated_at = excluded.thread_context_updated_at,
      recent_inbound_updates_json = excluded.recent_inbound_updates_json,
      pending_inbound_updates_json = excluded.pending_inbound_updates_json,
      pending_inbound_count = excluded.pending_inbound_count,
      processing_inbound_updates_json = excluded.processing_inbound_updates_json,
      processing_inbound_count = excluded.processing_inbound_count,
      updated_at = excluded.updated_at
  `).bind(
    binding.threadKey,
    binding.roleId,
    binding.accountId,
    binding.identity,
    binding.chatId,
    boolToInt(binding.wechatReplyTriggersAi),
    boolToInt(binding.pwaChatToWechat),
    binding.quietSeconds,
    binding.status,
    binding.bridgeType,
    binding.bridgeUrl,
    binding.bindingId,
    binding.remoteBindingId,
    binding.sessionId,
    binding.externalAccountId,
    binding.externalAccountName,
    binding.lastError,
    binding.lastLoginStartedAt,
    binding.lastStatusCheckedAt,
    binding.lastSyncedAt,
    binding.lastSentAt,
    binding.lastInboundAt,
    binding.lastInboundFrom,
    binding.lastInboundContextToken,
    binding.quietUntilAt,
    binding.autoReplyState,
    binding.lastAutoReplyReadyAt,
    binding.lastAutoReplyStartedAt,
    binding.lastAutoReplyQueuedAt,
    binding.lastAutoReplyCompletedAt,
    binding.nextAutoReplyAttemptAt,
    binding.autoReplyAttemptCount,
    binding.autoReplyLastError,
    binding.threadContextUpdatedAt,
    JSON.stringify(binding.recentInboundUpdates),
    JSON.stringify(binding.pendingInboundUpdates),
    binding.pendingInboundCount,
    JSON.stringify(binding.processingInboundUpdates),
    binding.processingInboundCount,
    binding.createdAt,
    binding.updatedAt
  ).run()

  await env.DB.prepare(`
    INSERT INTO wechat_thread_contexts (thread_key, snapshot_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(thread_key) DO UPDATE SET
      snapshot_json = excluded.snapshot_json,
      updated_at = excluded.updated_at
  `).bind(
    binding.threadKey,
    JSON.stringify(binding.threadContextSnapshot),
    binding.threadContextUpdatedAt || binding.updatedAt
  ).run()

  return readD1BindingRecord(env, binding.threadKey)
}

const removeD1BindingRecord = async (env = process.env, threadKey = '') => {
  const safeThreadKey = normalizeText(threadKey)
  if (!safeThreadKey) return false
  const existing = await readD1BindingRecord(env, safeThreadKey)
  if (!existing?.threadKey) return false
  await env.DB.prepare('DELETE FROM wechat_thread_contexts WHERE thread_key = ?').bind(safeThreadKey).run()
  await env.DB.prepare('DELETE FROM wechat_daemon_bindings WHERE thread_key = ?').bind(safeThreadKey).run()
  return true
}

async function readStoreFile(filePath = '') {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    const bindings = Array.isArray(parsed?.bindings)
      ? parsed.bindings.map((item) => normalizeBindingRecord(item)).filter((item) => item.threadKey)
      : []
    return {
      version: STORE_VERSION,
      updatedAt: Math.max(0, Number(parsed?.updatedAt || 0)),
      bindings
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return createEmptyStoreData()
    throw error
  }
}

async function writeStoreFile(filePath = '', data = {}) {
  const payload = {
    version: STORE_VERSION,
    updatedAt: Date.now(),
    bindings: Array.isArray(data?.bindings) ? data.bindings.map((item) => normalizeBindingRecord(item)) : []
  }
  await ensureParentDir(filePath)
  const tempPath = `${filePath}.tmp`
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8')
  await fs.rename(tempPath, filePath)
  return payload
}

async function readStoreData(env = process.env, filePath = '') {
  if (hasD1Store(env)) {
    const bindings = await listD1BindingRecords(env)
    return {
      version: STORE_VERSION,
      updatedAt: bindings.reduce((max, item) => Math.max(max, Number(item.updatedAt || 0)), 0),
      bindings
    }
  }
  return readStoreFile(filePath)
}

async function writeStoreData(env = process.env, filePath = '', data = {}) {
  if (hasD1Store(env)) {
    const bindings = Array.isArray(data?.bindings)
      ? data.bindings.map((item) => normalizeBindingRecord(item)).filter((item) => item.threadKey)
      : []
    for (const binding of bindings) {
      await upsertD1BindingRecord(env, binding)
    }
    return {
      version: STORE_VERSION,
      updatedAt: Date.now(),
      bindings
    }
  }
  return writeStoreFile(filePath, data)
}

export function createWechatDaemonStore(env = process.env) {
  const filePath = resolveStorePath(env)
  const storageLabel = hasD1Store(env) ? 'd1:wechat_daemon_bindings' : filePath
  let cache = null
  let pendingWrite = Promise.resolve()

  const load = async (force = false) => {
    if (!force && cache && !hasD1Store(env)) return cache
    cache = await readStoreData(env, filePath)
    return cache
  }

  const persist = async () => {
    const current = cache || await load()
    pendingWrite = pendingWrite.then(() => writeStoreData(env, filePath, current))
    cache = await pendingWrite
    return cache
  }

  const listBindings = async () => {
    const current = await load()
    return clone(current.bindings || [])
  }

  const getBindingByThreadKey = async (threadKey = '') => {
    const safeThreadKey = normalizeText(threadKey)
    if (!safeThreadKey) return null
    if (hasD1Store(env)) return readD1BindingRecord(env, safeThreadKey)
    const bindings = await listBindings()
    return bindings.find((item) => item.threadKey === safeThreadKey) || null
  }

  const upsertBinding = async (input = {}) => {
    const nextRecord = normalizeBindingRecord(input)
    if (!nextRecord.threadKey) return null
    if (hasD1Store(env)) {
      const existing = await readD1BindingRecord(env, nextRecord.threadKey)
      const merged = normalizeBindingRecord({
        ...(existing || {}),
        ...nextRecord,
        createdAt: existing?.createdAt || nextRecord.createdAt || Date.now(),
        updatedAt: Date.now()
      })
      cache = null
      return upsertD1BindingRecord(env, merged)
    }
    const current = await load()
    const index = current.bindings.findIndex((item) => item.threadKey === nextRecord.threadKey)
    if (index >= 0) {
      current.bindings[index] = normalizeBindingRecord({
        ...current.bindings[index],
        ...nextRecord,
        createdAt: current.bindings[index].createdAt || nextRecord.createdAt,
        updatedAt: Date.now()
      })
    } else {
      current.bindings.unshift(normalizeBindingRecord({
        ...nextRecord,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }))
    }
    await persist()
    return getBindingByThreadKey(nextRecord.threadKey)
  }

  const patchBinding = async (threadMeta = {}, patch = {}) => {
    const normalizedMeta = normalizeWechatDaemonThreadMeta(threadMeta)
    if (!normalizedMeta.threadKey) return null
    const existing = await getBindingByThreadKey(normalizedMeta.threadKey)
    const mergedInboundUpdates = patch?.pendingInboundUpdates !== undefined
      ? mergeInboundUpdates(existing?.pendingInboundUpdates || [], patch.pendingInboundUpdates)
      : (existing?.pendingInboundUpdates || [])
    return upsertBinding({
      ...(existing || {}),
      ...normalizedMeta,
      ...(patch && typeof patch === 'object' ? patch : {}),
      pendingInboundUpdates: mergedInboundUpdates,
      threadMeta: normalizedMeta
    })
  }

  const appendInboundUpdates = async (threadMeta = {}, updates = [], options = {}) => {
    const normalizedMeta = normalizeWechatDaemonThreadMeta(threadMeta)
    if (!normalizedMeta.threadKey) return null
    const existing = await getBindingByThreadKey(normalizedMeta.threadKey)
    const mergedUpdates = mergeInboundUpdates(existing?.pendingInboundUpdates || [], updates)
    const recentInboundUpdates = mergeRecentInboundUpdates(existing?.recentInboundUpdates || [], updates)
    const now = Date.now()
    const quietSeconds = normalizedMeta.quietSeconds
    const latestInbound = [...mergedUpdates].reverse().find((item) => item.from || item.contextToken) || null
    const quietUntilAt = mergedUpdates.length
      ? now + (Math.max(0, quietSeconds) * 1000)
      : 0
    const autoReplyState = resolveAutoReplyStateFromPending({
      pendingCount: mergedUpdates.length,
      quietSeconds,
      quietUntilAt,
      now
    })
    return upsertBinding({
      ...(existing || {}),
      ...normalizedMeta,
      ...(options && typeof options === 'object' ? options : {}),
      recentInboundUpdates,
      pendingInboundUpdates: mergedUpdates,
      lastInboundFrom: normalizeText(latestInbound?.from || existing?.lastInboundFrom),
      lastInboundContextToken: normalizeText(latestInbound?.contextToken || existing?.lastInboundContextToken),
      quietUntilAt,
      autoReplyState,
      lastAutoReplyReadyAt: autoReplyState === 'ready' ? now : Math.max(0, Number(existing?.lastAutoReplyReadyAt || 0)),
      threadMeta: normalizedMeta
    })
  }

  const appendThreadContextMessages = async (threadKey = '', messages = [], options = {}) => {
    const existing = await getBindingByThreadKey(threadKey)
    if (!existing?.threadKey) return null
    const currentSnapshot = normalizeThreadContextSnapshot(existing.threadContextSnapshot)
    const mergedMessages = mergeThreadContextMessages(currentSnapshot.messages, messages)
    const nextUpdatedAt = Math.max(
      0,
      Number(options?.updatedAt || Date.now())
    )
    const snapshotPatch = options?.snapshotPatch && typeof options.snapshotPatch === 'object'
      ? options.snapshotPatch
      : {}
    return upsertBinding({
      ...existing,
      ...(options?.bindingPatch && typeof options.bindingPatch === 'object' ? options.bindingPatch : {}),
      threadContextSnapshot: {
        ...currentSnapshot,
        ...snapshotPatch,
        updatedAt: nextUpdatedAt,
        messages: mergedMessages
      },
      threadContextUpdatedAt: nextUpdatedAt
    })
  }

  const markAutoReplyReady = async (threadKey = '') => {
    const existing = await getBindingByThreadKey(threadKey)
    if (!existing?.threadKey) return null
    return upsertBinding({
      ...existing,
      autoReplyState: existing.pendingInboundCount > 0 ? 'ready' : 'idle',
      quietUntilAt: existing.pendingInboundCount > 0 ? existing.quietUntilAt : 0,
      lastAutoReplyReadyAt: existing.pendingInboundCount > 0 ? Date.now() : existing.lastAutoReplyReadyAt
    })
  }

  const claimAutoReplyThread = async (threadKey = '') => {
    const existing = await getBindingByThreadKey(threadKey)
    if (!existing?.threadKey) return null
    if (normalizeAutoReplyState(existing.autoReplyState) !== 'ready') return null
    const claimedUpdates = normalizeInboundUpdates(existing.pendingInboundUpdates)
    if (!claimedUpdates.length) return null
    const claimedBinding = await upsertBinding({
      ...existing,
      pendingInboundUpdates: [],
      processingInboundUpdates: claimedUpdates,
      autoReplyState: 'processing',
      quietUntilAt: 0,
      lastAutoReplyStartedAt: Date.now(),
      autoReplyLastError: '',
      nextAutoReplyAttemptAt: 0
    })
    if (!claimedBinding?.threadKey) return claimedBinding
    if (normalizeInboundUpdates(claimedBinding.processingInboundUpdates).length) return claimedBinding
    return normalizeBindingRecord({
      ...claimedBinding,
      processingInboundUpdates: claimedUpdates
    })
  }

  const completeAutoReplyThread = async (threadKey = '', options = {}) => {
    const existing = await getBindingByThreadKey(threadKey)
    if (!existing?.threadKey) return null
    const now = Date.now()
    const remainingPendingUpdates = normalizeInboundUpdates(existing.pendingInboundUpdates)
    const nextQuietUntilAt = remainingPendingUpdates.length ? Math.max(0, Number(existing.quietUntilAt || 0)) : 0
    const nextAutoReplyState = resolveAutoReplyStateFromPending({
      pendingCount: remainingPendingUpdates.length,
      quietSeconds: existing.quietSeconds,
      quietUntilAt: nextQuietUntilAt,
      now
    })
    return upsertBinding({
      ...existing,
      ...(options && typeof options === 'object' ? options : {}),
      processingInboundUpdates: [],
      autoReplyState: nextAutoReplyState,
      quietUntilAt: nextAutoReplyState === 'waiting_quiet' ? nextQuietUntilAt : 0,
      lastAutoReplyQueuedAt: Math.max(
        0,
        Number(options?.lastAutoReplyQueuedAt || options?.queuedAt || now)
      ),
      lastAutoReplyCompletedAt: now,
      nextAutoReplyAttemptAt: 0,
      autoReplyAttemptCount: 0,
      autoReplyLastError: ''
    })
  }

  const failAutoReplyThread = async (threadKey = '', options = {}) => {
    const existing = await getBindingByThreadKey(threadKey)
    if (!existing?.threadKey) return null
    const now = Date.now()
    const mergedPendingUpdates = mergeInboundUpdates(
      existing.pendingInboundUpdates,
      existing.processingInboundUpdates
    )
    const retryDelayMs = Math.max(0, Number(options?.retryDelayMs || 0))
    const nextAttemptAt = mergedPendingUpdates.length ? now + retryDelayMs : 0
    return upsertBinding({
      ...existing,
      ...(options && typeof options === 'object' ? options : {}),
      pendingInboundUpdates: mergedPendingUpdates,
      processingInboundUpdates: [],
      autoReplyState: mergedPendingUpdates.length ? 'ready' : 'idle',
      quietUntilAt: 0,
      lastAutoReplyCompletedAt: now,
      nextAutoReplyAttemptAt: nextAttemptAt,
      autoReplyAttemptCount: mergedPendingUpdates.length
        ? Math.max(0, Number(existing.autoReplyAttemptCount || 0)) + 1
        : 0,
      autoReplyLastError: normalizeText(options?.autoReplyLastError || options?.lastError || '')
    })
  }

  const removeBinding = async (threadMeta = {}, options = {}) => {
    const normalizedMeta = normalizeWechatDaemonThreadMeta(threadMeta)
    const safeBindingId = normalizeText(options.bindingId)
    if (hasD1Store(env)) {
      if (normalizedMeta.threadKey) {
        cache = null
        return removeD1BindingRecord(env, normalizedMeta.threadKey)
      }
      if (!safeBindingId) return false
      const bindings = await listD1BindingRecords(env)
      const matched = bindings.find((item) => normalizeText(item.bindingId) === safeBindingId)
      if (!matched?.threadKey) return false
      cache = null
      return removeD1BindingRecord(env, matched.threadKey)
    }
    const current = await load()
    const before = current.bindings.length
    current.bindings = current.bindings.filter((item) => {
      if (normalizedMeta.threadKey && item.threadKey === normalizedMeta.threadKey) return false
      if (safeBindingId && normalizeText(item.bindingId) === safeBindingId) return false
      return true
    })
    if (current.bindings.length === before) return false
    await persist()
    return true
  }

  return {
    filePath: storageLabel,
    load,
    listBindings,
    getBindingByThreadKey,
    upsertBinding,
    patchBinding,
    appendInboundUpdates,
    appendThreadContextMessages,
    markAutoReplyReady,
    claimAutoReplyThread,
    completeAutoReplyThread,
    failAutoReplyThread,
    removeBinding,
  }
}

let defaultStore = null

export function getWechatDaemonStore(env = process.env) {
  if (!defaultStore) {
    defaultStore = createWechatDaemonStore(env)
  }
  return defaultStore
}
