import { formatEventMemoryCompact } from './eventMemoryCompact.js'

export const PROACTIVE_RECENT_MESSAGE_LIMIT = 12
export const PROACTIVE_COOLDOWN_MS = 8 * 60 * 1000
export const PROACTIVE_PENDING_LIMIT = 20
export const PROACTIVE_OFFLINE_GRACE_MS = 15 * 60 * 1000
export const PROACTIVE_OFFLINE_DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000
export const PROACTIVE_INTERVAL_LIMITS = Object.freeze({
  min: 5,
  max: 720
})

export const PROACTIVE_INTERVAL_PRESETS = Object.freeze({
  high: { min: 10, max: 25 },
  normal: { min: 30, max: 90 },
  low: { min: 120, max: 240 }
})

const DEFAULT_PROACTIVE_INTERVAL = PROACTIVE_INTERVAL_PRESETS.normal
const SUPPORTED_CHAT_LANGUAGES = ['zh', 'yue', 'en', 'ja', 'ko']
const DEFAULT_TEXT_LANGUAGE = 'zh'
const DEFAULT_VOICE_LANGUAGE = 'follow_text'

const normalizeProactiveTextLanguage = (value) => {
  const nextValue = String(value || '').trim().toLowerCase()
  return SUPPORTED_CHAT_LANGUAGES.includes(nextValue) ? nextValue : DEFAULT_TEXT_LANGUAGE
}

const normalizeProactiveVoiceLanguage = (value) => {
  const nextValue = String(value || '').trim().toLowerCase()
  if (nextValue === DEFAULT_VOICE_LANGUAGE) return DEFAULT_VOICE_LANGUAGE
  return SUPPORTED_CHAT_LANGUAGES.includes(nextValue) ? nextValue : DEFAULT_VOICE_LANGUAGE
}

const resolveProactiveVoiceLanguage = (textLanguage, voiceLanguage) => {
  const normalizedTextLanguage = normalizeProactiveTextLanguage(textLanguage)
  const normalizedVoiceLanguage = normalizeProactiveVoiceLanguage(voiceLanguage)
  return normalizedVoiceLanguage === DEFAULT_VOICE_LANGUAGE
    ? normalizedTextLanguage
    : normalizeProactiveTextLanguage(normalizedVoiceLanguage)
}

const clampIntervalMinutes = (value, fallback) => {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.min(PROACTIVE_INTERVAL_LIMITS.max, Math.max(PROACTIVE_INTERVAL_LIMITS.min, number))
}

const getLegacyIntervalPreset = (frequency = 'normal') => {
  const key = String(frequency || 'normal').trim()
  return PROACTIVE_INTERVAL_PRESETS[key] || DEFAULT_PROACTIVE_INTERVAL
}

export const sanitizeProactiveInterval = (autoMessage = {}) => {
  const preset = getLegacyIntervalPreset(autoMessage?.frequency)
  const min = clampIntervalMinutes(autoMessage?.intervalMinMinutes, preset.min)
  const max = clampIntervalMinutes(autoMessage?.intervalMaxMinutes, preset.max)
  return min <= max
    ? { intervalMinMinutes: min, intervalMaxMinutes: max }
    : { intervalMinMinutes: max, intervalMaxMinutes: min }
}

export const getLocalHourInTimeZone = (date = new Date(), timeZone = '') => {
  const safeDate = date instanceof Date ? date : new Date(date)
  if (!timeZone) return safeDate.getHours()
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23'
    }).formatToParts(safeDate)
    const hour = Number(parts.find((part) => part.type === 'hour')?.value)
    return Number.isFinite(hour) ? hour : safeDate.getHours()
  } catch {
    return safeDate.getHours()
  }
}

export const formatProactiveLocalTimeText = (date = new Date(), timeZone = '') => {
  const safeDate = date instanceof Date ? date : new Date(date)
  const hour = getLocalHourInTimeZone(safeDate, timeZone)
  const period = hour < 5
    ? '凌晨'
    : hour < 11
      ? '早上'
      : hour < 13
        ? '中午'
        : hour < 18
          ? '下午'
          : hour < 23
            ? '晚上'
            : '深夜'
  try {
    const text = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timeZone || undefined,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(safeDate)
    return `${text}，${period}`
  } catch {
    return `${safeDate.toISOString()}，${period}`
  }
}

export const calculateProactiveDelay = (autoMessage = {}, random = Math.random) => {
  const interval = typeof autoMessage === 'string'
    ? sanitizeProactiveInterval({ frequency: autoMessage })
    : sanitizeProactiveInterval(autoMessage)
  const minMinutes = interval.intervalMinMinutes
  const maxMinutes = interval.intervalMaxMinutes

  return (Math.floor(random() * (maxMinutes - minMinutes + 1)) + minMinutes) * 60 * 1000
}

export const getProactiveTimeWeight = (date = new Date(), timeZone = '') => {
  const h = getLocalHourInTimeZone(date, timeZone)
  if (h >= 0 && h < 6) return 0.03
  if (h >= 6 && h < 7) return 0.08
  if (h >= 7 && h < 10) return 0.4
  if (h >= 10 && h < 18) return 0.6
  if (h >= 18 && h < 23) return 0.8
  return 0.16
}

export const getProactiveInactivityWeight = (lastTs, now = Date.now()) => {
  if (!lastTs) return 0.6
  const mins = (now - Number(lastTs || 0)) / 60000
  if (mins < 20) return 0
  if (mins < 90) return 0.28
  if (mins < 300) return 0.48
  if (mins < 1440) return 0.68
  return 0.88
}

export const getProactiveBaseProbability = (autoMessage = {}) => {
  if (typeof autoMessage === 'string') {
    if (autoMessage === 'high') return 0.55
    if (autoMessage === 'low') return 0.18
    return 0.38
  }
  const interval = sanitizeProactiveInterval(autoMessage)
  const averageMinutes = (interval.intervalMinMinutes + interval.intervalMaxMinutes) / 2
  const normalAverageMinutes = (DEFAULT_PROACTIVE_INTERVAL.min + DEFAULT_PROACTIVE_INTERVAL.max) / 2
  const probability = 0.38 * Math.sqrt(normalAverageMinutes / averageMinutes)
  return Math.min(0.58, Math.max(0.22, probability))
}

export const pickRecentProactiveMessages = (history = [], limit = PROACTIVE_RECENT_MESSAGE_LIMIT) => {
  return (Array.isArray(history) ? history : [])
    .filter((message) => message && String(message.role || '') !== 'system')
    .slice(-limit)
}

export const formatProactiveMessagesForLLM = (messages = []) => {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const speaker = message?.role === 'user' ? '【对方】' : '【我】'
    if (message?.type === 'takeaway_pay') {
      const status = message?.status === 'paid' ? '已支付' : '待支付'
      const subType = String(message.subType || '').trim()
      const typeLabel = subType === 'gift'
        ? '外卖投喂'
        : subType === 'request'
          ? '外卖代付'
          : subType === 'self'
            ? '自购外卖'
            : '外卖订单'
      const recipient = message.recipient === '我' ? '用户' : (message.recipient || '未注明')
      return `${speaker} ${typeLabel}(${status}) 收件人/给谁:${recipient} 标题:${message.title || ''} 内容:${message.text || ''} 说明:${message.subDesc || ''} 金额:${message.amount || ''}`
    }
    if (message?.type === 'red_packet') return `${speaker} 红包 金额:${message.amount || ''} 备注:${message.text || ''}`
    if (message?.type === 'transfer') return `${speaker} 转账 金额:${message.amount || ''} 备注:${message.text || ''}`
    if (message?.type === 'image') return `${speaker} 图片 ${message.description || '无描述'}`
    if (message?.type === 'voice') return `${speaker} 语音 ${message.transcript || message.text || ''}`.trim()
    return `${speaker} ${String(message?.text || '').slice(0, 120)}`
  }).join('\n')
}

const trimPromptText = (value = '', limit = 500) => String(value || '').trim().slice(0, limit)

const formatProactiveRelativeTime = (timestamp = 0, now = Date.now()) => {
  const ts = Number(timestamp || 0)
  if (!ts) return '时间未知'
  const diff = Math.max(0, Number(now || Date.now()) - ts)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)}分钟前`
  if (diff < day) return `${Math.floor(diff / hour)}小时前`
  return `${Math.floor(diff / day)}天前`
}

const getProactiveMessageText = (message = {}) => trimPromptText(
  message?.text ||
  message?.originalText ||
  message?.transcript ||
  message?.description ||
  message?.title ||
  message?.subDesc ||
  '',
  240
)

const getProactiveTypeLabel = (message = {}) => {
  const type = String(message?.type || 'text').trim()
  if (type === 'image') return '图片'
  if (type === 'voice') return '语音'
  if (type === 'red_packet') return '红包'
  if (type === 'transfer') return '转账'
  if (type === 'takeaway_pay') return '外卖订单'
  if (type === 'sticker') return '表情'
  if (type === 'nudge') return '拍一拍互动'
  return '文字'
}

const formatProactiveTimelineLine = (message = {}, roleName = '对方', now = Date.now()) => {
  const speaker = String(message?.role || '') === 'user' ? '用户' : roleName
  const typeLabel = getProactiveTypeLabel(message)
  const text = getProactiveMessageText(message)
  const time = formatProactiveRelativeTime(message?.timestamp, now)
  return `- ${time} ${speaker}（${typeLabel}）：${text || '（无文本内容）'}`
}

const buildProactiveRoleBaseBlock = ({
  role = null,
  roleName = '对方',
  roleIntro = '',
  userPersona = ''
} = {}) => {
  const persona = trimPromptText(role?.persona || role?.description || role?.background || '', 900)
  const relationship = trimPromptText(role?.relationship || role?.relationshipText || role?.relation || '', 500)
  const speakingStyle = trimPromptText(role?.speakingStyle || role?.replyStyle || role?.chatStyle || '', 500)
  const customStatusText = trimPromptText(role?.customStatusText || '', 120)

  return [
    '【角色底座】',
    `- 当前发消息的人：${roleName}。你只能扮演这个角色，不能替用户说话。`,
    roleIntro ? `- 角色人设与气质：${roleIntro}` : '',
    persona ? `- 角色补充设定：${persona}` : '',
    relationship ? `- 和用户的关系设定：${relationship}` : '',
    speakingStyle ? `- 说话方式偏好：${speakingStyle}` : '',
    customStatusText ? `- 当前状态签名/近况：${customStatusText}` : '',
    userPersona ? `- 用户画像：${userPersona}` : '',
    '- 这是即时微信聊天，不是文案、旁白、小说、客服或系统公告。'
  ].filter(Boolean).join('\n')
}

const buildProactiveMemoryBlock = (role = null) => {
  const topicMemory = Array.isArray(role?.topicMemory)
    ? role.topicMemory
      .map((item) => [item?.topic, item?.summary, item?.stance].map((part) => trimPromptText(part, 120)).filter(Boolean).join('：'))
      .filter(Boolean)
      .slice(0, 4)
    : []
  const recentEvents = formatEventMemoryCompact(Array.isArray(role?.recentEvents) ? role.recentEvents : [], 4, {
    nowTs: Date.now(),
    includeTimeContext: true
  })

  const lines = [
    '【动态记忆】',
    role?.relationshipSummary ? `- 长期关系记忆：${role.relationshipSummary}` : '',
    role?.recentSummary ? `- 最近相处摘要：${role.recentSummary}` : '',
    role?.todaySummary ? `- 今天相关摘要：${role.todaySummary}` : '',
    Array.isArray(role?.shortTermFacts) && role.shortTermFacts.length ? `- 短期事实：${role.shortTermFacts.join('；')}` : '',
    Array.isArray(role?.openLoops) && role.openLoops.length ? `- 当前仍需接住：${role.openLoops.join('；')}` : '',
    Array.isArray(role?.userPreferences) && role.userPreferences.length ? `- 用户偏好：${role.userPreferences.join('；')}` : '',
    topicMemory.length ? `- 近期话题记忆：${topicMemory.join('；')}` : '',
    recentEvents ? `- 近期重要经历：${recentEvents}` : ''
  ].filter(Boolean)

  return lines.length > 1 ? lines.join('\n') : '【动态记忆】\n- 当前没有可用的长期/短期记忆摘要，只能依靠最近聊天自然发起。'
}

const buildProactiveMessageStateBlock = ({
  role = null,
  roleName = '对方',
  recentMessages = [],
  latestUserFocusText = '',
  now = Date.now()
} = {}) => {
  const safeMessages = Array.isArray(recentMessages) ? recentMessages : []
  const stats = role?.messageStats && typeof role.messageStats === 'object' ? role.messageStats : {}
  const lastVisibleMessage = safeMessages[safeMessages.length - 1] || null
  const lastUserMessage = [...safeMessages].reverse().find((message) => String(message?.role || '') === 'user') || null
  const lastAiMessage = [...safeMessages].reverse().find((message) => String(message?.role || '') === 'ai') || null
  const lastUserText = trimPromptText(stats.lastUserMessageText || getProactiveMessageText(lastUserMessage), 240)
  const lastAiText = trimPromptText(stats.lastAiMessageText || getProactiveMessageText(lastAiMessage), 240)
  const lastVisibleRole = String(stats.lastVisibleRole || lastVisibleMessage?.role || '').trim()
  const lastVisibleType = String(stats.lastVisibleType || lastVisibleMessage?.type || 'text').trim()
  const lastUserTs = Number(stats.lastUserMessageAt || lastUserMessage?.timestamp || 0)
  const lastAiTs = Number(stats.lastAiMessageAt || lastAiMessage?.timestamp || 0)
  const isAwaitingUserReply = lastAiTs > 0 && lastAiTs > lastUserTs
  const timeline = safeMessages
    .slice(-10)
    .map((message) => formatProactiveTimelineLine(message, roleName, now))
    .filter(Boolean)

  return [
    '【当前消息列表状态】',
    `- 消息总数：${Number(stats.totalMessageCount || 0)}；可见聊天消息数：${Number(stats.visibleMessageCount || safeMessages.length || 0)}；本次注入最近 ${safeMessages.length} 条。`,
    `- 会话未读数：${Number(role?.unread || 0)}；会话列表预览：${trimPromptText(role?.lastMsg || '', 160) || '（无）'}。`,
    lastVisibleRole ? `- 当前最后一条可见消息：${lastVisibleRole === 'user' ? '用户发的' : `${roleName}发的`}，类型=${lastVisibleType}，时间=${formatProactiveRelativeTime(stats.lastVisibleMessageAt || lastVisibleMessage?.timestamp, now)}。` : '',
    lastUserText ? `- 用户之前最后发过：${formatProactiveRelativeTime(stats.lastUserMessageAt || lastUserMessage?.timestamp, now)}，${lastUserText}` : '- 用户之前最后发过：暂无可用记录。',
    lastAiText ? `- 你之前最后发过：${formatProactiveRelativeTime(stats.lastAiMessageAt || lastAiMessage?.timestamp, now)}，${lastAiText}` : '- 你之前最后发过：暂无可用记录。',
    isAwaitingUserReply ? `- 明确状态：你在${formatProactiveRelativeTime(lastAiTs, now)}前主动发过上一条，用户到现在还没回复。继续发之前，要知道自己是在连着发第二轮。` : '',
    latestUserFocusText ? `- 这次最该接住的用户内容：${latestUserFocusText}` : '',
    '',
    '【最近聊天时间线】',
    timeline.length ? timeline.join('\n') : '- 暂无最近聊天记录。'
  ].filter(Boolean).join('\n')
}

export const findLatestProactiveUserMessage = (messages = []) => {
  const safeMessages = Array.isArray(messages) ? messages : []
  for (let index = safeMessages.length - 1; index >= 0; index -= 1) {
    const message = safeMessages[index]
    if (String(message?.role || '').trim() === 'user') return message
  }
  return null
}

export const chooseProactiveRole = (snapshot = {}, random = Math.random) => {
  const allowedRoleIds = Array.isArray(snapshot?.autoMessage?.allowedRoles)
    ? snapshot.autoMessage.allowedRoles.map((item) => String(item || '').trim()).filter(Boolean)
    : []
  const roles = Array.isArray(snapshot?.roles) ? snapshot.roles : []
  const candidates = roles.filter((role) => allowedRoleIds.includes(String(role?.id || '')))
  if (!candidates.length) return null
  return candidates[Math.floor(random() * candidates.length)]
}

const parseProactiveTimestamp = (value) => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

const INACTIVE_OFFLINE_STATUSES = new Set(['completed', 'cancelled', 'canceled', 'rejected', 'expired', 'ended'])

export const getProactiveOfflineSuppression = (offlineWindows = [], now = Date.now()) => {
  const safeNow = Number(now || Date.now())
  const active = (Array.isArray(offlineWindows) ? offlineWindows : [])
    .map((item) => {
      const status = String(item?.status || '').trim()
      if (INACTIVE_OFFLINE_STATUSES.has(status)) return null
      const startTs = parseProactiveTimestamp(item?.start || item?.startedAt || item?.timestamp || item?.createdAt)
      if (!startTs) return null
      const explicitEndTs = parseProactiveTimestamp(item?.end || item?.endedAt)
      const durationMs = Math.max(0, Number(item?.durationMinutes || 0)) * 60 * 1000
      const endTs = explicitEndTs || (durationMs > 0 ? startTs + durationMs : startTs + PROACTIVE_OFFLINE_DEFAULT_DURATION_MS)
      const suppressUntil = endTs + PROACTIVE_OFFLINE_GRACE_MS
      if (safeNow < startTs || safeNow > suppressUntil) return null
      return {
        suppressUntil,
        startTs,
        endTs,
        reason: 'offline_active',
        source: String(item?.source || '').trim()
      }
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.suppressUntil || 0) - Number(b.suppressUntil || 0))

  return active[0] || null
}

export const shouldRunProactiveForRole = ({
  snapshot = {},
  role = null,
  now = Date.now(),
  random = Math.random,
  force = false
} = {}) => {
  const autoMessage = snapshot?.autoMessage || {}
  if (autoMessage.enabled !== true) return { ok: false, reason: 'auto_message_disabled' }
  if (!role?.id) return { ok: false, reason: 'missing_role' }
  if (String(role?.scheduleStatus || '').trim() === 'sleeping') return { ok: false, reason: 'role_sleeping' }
  const offlineSuppression = getProactiveOfflineSuppression(role?.offlineWindows, now)
  const offlineSuppressedUntil = Number(role?.offlineSuppressedUntil || offlineSuppression?.suppressUntil || 0)
  if (offlineSuppression || offlineSuppressedUntil > Number(now || Date.now())) {
    return {
      ok: false,
      reason: 'offline_active',
      suppressUntil: offlineSuppressedUntil,
      source: String(offlineSuppression?.source || role?.offlineSuppressionSource || '')
    }
  }

  const messages = Array.isArray(role?.recentMessages) ? role.recentMessages : []
  const lastMessage = messages.length ? messages[messages.length - 1] : null
  if (!force && lastMessage?.timestamp && now - Number(lastMessage.timestamp || 0) < PROACTIVE_COOLDOWN_MS) {
    return {
      ok: false,
      reason: 'cooldown_8_minutes',
      msSinceLastMessage: now - Number(lastMessage.timestamp || 0)
    }
  }

  const probability = getProactiveBaseProbability(autoMessage)
    * getProactiveTimeWeight(new Date(now), snapshot?.timeZone || '')
    * (0.65 + getProactiveInactivityWeight(lastMessage?.timestamp, now))
  const roll = random()

  if (!force && roll > probability) {
    return { ok: false, reason: 'probability_miss', probability, roll }
  }

  return { ok: true, probability, roll }
}

export const buildProactiveRequestMessages = ({
  role = null,
  userPersona = '',
  proactiveMode = 'proactive_nudge',
  proactiveTimeContext = '',
  recentChatText = '',
  backgroundPendingText = '',
  recentInteractionText = '',
  latestUserFocusText = '',
  currentEventText = '',
  stickers = []
} = {}) => {
  const roleName = String(role?.name || '对方').trim() || '对方'
  const roleIntro = String(role?.intro || '朋友').trim() || '朋友'
  const pokeSuffix = String(role?.pokeSuffix || '的小脑袋').trim() || '的小脑袋'
  const recentMessages = Array.isArray(role?.recentMessages) ? role.recentMessages : []
  const nowTs = Date.now()
  const textLanguage = normalizeProactiveTextLanguage(role?.textLanguage)
  const resolvedVoiceLanguage = resolveProactiveVoiceLanguage(textLanguage, role?.voiceLanguage)
  const textIsBilingual = textLanguage !== DEFAULT_TEXT_LANGUAGE
  const voiceIsBilingual = resolvedVoiceLanguage !== DEFAULT_TEXT_LANGUAGE
  const languageBlock = textIsBilingual || voiceIsBilingual
    ? [
        '【语言设置】',
        `- 文字语言：${textLanguage}。`,
        `- 语音语言：${resolvedVoiceLanguage}。`,
        textIsBilingual
          ? `- 这轮文字正文必须用单行机器协议输出：@@msg:${textLanguage}@@原文||中文译文；语言码直接写 ${textLanguage}，禁止写 <${textLanguage}> 或 <lang>；不要输出没有翻译的英文/日文/韩文裸文本。`
          : '',
        voiceIsBilingual
          ? `- 这轮如果发语音，按机器协议输出：[语音] @@voice:${resolvedVoiceLanguage}@@原文||中文译文；语言码不要带尖括号。`
          : ''
      ].filter(Boolean).join('\n')
    : ''
  const stickerNames = (Array.isArray(stickers) ? stickers : [])
    .map((item) => String(item?.name || item || '').trim())
    .filter(Boolean)
  const roleBaseBlock = buildProactiveRoleBaseBlock({
    role,
    roleName,
    roleIntro,
    userPersona
  })
  const memoryBlock = buildProactiveMemoryBlock(role)
  const messageStateBlock = buildProactiveMessageStateBlock({
    role,
    roleName,
    recentMessages,
    latestUserFocusText,
    now: nowTs
  })

  const systemPrompt = [
    roleBaseBlock,
    '',
    memoryBlock,
    '',
    messageStateBlock,
    '',
    '【额外上下文】',
    proactiveTimeContext ? `- 当前时间语境：\n${proactiveTimeContext}` : '',
    currentEventText ? `- 当前经历：${currentEventText}` : '',
    backgroundPendingText ? `【后台已发但尚未回流到聊天记录的消息】\n${backgroundPendingText}` : '',
    recentInteractionText || '',
    recentChatText ? `【最近聊天原始摘要】\n${recentChatText}` : '',
    '',
    '【当前场景】',
    proactiveMode === 'delayed_reply_recovery'
      ? '- 这是补回消息模式。用户刚发过消息，你先接住对方最后那个点，不要另起无关话题。'
      : '- 这是正常主动消息模式。自然地主动发一句或几句微信，不要硬演。',
    '',
    languageBlock,
    '',
    '【可用能力】',
    '- 你这里只能使用：文字、HTML 网页气泡、语音、表情包、拍一拍、设置拍一拍后缀。',
    `- 当前拍一拍后缀是“${pokeSuffix}”。`,
    '- 拍一拍低频自然；如果使用，只输出对应指令，不要在普通正文里描述拍一拍动作。',
    '- 表情包只允许使用现有名字，禁止编造不存在的表情包。',
    stickerNames.length ? `- 当前可用表情包：${stickerNames.join('、')}` : '- 当前没有额外表情包可用。',
    '',
    '【输出格式】',
    textIsBilingual
      ? `- 非中文/双语文字：必须单行写成 \`@@msg:${textLanguage}@@原文||中文译文\`；每一条非中文消息都要各自带翻译，不要使用其它旧双语标签，不要写 <lang> 或 <${textLanguage}>。`
      : '- 普通文字：直接写中文内容，一行一条消息。',
    '- HTML 网页气泡：当分享网站、测试/demo、小页面、表格、状态卡片或其他适合网页表达的内容时，可以自行输出完整 HTML；不要包在 ``` 代码块里，整段 HTML 必须作为一条消息保留。',
    voiceIsBilingual
      ? `- 非中文/双语语音：统一写成 \`[语音] @@voice:${resolvedVoiceLanguage}@@原文||中文译文\`，语言码不要带尖括号。`
      : '- 语音：`[语音] <一句可以直接说出口的自然话>`。',
    '- 表情包：`[表情:名字]`。',
    '- 拍用户：`[拍一拍]`；拍自己：`[拍一拍自己]`；改后缀说话：先写 `[设置拍一拍后缀:短尾巴]`，再另起一行写 `[拍一拍]` 或 `[拍一拍自己]`。',
    '- 想分多条消息时，必须用真正换行；每一行都要是可以单独发出的微信消息。',
    '- 不要输出红包、转账、外卖、朋友圈、撤回、状态、约会、打电话、顶号、换头等其他指令。',
    '- 语音参数由你自己决定是否需要；只有确实能帮助情绪表达时才写成 `[语音|emotion=...|speed=...|volume=...|pause=...]`，而且要克制，像正常说话，不要表演欲太强。',
    '- 语音内容里禁止写括号动作、心理旁白、舞台说明或星号动作。',
    '- 主动找用户时，整轮不能只有拍一拍、表情包或改后缀；除非是在回应用户刚刚的拍一拍，否则至少要有一句真正能发出去的文字或语音。',
    '- 不要凭感觉猜作息；只有当前时间语境明确给出的本地小时在 23:00-04:59，或最近聊天明确在熬夜，才可以提“睡/没睡/困/晚安”。',
    '- 不要输出“用户：”“我：”“AI：”前缀，不要写括号旁白、动作描写、心理描写、系统说明。',
    '- 不要输出 JSON，不要解释规则，不要说明自己在做什么。'
  ].filter(Boolean).join('\n')

  const userLines = []
  if (proactiveMode === 'delayed_reply_recovery') {
    userLines.push('请围绕用户刚刚那一轮还没被接住的最新消息，自然补回这一轮微信内容。')
  } else {
    userLines.push('这是一次主动发消息场景。用户最近没有新的直接输入，可以理解成对方沉默了一阵、已读未回，或者此刻适合你主动起个头。')
    userLines.push('请结合 system 里的关系、最近聊天和时间语境，自然发起一条新的微信消息。不要重复你自己上一条的核心意思。')
  }
  userLines.push('只输出最终要发出去的微信内容，不要解释规则。')

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userLines.join('\n') }
  ]
}
