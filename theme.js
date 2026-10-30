;(() => {
  'use strict'
  const channel = new URLSearchParams(location.hash.slice(1)).get('theme-channel')
  if (!channel || window.parent === window) return
  const colors = [
    '--la-color-bg-primary',
    '--la-color-text-primary',
    '--la-color-link',
    '--la-color-select-menu-bg',
    '--la-color-message-bg',
    '--la-color-popconfirm-bg',
    '--la-color-popover-border',
    '--la-card-surface-95',
    '--la-card-muted-surface',
    '--la-color-scrollbar-thumb',
    '--la-color-scrollbar-thumb-hover'
  ]
  const rgb = ['--la-card-tint-rgb', '--la-card-border-rgb']
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return
    // Packaged Electron pages use file://; development renderer uses a local HTTP origin.
    let trustedOrigin = event.origin === 'null'
    try {
      const origin = new URL(event.origin)
      trustedOrigin ||=
        origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)
    } catch {
      /* The file origin is opaque. Source and per-frame channel are checked separately. */
    }
    const message = event.data
    if (
      !trustedOrigin ||
      !message ||
      message.type !== 'sanwan-maintenance-theme' ||
      message.version !== 1 ||
      message.channel !== channel ||
      !['light', 'dark'].includes(message.mode)
    )
      return
    const root = document.documentElement
    root.dataset.theme = message.mode
    root.style.colorScheme = message.mode
    if (typeof message.themeId === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(message.themeId))
      root.dataset.themeId = message.themeId
    // Only color tokens are accepted. Never consume URLs, selectors, HTML or authentication data.
    for (const key of [...colors, ...rgb]) {
      const value = message.variables?.[key]
      if (
        typeof value === 'string' &&
        value.length < 120 &&
        CSS.supports('color', rgb.includes(key) ? `rgb(${value})` : value)
      )
        root.style.setProperty(key, value)
    }
  })
})()
