import fs from 'node:fs/promises'
import path from 'node:path'
import { buildWechatDaemonThreadKey, normalizeWechatDaemonThreadMeta } from './wechatDaemonStore.js'

const STORE_VERSION = 1
const DEFAULT_STORE_RELATIVE_PATH = path.join('data', 'wechat-outbox-store.json')

const normalizeText = (value = '') => String(value || '').trim()
const clone = (value) => JSON.parse(JSON.stringify(value))

function resolveStorePath(env = process.env) {
  const configured = normalizeText(env.WECHAT_OUTBOX_STORE_FILE)
  return path.resolve(configured || DEFAULT_STORE_RELATIVE_PATH)
}

function createEmptyStoreData() {
  return {
    version: STORE_VERSION,
    updatedAt: Date.now(),
    messages: []
  }
}

function normalizeOutboxMessage(input = {}) {
  const safe = input && typeof input === 'object' ? input : {}
  const threadMeta = normalizeWechatDaemonThreadMeta(safe.threadMeta || safe)
  const idempotencyKey = normalizeText(safe.idempotencyKey || safe.idempotency_key || safe.id)
  const id = normalizeText(safe.id)
    || (idempotencyKey ? `wechat_outbox:${idempotencyKey}` : `wechat_outbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  return {
    id,
    threadKey: normalizeText(safe.threadKey) || buildWechatDaemonThreadKey(threadMeta),
    roleId: normalizeText(safe.roleId || threadMeta.roleId),
    accountId: normalizeText(safe.accountId || threadMeta.accountId),
    identity: normalizeText(safe.identity || threadMeta.identity || 'main'),
    chatId: normalizeText(safe.chatId || threadMeta.chatId),
    to: normalizeText(safe.to),
    type: normalizeText(safe.type) || 'text',
    content: normalizeText(safe.content),
    mediaUrl: normalizeText(safe.mediaUrl || safe.media_url),
    mediaMime: normalizeText(safe.mediaMime || safe.media_mime),
    caption: normalizeText(safe.caption),
    contextToken: normalizeText(safe.contextToken),
    source: normalizeText(safe.source) || 'unknown',
    status: normalizeText(safe.status) || 'pending',
    bindingId: normalizeText(safe.bindingId),
    remoteBindingId: normalizeText(safe.remoteBindingId || safe.bindingId),
    clientMessageId: normalizeText(safe.clientMessageId || safe.client_message_id),
    idempotencyKey: idempotencyKey || id,
    messageId: normalizeText(safe.messageId),
    lastError: normalizeText(safe.lastError),
    attemptCount: Math.max(0, Number(safe.attemptCount || 0)),
    nextAttemptAt: Math.max(0, Number(safe.nextAttemptAt || 0)),
    createdAt: Math.max(0, Number(safe.createdAt || Date.now())),
    updatedAt: Math.max(0, Number(safe.updatedAt || Date.now())),
    sentAt: Math.max(0, Number(safe.sentAt || 0))
  }
}

async function ensureParentDir(filePath = '') {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

function hasD1Store(env = process.env) {
  return Boolean(env?.DB && typeof env.DB.prepare === 'function')
}

const rowToOutboxMessage = (row = {}) => normalizeOutboxMessage({
  id: row.id,
  threadKey: row.thread_key,
  roleId: row.role_id,
  accountId: row.account_id,
  identity: row.identity,
  chatId: row.chat_id,
  to: row.to_user,
  type: row.type,
  content: row.content,
  mediaUrl: row.media_url,
  mediaMime: row.media_mime,
  caption: row.caption,
  contextToken: row.context_token,
  source: row.source,
  status: row.status,
  bindingId: row.binding_id,
  remoteBindingId: row.remote_binding_id,
  clientMessageId: row.client_message_id,
  idempotencyKey: row.idempotency_key,
  messageId: row.message_id,
  lastError: row.last_error,
  attemptCount: row.attempt_count,
  nextAttemptAt: row.next_attempt_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  sentAt: row.sent_at
})

const listD1OutboxMessages = async (env = process.env) => {
  const result = await env.DB
    .prepare('SELECT * FROM wechat_outbox_messages ORDER BY created_at ASC')
    .all()
  return (result?.results || []).map((row) => rowToOutboxMessage(row)).filter((item) => item.id)
}

const listD1PendingOutboxMessages = async (env = process.env, limit = 50, now = Date.now()) => {
  const result = await env.DB
    .prepare(`
      SELECT * FROM wechat_outbox_messages
      WHERE (
        (status = 'pending' AND next_attempt_at <= ?)
        OR (status = 'sending' AND next_attempt_at <= ?)
      )
      ORDER BY created_at ASC
      LIMIT ?
    `)
    .bind(now, now, Math.max(1, Number(limit || 50)))
    .all()
  return (result?.results || []).map((row) => rowToOutboxMessage(row)).filter((item) => item.id)
}

const readD1OutboxByIdempotencyKey = async (env = process.env, idempotencyKey = '') => {
  const safeKey = normalizeText(idempotencyKey)
  if (!safeKey) return null
  const row = await env.DB
    .prepare('SELECT * FROM wechat_outbox_messages WHERE idempotency_key = ?')
    .bind(safeKey)
    .first()
  return row ? rowToOutboxMessage(row) : null
}

const readD1OutboxMessage = async (env = process.env, messageId = '') => {
  const safeMessageId = normalizeText(messageId)
  if (!safeMessageId) return null
  const row = await env.DB
    .prepare('SELECT * FROM wechat_outbox_messages WHERE id = ?')
    .bind(safeMessageId)
    .first()
  return row ? rowToOutboxMessage(row) : null
}

const claimD1OutboxMessage = async (env = process.env, messageId = '', options = {}) => {
  const safeMessageId = normalizeText(messageId)
  if (!safeMessageId) return null
  const now = Math.max(0, Number(options?.now || Date.now()))
  const leaseMs = Math.max(5000, Math.min(5 * 60 * 1000, Number(options?.leaseMs || 45 * 1000)))
  const leaseUntil = now + leaseMs
  const result = await env.DB.prepare(`
    UPDATE wechat_outbox_messages
    SET status = 'sending',
        updated_at = ?,
        next_attempt_at = ?
    WHERE id = ?
      AND (
        (status = 'pending' AND next_attempt_at <= ?)
        OR (status = 'sending' AND next_attempt_at <= ?)
      )
  `).bind(now, leaseUntil, safeMessageId, now, now).run()
  const changes = Number(result?.meta?.changes ?? result?.changes ?? 0)
  if (changes <= 0) return null
  return readD1OutboxMessage(env, safeMessageId)
}

const upsertD1OutboxMessage = async (env = process.env, input = {}) => {
  const message = normalizeOutboxMessage(input)
  await env.DB.prepare(`
    INSERT INTO wechat_outbox_messages (
      id, thread_key, role_id, account_id, identity, chat_id, to_user,
      type, content, media_url, media_mime, caption, context_token,
      source, status, binding_id, remote_binding_id, client_message_id,
      idempotency_key, message_id, last_error, attempt_count, next_attempt_at,
      created_at, updated_at, sent_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      thread_key = excluded.thread_key,
      role_id = excluded.role_id,
      account_id = excluded.account_id,
      identity = excluded.identity,
      chat_id = excluded.chat_id,
      to_user = excluded.to_user,
      type = excluded.type,
      content = excluded.content,
      media_url = excluded.media_url,
      media_mime = excluded.media_mime,
      caption = excluded.caption,
      context_token = excluded.context_token,
      source = excluded.source,
      status = excluded.status,
      binding_id = excluded.binding_id,
      remote_binding_id = excluded.remote_binding_id,
      client_message_id = excluded.client_message_id,
      idempotency_key = excluded.idempotency_key,
      message_id = excluded.message_id,
      last_error = excluded.last_error,
      attempt_count = excluded.attempt_count,
      next_attempt_at = excluded.next_attempt_at,
      updated_at = excluded.updated_at,
      sent_at = excluded.sent_at
  `).bind(
    message.id,
    message.threadKey,
    message.roleId,
    message.accountId,
    message.identity,
    message.chatId,
    message.to,
    message.type,
    message.content,
    message.mediaUrl,
    message.mediaMime,
    message.caption,
    message.contextToken,
    message.source,
    message.status,
    message.bindingId,
    message.remoteBindingId,
    message.clientMessageId,
    message.idempotencyKey,
    message.messageId,
    message.lastError,
    message.attemptCount,
    message.nextAttemptAt,
    message.createdAt,
    message.updatedAt,
    message.sentAt
  ).run()
  return readD1OutboxMessage(env, message.id)
}

const insertD1OutboxMessageOnce = async (env = process.env, input = {}) => {
  const message = normalizeOutboxMessage(input)
  const existing = await readD1OutboxByIdempotencyKey(env, message.idempotencyKey)
  if (existing?.id) return existing
  await env.DB.prepare(`
    INSERT INTO wechat_outbox_messages (
      id, thread_key, role_id, account_id, identity, chat_id, to_user,
      type, content, media_url, media_mime, caption, context_token,
      source, status, binding_id, remote_binding_id, client_message_id,
      idempotency_key, message_id, last_error, attempt_count, next_attempt_at,
      created_at, updated_at, sent_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO NOTHING
  `).bind(
    message.id,
    message.threadKey,
    message.roleId,
    message.accountId,
    message.identity,
    message.chatId,
    message.to,
    message.type,
    message.content,
    message.mediaUrl,
    message.mediaMime,
    message.caption,
    message.contextToken,
    message.source,
    message.status,
    message.bindingId,
    message.remoteBindingId,
    message.clientMessageId,
    message.idempotencyKey,
    message.messageId,
    message.lastError,
    message.attemptCount,
    message.nextAttemptAt,
    message.createdAt,
    message.updatedAt,
    message.sentAt
  ).run()
  return readD1OutboxByIdempotencyKey(env, message.idempotencyKey)
    || readD1OutboxMessage(env, message.id)
}

async function readStoreFile(filePath = '') {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      version: STORE_VERSION,
      updatedAt: Math.max(0, Number(parsed?.updatedAt || 0)),
      messages: Array.isArray(parsed?.messages)
        ? parsed.messages.map((item) => normalizeOutboxMessage(item)).filter((item) => item.id)
        : []
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
    messages: Array.isArray(data?.messages) ? data.messages.map((item) => normalizeOutboxMessage(item)) : []
  }
  await ensureParentDir(filePath)
  const tempPath = `${filePath}.tmp`
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8')
  await fs.rename(tempPath, filePath)
  return payload
}

async function readStoreData(env = process.env, filePath = '') {
  if (hasD1Store(env)) {
    const messages = await listD1OutboxMessages(env)
    return {
      version: STORE_VERSION,
      updatedAt: messages.reduce((max, item) => Math.max(max, Number(item.updatedAt || 0)), 0),
      messages
    }
  }
  return readStoreFile(filePath)
}

async function writeStoreData(env = process.env, filePath = '', data = {}) {
  if (hasD1Store(env)) {
    const messages = Array.isArray(data?.messages)
      ? data.messages.map((item) => normalizeOutboxMessage(item)).filter((item) => item.id)
      : []
    for (const message of messages) {
      await upsertD1OutboxMessage(env, message)
    }
    return {
      version: STORE_VERSION,
      updatedAt: Date.now(),
      messages
    }
  }
  return writeStoreFile(filePath, data)
}

export function createWechatOutboxStore(env = process.env) {
  const filePath = resolveStorePath(env)
  const storageLabel = hasD1Store(env) ? 'd1:wechat_outbox_messages' : filePath
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

  const listMessages = async () => {
    if (hasD1Store(env)) return clone(await listD1OutboxMessages(env))
    const current = await load()
    return clone(current.messages || [])
  }

  const listPendingMessages = async (limit = 50, now = Date.now()) => {
    if (hasD1Store(env)) return listD1PendingOutboxMessages(env, limit, now)
    const messages = await listMessages()
    return messages
      .filter((item) => (
        (item.status === 'pending' || item.status === 'sending')
        && Number(item.nextAttemptAt || 0) <= now
      ))
      .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
      .slice(0, Math.max(1, Number(limit || 50)))
  }

  const claimMessage = async (messageId = '', options = {}) => {
    const safeMessageId = normalizeText(messageId)
    if (!safeMessageId) return null
    if (hasD1Store(env)) {
      cache = null
      return clone(await claimD1OutboxMessage(env, safeMessageId, options))
    }
    const now = Math.max(0, Number(options?.now || Date.now()))
    const leaseMs = Math.max(5000, Math.min(5 * 60 * 1000, Number(options?.leaseMs || 45 * 1000)))
    const current = await load()
    const index = current.messages.findIndex((item) => item.id === safeMessageId)
    if (index < 0) return null
    const existing = current.messages[index]
    const isClaimable = (
      (existing.status === 'pending' || existing.status === 'sending')
      && Number(existing.nextAttemptAt || 0) <= now
    )
    if (!isClaimable) return null
    current.messages[index] = normalizeOutboxMessage({
      ...existing,
      status: 'sending',
      nextAttemptAt: now + leaseMs,
      updatedAt: now
    })
    await persist()
    return clone(current.messages[index])
  }

  const enqueueMessage = async (input = {}) => {
    const message = normalizeOutboxMessage(input)
    if (hasD1Store(env)) {
      cache = null
      return clone(await insertD1OutboxMessageOnce(env, message))
    }
    const current = await load()
    const duplicate = current.messages.find((item) => (
      message.idempotencyKey
      && String(item.idempotencyKey || '') === message.idempotencyKey
    ))
    if (duplicate) return clone(duplicate)
    current.messages.push(message)
    await persist()
    return message
  }

  const patchMessage = async (messageId = '', patch = {}) => {
    const safeMessageId = normalizeText(messageId)
    if (!safeMessageId) return null
    if (hasD1Store(env)) {
      const existing = await readD1OutboxMessage(env, safeMessageId)
      if (!existing?.id) return null
      const nextMessage = normalizeOutboxMessage({
        ...existing,
        ...(patch && typeof patch === 'object' ? patch : {}),
        id: safeMessageId,
        updatedAt: Date.now()
      })
      cache = null
      return clone(await upsertD1OutboxMessage(env, nextMessage))
    }
    const current = await load()
    const index = current.messages.findIndex((item) => item.id === safeMessageId)
    if (index < 0) return null
    current.messages[index] = normalizeOutboxMessage({
      ...current.messages[index],
      ...(patch && typeof patch === 'object' ? patch : {}),
      id: safeMessageId,
      updatedAt: Date.now()
    })
    await persist()
    return clone(current.messages[index])
  }

  return {
    filePath: storageLabel,
    load,
    listMessages,
    listPendingMessages,
    claimMessage,
    enqueueMessage,
    patchMessage
  }
}

let defaultStore = null

export function getWechatOutboxStore(env = process.env) {
  if (!defaultStore) {
    defaultStore = createWechatOutboxStore(env)
  }
  return defaultStore
}
