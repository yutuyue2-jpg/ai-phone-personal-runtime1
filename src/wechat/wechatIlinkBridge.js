import {
  getWechatDaemonStore,
  normalizeWechatDaemonThreadMeta
} from './wechatDaemonStore.js'
import { getWechatOutboxStore } from './wechatOutboxStore.js'
import { probeWechatDaemonAiSettings } from './wechatDaemonAutoReplyHandler.js'
import nodeCrypto from 'node:crypto'

const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const ILINK_DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const ILINK_CLIENT_VERSION = '1'
const SESSION_TTL_MS = 10 * 60 * 1000
const BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1000
const ILINK_IMAGE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024
const RECENT_OUTGOING_CLIENT_ID_LIMIT = 24
const RECENT_OUTGOING_CLIENT_ID_TTL_MS = 10 * 60 * 1000

const json = (res, payload, status = 200) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

const normalizeText = (value = '') => String(value || '').trim()

const cloneJson = (value) => JSON.parse(JSON.stringify(value))

const isWechatDaemonStoreDisabled = (env = {}) => ['1', 'true'].includes(
  normalizeText(env.WECHAT_DAEMON_STORE_DISABLED).toLowerCase()
)

const getWechatDaemonStoreSafe = (env = {}) => {
  if (isWechatDaemonStoreDisabled(env)) return null
  try {
    return getWechatDaemonStore(env)
  } catch (error) {
    console.warn('[wechat-ilink] get daemon store failed', error)
    return null
  }
}

const getWechatOutboxStoreSafe = (env = {}) => {
  try {
    return getWechatOutboxStore(env)
  } catch (error) {
    console.warn('[wechat-ilink] get outbox store failed', error)
    return null
  }
}

const getThreadMetaFromInput = (value = null) => normalizeWechatDaemonThreadMeta(
  value && typeof value === 'object' ? value : {}
)

const getThreadContextMessageText = (message = {}) => normalizeText(
  message?.originalText
    || message?.text
    || message?.translatedText
    || message?.transcript
    || message?.description
    || message?.content
)

const buildThreadContextMessageKey = (message = {}) => [
  normalizeText(message?.id),
  normalizeText(message?.role),
  normalizeText(message?.type || 'text') || 'text',
  getThreadContextMessageText(message),
  Math.max(0, Number(message?.timestamp || message?.createdAt || 0))
].join('|')

const mergeThreadContextMessages = (existing = [], incoming = [], limit = 80) => {
  const seen = new Set()
  return [
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(incoming) ? incoming : [])
  ]
    .filter((message) => message && typeof message === 'object')
    .filter((message) => normalizeText(message.id) || getThreadContextMessageText(message))
    .map((message) => cloneJson(message))
    .filter((message) => {
      const key = buildThreadContextMessageKey(message)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => Number(left?.timestamp || left?.createdAt || 0) - Number(right?.timestamp || right?.createdAt || 0))
    .slice(-Math.max(1, Number(limit || 80)))
}

const mergeThreadContextSnapshots = (existing = null, incoming = null) => {
  const base = existing && typeof existing === 'object' ? existing : {}
  const next = incoming && typeof incoming === 'object' ? incoming : {}
  return {
    ...cloneJson(base),
    ...cloneJson(next),
    updatedAt: Math.max(
      0,
      Number(base.updatedAt || 0),
      Number(next.updatedAt || 0),
      Date.now()
    ),
    messages: mergeThreadContextMessages(base.messages, next.messages)
  }
}

const listRecentThreadContextMessages = (binding = null, limit = 40) => {
  const messages = Array.isArray(binding?.threadContextSnapshot?.messages)
    ? binding.threadContextSnapshot.messages
    : []
  return messages
    .slice(-Math.max(1, Number(limit || 40)))
    .map((message) => cloneJson(message))
}

const resolveThreadMeta = (body = {}, state = {}) => {
  const bodyMeta = getThreadMetaFromInput(body?.threadMeta)
  if (bodyMeta.threadKey) return bodyMeta
  const stateMeta = getThreadMetaFromInput(state?.threadMeta)
  if (stateMeta.threadKey) return stateMeta
  return bodyMeta
}

const persistWechatDaemonBinding = async (env = {}, threadMeta = {}, patch = {}) => {
  const normalizedThreadMeta = getThreadMetaFromInput(threadMeta)
  if (!normalizedThreadMeta.threadKey) return null
  const store = getWechatDaemonStoreSafe(env)
  if (!store) return null
  try {
    return await store.patchBinding(normalizedThreadMeta, {
      ...(patch && typeof patch === 'object' ? patch : {}),
      roleId: normalizedThreadMeta.roleId,
      accountId: normalizedThreadMeta.accountId,
      identity: normalizedThreadMeta.identity,
      chatId: normalizedThreadMeta.chatId,
      threadMeta: normalizedThreadMeta
    })
  } catch (error) {
    console.warn('[wechat-ilink] persist daemon binding failed', error)
    return null
  }
}

const getWechatDaemonBindingByThreadMeta = async (env = {}, threadMeta = {}) => {
  const normalizedThreadMeta = getThreadMetaFromInput(threadMeta)
  if (!normalizedThreadMeta.threadKey) return null
  const store = getWechatDaemonStoreSafe(env)
  if (!store) return null
  return store.getBindingByThreadKey(normalizedThreadMeta.threadKey).catch(() => null)
}

const appendWechatDaemonInboundUpdates = async (env = {}, threadMeta = {}, updates = [], options = {}) => {
  const normalizedThreadMeta = getThreadMetaFromInput(threadMeta)
  if (!normalizedThreadMeta.threadKey) return null
  const store = getWechatDaemonStoreSafe(env)
  if (!store) return null
  try {
    return await store.appendInboundUpdates(normalizedThreadMeta, updates, options)
  } catch (error) {
    console.warn('[wechat-ilink] append daemon inbound updates failed', error)
    return null
  }
}

const enqueueWechatDaemonOutboxMessage = async (env = {}, threadMeta = {}, payload = {}) => {
  const normalizedThreadMeta = getThreadMetaFromInput(threadMeta)
  if (!normalizedThreadMeta.threadKey) return null
  const outboxStore = getWechatOutboxStoreSafe(env)
  if (!outboxStore) return null
  const daemonStore = getWechatDaemonStoreSafe(env)
  const binding = daemonStore
    ? await daemonStore.getBindingByThreadKey(normalizedThreadMeta.threadKey).catch(() => null)
    : null
  return outboxStore.enqueueMessage({
    ...normalizedThreadMeta,
    ...(payload && typeof payload === 'object' ? payload : {}),
    threadMeta: normalizedThreadMeta,
    bindingId: normalizeText(payload?.bindingId || binding?.bindingId || binding?.remoteBindingId),
    remoteBindingId: normalizeText(payload?.remoteBindingId || binding?.remoteBindingId || binding?.bindingId),
    to: normalizeText(payload?.to || binding?.lastInboundFrom),
    contextToken: normalizeText(payload?.contextToken || binding?.lastInboundContextToken)
  })
}

const mapOutboxSourceToThreadRole = (source = '') => {
  const value = normalizeText(source)
  if (value === 'pwa_manual') return 'user'
  if (['pwa_ai_reply', 'background_proactive', 'daemon_auto_reply'].includes(value)) return 'assistant'
  return ''
}

const appendOutboxMessageToThreadContext = async (env = {}, threadMeta = {}, outboxMessage = null, source = '') => {
  const normalizedThreadMeta = getThreadMetaFromInput(threadMeta)
  const role = mapOutboxSourceToThreadRole(source || outboxMessage?.source)
  const content = normalizeText(outboxMessage?.content)
  if (!normalizedThreadMeta.threadKey || !role || !content) return null
  const daemonStore = getWechatDaemonStoreSafe(env)
  if (!daemonStore || typeof daemonStore.appendThreadContextMessages !== 'function') return null
  return daemonStore.appendThreadContextMessages(normalizedThreadMeta.threadKey, [{
    id: normalizeText(outboxMessage?.clientMessageId || outboxMessage?.id || outboxMessage?.messageId),
    role,
    type: normalizeText(outboxMessage?.type) === 'image' ? 'image' : 'text',
    text: content,
    originalText: content,
    url: normalizeText(outboxMessage?.mediaUrl),
    mediaUrl: normalizeText(outboxMessage?.mediaUrl),
    caption: normalizeText(outboxMessage?.caption),
    timestamp: Math.max(0, Number(outboxMessage?.createdAt || Date.now())),
    source: normalizeText(source || outboxMessage?.source)
  }], {
    updatedAt: Math.max(0, Number(outboxMessage?.createdAt || Date.now()))
  }).catch((error) => {
    console.warn('[wechat-ilink] append outbox message to thread context failed', {
      threadKey: normalizedThreadMeta.threadKey,
      source,
      error
    })
    return null
  })
}

const normalizeBaseUrl = (value = '') => normalizeText(value || ILINK_DEFAULT_BASE_URL).replace(/\/+$/, '')

const normalizeImageSrc = (value = '') => {
  let text = normalizeText(value)
  if (!text) return ''
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim()
  }
  if (/^(data:image\/|https?:\/\/)/i.test(text)) return text
  if (/^<svg[\s>]/i.test(text)) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
  if (!/^[A-Za-z0-9+/=_-]{80,}$/.test(text)) return ''
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')
  const normalized = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`
  const mime = normalized.startsWith('/9j/')
    ? 'image/jpeg'
    : (normalized.startsWith('iVBOR')
      ? 'image/png'
      : (normalized.startsWith('R0lG')
      ? 'image/gif'
        : (normalized.startsWith('UklGR') ? 'image/webp' : 'image/png')))
  return `data:${mime};base64,${normalized}`
}

const isWechatQrPayloadUrl = (value = '') => {
  const text = normalizeText(value)
  return /^https?:\/\/liteapp\.weixin\.qq\.com\/q\//i.test(text)
    || /[?&]qrcode=/i.test(text)
}

const getRequestBody = (req) => {
  if (req?.body && typeof req.body === 'object') return req.body
  return {}
}

const getQueryValue = (requestUrl = '', key = '') => {
  try {
    return new URL(requestUrl || 'http://localhost').searchParams.get(key) || ''
  } catch {
    return ''
  }
}

const toBase64Url = (bytes) => {
  const binary = Array.from(bytes || [], (byte) => String.fromCharCode(byte)).join('')
  const base64 = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

const fromBase64Url = (value = '') => {
  const base64 = normalizeText(value).replace(/-/g, '+').replace(/_/g, '/')
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`
  const binary = typeof atob === 'function'
    ? atob(padded)
    : Buffer.from(padded, 'base64').toString('binary')
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const getStateSecret = (env = {}) => normalizeText(
  env.WECHAT_ILINK_STATE_SECRET
    || env.WECHAT_BRIDGE_STATE_SECRET
)

const buildRouteHeaders = (env = {}) => {
  const routeTag = normalizeText(env.WECHAT_ILINK_ROUTE_TAG || env.ILINK_ROUTE_TAG)
  return routeTag ? { SKRouteTag: routeTag } : {}
}

const randomWechatUin = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  const value = ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]
  return toBase64Url(new TextEncoder().encode(String(value))).replace(/-/g, '+').replace(/_/g, '/')
}

const importAesKey = async (secret = '') => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

const sealState = async (env = {}, payload = {}) => {
  const secret = getStateSecret(env)
  if (!secret) {
    const error = new Error('missing_wechat_ilink_state_secret')
    error.status = 500
    throw error
  }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await importAesKey(secret)
  const data = new TextEncoder().encode(JSON.stringify(payload))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data))
  return `ilink.${toBase64Url(iv)}.${toBase64Url(encrypted)}`
}

const openState = async (env = {}, token = '') => {
  const secret = getStateSecret(env)
  if (!secret) {
    const error = new Error('missing_wechat_ilink_state_secret')
    error.status = 500
    throw error
  }
  const parts = normalizeText(token).split('.')
  if (parts.length !== 3 || parts[0] !== 'ilink') {
    const error = new Error('invalid_ilink_state')
    error.status = 401
    throw error
  }
  const key = await importAesKey(secret)
  const iv = fromBase64Url(parts[1])
  const encrypted = fromBase64Url(parts[2])
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted)
  return JSON.parse(new TextDecoder().decode(decrypted))
}

const assertStateFresh = (state = {}, ttlMs = SESSION_TTL_MS) => {
  const createdAt = Number(state.createdAt || 0)
  if (!createdAt || Date.now() - createdAt > ttlMs) {
    const error = new Error('ilink_state_expired')
    error.status = 401
    throw error
  }
}

const readIlinkJson = async (response, fallback = 'ilink_request_failed') => {
  const text = await response.text().catch(() => '')
  let payload = {}
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { message: text }
    }
  }
  if (!response.ok) {
    const error = new Error(normalizeText(payload?.errmsg || payload?.message || payload?.error) || fallback)
    error.status = response.status
    error.payload = payload
    throw error
  }
  return payload
}

const ilinkFetchJson = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'iLink-App-ClientVersion': ILINK_CLIENT_VERSION,
      ...buildRouteHeaders(options.env || {}),
      ...(options.headers || {})
    }
  })
  return readIlinkJson(response)
}

const ilinkBusinessFetchJson = async (url, state = {}, payload = {}, env = {}) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${state.botToken}`,
      'X-WECHAT-UIN': randomWechatUin(),
      ...buildRouteHeaders(env)
    },
    body: JSON.stringify({
      ...payload,
      base_info: {
        channel_version: normalizeText(env.WECHAT_ILINK_CHANNEL_VERSION) || 'ai-phone-0.1.0'
      }
    })
  })
  return readIlinkJson(response)
}

const getIlinkBaseUrl = (env = {}, state = {}) => normalizeBaseUrl(
  state.baseUrl
    || env.WECHAT_ILINK_BASE_URL
    || env.ILINK_BASE_URL
)

const normalizeIlinkAccount = (payload = {}) => ({
  externalAccountId: normalizeText(payload.ilink_bot_id || payload.bot_id || payload.openid),
  externalAccountName: normalizeText(payload.nickname || payload.name || payload.alias)
})

const mapLoginStatus = (payload = {}) => {
  const status = normalizeText(payload.status || payload.qrcode_status || payload.state)
  if (payload.bot_token || status === 'confirmed' || status === 'logged_in') return 'bound'
  if (status === 'expired' || status === 'timeout') return 'expired'
  if (status === 'scaned' || status === 'scanned') return 'scanned'
  return status || 'pending'
}

const mapIlinkUpdate = (update = {}) => {
  const message = update.message || update.msg || update
  const sender = message.sender || message.from || update.sender || {}
  const textItems = Array.isArray(message.item_list)
    ? message.item_list
      .map((item) => normalizeText(item?.text_item?.text || item?.text || item?.content))
      .filter(Boolean)
    : []
  return {
    id: normalizeText(message.message_id || message.msg_id || message.msgid || message.id || update.id),
    clientId: normalizeText(message.client_id || message.clientId || update.client_id || update.clientId),
    type: normalizeText(message.message_type || message.msg_type || message.msgtype || message.type || 'text'),
    content: normalizeText(textItems.join('\n') || message.content || message.text || message.message),
    from: normalizeText(message.from_user_id || sender.openid || sender.id || message.from_openid || message.from),
    contextToken: normalizeText(message.context_token || update.context_token),
    createdAt: Number(message.create_time_ms || message.created_at || 0),
    raw: update
  }
}

const normalizeIlinkUserId = (value = '') => normalizeText(value).toLowerCase()

const normalizeRecentOutgoingClientIds = (items = [], now = Date.now()) => (
  Array.isArray(items) ? items : []
)
  .map((item) => {
    if (typeof item === 'string') {
      return {
        id: normalizeText(item),
        sentAt: now
      }
    }
    return {
      id: normalizeText(item?.id || item?.clientId),
      sentAt: Math.max(0, Number(item?.sentAt || item?.createdAt || 0))
    }
  })
  .filter((item) => item.id)
  .filter((item) => !item.sentAt || (now - item.sentAt) <= RECENT_OUTGOING_CLIENT_ID_TTL_MS)
  .sort((left, right) => Number(right?.sentAt || 0) - Number(left?.sentAt || 0))
  .slice(0, RECENT_OUTGOING_CLIENT_ID_LIMIT)

const buildBindingStateWithOutgoingClientId = (state = {}, clientId = '', extra = {}) => {
  const safeClientId = normalizeText(clientId)
  const now = Date.now()
  const recentClientIds = normalizeRecentOutgoingClientIds([
    ...(Array.isArray(state?.recentOutgoingClientIds) ? state.recentOutgoingClientIds : []),
    ...(safeClientId ? [{ id: safeClientId, sentAt: now }] : [])
  ], now)
  return {
    ...state,
    ...(extra && typeof extra === 'object' ? extra : {}),
    recentOutgoingClientIds: recentClientIds,
    createdAt: now,
    updatedAt: now
  }
}

const isSelfIlinkUpdate = (update = {}, state = {}) => {
  const updateFrom = normalizeIlinkUserId(update?.from)
  const botId = normalizeIlinkUserId(state?.botId)
  if (updateFrom && botId && updateFrom === botId) return true
  const updateClientId = normalizeText(update?.clientId)
  if (!updateClientId) return false
  const recentClientIds = normalizeRecentOutgoingClientIds(state?.recentOutgoingClientIds)
  return recentClientIds.some((item) => item.id === updateClientId)
}

const buildTextMessagePayload = (state = {}, input = {}) => {
  const content = normalizeText(input.content || input.text || input.message?.content)
  const to = normalizeText(input.to || input.openid || input.message?.to || input.message?.openid)
  const contextToken = normalizeText(input.contextToken || input.context_token || input.message?.contextToken)
    || normalizeText(state.contextByUser?.[to])
  return {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: normalizeText(input.clientId || input.client_id || input.message?.id) || `ai-phone:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{
        type: 1,
        text_item: { text: content }
      }]
    }
  }
}

const aesEcbPaddedSize = (plaintextSize = 0) => Math.ceil((Number(plaintextSize || 0) + 1) / 16) * 16

const encryptAesEcb = (buffer, key) => {
  const cipher = nodeCrypto.createCipheriv('aes-128-ecb', key, Buffer.alloc(0))
  return Buffer.concat([cipher.update(buffer), cipher.final()])
}

const isPublicHttpUrl = (value = '') => /^https?:\/\//i.test(normalizeText(value))

const resolveIlinkCdnBaseUrl = (env = {}, state = {}) => normalizeBaseUrl(
  state.cdnBaseUrl
    || env.WECHAT_ILINK_CDN_BASE_URL
    || env.ILINK_CDN_BASE_URL
    || ILINK_DEFAULT_CDN_BASE_URL
)

const fetchMediaBuffer = async (mediaUrl = '') => {
  const url = normalizeText(mediaUrl)
  if (!isPublicHttpUrl(url)) {
    const error = new Error('wechat_media_url_not_public')
    error.status = 400
    throw error
  }
  const response = await fetch(url)
  if (!response.ok) {
    const error = new Error(`wechat_media_fetch_failed:${response.status}`)
    error.status = 502
    throw error
  }
  const arrayBuffer = await response.arrayBuffer()
  if (arrayBuffer.byteLength > ILINK_IMAGE_UPLOAD_MAX_BYTES) {
    const error = new Error('wechat_media_too_large')
    error.status = 413
    throw error
  }
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: normalizeText(response.headers.get('content-type')).split(';')[0].toLowerCase()
  }
}

const resolveWechatIlinkUploadUrl = (env = {}, state = {}, uploadResp = {}, filekey = '') => {
  const safe = uploadResp && typeof uploadResp === 'object' ? uploadResp : {}
  const nested = safe.data && typeof safe.data === 'object' ? safe.data : {}
  const uploadFullUrl = normalizeText(
    safe.upload_full_url
      || safe.uploadFullUrl
      || nested.upload_full_url
      || nested.uploadFullUrl
  )
  if (isPublicHttpUrl(uploadFullUrl)) return uploadFullUrl
  const uploadParam = normalizeText(
    safe.upload_param
      || safe.uploadParam
      || nested.upload_param
      || nested.uploadParam
  )
  if (!uploadParam) return ''
  return `${resolveIlinkCdnBaseUrl(env, state)}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

const uploadWechatIlinkImageFromUrl = async ({
  env = {},
  state = {},
  baseUrl = '',
  to = '',
  mediaUrl = ''
} = {}) => {
  const { buffer } = await fetchMediaBuffer(mediaUrl)
  const rawsize = buffer.length
  const rawfilemd5 = nodeCrypto.createHash('md5').update(buffer).digest('hex')
  const filesize = aesEcbPaddedSize(rawsize)
  const filekey = nodeCrypto.randomBytes(16).toString('hex')
  const aeskey = nodeCrypto.randomBytes(16)
  const uploadResp = await ilinkBusinessFetchJson(`${baseUrl}/ilink/bot/getuploadurl`, state, {
    filekey,
    media_type: 1,
    to_user_id: to,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString('hex')
  }, env)
  const uploadUrl = resolveWechatIlinkUploadUrl(env, state, uploadResp, filekey)
  if (!uploadUrl) {
    const error = new Error('wechat_media_upload_param_missing')
    error.status = 502
    error.payload = uploadResp
    throw error
  }
  const ciphertext = encryptAesEcb(buffer, aeskey)
  const uploadResult = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(ciphertext)
  })
  if (uploadResult.status !== 200) {
    const errorText = normalizeText(uploadResult.headers.get('x-error-message')) || await uploadResult.text().catch(() => '')
    const error = new Error(`wechat_media_cdn_upload_failed:${uploadResult.status}:${errorText}`)
    error.status = 502
    throw error
  }
  const downloadEncryptedQueryParam = normalizeText(uploadResult.headers.get('x-encrypted-param'))
  if (!downloadEncryptedQueryParam) {
    const error = new Error('wechat_media_cdn_param_missing')
    error.status = 502
    throw error
  }
  return {
    downloadEncryptedQueryParam,
    aeskey: aeskey.toString('hex'),
    fileSizeCiphertext: filesize
  }
}

const buildImageMessagePayload = (state = {}, input = {}, uploaded = {}) => {
  const to = normalizeText(input.to || input.openid || input.message?.to || input.message?.openid)
  const contextToken = normalizeText(input.contextToken || input.context_token || input.message?.contextToken)
    || normalizeText(state.contextByUser?.[to])
  return {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: normalizeText(input.clientId || input.client_id || input.message?.id) || `ai-phone:image:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{
        type: 2,
        image_item: {
          media: {
            encrypt_query_param: uploaded.downloadEncryptedQueryParam,
            aes_key: Buffer.from(uploaded.aeskey, 'hex').toString('base64'),
            encrypt_type: 1
          },
          mid_size: uploaded.fileSizeCiphertext
        }
      }]
    }
  }
}

const buildTypingConfigPayload = (input = {}) => ({
  ilink_user_id: normalizeText(input.ilinkUserId || input.ilink_user_id || input.to || input.openid),
  context_token: normalizeText(input.contextToken || input.context_token)
})

const buildTypingPayload = (input = {}) => ({
  ilink_user_id: normalizeText(input.ilinkUserId || input.ilink_user_id || input.to || input.openid),
  typing_ticket: normalizeText(input.typingTicket || input.typing_ticket),
  status: Number(input.status || 1) === 2 ? 2 : 1
})

const handleStartLogin = async (req, res, env) => {
  const body = getRequestBody(req)
  const threadMeta = getThreadMetaFromInput(body?.threadMeta)
  const baseUrl = getIlinkBaseUrl(env)
  const target = new URL(`${baseUrl}/ilink/bot/get_bot_qrcode`)
  target.searchParams.set('bot_type', normalizeText(env.WECHAT_ILINK_BOT_TYPE) || '3')
  const payload = await ilinkFetchJson(target.toString(), { method: 'GET', env })
  const qrcode = normalizeText(payload.qrcode || payload.qr_code || payload.ticket)
  if (!qrcode) {
    json(res, {
      ok: false,
      error: 'ilink_qrcode_missing',
      message: 'iLink did not return a qrcode value.'
    }, 502)
    return
  }
  const sessionId = await sealState(env, {
    kind: 'login',
    baseUrl,
    qrcode,
    threadMeta,
    createdAt: Date.now()
  })
  await persistWechatDaemonBinding(env, threadMeta, {
    status: 'pending',
    bridgeType: 'ilink',
    sessionId,
    lastLoginStartedAt: Date.now(),
    bridgeUrl: normalizeText(body?.bridgeUrl)
  })
  json(res, {
    ok: true,
    sessionId,
    qrCodeUrl: normalizeText(payload.qrcode_img_url || payload.qrCodeUrl || payload.qrcode_img_content),
    qrCodeImage: isWechatQrPayloadUrl(payload.qrcode_img_content || payload.qrCodeImage)
      ? ''
      : normalizeImageSrc(payload.qrcode_img_content || payload.qrCodeImage),
    qrcode
  })
}

const handleLoginStatus = async (req, res, env) => {
  const sessionId = getQueryValue(req?.url, 'sessionId')
  const state = await openState(env, sessionId)
  assertStateFresh(state)
  const threadMeta = getThreadMetaFromInput(state?.threadMeta)
  const baseUrl = getIlinkBaseUrl(env, state)
  const target = new URL(`${baseUrl}/ilink/bot/get_qrcode_status`)
  target.searchParams.set('qrcode', state.qrcode)
  const payload = await ilinkFetchJson(target.toString(), { method: 'GET', env })
  const status = mapLoginStatus(payload)
  const account = normalizeIlinkAccount(payload)
  let bindingId = ''
  if (status === 'bound' && payload.bot_token) {
    bindingId = await sealState(env, {
      kind: 'binding',
      baseUrl: normalizeBaseUrl(payload.baseurl || payload.baseUrl || baseUrl),
      botToken: normalizeText(payload.bot_token),
      botId: account.externalAccountId,
      syncBuf: '',
      contextByUser: {},
      createdAt: Date.now()
    })
  }
  await persistWechatDaemonBinding(env, threadMeta, {
    status,
    sessionId,
    bindingId,
    remoteBindingId: bindingId,
    externalAccountId: account.externalAccountId,
    externalAccountName: account.externalAccountName,
    lastStatusCheckedAt: Date.now(),
    lastError: ''
  })
  json(res, {
    ok: true,
    status,
    bindingId,
    remoteBindingId: bindingId,
    ...account,
    raw: {
      errmsg: payload.errmsg,
      status: payload.status || payload.qrcode_status || payload.state
    }
  })
}

const openBindingState = async (env = {}, bindingId = '') => {
  const state = await openState(env, bindingId)
  assertStateFresh(state, BINDING_TTL_MS)
  if (state.kind !== 'binding' || !state.botToken) {
    const error = new Error('invalid_ilink_binding')
    error.status = 401
    throw error
  }
  return state
}

const resolveWechatBindingAccess = async (env = {}, {
  bindingId = '',
  threadMeta = null,
  message = null
} = {}) => {
  const inputThreadMeta = resolveThreadMeta({ threadMeta, message }, {})
  const storedBinding = await getWechatDaemonBindingByThreadMeta(env, inputThreadMeta)
  const storedBindingId = normalizeText(storedBinding?.bindingId || storedBinding?.remoteBindingId)
  const requestBindingId = normalizeText(bindingId)
  const preferredBindingId = storedBindingId || requestBindingId
  if (!preferredBindingId) {
    const error = new Error('missing_ilink_binding')
    error.status = 401
    throw error
  }

  try {
    const state = await openBindingState(env, preferredBindingId)
    return {
      state,
      bindingId: preferredBindingId,
      threadMeta: resolveThreadMeta({ threadMeta, message }, state)
    }
  } catch (error) {
    if (!requestBindingId || requestBindingId === preferredBindingId) throw error
    const state = await openBindingState(env, requestBindingId)
    return {
      state,
      bindingId: requestBindingId,
      threadMeta: resolveThreadMeta({ threadMeta, message }, state)
    }
  }
}

export const syncWechatIlinkBinding = async ({
  env = {},
  bindingId = '',
  threadMeta = null
} = {}) => {
  const bindingAccess = await resolveWechatBindingAccess(env, { bindingId, threadMeta })
  const state = bindingAccess.state
  const resolvedThreadMeta = bindingAccess.threadMeta
  const existingBinding = await getWechatDaemonBindingByThreadMeta(env, resolvedThreadMeta)
  const baseUrl = getIlinkBaseUrl(env, state)
  const payload = await ilinkBusinessFetchJson(`${baseUrl}/ilink/bot/getupdates`, state, {
    get_updates_buf: normalizeText(state.syncBuf)
  }, env)
  const rawUpdates = Array.isArray(payload.msgs)
    ? payload.msgs
    : (Array.isArray(payload.updates)
      ? payload.updates
      : (Array.isArray(payload.msg_list) ? payload.msg_list : []))
  const updates = rawUpdates.map(mapIlinkUpdate).filter((item) => item.id || item.content)
  const inboundUpdates = updates.filter((item) => !isSelfIlinkUpdate(item, state))
  const selfEchoUpdates = updates.filter((item) => isSelfIlinkUpdate(item, state))
  const contextByUser = { ...(state.contextByUser || {}) }
  inboundUpdates.forEach((update) => {
    if (update.from && update.contextToken) contextByUser[update.from] = update.contextToken
  })
  const nextBindingId = await sealState(env, buildBindingStateWithOutgoingClientId(state, '', {
    threadMeta: resolvedThreadMeta,
    syncBuf: normalizeText(payload.get_updates_buf || payload.syncbuf || payload.next_syncbuf || state.syncBuf),
    contextByUser
  }))
  const latestInbound = [...inboundUpdates].reverse().find((item) => item.from || item.contextToken) || null
  const latestInboundAt = inboundUpdates.reduce(
    (maxTs, update) => Math.max(maxTs, Number(update?.createdAt || 0)),
    0
  )
  await persistWechatDaemonBinding(env, resolvedThreadMeta, {
    status: 'bound',
    bindingId: nextBindingId,
    remoteBindingId: nextBindingId,
    externalAccountId: normalizeText(state?.botId),
    lastSyncedAt: Date.now(),
    lastInboundAt: latestInboundAt || Number(existingBinding?.lastInboundAt || 0),
    lastInboundFrom: normalizeText(latestInbound?.from || existingBinding?.lastInboundFrom),
    lastInboundContextToken: normalizeText(latestInbound?.contextToken || existingBinding?.lastInboundContextToken),
    lastError: ''
  })
  if (inboundUpdates.length) {
    await appendWechatDaemonInboundUpdates(env, resolvedThreadMeta, inboundUpdates, {
      status: 'bound',
      bindingId: nextBindingId,
      remoteBindingId: nextBindingId,
      lastSyncedAt: Date.now(),
      lastInboundAt: latestInboundAt || 0,
      lastError: ''
    })
  }
  const daemonStore = getWechatDaemonStoreSafe(env)
  const latestBinding = daemonStore
    ? await daemonStore.getBindingByThreadKey(resolvedThreadMeta.threadKey).catch(() => null)
    : null
  const recentInboundUpdates = Array.isArray(latestBinding?.recentInboundUpdates)
    ? latestBinding.recentInboundUpdates
    : []
  return {
    updates: inboundUpdates,
    recentInboundUpdates: recentInboundUpdates.length ? recentInboundUpdates : inboundUpdates,
    recentThreadMessages: listRecentThreadContextMessages(latestBinding),
    bindingId: nextBindingId,
    remoteBindingId: nextBindingId,
    latestInboundAt
  }
}

const handleSyncNow = async (req, res, env) => {
  const body = getRequestBody(req)
  const result = await syncWechatIlinkBinding({
    env,
    bindingId: body.bindingId,
    threadMeta: body.threadMeta
  })
  json(res, {
    ok: true,
    updates: result.updates,
    recentInboundUpdates: Array.isArray(result.recentInboundUpdates)
      ? result.recentInboundUpdates
      : [],
    recentThreadMessages: Array.isArray(result.recentThreadMessages)
      ? result.recentThreadMessages
      : [],
    bindingId: result.bindingId,
    remoteBindingId: result.remoteBindingId,
    latestInboundAt: Number(result.latestInboundAt || 0)
  })
}

export const sendWechatIlinkTextMessage = async ({
  env = {},
  bindingId = '',
  message = null,
  threadMeta = null
} = {}) => {
  const bindingAccess = await resolveWechatBindingAccess(env, { bindingId, threadMeta, message })
  const state = bindingAccess.state
  const activeBindingId = bindingAccess.bindingId
  const resolvedThreadMeta = bindingAccess.threadMeta
  const baseUrl = getIlinkBaseUrl(env, state)
  const payload = buildTextMessagePayload(state, message || {})
  if (!payload.msg.item_list[0]?.text_item?.text) {
    const error = new Error('empty_wechat_message')
    error.status = 400
    throw error
  }
  if (!payload.msg.context_token) {
    const error = new Error('missing_context_token')
    error.status = 400
    throw error
  }
  const result = await ilinkBusinessFetchJson(`${baseUrl}/ilink/bot/sendmessage`, state, payload, env)
  const nextBindingId = await sealState(env, buildBindingStateWithOutgoingClientId(state, payload.msg.client_id, {
    threadMeta: resolvedThreadMeta
  }))
  await persistWechatDaemonBinding(env, resolvedThreadMeta, {
    status: 'bound',
    bindingId: nextBindingId,
    remoteBindingId: nextBindingId,
    lastSentAt: Date.now(),
    lastError: ''
  })
  return {
    ok: true,
    messageId: normalizeText(result.msg_id || result.msgid || result.id),
    raw: result
  }
}

export const sendWechatIlinkMediaMessage = async ({
  env = {},
  bindingId = '',
  message = null,
  threadMeta = null
} = {}) => {
  let bindingAccess = await resolveWechatBindingAccess(env, { bindingId, threadMeta, message })
  let state = bindingAccess.state
  let activeBindingId = bindingAccess.bindingId
  let resolvedThreadMeta = bindingAccess.threadMeta
  let baseUrl = getIlinkBaseUrl(env, state)
  const safeMessage = message && typeof message === 'object' ? message : {}
  const to = normalizeText(safeMessage.to || safeMessage.openid)
  let contextToken = normalizeText(safeMessage.contextToken || safeMessage.context_token)
    || normalizeText(state.contextByUser?.[to])
  const mediaUrl = normalizeText(safeMessage.mediaUrl || safeMessage.media_url)
  const caption = normalizeText(safeMessage.caption || safeMessage.content)
  if (!to) {
    const error = new Error('missing_wechat_media_target')
    error.status = 400
    throw error
  }
  if (!contextToken) {
    const error = new Error('missing_context_token')
    error.status = 400
    throw error
  }
  if (!mediaUrl) {
    const error = new Error('missing_wechat_media_url')
    error.status = 400
    throw error
  }
  if (caption) {
    await sendWechatIlinkTextMessage({
      env,
      bindingId: activeBindingId,
      threadMeta: resolvedThreadMeta,
      message: {
        to,
        content: caption,
        contextToken
      }
    })
    bindingAccess = await resolveWechatBindingAccess(env, { bindingId: activeBindingId, threadMeta: resolvedThreadMeta, message })
    state = bindingAccess.state
    activeBindingId = bindingAccess.bindingId
    resolvedThreadMeta = bindingAccess.threadMeta
    baseUrl = getIlinkBaseUrl(env, state)
    contextToken = normalizeText(safeMessage.contextToken || safeMessage.context_token)
      || normalizeText(state.contextByUser?.[to])
  }
  const uploaded = await uploadWechatIlinkImageFromUrl({
    env,
    state,
    baseUrl,
    to,
    mediaUrl
  })
  const payload = buildImageMessagePayload(state, {
    ...safeMessage,
    to,
    contextToken
  }, uploaded)
  const result = await ilinkBusinessFetchJson(`${baseUrl}/ilink/bot/sendmessage`, state, payload, env)
  const nextBindingId = await sealState(env, buildBindingStateWithOutgoingClientId(state, payload.msg.client_id, {
    threadMeta: resolvedThreadMeta
  }))
  await persistWechatDaemonBinding(env, resolvedThreadMeta, {
    status: 'bound',
    bindingId: nextBindingId,
    remoteBindingId: nextBindingId,
    lastSentAt: Date.now(),
    lastError: ''
  })
  return {
    ok: true,
    messageId: normalizeText(result.msg_id || result.msgid || result.id || payload.msg.client_id),
    raw: result
  }
}

export const sendWechatIlinkTypingIndicator = async ({
  env = {},
  bindingId = '',
  threadMeta = null,
  to = '',
  contextToken = '',
  status = 1
} = {}) => {
  const bindingAccess = await resolveWechatBindingAccess(env, { bindingId, threadMeta })
  const state = bindingAccess.state
  const activeBindingId = bindingAccess.bindingId
  const resolvedThreadMeta = bindingAccess.threadMeta
  const baseUrl = getIlinkBaseUrl(env, state)
  const ilinkUserId = normalizeText(to || resolvedThreadMeta.lastInboundFrom)
  if (!ilinkUserId) {
    const error = new Error('missing_typing_user_id')
    error.status = 400
    throw error
  }
  const config = await ilinkBusinessFetchJson(`${baseUrl}/ilink/bot/getconfig`, state, buildTypingConfigPayload({
    ilinkUserId,
    contextToken
  }), env)
  const typingTicket = normalizeText(
    config.typing_ticket
    || config.typingTicket
    || config.data?.typing_ticket
    || config.data?.typingTicket
  )
  if (!typingTicket) {
    const error = new Error('missing_typing_ticket')
    error.status = 502
    error.payload = config
    throw error
  }
  const result = await ilinkBusinessFetchJson(`${baseUrl}/ilink/bot/sendtyping`, state, buildTypingPayload({
    ilinkUserId,
    typingTicket,
    status
  }), env)
  await persistWechatDaemonBinding(env, resolvedThreadMeta, {
    status: 'bound',
    bindingId: activeBindingId,
    remoteBindingId: activeBindingId,
    lastTypingAt: Date.now(),
    lastError: ''
  })
  return {
    ok: true,
    status: Number(status || 1) === 2 ? 2 : 1,
    raw: result
  }
}

const handleSend = async (req, res, env) => {
  const body = getRequestBody(req)
  const result = await sendWechatIlinkTextMessage({
    env,
    bindingId: body.bindingId,
    message: body.message,
    threadMeta: body.threadMeta
  })
  json(res, {
    ok: result.ok,
    messageId: result.messageId,
    raw: result.raw
  })
}

const handleConfig = async (req, res, env) => {
  const body = getRequestBody(req)
  const threadMeta = getThreadMetaFromInput(body?.threadMeta)
  const existingBinding = await getWechatDaemonBindingByThreadMeta(env, threadMeta)
  const existingBindingId = normalizeText(existingBinding?.bindingId || existingBinding?.remoteBindingId)
  const requestBindingId = normalizeText(body?.bindingId)
  const nextBindingId = existingBindingId || requestBindingId
  const patch = body?.config && typeof body.config === 'object'
    ? {
        wechatReplyTriggersAi: body.config.wechatReplyTriggersAi,
        pwaChatToWechat: body.config.pwaChatToWechat,
        quietSeconds: body.config.quietSeconds,
        ...(nextBindingId ? {
          bindingId: nextBindingId,
          remoteBindingId: nextBindingId
        } : {})
      }
    : {}
  const result = await persistWechatDaemonBinding(env, threadMeta, patch)
  json(res, {
    ok: true,
    binding: result
  })
}

const handleThreadContext = async (req, res, env) => {
  const body = getRequestBody(req)
  const threadMeta = getThreadMetaFromInput(body?.threadMeta)
  const snapshot = body?.snapshot && typeof body.snapshot === 'object'
    ? body.snapshot
    : null
  if (!threadMeta.threadKey) {
    json(res, {
      ok: false,
      error: 'missing_thread_meta',
      message: 'Thread meta is required.'
    }, 400)
    return
  }
  const existingBinding = await getWechatDaemonBindingByThreadMeta(env, threadMeta)
  const existingBindingId = normalizeText(existingBinding?.bindingId || existingBinding?.remoteBindingId)
  const requestBindingId = normalizeText(body?.bindingId)
  const nextBindingId = existingBindingId || requestBindingId
  const mergedSnapshot = mergeThreadContextSnapshots(existingBinding?.threadContextSnapshot, snapshot)
  const result = await persistWechatDaemonBinding(env, threadMeta, {
    ...(nextBindingId ? {
      bindingId: nextBindingId,
      remoteBindingId: nextBindingId
    } : {}),
    threadContextSnapshot: mergedSnapshot,
    threadContextUpdatedAt: Math.max(0, Number(mergedSnapshot?.updatedAt || Date.now()))
  })
  const daemonAiStatus = await probeWechatDaemonAiSettings(env, {
    binding: result,
    threadContext: result?.threadContextSnapshot
  }).catch((error) => ({
    ok: false,
    error: normalizeText(error?.message) || 'wechat_daemon_ai_probe_failed',
    userMessage: normalizeText(error?.message) || '后台 AI 配置检查失败'
  }))
  json(res, {
    ok: true,
    binding: result,
    daemonAiStatus
  })
}

const handleOutboxEnqueue = async (req, res, env) => {
  const body = getRequestBody(req)
  const threadMeta = getThreadMetaFromInput(body?.threadMeta)
  const content = normalizeText(
    body?.message?.content
    || body?.message?.text
    || body?.content
    || body?.text
  )
  const messageType = normalizeText(body?.message?.type || body?.type || 'text') || 'text'
  const mediaUrl = normalizeText(body?.message?.mediaUrl || body?.message?.media_url || body?.mediaUrl || body?.media_url)
  if (!content && !(messageType === 'image' && mediaUrl)) {
    json(res, {
      ok: false,
      error: 'empty_wechat_message',
      message: 'Message content is empty.'
    }, 400)
    return
  }
  const enqueued = await enqueueWechatDaemonOutboxMessage(env, threadMeta, {
    source: normalizeText(body?.source) || 'manual',
    type: messageType,
    content,
    mediaUrl,
    mediaMime: normalizeText(body?.message?.mediaMime || body?.message?.media_mime || body?.mediaMime || body?.media_mime),
    caption: normalizeText(body?.message?.caption || body?.caption),
    bindingId: normalizeText(body?.bindingId),
    remoteBindingId: normalizeText(body?.bindingId),
    to: normalizeText(body?.message?.to || body?.to),
    contextToken: normalizeText(body?.message?.contextToken || body?.contextToken),
    clientMessageId: normalizeText(body?.message?.id || body?.clientMessageId),
    idempotencyKey: normalizeText(body?.idempotencyKey || body?.message?.id || body?.clientMessageId)
  })
  await appendOutboxMessageToThreadContext(env, threadMeta, enqueued, normalizeText(body?.source) || 'manual')
  json(res, {
    ok: true,
    queued: !!enqueued,
    outboxMessage: enqueued
  })
}

const handleUnbind = async (req, res, env) => {
  const body = getRequestBody(req)
  const threadMeta = getThreadMetaFromInput(body?.threadMeta)
  const store = getWechatDaemonStoreSafe(env)
  if (store) {
    try {
      await store.removeBinding(threadMeta, { bindingId: normalizeText(body?.bindingId) })
    } catch (error) {
      console.warn('[wechat-ilink] remove daemon binding failed', error)
    }
  }
  json(res, { ok: true })
}

export async function handleWechatIlinkBridge(req, res, env = {}, routePath = '') {
  try {
    if (routePath === '/wechat/login/start') {
      await handleStartLogin(req, res, env)
      return true
    }
    if (routePath === '/wechat/login/status') {
      await handleLoginStatus(req, res, env)
      return true
    }
    if (routePath === '/wechat/sync-now') {
      await handleSyncNow(req, res, env)
      return true
    }
    if (routePath === '/wechat/send') {
      await handleSend(req, res, env)
      return true
    }
    if (routePath === '/wechat/config') {
      await handleConfig(req, res, env)
      return true
    }
    if (routePath === '/wechat/thread-context') {
      await handleThreadContext(req, res, env)
      return true
    }
    if (routePath === '/wechat/outbox/enqueue') {
      await handleOutboxEnqueue(req, res, env)
      return true
    }
    if (routePath === '/wechat/unbind') {
      await handleUnbind(req, res, env)
      return true
    }
    return false
  } catch (error) {
    json(res, {
      ok: false,
      error: normalizeText(error?.message) || 'wechat_ilink_failed',
      message: normalizeText(error?.message) || 'wechat ilink request failed'
    }, Number(error?.status || 502))
    return true
  }
}
