const LOGIN_TTL_MS = 5 * 60 * 1000
const SESSION_TTL_MS = 2 * 60 * 60 * 1000
const CODE_TTL_MS = 10 * 60 * 1000
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
const PASSWORD_ITERATIONS = 100000

function passwordReady(env) {
  return typeof env.AUTH_PASSWORD_PEPPER === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(env.AUTH_PASSWORD_PEPPER)
}

function usernameOf(input) {
  if (typeof input !== 'string') return null
  const username = input.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username) ? username : null
}

function passwordValid(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128 && value.trim().length > 0
}

async function passwordHash(password, salt, pepper) {
  const pepperKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const secretInput = await crypto.subtle.sign('HMAC', pepperKey, new TextEncoder().encode(password))
  const key = await crypto.subtle.importKey('raw', secretInput, 'PBKDF2', false, ['deriveBits'])
  return base64url(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256',
    salt: Uint8Array.from(atob(salt.replace(/-/g, '+').replace(/_/g, '/') + '='), char => char.charCodeAt(0)),
    iterations: PASSWORD_ITERATIONS }, key, 256)))
}

function sameHash(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false
  let difference = 0
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i)
  return difference === 0
}

async function consumeLimit(db, key, limit, windowMs) {
  const now = Date.now(), windowStart = Math.floor(now / windowMs) * windowMs
  const row = await db.prepare(`INSERT INTO auth_rate_limits (bucket_key,window_start,attempts,expires_at) VALUES (?,?,1,?)
    ON CONFLICT(bucket_key) DO UPDATE SET attempts=CASE WHEN window_start=excluded.window_start THEN attempts+1 ELSE 1 END,
      window_start=excluded.window_start,expires_at=excluded.expires_at
    WHERE window_start<>excluded.window_start OR attempts<? RETURNING attempts`)
    .bind(await hashSecret(key), windowStart, windowStart + windowMs, limit).first()
  return Boolean(row)
}

async function passwordRateLimit(request, db, username, register) {
  // Cloudflare supplies this header at the edge. Never use attacker-controlled X-Forwarded-For.
  const ip = request.headers.get('CF-Connecting-IP') || 'unavailable'
  await db.prepare('DELETE FROM auth_rate_limits WHERE expires_at<=?').bind(Date.now()).run()
  const action = register ? 'register' : 'login', windowMs = register ? 3600000 : 900000
  const ipAllowed = await consumeLimit(db, `${action}:ip:${ip}`, register ? 5 : 30, windowMs)
  if (!ipAllowed) return false
  return consumeLimit(db, `${action}:username:${username}`, register ? 5 : 10, windowMs)
}

async function issueSession(db, ownerId, provider, username, json, status = 200) {
  const accessToken = `swa_${randomValue()}`, now = Date.now(), expiresAt = now + SESSION_TTL_MS
  await db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').bind(now).run()
  await db.prepare('INSERT INTO auth_sessions (token_hash,owner_id,created_at,expires_at) VALUES (?,?,?,?)')
    .bind(await hashSecret(accessToken), ownerId, now, expiresAt).run()
  const user = { id: ownerId, provider, ...(username ? { username } : {}) }
  return json({ accessToken, tokenType: 'Bearer', expiresAt: new Date(expiresAt).toISOString(), user }, status)
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomValue() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function hashSecret(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}

export function authConfig(env) {
  if (typeof env.WECHAT_APP_ID !== 'string' || !/^wx[a-z0-9]{16}$/i.test(env.WECHAT_APP_ID) ||
      typeof env.WECHAT_APP_SECRET !== 'string' || env.WECHAT_APP_SECRET.length < 16 || env.WECHAT_APP_SECRET.length > 256) return null
  try {
    const callback = new URL(env.WECHAT_REDIRECT_URI)
    if (callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash ||
        callback.pathname !== '/api/auth/wechat/callback') return null
    return { appId: env.WECHAT_APP_ID, appSecret: env.WECHAT_APP_SECRET, redirectUri: callback.href }
  } catch { return null }
}

export async function authenticate(request, db) {
  const authorization = request.headers.get('Authorization') || ''
  const match = authorization.match(/^Bearer (swa_[A-Za-z0-9_-]{43})$/)
  if (!match) return null
  const sessionHash = await hashSecret(match[1])
  const session = await db.prepare(`SELECT s.owner_id AS ownerId, s.expires_at AS expiresAt, u.provider, u.username
    FROM auth_sessions s JOIN auth_users u ON u.id=s.owner_id WHERE s.token_hash=? AND s.expires_at>?`).bind(sessionHash, Date.now()).first()
  return session ? { ...session, sessionHash } : null
}

function callbackPage(message, status = 200) {
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>三晚助手微信登录</title><body><h1>三晚助手</h1><p>${message}</p></body></html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    }
  })
}

async function markFailed(db, loginId) {
  await db.prepare("UPDATE auth_login_transactions SET status='failed',owner_id=NULL WHERE id=? AND status='processing'").bind(loginId).run()
}

async function findTransaction(db, body) {
  if (!body || typeof body !== 'object' || !RANDOM_VALUE.test(body.loginId || '') || !VERIFIER.test(body.codeVerifier || '')) return null
  const challenge = await hashSecret(body.codeVerifier)
  return db.prepare(`SELECT id,status,expires_at AS expiresAt,owner_id AS ownerId FROM auth_login_transactions
    WHERE id=? AND code_challenge=? AND expires_at>?`).bind(body.loginId, challenge, Date.now()).first()
}

export async function authRoute(request, env, path, { json, error, readBody }) {
  if (path === '/api/auth/config' && request.method === 'GET') {
    return json({ wechat: authConfig(env) ? { enabled: true } : { enabled: false, reason: 'setup_required' },
      password: passwordReady(env) ? { enabled: true } : { enabled: false, reason: 'setup_required' } })
  }
  if (!path.startsWith('/api/auth/')) return null
  if ((path === '/api/auth/session' && request.method === 'GET') || (path === '/api/auth/logout' && request.method === 'POST')) {
    const session = await authenticate(request, env.DB)
    if (!session) return error(401, 'unauthorized', '请先登录。')
    if (path.endsWith('/logout')) {
      await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash=? AND owner_id=?').bind(session.sessionHash, session.ownerId).run()
      return json({ ok: true })
    }
    return json({ user: { id: session.ownerId, provider: session.provider, ...(session.username ? { username: session.username } : {}) }, expiresAt: new Date(session.expiresAt).toISOString() })
  }
  if ((path === '/api/auth/register' || path === '/api/auth/login') && request.method === 'POST') {
    if (!passwordReady(env)) return error(503, 'setup_not_ready', '账号登录尚未完成配置，请联系管理员。')
    const body = await readBody(request), username = usernameOf(body?.username), register = path.endsWith('/register')
    // Invalid usernames still consume the IP budget, so format errors cannot bypass throttling.
    if (!await passwordRateLimit(request, env.DB, username || '<invalid>', register)) return error(429, 'rate_limited', '尝试次数过多，请稍后再试。')
    if (!username || !passwordValid(body?.password)) return error(400, 'invalid_credentials', '用户名须为3–32位英文字母、数字、点、下划线或短横线，首位为字母或数字；密码须为12–128字符。')
    if (register) {
      const id = crypto.randomUUID(), salt = randomValue()
      const hash = await passwordHash(body.password, salt, env.AUTH_PASSWORD_PEPPER)
      const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO auth_users
        (id,provider,username,password_salt,password_hash,password_iterations,created_at) VALUES (?,'password',?,?,?,?,?)`)
        .bind(id, username, salt, hash, PASSWORD_ITERATIONS, Date.now()).run()
      if (!inserted.meta?.changes) return error(409, 'username_taken', '该用户名已被使用，请换一个。')
      return issueSession(env.DB, id, 'password', username, json, 201)
    }
    const user = await env.DB.prepare(`SELECT id,username,password_salt AS salt,password_hash AS passwordHash,password_iterations AS iterations
      FROM auth_users WHERE username=? AND provider='password'`).bind(username).first()
    // Do the same KDF work for unknown names; login failures never reveal which field was wrong.
    const hash = await passwordHash(body.password, user?.salt || 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', env.AUTH_PASSWORD_PEPPER)
    if (!user || user.iterations !== PASSWORD_ITERATIONS || !sameHash(hash, user.passwordHash)) return error(401, 'invalid_credentials', '用户名或密码错误。')
    return issueSession(env.DB, user.id, 'password', user.username, json)
  }
  const config = authConfig(env)
  if (!config) return error(503, 'setup_not_ready', '微信登录尚未完成配置，请联系管理员。')
  if (path === '/api/auth/wechat/start' && request.method === 'POST') {
    const body = await readBody(request)
    if (!body || body.codeChallengeMethod !== 'S256' || !RANDOM_VALUE.test(body.codeChallenge || '')) {
      return error(400, 'invalid_login_request', '登录请求无效，请重新发起登录。')
    }
    const now = Date.now()
    if (!await consumeLimit(env.DB, `wechat-start:ip:${request.headers.get('CF-Connecting-IP') || 'unavailable'}`, 20, 900000)) {
      return error(429, 'rate_limited', '尝试次数过多，请稍后再试。')
    }
    // Expired secrets remain unusable even if cleanup is interrupted.
    await env.DB.prepare('DELETE FROM auth_login_transactions WHERE expires_at<=?').bind(now).run()
    await env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').bind(now).run()
    await env.DB.prepare('DELETE FROM auth_oauth_codes WHERE expires_at<=?').bind(now).run()
    const loginId = randomValue(), state = randomValue(), expiresAt = now + LOGIN_TTL_MS
    await env.DB.prepare(`INSERT INTO auth_login_transactions
      (id,state_hash,code_challenge,wechat_app_id,status,created_at,expires_at) VALUES (?,?,?,?,'pending',?,?)`)
      .bind(loginId, await hashSecret(state), body.codeChallenge, config.appId, now, expiresAt).run()
    const authorization = new URL('https://open.weixin.qq.com/connect/qrconnect')
    authorization.search = new URLSearchParams({ appid: config.appId, redirect_uri: config.redirectUri,
      response_type: 'code', scope: 'snsapi_login', state }).toString()
    authorization.hash = 'wechat_redirect'
    return json({ loginId, authorizationUrl: authorization.href, expiresAt: new Date(expiresAt).toISOString(), pollIntervalMs: 2000 }, 201)
  }
  if (path === '/api/auth/wechat/callback' && request.method === 'GET') {
    const url = new URL(request.url), states = url.searchParams.getAll('state'), codes = url.searchParams.getAll('code')
    if (states.length !== 1 || !RANDOM_VALUE.test(states[0])) return callbackPage('登录请求已失效，请回到三晚助手重新登录。', 400)
    // Claim before any remote call: a callback state can never authorize two sessions.
    const transaction = await env.DB.prepare(`UPDATE auth_login_transactions SET status='processing'
      WHERE state_hash=? AND wechat_app_id=? AND status='pending' AND expires_at>? RETURNING id`)
      .bind(await hashSecret(states[0]), config.appId, Date.now()).first()
    if (!transaction) return callbackPage('登录请求已失效，请回到三晚助手重新登录。', 400)
    if (codes.length !== 1 || !/^[A-Za-z0-9_-]{1,256}$/.test(codes[0])) {
      await markFailed(env.DB, transaction.id)
      return callbackPage('微信授权未完成，请回到三晚助手重新登录。', 400)
    }
    const claim = await env.DB.prepare('INSERT OR IGNORE INTO auth_oauth_codes (code_hash,expires_at) VALUES (?,?)')
      .bind(await hashSecret(`${config.appId}\0${codes[0]}`), Date.now() + CODE_TTL_MS).run()
    if (!claim.meta?.changes) {
      await markFailed(env.DB, transaction.id)
      return callbackPage('登录请求已失效，请回到三晚助手重新登录。', 400)
    }
    try {
      const endpoint = new URL('https://api.weixin.qq.com/sns/oauth2/access_token')
      endpoint.search = new URLSearchParams({ appid: config.appId, secret: config.appSecret, code: codes[0], grant_type: 'authorization_code' }).toString()
      // Do not log this URL, code, response, or WeChat credentials. Never follow a credential-bearing redirect.
      const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(10000) })
      if (!response.ok) throw new Error('Provider rejected authorization')
      const result = await response.json()
      if (result.errcode || typeof result.openid !== 'string' || !result.openid || result.openid.length > 128 ||
          typeof result.access_token !== 'string' || !result.access_token ||
          typeof result.scope !== 'string' || !result.scope.split(',').includes('snsapi_login')) throw new Error('Invalid provider response')
      // The provider-returned openid is scoped by AppID. UnionID and client-supplied identity are not trusted inputs.
      const subjectHash = await hashSecret(`${config.appId}\0${result.openid}`)
      await env.DB.prepare('INSERT OR IGNORE INTO auth_users (id,wechat_subject_hash,created_at) VALUES (?,?,?)')
        .bind(crypto.randomUUID(), subjectHash, Date.now()).run()
      const user = await env.DB.prepare('SELECT id FROM auth_users WHERE wechat_subject_hash=?').bind(subjectHash).first()
      const saved = await env.DB.prepare(`UPDATE auth_login_transactions SET status='ready',owner_id=?
        WHERE id=? AND status='processing' AND expires_at>?`).bind(user.id, transaction.id, Date.now()).run()
      if (!saved.meta?.changes) return callbackPage('登录请求已过期，请回到三晚助手重新登录。', 400)
      return callbackPage('微信登录成功，请回到三晚助手。此页面可以关闭。')
    } catch {
      await markFailed(env.DB, transaction.id)
      return callbackPage('暂时无法完成微信登录，请回到三晚助手重新登录。', 502)
    }
  }
  if ((path === '/api/auth/wechat/poll' || path === '/api/auth/wechat/exchange') && request.method === 'POST') {
    const body = await readBody(request), transaction = await findTransaction(env.DB, body)
    if (!transaction) return error(404, 'login_not_found', '登录请求已失效，请重新登录。')
    if (path.endsWith('/poll')) {
      return json({ status: transaction.status === 'processing' ? 'pending' : transaction.status, expiresAt: new Date(transaction.expiresAt).toISOString() })
    }
    if (transaction.status !== 'ready') return error(409, 'login_not_ready', '微信授权尚未完成。')
    const claimed = await env.DB.prepare(`DELETE FROM auth_login_transactions WHERE id=? AND code_challenge=?
      AND status='ready' AND expires_at>? RETURNING owner_id AS ownerId`)
      .bind(body.loginId, await hashSecret(body.codeVerifier), Date.now()).first()
    if (!claimed) return error(404, 'login_not_found', '登录请求已失效，请重新登录。')
    return issueSession(env.DB, claimed.ownerId, 'wechat', null, json)
  }
  return error(404, 'NOT_FOUND', '接口不存在。')
}
