import { createWechatDaemonAutoReplyHandler } from './wechatDaemonAutoReplyHandler.js'
import { createWechatDaemonRuntime } from './wechatDaemonRuntime.js'
import { handleWechatIlinkBridge } from './wechatIlinkBridge.js'

const json = (res, payload, status = 200) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

const normalizeText = (value = '') => String(value || '').trim()
const HOSTED_WECHAT_BACKGROUND_WORKER_URL = 'https://ai-phone-background.yutuyue2.workers.dev'

const POST_ROUTE_DAEMON_TICK_PATHS = new Set([
  '/wechat/login/status',
  '/wechat/sync-now',
  '/wechat/outbox/enqueue',
  '/wechat/thread-context',
  '/wechat/config'
])

const isWechatDaemonEnabled = (env = {}) => ['1', 'true'].includes(
  normalizeText(env?.WECHAT_DAEMON_ENABLED).toLowerCase()
)

const createWechatDaemonRuntimeForBridge = (env = {}) => createWechatDaemonRuntime({
  ...env,
  __WECHAT_DAEMON_AUTO_REPLY_HANDLER__: createWechatDaemonAutoReplyHandler(env)
})

const schedulePostRouteDaemonTick = (env = {}, routePath = '') => {
  if (!isWechatDaemonEnabled(env)) return
  if (!POST_ROUTE_DAEMON_TICK_PATHS.has(String(routePath || '').trim())) return
  void createWechatDaemonRuntimeForBridge(env).tick().catch((error) => {
    console.warn('[wechat-bridge-proxy] post-route daemon tick failed', {
      routePath,
      error
    })
  })
}

const normalizeUpstreamUrl = (value = '') => normalizeText(value).replace(/\/+$/, '')

const resolveUpstreamBase = (env = {}) => normalizeUpstreamUrl(
  env.WECHAT_ILINK_UPSTREAM_URL
    || env.WECHAT_BRIDGE_UPSTREAM_URL
    || env.ILINK_BRIDGE_URL
    || (normalizeText(env.CF_PAGES) === '1' ? HOSTED_WECHAT_BACKGROUND_WORKER_URL : '')
)

const getRequestBody = (req) => {
  if (req?.body && typeof req.body === 'object') return req.body
  return {}
}

const buildUpstreamTarget = (env = {}, routePath = '', requestUrl = '') => {
  const upstreamBase = resolveUpstreamBase(env)
  if (!upstreamBase) return ''
  const safeRoutePath = String(routePath || '').startsWith('/') ? routePath : `/${routePath}`
  const sourceUrl = new URL(requestUrl || 'http://localhost')
  const targetUrl = new URL(`${upstreamBase}${safeRoutePath}`)
  targetUrl.search = sourceUrl.search
  return targetUrl.toString()
}

const buildProxyHeaders = (env = {}) => {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json'
  }
  const token = normalizeText(
    env.WECHAT_ILINK_UPSTREAM_TOKEN
      || env.WECHAT_BRIDGE_UPSTREAM_TOKEN
      || env.ILINK_BRIDGE_TOKEN
  )
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

export async function handleWechatBridgeProxy(req, res, env = {}, routePath = '') {
  if (String(req?.method || '').toUpperCase() === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  const targetUrl = buildUpstreamTarget(env, routePath, req?.url)
  if (!targetUrl) {
    await handleWechatIlinkBridge(req, res, env, routePath)
    schedulePostRouteDaemonTick(env, routePath)
    return
  }

  try {
    const method = String(req?.method || 'GET').toUpperCase()
    const response = await fetch(targetUrl, {
      method,
      headers: buildProxyHeaders(env),
      body: method === 'GET' || method === 'HEAD'
        ? undefined
        : JSON.stringify(getRequestBody(req))
    })
    const text = await response.text()
    res.statusCode = response.status
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json; charset=utf-8')
    res.end(text)
    schedulePostRouteDaemonTick(env, routePath)
  } catch (error) {
    json(res, {
      ok: false,
      error: 'wechat_bridge_proxy_failed',
      message: error?.message || String(error || '')
    }, 502)
  }
}
