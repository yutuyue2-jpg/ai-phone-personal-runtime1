const normalizeText = (value = '') => String(value || '').trim()
const nowMs = () => Date.now()

const safeJson = (value, fallback) => {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const safeDeviceId = (value = '') => normalizeText(value).replace(/[^\w:-]/g, '').slice(0, 160)

const normalizeMessageId = (message = {}) => normalizeText(message?.messageId || message?.id)

const assertDb = (env = {}) => {
  if (!env?.DB || typeof env.DB.prepare !== 'function') {
    throw new Error('missing_d1_binding')
  }
}

export const registerBackgroundDevice = async (env = {}, deviceId = '') => {
  assertDb(env)
  const id = safeDeviceId(deviceId)
  if (!id) return null
  const now = nowMs()
  await env.DB.prepare(`
    INSERT INTO background_devices (device_id, created_at, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET updated_at = excluded.updated_at
  `).bind(id, now, now).run()
  return id
}

export const listBackgroundDeviceIds = async (env = {}, limit = 2000) => {
  assertDb(env)
  const result = await env.DB.prepare(`
    SELECT device_id FROM background_devices
    ORDER BY updated_at DESC
    LIMIT ?
  `).bind(Math.max(1, Math.min(5000, Number(limit || 2000)))).all()
  return (result?.results || []).map((row) => safeDeviceId(row.device_id)).filter(Boolean)
}

export const getRuntimeSetting = async (env = {}, key = '', fallback = null) => {
  assertDb(env)
  const safeKey = normalizeText(key)
  if (!safeKey) return fallback
  const row = await env.DB
    .prepare('SELECT value_json FROM runtime_settings WHERE key = ?')
    .bind(safeKey)
    .first()
  return safeJson(row?.value_json, fallback)
}

export const putRuntimeSetting = async (env = {}, key = '', value = null) => {
  assertDb(env)
  const safeKey = normalizeText(key)
  if (!safeKey) return null
  const now = nowMs()
  await env.DB.prepare(`
    INSERT INTO runtime_settings (key, value_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).bind(safeKey, JSON.stringify(value), now, now).run()
  return value
}

export const getBackgroundSnapshot = async (env = {}, deviceId = '') => {
  assertDb(env)
  const id = safeDeviceId(deviceId)
  if (!id) return null
  const row = await env.DB
    .prepare('SELECT snapshot_json FROM background_snapshots WHERE device_id = ?')
    .bind(id)
    .first()
  return safeJson(row?.snapshot_json, null)
}

export const putBackgroundSnapshot = async (env = {}, deviceId = '', snapshot = {}) => {
  assertDb(env)
  const id = await registerBackgroundDevice(env, deviceId)
  if (!id) return null
  const now = nowMs()
  const nextSnapshot = {
    ...(snapshot && typeof snapshot === 'object' ? snapshot : {}),
    updatedAt: now
  }
  await env.DB.prepare(`
    INSERT INTO background_snapshots (device_id, snapshot_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      snapshot_json = excluded.snapshot_json,
      updated_at = excluded.updated_at
  `).bind(id, JSON.stringify(nextSnapshot), now).run()
  return nextSnapshot
}

export const getPushSubscription = async (env = {}, deviceId = '') => {
  assertDb(env)
  const id = safeDeviceId(deviceId)
  if (!id) return null
  const row = await env.DB
    .prepare('SELECT subscription_json FROM push_subscriptions WHERE device_id = ?')
    .bind(id)
    .first()
  return safeJson(row?.subscription_json, null)
}

export const putPushSubscription = async (env = {}, deviceId = '', subscription = {}) => {
  assertDb(env)
  const id = await registerBackgroundDevice(env, deviceId)
  if (!id) return null
  const now = nowMs()
  await env.DB.prepare(`
    INSERT INTO push_subscriptions (device_id, subscription_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      subscription_json = excluded.subscription_json,
      updated_at = excluded.updated_at
  `).bind(id, JSON.stringify(subscription || {}), now, now).run()
  return subscription
}

export const deletePushSubscription = async (env = {}, deviceId = '') => {
  assertDb(env)
  const id = safeDeviceId(deviceId)
  if (!id) return false
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').bind(id).run()
  return true
}

export const getBackgroundAiKeyPayload = async (env = {}, deviceId = '') => {
  assertDb(env)
  const id = safeDeviceId(deviceId)
  if (!id) return null
  const row = await env.DB
    .prepare('SELECT encrypted_json FROM background_ai_keys WHERE device_id = ?')
    .bind(id)
    .first()
  return safeJson(row?.encrypted_json, null)
}

export const putBackgroundAiKeyPayload = async (env = {}, deviceId = '', encryptedPayload = {}) => {
  assertDb(env)
  const id = await registerBackgroundDevice(env, deviceId)
  if (!id) return null
  const now = nowMs()
  await env.DB.prepare(`
    INSERT INTO background_ai_keys (device_id, encrypted_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      encrypted_json = excluded.encrypted_json,
      updated_at = excluded.updated_at
  `).bind(id, JSON.stringify(encryptedPayload || {}), now).run()
  return encryptedPayload
}

export const deleteBackgroundAiKeyPayload = async (env = {}, deviceId = '') => {
  assertDb(env)
  const id = safeDeviceId(deviceId)
  if (!id) return false
  await env.DB.prepare('DELETE FROM background_ai_keys WHERE device_id = ?').bind(id).run()
  return true
}

export const getPendingMessages = async (env = {}, deviceId = '') => {
  assertDb(env)
  const id = safeDeviceId(deviceId)
  if (!id) return []
  const result = await env.DB.prepare(`
    SELECT message_json FROM background_pending_messages
    WHERE device_id = ?
    ORDER BY created_at ASC
  `).bind(id).all()
  return (result?.results || [])
    .map((row) => safeJson(row.message_json, null))
    .filter(Boolean)
}

export const appendPendingMessage = async (env = {}, deviceId = '', message = {}, limit = 20) => {
  assertDb(env)
  const id = await registerBackgroundDevice(env, deviceId)
  if (!id) return null
  const now = nowMs()
  const messageId = normalizeMessageId(message) || `pending_${now}_${crypto.randomUUID()}`
  const nextMessage = {
    ...(message && typeof message === 'object' ? message : {}),
    messageId
  }
  await env.DB.prepare(`
    INSERT INTO background_pending_messages (id, device_id, role_id, message_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      message_json = excluded.message_json,
      updated_at = excluded.updated_at
  `).bind(
    messageId,
    id,
    normalizeText(nextMessage.roleId),
    JSON.stringify(nextMessage),
    Number(nextMessage.createdAt || now),
    now
  ).run()

  const current = await env.DB.prepare(`
    SELECT id FROM background_pending_messages
    WHERE device_id = ?
    ORDER BY created_at DESC
  `).bind(id).all()
  const staleIds = (current?.results || [])
    .slice(Math.max(1, Number(limit || 20)))
    .map((row) => normalizeText(row.id))
    .filter(Boolean)
  for (const staleId of staleIds) {
    await env.DB.prepare('DELETE FROM background_pending_messages WHERE id = ?').bind(staleId).run()
  }
  return nextMessage
}

export const ackPendingMessages = async (env = {}, deviceId = '', messageIds = []) => {
  assertDb(env)
  const id = safeDeviceId(deviceId)
  const ids = Array.from(new Set(
    (Array.isArray(messageIds) ? messageIds : [messageIds])
      .map((item) => normalizeText(item))
      .filter(Boolean)
  ))
  if (!id || !ids.length) return 0
  let deleted = 0
  for (const messageId of ids) {
    const result = await env.DB
      .prepare('DELETE FROM background_pending_messages WHERE device_id = ? AND id = ?')
      .bind(id, messageId)
      .run()
    deleted += Number(result?.meta?.changes || 0)
  }
  return deleted
}

export const getBackgroundState = async (env = {}, deviceId = '') => {
  assertDb(env)
  const id = safeDeviceId(deviceId)
  if (!id) return {}
  const row = await env.DB
    .prepare('SELECT state_json FROM background_runtime_states WHERE device_id = ?')
    .bind(id)
    .first()
  return safeJson(row?.state_json, {})
}

export const putBackgroundState = async (env = {}, deviceId = '', state = {}) => {
  assertDb(env)
  const id = await registerBackgroundDevice(env, deviceId)
  if (!id) return null
  const now = nowMs()
  await env.DB.prepare(`
    INSERT INTO background_runtime_states (device_id, state_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `).bind(id, JSON.stringify(state || {}), now).run()
  return state
}

export const getBackgroundActivity = async (env = {}, deviceId = '') => {
  assertDb(env)
  const id = safeDeviceId(deviceId)
  if (!id) return {}
  const row = await env.DB
    .prepare('SELECT state, foreground_until, updated_at FROM background_activities WHERE device_id = ?')
    .bind(id)
    .first()
  if (!row) return {}
  return {
    state: normalizeText(row.state),
    foregroundUntil: Math.max(0, Number(row.foreground_until || 0)),
    updatedAt: Math.max(0, Number(row.updated_at || 0))
  }
}

export const putBackgroundActivity = async (env = {}, deviceId = '', activity = {}) => {
  assertDb(env)
  const id = await registerBackgroundDevice(env, deviceId)
  if (!id) return null
  const now = nowMs()
  const nextActivity = {
    state: normalizeText(activity?.state),
    foregroundUntil: Math.max(0, Number(activity?.foregroundUntil || 0)),
    updatedAt: now
  }
  await env.DB.prepare(`
    INSERT INTO background_activities (device_id, state, foreground_until, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      state = excluded.state,
      foreground_until = excluded.foreground_until,
      updated_at = excluded.updated_at
  `).bind(id, nextActivity.state, nextActivity.foregroundUntil, now).run()
  return nextActivity
}
