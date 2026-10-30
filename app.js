;(() => {
  'use strict'
  const $ = (selector) => document.querySelector(selector)
  const dialog = $('#account-dialog')
  const form = $('#account-form')
  const fields = form.elements
  const apiBase = String(window.TRACKER_API_BASE || '')
    .trim()
    .replace(/\/+$/, '')
  const auth = window.MaintenanceAuth
  let records = []
  let connected = false
  let editing = null
  let toastTimer
  let busy = false
  const regionGroups = [
    ['HN1', ['艾欧尼亚']],
    ['HN10', ['黑色玫瑰']],
    ['BGP2', ['峡谷之巅']],
    [
      'NJ100',
      [
        '联盟一区',
        '祖安',
        '皮尔特沃夫',
        '巨神峰',
        '教育网',
        '男爵领域',
        '均衡教派',
        '影流',
        '守望之海'
      ]
    ],
    ['GZ100', ['联盟二区', '卡拉曼达', '暗影岛', '征服之海', '诺克萨斯', '战争学院', '雷瑟守备']],
    ['CQ100', ['联盟三区', '班德尔城', '裁决之地', '水晶之痕', '钢铁烈阳', '皮城警备']],
    ['TJ100', ['联盟四区', '比尔吉沃特', '弗雷尔卓德', '扭曲丛林']],
    ['TJ101', ['联盟五区', '德玛西亚', '无畏先锋', '恕瑞玛', '巨龙之巢']]
  ]
  const regionCodes = new Map(
    regionGroups.flatMap(([code, names]) => [[code, code], ...names.map((name) => [name, code])])
  )
  regionCodes.set('皮尔特洛夫', 'NJ100')
  const rankNames = {
    IRON: '黑铁',
    BRONZE: '青铜',
    SILVER: '白银',
    GOLD: '黄金',
    PLATINUM: '铂金',
    EMERALD: '翡翠',
    DIAMOND: '钻石',
    MASTER: '大师',
    GRANDMASTER: '宗师',
    CHALLENGER: '王者'
  }
  const profiles = new Map()
  let loadingProfiles = false
  const profileKey = (record) => `${record.name}\n${record.region}`
  function profileFields(profile) {
    if (profile.rankStatus === 'provisional')
      return { rankTier: null, rankDivision: null, rankLp: null, profileObservedAt: null }
    return {
      rankTier: profile.rankTier ?? null,
      rankDivision: profile.rankDivision ?? null,
      rankLp: profile.rankLp ?? null,
      profileObservedAt: profile.profileObservedAt
        ? new Date(profile.profileObservedAt).toISOString()
        : null
    }
  }
  function rankLabel(record) {
    const profile = profiles.get(profileKey(record))?.data || record
    if (profile.rankStatus === 'provisional') return '定级中'
    if (profile.rankTier === 'UNRANKED') return '未定级'
    if (!rankNames[profile.rankTier]) return '段位未获取'
    const division = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(profile.rankTier)
      ? ''
      : profile.rankDivision
        ? ` ${profile.rankDivision}`
        : ''
    return `${rankNames[profile.rankTier]}${division} · ${Number.isInteger(profile.rankLp) ? `${profile.rankLp} 分` : '胜点未获取'}`
  }
  async function queryLocal(path, payload, timeout = 45000) {
    let response
    try {
      response = await fetch(`http://127.0.0.1:8765${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          region: regionCodes.get(payload.region) || payload.region
        }),
        signal: AbortSignal.any([auth.signal, AbortSignal.timeout(timeout)])
      })
    } catch (error) {
      throw new Error(
        error.name === 'TimeoutError'
          ? '游戏资料查询超时，请稍后重试。'
          : '无法连接本机查询服务，请保持游戏客户端和查询程序运行。'
      )
    }
    const data = await response.json()
    if (!response.ok || !data.ok)
      throw new Error(data.error || `游戏资料查询失败（${response.status}）`)
    return data
  }
  async function queryProfile(record) {
    const expected = auth.generation
    auth.assertSession(expected)
    const profile = await queryLocal('/api/profile', { riotId: record.name, region: record.region })
    auth.assertSession(expected)
    profiles.set(profileKey(record), { data: profile, at: Date.now() })
    return profile
  }
  async function loadProfiles() {
    if (loadingProfiles || !connected) return
    loadingProfiles = true
    const expected = auth.generation
    const pending = records.filter(
      (record) => Date.now() - (profiles.get(profileKey(record))?.at || 0) > 300000
    )
    try {
      await Promise.all(
        Array.from({ length: Math.min(3, pending.length) }, async () => {
          while (pending.length && expected === auth.generation && auth.user) {
            const record = pending.shift()
            try {
              await queryProfile(record)
            } catch {
              if (expected === auth.generation)
                profiles.set(profileKey(record), { data: null, at: Date.now() })
            }
            if (!busy && expected === auth.generation) render()
          }
        })
      )
    } finally {
      if (expected === auth.generation) loadingProfiles = false
    }
  }
  for (const [, names] of regionGroups)
    for (const name of names) {
      const option = document.createElement('option')
      option.value = name
      option.textContent = name
      fields.server.append(option)
    }

  function localToday() {
    return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  }
  function beijingTime(value) {
    const date = new Date(value)
    return Number.isNaN(date.getTime())
      ? '时间未知'
      : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  }
  function dayNumber(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN
    const [year, month, day] = value.split('-').map(Number)
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    date.setUTCHours(0, 0, 0, 0)
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    )
      return NaN
    return date.getTime() / 86400000
  }
  function remaining(record) {
    if (
      window.MaintenanceEngine &&
      record.candidateStatus === 'estimate' &&
      Number.isInteger(record.candidateDays) &&
      record.candidateAt
    ) {
      try {
        return window.MaintenanceEngine.decay(
          record.candidateDays,
          record.candidateAt,
          new Date().toISOString()
        )
      } catch {
        /* fall back */
      }
    }
    if (window.MaintenanceEngine && record.baselineAt) {
      try {
        return window.MaintenanceEngine.decay(
          record.days,
          record.baselineAt,
          new Date().toISOString()
        )
      } catch {
        /* fall back */
      }
    }
    return Math.max(
      0,
      record.days - Math.max(0, dayNumber(localToday()) - dayNumber(record.baselineDate))
    )
  }
  function toast(message) {
    const box = $('#toast')
    box.textContent = message
    box.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => box.classList.remove('show'), 4500)
  }
  function validRecord(item) {
    return (
      item &&
      typeof item.id === 'string' &&
      item.id.length > 0 &&
      typeof item.name === 'string' &&
      item.name.trim() &&
      typeof item.region === 'string' &&
      item.region.trim() &&
      ['单双排', '灵活组排', '未知'].includes(item.queue) &&
      ['钻石', '大师及以上', '未知'].includes(item.tier) &&
      Number.isInteger(item.days) &&
      item.days >= 0 &&
      item.days <= 365 &&
      Number.isFinite(dayNumber(item.baselineDate)) &&
      typeof item.note === 'string' &&
      Number.isInteger(item.revision)
    )
  }
  function setConnection(isConnected, message) {
    connected = isConnected && Boolean(auth.user)
    $('#connection-status').textContent = connected ? '私人记录已连接' : '私人记录未连接'
    const alert = $('#connection-alert')
    alert.classList.toggle('ok', isConnected)
    alert.firstChild.textContent = message
    $('#retry-connection').hidden = isConnected
    $('#add-account').disabled = !isConnected
    $('#empty-add').disabled = !isConnected
    $('#update-maintenance').disabled = !isConnected || busy
  }
  async function request(path, options = {}, expected = auth.generation) {
    return auth.request(path, options, expected)
  }
  async function refresh() {
    const expected = auth.generation
    if (!auth.user) {
      records = []
      setConnection(false, '请先登录自己的账号。')
      render()
      return
    }
    if (!apiBase) {
      setConnection(false, '尚未配置服务地址，请先完成部署。')
      render()
      return
    }
    try {
      const url = new URL(apiBase)
      if (
        url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
      )
        throw new Error('私人记录服务地址必须使用 HTTPS。')
      const result = await request('/api/accounts', {}, expected)
      if (!Array.isArray(result.accounts) || !result.accounts.every(validRecord))
        throw new Error('私人记录服务返回的数据格式不正确。')
      records = result.accounts
      setConnection(true, '已连接私人记录。只有当前登录账号可以查看和修改。')
    } catch (error) {
      if (expected !== auth.generation) return
      setConnection(false, `无法连接私人记录：${error.message}。请稍后重试。`)
    }
    render()
    void loadProfiles()
  }
  function element(tag, className, content) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (content !== undefined) node.textContent = content
    return node
  }
  function cardFor(record) {
    const days = remaining(record)
    const card = element('article', `account-card${days === 0 ? ' urgent' : ''}`)
    const identity = element('div', 'account-identity')
    const identityText = element('div', 'identity-text')
    identityText.append(
      element('div', 'account-name', record.name),
      element('div', 'account-server', record.region),
      element('div', 'row-tags', `${record.queue} · ${rankLabel(record)}`)
    )
    if (record.note) identityText.append(element('div', 'account-note', record.note))
    identity.append(identityText)
    const remainingBlock = element('div', 'account-meta')
    const hasCandidate =
      record.candidateStatus === 'estimate' &&
      Number.isInteger(record.candidateDays) &&
      record.candidateAt
    remainingBlock.append(
      element('div', 'meta-label', hasCandidate ? '估算剩余（按结算递减）' : '未查战绩的估算'),
      element('div', 'meta-value days-value', days === 0 ? '0 天 · 需要维护' : `${days} 天`)
    )
    if (hasCandidate)
      remainingBlock.append(
        element(
          'div',
          'meta-label',
          `核对时 ${record.candidateDays} 天 · ${beijingTime(record.candidateAt)}（北京）`
        )
      )
    const recordBlock = element('div', 'account-meta')
    recordBlock.append(
      element('div', 'meta-label', '记录日期 / 当时天数'),
      element('div', 'meta-value', `${record.baselineDate} · ${record.days} 天`)
    )
    recordBlock.append(
      element(
        'div',
        'meta-label',
        record.baselineAt
          ? `人工基准：${beijingTime(record.baselineAt)}（北京）`
          : '缺少精确时间，请编辑并重新填写当前天数'
      )
    )
    const actions = element('div', 'row-actions')
    for (const [action, label] of [
      ['edit', '编辑'],
      ['delete', '删除']
    ]) {
      const button = element('button', 'icon-button', label)
      button.type = 'button'
      button.dataset.action = action
      button.dataset.id = record.id
      button.disabled = !connected || busy
      button.setAttribute('aria-label', `${label} ${record.name} 的记录`)
      actions.append(button)
    }
    card.append(identity, remainingBlock, recordBlock, actions)
    return card
  }
  function render() {
    const visible = records
      .filter((record) =>
        `${record.name}\n${record.region}`
          .toLocaleLowerCase()
          .includes($('#search').value.trim().toLocaleLowerCase())
      )
      .sort((a, b) => remaining(a) - remaining(b))
    const show = (value) => (connected ? String(value).padStart(2, '0') : '—')
    $('#total-count').textContent = show(records.length)
    $('#urgent-count').textContent = show(
      records.filter((record) => remaining(record) === 0).length
    )
    $('#expired-count').textContent = show(records.filter((record) => remaining(record) > 0).length)
    $('#today-date').textContent = localToday().replaceAll('-', '.')
    $('#list-count').textContent = connected ? records.length : '—'
    $('#result-count').textContent = !connected
      ? '私人记录未连接'
      : visible.length === records.length
        ? `共 ${records.length} 个账号`
        : `找到 ${visible.length} 个账号`
    $('#account-list').replaceChildren(...(connected ? visible.map(cardFor) : []))
    $('#empty-state').hidden = !connected || records.length !== 0
    $('#no-results').hidden = !connected || records.length === 0 || visible.length !== 0
  }
  function openForm(record) {
    if (!connected || busy) return
    form.reset()
    $('#form-error').hidden = true
    editing = record || null
    $('#dialog-title').textContent = record ? '编辑账号' : '添加账号'
    const separator = record?.name.lastIndexOf('#') ?? -1
    fields.gameId.value = separator >= 0 ? record.name.slice(0, separator) : record?.name || ''
    fields.tag.value = separator >= 0 ? record.name.slice(separator + 1) : ''
    if (
      record?.region &&
      !Array.from(fields.server.options).some((option) => option.value === record.region)
    ) {
      const option = document.createElement('option')
      option.value = record.region
      option.textContent = record.region
      fields.server.append(option)
    }
    fields.server.value = record?.region || ''
    fields.days.value = ''
    form.querySelector('[type=submit]').disabled = false
    dialog.showModal()
  }
  $('#add-account').addEventListener('click', () => openForm())
  $('#empty-add').addEventListener('click', () => openForm())
  $('#close-dialog').addEventListener('click', () => {
    if (!busy) dialog.close()
  })
  $('#cancel-dialog').addEventListener('click', () => {
    if (!busy) dialog.close()
  })
  dialog.addEventListener('cancel', (event) => {
    if (busy) event.preventDefault()
  })
  $('#retry-connection').addEventListener('click', refresh)
  $('#search').addEventListener('input', render)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (busy || !connected) return
    const expected = auth.generation
    const now = new Date()
    const name = fields.gameId.value.trim(),
      tag = fields.tag.value.trim()
    const data = {
      name: `${name}#${tag}`,
      region: fields.server.value,
      queue: '单双排',
      days: Number(fields.days.value),
      baselineDate: new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10),
      baselineAt: now.toISOString(),
      note: editing?.note || ''
    }
    if (
      !name ||
      !tag ||
      name.includes('#') ||
      tag.includes('#') ||
      !data.region ||
      !fields.days.value.trim() ||
      !Number.isInteger(data.days) ||
      data.days < 0 ||
      data.days > 28
    ) {
      $('#form-error').textContent = '请填写游戏 ID 和编号，选择大区，并填写 0–28 的整数天数。'
      $('#form-error').hidden = false
      return
    }
    busy = true
    const submit = form.querySelector('[type=submit]')
    submit.disabled = true
    submit.textContent = '正在查询段位并保存…'
    render()
    let writeAttempted = false
    try {
      const profile = await queryProfile(data)
      if (!['钻石', '大师及以上', '未知'].includes(profile.tier))
        throw new Error('未获取到有效段位，请稍后重试。')
      data.tier = profile.tier
      Object.assign(data, profileFields(profile))
      if (data.tier === '大师及以上' && data.days > 14)
        throw new Error('当前段位为大师及以上，剩余天数最多为 14。')
      writeAttempted = true
      await request(
        editing ? `/api/accounts/${encodeURIComponent(editing.id)}` : '/api/accounts',
        {
          method: editing ? 'PUT' : 'POST',
          body: JSON.stringify(editing ? { ...data, revision: editing.revision } : data)
        },
        expected
      )
      dialog.close()
      await refresh()
      toast(editing ? '记录已更新' : '账号已添加')
    } catch (error) {
      if (expected !== auth.generation) return
      if (error.status === 409 || error.status === 404) {
        await refresh()
        $('#form-error').textContent =
          '这条记录已在其他设备修改或删除。请关闭窗口并重新打开最新记录后再编辑。'
      } else {
        $('#form-error').textContent =
          `${error.message}${writeAttempted ? ' 如连接中断，请刷新记录后确认是否已保存。' : ''}`
        if (writeAttempted && !error.status) {
          setConnection(false, '私人记录连接失败，请重试并确认记录是否已保存。')
        }
      }
      $('#form-error').hidden = false
    } finally {
      if (expected === auth.generation) {
        busy = false
        submit.disabled = !connected
        submit.textContent = '查询段位并保存'
        render()
      }
    }
  })
  $('#account-list').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]')
    if (!button || !connected) return
    const record = records.find((item) => item.id === button.dataset.id)
    if (!record) return
    if (button.dataset.action === 'edit') {
      openForm(record)
      return
    }
    if (
      button.dataset.action === 'delete' &&
      !busy &&
      confirm(`确定删除你保存的“${record.name}”（${record.region}）记录吗？`)
    ) {
      const expected = auth.generation
      busy = true
      button.disabled = true
      try {
        await request(
          `/api/accounts/${encodeURIComponent(record.id)}`,
          { method: 'DELETE', body: JSON.stringify({ revision: record.revision }) },
          expected
        )
        await refresh()
        toast('记录已删除')
      } catch (error) {
        if (expected !== auth.generation) return
        if (error.status === 409 || error.status === 404) {
          await refresh()
          toast('记录已在其他设备修改或删除，列表已刷新。')
        } else {
          if (!error.status) {
            setConnection(false, '私人记录连接失败，请重试并确认记录是否已删除。')
            render()
          } else {
            button.disabled = false
          }
          toast(`${error.message}。请刷新确认删除是否成功。`)
        }
      } finally {
        if (expected === auth.generation) busy = false
      }
    }
  })
  $('#update-maintenance').addEventListener('click', async () => {
    if (!connected || busy) return
    const expected = auth.generation
    const targets = [...records]
    const status = $('#update-status')
    status.hidden = false
    status.replaceChildren()
    if (!targets.length) {
      status.append(element('p', '', '没有可更新的账号。'))
      return
    }
    busy = true
    $('#update-maintenance').disabled = true
    $('#add-account').disabled = true
    $('#empty-add').disabled = true
    render()
    const heading = element('strong', '', `正在核对 ${targets.length} 个账号…`)
    status.append(heading)
    for (const record of targets) {
      if (expected !== auth.generation || !auth.user) return
      const line = element('p', '', `${record.name}（${record.region}）：正在查询…`)
      status.append(line)
      let writeAttempted = false
      try {
        if (!record.baselineAt) throw new Error('缺少精确基准时间，请编辑记录并重新填写当前天数。')
        if (!window.MaintenanceEngine) throw new Error('计算组件未加载，请刷新页面重试。')
        const profile = await queryProfile(record)
        const data = await queryLocal(
          '/api/matches',
          { riotId: record.name, region: record.region, since: record.baselineAt },
          120000
        )
        if (data.complete !== true)
          throw new Error(
            `战绩未能覆盖录入时刻，不能计算。${typeof data.reason === 'string' ? data.reason : '请稍后重试或重新确认天数。'}`
          )
        const calculationRecord = { ...record, tier: profile.tier }
        const plan = window.MaintenanceEngine.plan(calculationRecord, data)
        line.textContent = `${record.name}（${record.region}）：正在计入 ${plan.decisions.length} 场单双排…`
        const saved =
          record.candidateReviews && typeof record.candidateReviews === 'object'
            ? record.candidateReviews
            : {}
        const present = new Set(plan.decisions.map((match) => match.gameId))
        if (Object.keys(saved).some((id) => !present.has(id)))
          throw new Error('此前查询到的对局未出现在此次战绩中，请稍后重试；原估算未更改。')
        const estimate = window.MaintenanceEngine.calculate(calculationRecord, plan)
        Object.assign(estimate, profileFields(profile))
        // Keep the existing API shape; every returned eligible match now counts automatically.
        estimate.candidateReviews = Object.fromEntries(
          plan.decisions.map((match) => [
            match.gameId,
            { include: true, wasAfk: match.wasAfk, endedAt: new Date(match.endedAt).toISOString() }
          ])
        )
        writeAttempted = true
        await request(
          `/api/accounts/${encodeURIComponent(record.id)}/estimate`,
          { method: 'POST', body: JSON.stringify({ revision: record.revision, ...estimate }) },
          expected
        )
        line.textContent = `${record.name}（${record.region}）：已计入基准后的 ${plan.decisions.length} 场单双排，保存 ${estimate.candidateDays} 天的估算，查询时间 ${beijingTime(estimate.candidateAt)}（北京）。`
      } catch (error) {
        if (expected !== auth.generation) return
        const detail =
          error.status === 409
            ? '记录已被修改，请刷新后重新核对。'
            : writeAttempted && (!error.status || error.status >= 500)
              ? '保存结果未知，请刷新记录确认后再试。'
              : error instanceof TypeError
                ? '无法连接查询程序，请确认本机客户端和查询程序已启动。'
                : error.name === 'TimeoutError'
                  ? '查询超时，请稍后重试。'
                  : error.message
        line.textContent = `${record.name}（${record.region}）：${writeAttempted && (!error.status || error.status >= 500) ? '' : '未更新。'}${detail}`
      }
    }
    heading.textContent = '本次核对已结束，请查看各账号的结果。'
    busy = false
    await refresh()
  })

  auth.onChange(() => {
    records = []
    profiles.clear()
    loadingProfiles = false
    busy = false
    editing = null
    dialog.close()
    form.reset()
    $('#form-error').textContent = ''
    $('#form-error').hidden = true
    clearTimeout(toastTimer)
    $('#toast').textContent = ''
    $('#toast').classList.remove('show')
    $('#update-status').hidden = true
    $('#update-status').replaceChildren()
    $('#search').value = ''
    setConnection(false, auth.user ? '正在加载私人记录…' : '请先登录自己的账号。')
    render()
    if (auth.user) void refresh()
  })
  setConnection(false, '请先登录自己的账号。')
  render()
  void auth.start()
  setInterval(render, 60000)
})()
