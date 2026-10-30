;(() => {
  'use strict'
  const $ = (selector) => document.querySelector(selector)
  const apiBase = String(window.TRACKER_API_BASE || '')
    .trim()
    .replace(/\/+$/, '')
  const storageKey = 'sanwan-maintenance-session-v1'
  const rememberedKey = 'sanwan-maintenance-remembered-v1'
  const desktopChannel =
    window.parent && window.parent !== window && window.location?.hash
      ? new URLSearchParams(window.location.hash.slice(1)).get('theme-channel')
      : null
  let desktopStorageReady = false
  let storageQueue = Promise.resolve()
  const events = new EventTarget()
  let session = null
  let generation = 0
  let controller = new AbortController()
  let expiryTimer
  let mode = 'login'
  let submitting = false
  let attempt = 0
  let initializing = true
  let config = { password: { enabled: false }, wechat: { enabled: false } }

  function desktopStorage(action, value) {
    if (action !== 'read' && !desktopStorageReady)
      return desktopStorage('read').then(() => desktopStorage(action, value))
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID()
      const finish = () => {
        clearTimeout(timeout)
        window.removeEventListener('message', receive)
      }
      const receive = (event) => {
        if (event.source !== window.parent) return
        let trusted = event.origin === 'null'
        try {
          const origin = new URL(event.origin)
          trusted ||=
            origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)
        } catch {
          /* Packaged Electron has an opaque file origin. */
        }
        const reply = event.data
        if (
          !trusted ||
          reply?.type !== 'sanwan-maintenance-storage-result' ||
          reply.version !== 1 ||
          reply.channel !== desktopChannel ||
          reply.requestId !== requestId
        )
          return
        finish()
        if (reply.ok === true) {
          desktopStorageReady = true
          resolve(reply.value ?? null)
        } else reject(new Error('无法保存本机登录状态。'))
      }
      const timeout = setTimeout(() => {
        finish()
        reject(new Error('本机登录存储未响应。'))
      }, 5000)
      window.addEventListener('message', receive)
      window.parent.postMessage(
        {
          type: 'sanwan-maintenance-storage',
          version: 1,
          channel: desktopChannel,
          requestId,
          action,
          ...(action === 'write' ? { value } : {})
        },
        '*'
      )
    })
  }
  function rememberedStorage(action, value) {
    const next = storageQueue
      .catch(() => {})
      .then(async () => {
        if (desktopChannel) return desktopStorage(action, value)
        if (action === 'read') {
          try {
            return JSON.parse(localStorage.getItem(rememberedKey) || 'null')
          } catch {
            return null
          }
        }
        if (action === 'write') localStorage.setItem(rememberedKey, JSON.stringify(value))
        else localStorage.removeItem(rememberedKey)
        return value ?? null
      })
    storageQueue = next
    return next
  }

  function authError(message, status = 401) {
    const error = new Error(message)
    error.status = status
    return error
  }
  function assertSession(expected = generation) {
    if (
      !session ||
      expected !== generation ||
      (session.expiresAt !== null && Date.parse(session.expiresAt) <= Date.now())
    ) {
      throw authError('登录状态已变化，请重新登录后再操作。')
    }
  }
  function render() {
    const signedIn = Boolean(session)
    $('#auth-panel').dataset.state = signedIn ? 'signed-in' : 'signed-out'
    $('#auth-form').hidden = signedIn || initializing
    $('#auth-actions').hidden = initializing
    $('#account-workspace').hidden = !signedIn
    $('#auth-user').hidden = !signedIn
    $('#auth-user').textContent = signedIn ? session.user.username || '微信用户' : ''
    $('#logout-button').hidden = !signedIn
    $('#login-wechat').hidden = signedIn
    $('#login-wechat').disabled = !config.wechat?.enabled || submitting
    $('#login-wechat').textContent = config.wechat?.enabled ? '使用微信登录' : '微信登录 · 尚未开通'
    $('#auth-submit').disabled = initializing || submitting || !config.password?.enabled
    $('#auth-submit').textContent = submitting
      ? '正在处理…'
      : mode === 'register'
        ? '注册并登录'
        : '登录'
    $('#auth-mode-login').disabled = submitting
    $('#auth-mode-register').disabled = submitting
    $('#remember-login').disabled = submitting
    $('#auth-mode-login').setAttribute('aria-selected', String(mode === 'login'))
    $('#auth-mode-register').setAttribute('aria-selected', String(mode === 'register'))
    $('#confirm-password-field').hidden = mode !== 'register'
    $('#confirm-password').required = mode === 'register'
    $('#password').autocomplete = mode === 'register' ? 'new-password' : 'current-password'
    $('#auth-status').textContent =
      initializing && !signedIn
        ? '正在恢复登录状态…'
        : signedIn
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
    void rememberedStorage('clear').catch(() =>
      showError('未能清除本机登录状态，请重新打开后退出登录。')
    )
    $('#auth-form').reset()
    submitting = false
    attempt++
    render()
    showError(message)
    events.dispatchEvent(new Event('change'))
  }
  function acceptSession(value, rememberMe = false, persist = true) {
    if (
      !value ||
      typeof value.accessToken !== 'string' ||
      !value.accessToken ||
      value.tokenType !== 'Bearer' ||
      typeof value.user?.id !== 'string' ||
      (value.expiresAt === null
        ? !rememberMe
        : !Number.isFinite(Date.parse(value.expiresAt)) ||
          Date.parse(value.expiresAt) <= Date.now())
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
      user: value.user,
      rememberMe
    }
    try {
      if (rememberMe) sessionStorage.removeItem(storageKey)
      else sessionStorage.setItem(storageKey, JSON.stringify(session))
    } catch {
      /* Session is memory-only. */
    }
    clearTimeout(expiryTimer)
    const timedSession = session
    const checkExpiry = () => {
      if (session !== timedSession) return
      if (timedSession.expiresAt === null) return
      const remaining = Date.parse(timedSession.expiresAt) - Date.now()
      if (remaining <= 0) clearSession('登录已过期，请重新登录。')
      else expiryTimer = setTimeout(checkExpiry, Math.min(2147483647, remaining))
    }
    checkExpiry()
    $('#auth-form').reset()
    showError('')
    submitting = false
    render()
    events.dispatchEvent(new Event('change'))
    if (persist) {
      const saved = session
      void rememberedStorage(rememberMe ? 'write' : 'clear', rememberMe ? saved : undefined).catch(
        () => {
          if (session === saved) {
            $('#auth-status').textContent = '已登录，但未能记住登录状态；下次打开需要重新登录。'
          }
        }
      )
    }
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
      const restoringAttempt = attempt
      const restoringGeneration = generation
      let saved
      try {
        saved = await rememberedStorage('read')
      } catch {
        /* Secure storage may be unavailable; manual login still works. */
      }
      if (attempt !== restoringAttempt || generation !== restoringGeneration) return
      if (!saved) {
        try {
          saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null')
        } catch {
          /* Invalid saved value. */
        }
      }
      if (
        saved?.accessToken &&
        ((saved.expiresAt === null && saved.rememberMe === true) ||
          Date.parse(saved.expiresAt) > Date.now())
      ) {
        try {
          const checked = await send('/api/auth/session', {}, saved.accessToken)
          if (attempt === restoringAttempt && generation === restoringGeneration)
            acceptSession(
              { ...saved, ...checked, tokenType: 'Bearer' },
              saved.rememberMe === true,
              false
            )
        } catch (error) {
          if (attempt === restoringAttempt && generation === restoringGeneration) {
            if (error.status === 401) clearSession('登录已失效，请重新登录。')
            else showError('暂时无法恢复登录，请检查网络后重新载入。已保存的登录状态会保留。')
          }
        }
      } else {
        try {
          sessionStorage.removeItem(storageKey)
        } catch {
          /* Storage may be unavailable. */
        }
        if (saved) {
          if (typeof saved.user?.username === 'string') $('#username').value = saved.user.username
          void rememberedStorage('clear').catch(() => {})
        }
      }
    } catch (error) {
      render()
      showError(`无法连接登录服务：${error.message}`)
    } finally {
      initializing = false
      render()
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
    const rememberMe = $('#remember-login').checked === true
    if (!username || !password.length) {
      showError('请输入用户名和密码。')
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
        body: JSON.stringify({ username, password, rememberMe })
      })
      if (current === attempt) acceptSession(result, rememberMe)
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
