;(() => {
  'use strict'
  const $ = (selector) => document.querySelector(selector)
  const apiBase = String(window.TRACKER_API_BASE || '')
    .trim()
    .replace(/\/+$/, '')
  const storageKey = 'sanwan-maintenance-session-v1'
  const events = new EventTarget()
  let session = null
  let generation = 0
  let controller = new AbortController()
  let expiryTimer
  let mode = 'login'
  let submitting = false
  let attempt = 0
  let config = { password: { enabled: false }, wechat: { enabled: false } }

  function authError(message, status = 401) {
    const error = new Error(message)
    error.status = status
    return error
  }
  function assertSession(expected = generation) {
    if (!session || expected !== generation || Date.parse(session.expiresAt) <= Date.now()) {
      throw authError('登录状态已变化，请重新登录后再操作。')
    }
  }
  function render() {
    const signedIn = Boolean(session)
    $('#auth-panel').dataset.state = signedIn ? 'signed-in' : 'signed-out'
    $('#auth-form').hidden = signedIn
    $('#account-workspace').hidden = !signedIn
    $('#auth-user').hidden = !signedIn
    $('#auth-user').textContent = signedIn ? session.user.username || '微信用户' : ''
    $('#logout-button').hidden = !signedIn
    $('#login-wechat').hidden = signedIn
    $('#login-wechat').disabled = !config.wechat?.enabled || submitting
    $('#login-wechat').textContent = config.wechat?.enabled ? '使用微信登录' : '微信登录 · 尚未开通'
    $('#auth-submit').disabled = submitting || !config.password?.enabled
    $('#auth-submit').textContent = submitting
      ? '正在处理…'
      : mode === 'register'
        ? '注册并登录'
        : '登录'
    $('#auth-mode-login').disabled = submitting
    $('#auth-mode-register').disabled = submitting
    $('#auth-mode-login').setAttribute('aria-selected', String(mode === 'login'))
    $('#auth-mode-register').setAttribute('aria-selected', String(mode === 'register'))
    $('#confirm-password-field').hidden = mode !== 'register'
    $('#confirm-password').required = mode === 'register'
    $('#password').autocomplete = mode === 'register' ? 'new-password' : 'current-password'
    $('#auth-status').textContent = signedIn
      ? '私人记录 · 仅当前账号可见和修改'
      : config.password?.enabled
        ? '登录后查看自己的维护记录。每个账号独立保存，支持在其他电脑登录。'
        : '登录服务尚未开通，请稍后重试。'
  }
  function showError(message) {
    $('#auth-error').textContent = message || ''
    $('#auth-error').hidden = !message
  }
  function clearSession(message = '') {
    controller.abort()
    controller = new AbortController()
    generation++
    session = null
    clearTimeout(expiryTimer)
    try {
      sessionStorage.removeItem(storageKey)
    } catch {
      /* In-memory login still works. */
    }
    $('#auth-form').reset()
    submitting = false
    attempt++
    render()
    showError(message)
    events.dispatchEvent(new Event('change'))
  }
  function acceptSession(value) {
    if (
      !value ||
      typeof value.accessToken !== 'string' ||
      !value.accessToken ||
      value.tokenType !== 'Bearer' ||
      typeof value.user?.id !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= Date.now()
    ) {
      throw new Error('登录服务返回了无效的会话，请稍后重试。')
    }
    controller.abort()
    controller = new AbortController()
    generation++
    session = {
      accessToken: value.accessToken,
      tokenType: 'Bearer',
      expiresAt: value.expiresAt,
      user: value.user
    }
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(session))
    } catch {
      /* Session is memory-only. */
    }
    clearTimeout(expiryTimer)
    expiryTimer = setTimeout(
      () => clearSession('登录已过期，请重新登录。'),
      Math.min(2147483647, Date.parse(session.expiresAt) - Date.now())
    )
    $('#auth-form').reset()
    showError('')
    submitting = false
    render()
    events.dispatchEvent(new Event('change'))
  }
  async function send(path, options = {}, token = null, signal = undefined) {
    const url = new URL(apiBase)
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))
    ) {
      throw new Error('登录服务必须使用 HTTPS。')
    }
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000)
    })
    let body
    try {
      body = await response.json()
    } catch {
      throw new Error('登录服务返回了无法识别的数据。')
    }
    if (!response.ok) {
      const error = authError(
        body?.error?.message || `请求失败（${response.status}）`,
        response.status
      )
      error.code = body?.error?.code
      throw error
    }
    return body
  }
  async function request(path, options = {}, expected = generation) {
    assertSession(expected)
    try {
      const result = await send(path, options, session.accessToken, controller.signal)
      assertSession(expected)
      return result
    } catch (error) {
      if (error.status === 401 && expected === generation) clearSession('登录已过期，请重新登录。')
      throw error
    }
  }
  async function start() {
    try {
      config = await send('/api/auth/config')
      render()
      let saved
      try {
        saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null')
      } catch {
        /* Invalid saved value. */
      }
      if (saved?.accessToken && Date.parse(saved.expiresAt) > Date.now()) {
        try {
          const checked = await send('/api/auth/session', {}, saved.accessToken)
          acceptSession({ ...saved, ...checked, tokenType: 'Bearer' })
        } catch {
          clearSession('登录已失效，请重新登录。')
        }
      } else {
        try {
          sessionStorage.removeItem(storageKey)
        } catch {
          /* Storage may be unavailable. */
        }
      }
    } catch (error) {
      render()
      showError(`无法连接登录服务：${error.message}`)
    }
  }
  for (const selected of ['login', 'register']) {
    $(`#auth-mode-${selected}`).addEventListener('click', () => {
      if (submitting) return
      mode = selected
      $('#password').value = ''
      $('#confirm-password').value = ''
      showError('')
      render()
    })
  }
  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    if (submitting || !config.password?.enabled || session) return
    const username = $('#username').value.trim().toLowerCase()
    const password = $('#password').value
    if (
      !/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username) ||
      password.length < 12 ||
      password.length > 128
    ) {
      showError(
        '账号需为 3–32 位英文字母、数字、下划线、点或横线，首位为字母或数字；密码需为 12–128 位。'
      )
      return
    }
    if (mode === 'register' && password !== $('#confirm-password').value) {
      showError('两次输入的密码不一致。')
      return
    }
    submitting = true
    const current = ++attempt
    render()
    showError('')
    try {
      const result = await send(`/api/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ username, password })
      })
      if (current === attempt) acceptSession(result)
    } catch (error) {
      if (current === attempt)
        showError(error.status === 429 ? '尝试次数较多，请稍后再试。' : error.message)
    } finally {
      if (current === attempt) {
        submitting = false
        render()
      }
    }
  })
  $('#logout-button').addEventListener('click', () => {
    const previous = session
    clearSession()
    if (previous)
      void send('/api/auth/logout', { method: 'POST', body: '{}' }, previous.accessToken).catch(
        () => {}
      )
  })
  $('#login-wechat').addEventListener('click', async () => {
    if (!config.wechat?.enabled || submitting || session) return
    submitting = true
    const current = ++attempt
    render()
    showError('')
    const base64url = (bytes) =>
      btoa(String.fromCharCode(...bytes))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '')
    const codeVerifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
    const codeChallenge = base64url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier)))
    )
    try {
      const login = await send('/api/auth/wechat/start', {
        method: 'POST',
        body: JSON.stringify({ codeChallenge, codeChallengeMethod: 'S256' })
      })
      const authorization = new URL(login.authorizationUrl)
      if (
        authorization.protocol !== 'https:' ||
        authorization.hostname !== 'open.weixin.qq.com' ||
        authorization.pathname !== '/connect/qrconnect'
      )
        throw new Error('微信授权地址无效。')
      const link = document.createElement('a')
      link.href = authorization.href
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.click()
      $('#auth-status').textContent = '请在打开的微信授权页面完成登录…'
      while (current === attempt && Date.parse(login.expiresAt) > Date.now()) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        if (current !== attempt) return
        const body = JSON.stringify({ loginId: login.loginId, codeVerifier })
        const state = await send('/api/auth/wechat/poll', { method: 'POST', body })
        if (current !== attempt) return
        if (state.status === 'ready') {
          const result = await send('/api/auth/wechat/exchange', { method: 'POST', body })
          if (current === attempt) acceptSession(result)
          return
        }
        if (state.status === 'failed') throw new Error('微信授权未完成，请重试。')
      }
      if (current === attempt) throw new Error('微信登录已超时，请重试。')
    } catch (error) {
      if (current === attempt) showError(error.message)
    } finally {
      if (current === attempt) {
        submitting = false
        render()
      }
    }
  })
  window.MaintenanceAuth = {
    start,
    request,
    assertSession,
    get user() {
      return session?.user || null
    },
    get generation() {
      return generation
    },
    get signal() {
      return controller.signal
    },
    onChange(listener) {
      events.addEventListener('change', listener)
    }
  }
})()
