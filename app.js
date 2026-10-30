(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const dialog = $('#account-dialog');
  const form = $('#account-form');
  const fields = form.elements;
  const apiBase = String(window.TRACKER_API_BASE || '').trim().replace(/\/+$/, '');
  let records = [];
  let connected = false;
  let editing = null;
  let toastTimer;
  let busy = false;

  function localToday() {
    return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  }
  function beijingTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  }
  function dayNumber(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return NaN;
    return date.getTime() / 86400000;
  }
  function remaining(record) {
    if (window.MaintenanceEngine && record.candidateStatus === 'estimate' && Number.isInteger(record.candidateDays) && record.candidateAt) {
      try { return window.MaintenanceEngine.decay(record.candidateDays, record.candidateAt, new Date().toISOString()); } catch { /* fall back */ }
    }
    if (window.MaintenanceEngine && record.baselineAt) {
      try { return window.MaintenanceEngine.decay(record.days, record.baselineAt, new Date().toISOString()); } catch { /* fall back */ }
    }
    return Math.max(0, record.days - Math.max(0, dayNumber(localToday()) - dayNumber(record.baselineDate)));
  }
  function toast(message) {
    const box = $('#toast'); box.textContent = message; box.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.remove('show'), 4500);
  }
  function validRecord(item) {
    return item && typeof item.id === 'string' && item.id.length > 0 && typeof item.name === 'string' && item.name.trim() && typeof item.region === 'string' && item.region.trim() && ['单双排', '灵活组排', '未知'].includes(item.queue) && ['钻石', '大师及以上', '未知'].includes(item.tier) && Number.isInteger(item.days) && item.days >= 0 && item.days <= 365 && Number.isFinite(dayNumber(item.baselineDate)) && typeof item.note === 'string' && Number.isInteger(item.revision);
  }
  function setConnection(isConnected, message) {
    connected = isConnected;
    $('#connection-status').textContent = isConnected ? '共享服务已连接' : '共享服务未连接';
    const alert = $('#connection-alert'); alert.classList.toggle('ok', isConnected); alert.firstChild.textContent = message;
    $('#retry-connection').hidden = isConnected;
    $('#add-account').disabled = !isConnected;
    $('#empty-add').disabled = !isConnected;
    $('#export-button').disabled = !isConnected;
    $('#update-maintenance').disabled = !isConnected || busy;
  }
  async function request(path, options = {}) {
    const response = await fetch(`${apiBase}${path}`, { ...options, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    let body;
    try { body = await response.json(); } catch { throw new Error('共享服务返回了无法识别的数据。'); }
    if (!response.ok) { const error = new Error(body?.error?.message || `请求失败（${response.status}）`); error.status = response.status; throw error; }
    return body;
  }
  async function refresh() {
    if (!apiBase) { setConnection(false, '尚未配置共享服务地址，请先完成部署。当前没有使用浏览器本地存储。'); render(); return; }
    try {
      const url = new URL(apiBase);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('共享服务地址必须使用 HTTPS。');
      const result = await request('/api/accounts');
      if (!Array.isArray(result.accounts) || !result.accounts.every(validRecord)) throw new Error('共享服务返回的数据格式不正确。');
      records = result.accounts;
      setConnection(true, '共享服务已连接。所有访问者均可查看和修改记录，请勿保存密码等敏感信息。');
    } catch (error) {
      setConnection(false, `无法连接共享服务：${error.message}。请检查服务地址或稍后重试。`);
    }
    render();
  }
  function element(tag, className, content) {
    const node = document.createElement(tag); if (className) node.className = className; if (content !== undefined) node.textContent = content; return node;
  }
  function cardFor(record) {
    const days = remaining(record);
    const card = element('article', `account-card${days <= 3 ? ' urgent' : ''}`);
    const identity = element('div', 'account-identity');
    const avatar = element('div', 'avatar', Array.from(record.name)[0].toUpperCase()); avatar.setAttribute('aria-hidden', 'true');
    const identityText = element('div', 'identity-text');
    identityText.append(element('div', 'account-name', record.name), element('div', 'account-server', record.region), element('div', 'row-tags', `${record.queue} · ${record.tier}`));
    if (record.note) identityText.append(element('div', 'account-note', record.note));
    identity.append(avatar, identityText);
    const remainingBlock = element('div', 'account-meta');
    const hasCandidate = record.candidateStatus === 'estimate' && Number.isInteger(record.candidateDays) && record.candidateAt;
    remainingBlock.append(element('div', 'meta-label', hasCandidate ? '估算剩余（按结算递减）' : '未查战绩的估算'), element('div', 'meta-value days-value', days === 0 ? '0 天 · 待确认' : `${days} 天`));
    if (hasCandidate) remainingBlock.append(element('div', 'meta-label', `核对时 ${record.candidateDays} 天 · ${beijingTime(record.candidateAt)}（北京）`));
    const recordBlock = element('div', 'account-meta');
    recordBlock.append(element('div', 'meta-label', '记录日期 / 当时天数'), element('div', 'meta-value', `${record.baselineDate} · ${record.days} 天`));
    recordBlock.append(element('div', 'meta-label', record.baselineAt ? `人工基准：${beijingTime(record.baselineAt)}（北京）` : '缺少精确时间，请编辑并重新填写当前天数'));
    const actions = element('div', 'row-actions');
    for (const [action, label] of [['matches', '查看战绩'], ['edit', '编辑'], ['delete', '删除']]) {
      const button = element('button', 'icon-button', label); button.type = 'button'; button.dataset.action = action; button.dataset.id = record.id;
      button.disabled = !connected || busy; button.setAttribute('aria-label', `${label} ${record.name} 的记录`); actions.append(button);
    }
    card.append(identity, remainingBlock, recordBlock, actions); return card;
  }
  function render() {
    const visible = records.filter((record) => `${record.name}\n${record.region}`.toLocaleLowerCase().includes($('#search').value.trim().toLocaleLowerCase()));
    const show = (value) => connected ? String(value).padStart(2, '0') : '—';
    $('#total-count').textContent = show(records.length);
    $('#urgent-count').textContent = show(records.filter((record) => remaining(record) > 0 && remaining(record) <= 3).length);
    $('#expired-count').textContent = show(records.filter((record) => remaining(record) === 0).length);
    $('#today-date').textContent = localToday().replaceAll('-', '.');
    $('#list-count').textContent = connected ? records.length : '—';
    $('#result-count').textContent = !connected ? '共享服务未连接' : visible.length === records.length ? `共 ${records.length} 个账号` : `找到 ${visible.length} 个账号`;
    $('#account-list').replaceChildren(...(connected ? visible.map(cardFor) : []));
    $('#empty-state').hidden = !connected || records.length !== 0;
    $('#no-results').hidden = !connected || records.length === 0 || visible.length !== 0;
  }
  function openForm(record) {
    if (!connected) return;
    form.reset(); $('#form-error').hidden = true;
    editing = record || null; $('#dialog-title').textContent = record ? '编辑账号' : '添加账号';
    fields.gameId.value = record?.name || ''; fields.server.value = record?.region || '';
    fields.queue.value = record?.queue || '未知'; fields.tier.value = record?.tier || '未知';
    fields.days.value = ''; fields.recordedAt.value = localToday(); fields.note.value = record?.note || '';
    form.querySelector('[type=submit]').disabled = false; dialog.showModal();
  }
  $('#add-account').addEventListener('click', () => openForm());
  $('#empty-add').addEventListener('click', () => openForm());
  $('#close-dialog').addEventListener('click', () => dialog.close());
  $('#cancel-dialog').addEventListener('click', () => dialog.close());
  $('#retry-connection').addEventListener('click', refresh);
  $('#search').addEventListener('input', render);
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || !connected) return;
    const now = new Date();
    const data = { name: fields.gameId.value.trim(), region: fields.server.value.trim(), queue: fields.queue.value, tier: fields.tier.value, days: Number(fields.days.value), baselineDate: new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10), baselineAt: now.toISOString(), note: fields.note.value.trim() };
    if (!data.name || !data.region || !fields.days.value.trim() || !Number.isInteger(data.days) || data.days < 0 || data.days > 365 || !Number.isFinite(dayNumber(data.baselineDate)) || data.baselineDate > localToday()) {
      $('#form-error').textContent = '请检查游戏 ID、区服、天数及记录日期。日期不能晚于今天。'; $('#form-error').hidden = false; return;
    }
    busy = true; const submit = form.querySelector('[type=submit]'); submit.disabled = true;
    try {
      await request(editing ? `/api/accounts/${encodeURIComponent(editing.id)}` : '/api/accounts', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(editing ? { ...data, revision: editing.revision } : data) });
      dialog.close(); await refresh(); toast(editing ? '记录已更新' : '账号已添加');
    } catch (error) {
      if (error.status === 409 || error.status === 404) {
        await refresh(); $('#form-error').textContent = '这条记录已被他人修改或删除。请关闭窗口并重新打开最新记录后再编辑。';
      } else { $('#form-error').textContent = `${error.message}。如连接中断，请刷新记录后确认是否已保存。`; if (!error.status) { setConnection(false, '共享服务连接失败，请重试并确认记录是否已保存。'); render(); } else { submit.disabled = false; } }
      $('#form-error').hidden = false;
    } finally { busy = false; }
  });
  $('#account-list').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]'); if (!button || !connected) return;
    const record = records.find((item) => item.id === button.dataset.id); if (!record) return;
    if (button.dataset.action === 'edit') { openForm(record); return; }
    if (button.dataset.action === 'matches') { openMatches(record); return; }
    if (button.dataset.action === 'delete' && !busy && confirm(`确定删除“${record.name}”（${record.region}）的共享记录吗？所有访问者都将看不到它。`)) {
      busy = true; button.disabled = true;
      try { await request(`/api/accounts/${encodeURIComponent(record.id)}`, { method: 'DELETE', body: JSON.stringify({ revision: record.revision }) }); await refresh(); toast('记录已删除'); }
      catch (error) { if (error.status === 409 || error.status === 404) { await refresh(); toast('记录已被他人修改或删除，列表已刷新。'); } else { if (!error.status) { setConnection(false, '共享服务连接失败，请重试并确认记录是否已删除。'); render(); } else { button.disabled = false; } toast(`${error.message}。请刷新确认删除是否成功。`); } }
      finally { busy = false; }
    }
  });
  $('#export-button').addEventListener('click', () => {
    if (!connected) return;
    const backup = { format: 'summoner-maintenance-backup', version: 2, exportedAt: new Date().toISOString(), accounts: records };
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const link = element('a'); link.href = url; link.download = `维护簿备份-${localToday()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('备份文件已导出');
  });

  const decisionDialog = $('#decision-dialog');
  function reviewMatches(record, plan, previous) {
    const list = $('#decision-list'); list.replaceChildren();
    $('#decision-error').hidden = true;
    $('#decision-description').textContent = `${record.name} · ${record.region}。从人工基准 ${beijingTime(record.baselineAt)} 到查询时刻 ${beijingTime(plan.targetAt)}（北京时间），有 ${plan.decisions.length} 场单双排、${plan.settlements} 次结算。请逐场核对，选择是否计入；数据源标记不能证明是否有效。结果为估算。`;
    if (!plan.decisions.length) list.append(element('p', 'match-empty', '此时间范围内没有需要核对的单双排。'));
    plan.decisions.forEach((match, index) => {
      const group = element('fieldset', 'decision-game');
      group.append(element('legend', '', `${beijingTime(match.endedAt)} · ${match.championName || '英雄未知'} · 对局 ${match.gameId}`));
      const afk = match.wasAfk === true ? '数据源标记挂机，请核对' : match.wasAfk === false ? '数据源未标记挂机，仍需核对' : '挂机状态未知，请核对';
      group.append(element('p', match.wasAfk === true ? 'decision-warning' : '', afk));
      for (const [value, label] of [['yes', '计入维护'], ['no', '不计入']]) {
        const choice = element('label', 'decision-choice'); const radio = document.createElement('input');
        radio.type = 'radio'; radio.name = `decision-${index}`; radio.value = value;
        if (Object.hasOwn(previous, match.gameId)) radio.checked = previous[match.gameId] === (value === 'yes');
        choice.append(radio, document.createTextNode(label)); group.append(choice);
      }
      list.append(group);
    });
    return new Promise((resolve) => {
      let answers = null;
      $('#decision-form').onsubmit = (event) => {
        event.preventDefault(); const selected = Object.create(null);
        for (let index = 0; index < plan.decisions.length; index++) {
          const choice = list.querySelector(`input[name="decision-${index}"]:checked`);
          if (!choice) { $('#decision-error').textContent = '请逐场选择“计入维护”或“不计入”，也可以跳过此账号。'; $('#decision-error').hidden = false; return; }
          selected[plan.decisions[index].gameId] = choice.value === 'yes';
        }
        answers = selected; decisionDialog.close('save');
      };
      $('#decision-skip').onclick = () => decisionDialog.close('skip');
      decisionDialog.addEventListener('close', () => resolve(decisionDialog.returnValue === 'save' ? answers : null), { once: true });
      decisionDialog.returnValue = ''; decisionDialog.showModal();
    });
  }
  $('#update-maintenance').addEventListener('click', async () => {
    if (!connected || busy) return;
    const targets = [...records]; const status = $('#update-status'); status.hidden = false; status.replaceChildren();
    if (!targets.length) { status.append(element('p', '', '没有可更新的账号。')); return; }
    busy = true; $('#update-maintenance').disabled = true; $('#add-account').disabled = true; $('#empty-add').disabled = true; render();
    const heading = element('strong', '', `正在核对 ${targets.length} 个账号…`); status.append(heading);
    for (const record of targets) {
      const line = element('p', '', `${record.name}（${record.region}）：正在查询…`); status.append(line);
      let writeAttempted = false;
      try {
        if (!record.baselineAt) throw new Error('缺少精确基准时间，请编辑记录并重新填写当前天数。');
        if (!window.MaintenanceEngine) throw new Error('计算组件未加载，请刷新页面重试。');
        const response = await fetch('http://127.0.0.1:8765/api/matches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ riotId: record.name, region: record.region, since: record.baselineAt }), signal: AbortSignal.timeout(120000) });
        const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || `查询失败（${response.status}）`);
        if (data.complete !== true) throw new Error(`战绩未能覆盖录入时刻，不能计算。${typeof data.reason === 'string' ? data.reason : '请稍后重试或重新确认天数。'}`);
        const plan = window.MaintenanceEngine.plan(record, data);
        line.textContent = `${record.name}（${record.region}）：等待逐场确认。`;
        const previous = Object.create(null);
        const saved = record.candidateReviews && typeof record.candidateReviews === 'object' ? record.candidateReviews : {};
        const present = new Set(plan.decisions.map((match) => match.gameId));
        if (Object.keys(saved).some((id) => !present.has(id))) throw new Error('此前核对过的对局未出现在此次战绩中，请稍后重试；原估算未更改。');
        for (const match of plan.decisions) {
          const old = saved[match.gameId];
          if (old && typeof old.include === 'boolean' && old.wasAfk === match.wasAfk && old.endedAt === new Date(match.endedAt).toISOString()) previous[match.gameId] = old.include;
        }
        const decisions = plan.decisions.every((match) => Object.hasOwn(previous, match.gameId)) ? previous : await reviewMatches(record, plan, previous);
        if (!decisions) { line.textContent = `${record.name}（${record.region}）：已跳过，记录未更改。`; continue; }
        const estimate = window.MaintenanceEngine.calculate(record, plan, decisions);
        estimate.candidateReviews = Object.fromEntries(plan.decisions.map((match) => [match.gameId, { include: decisions[match.gameId], wasAfk: match.wasAfk, endedAt: new Date(match.endedAt).toISOString() }]));
        writeAttempted = true;
        await request(`/api/accounts/${encodeURIComponent(record.id)}/estimate`, { method: 'POST', body: JSON.stringify({ revision: record.revision, ...estimate }) });
        line.textContent = `${record.name}（${record.region}）：已保存 ${estimate.candidateDays} 天的估算，查询时间 ${beijingTime(estimate.candidateAt)}（北京）。`;
      } catch (error) {
        const detail = error.status === 409 ? '记录已被修改，请刷新后重新核对。' : writeAttempted && (!error.status || error.status >= 500) ? '保存结果未知，请刷新记录确认后再试。' : error instanceof TypeError ? '无法连接查询程序，请确认本机客户端和查询程序已启动。' : error.name === 'TimeoutError' ? '查询超时，请稍后重试。' : error.message;
        line.textContent = `${record.name}（${record.region}）：${writeAttempted && (!error.status || error.status >= 500) ? '' : '未更新。'}${detail}`;
      }
    }
    heading.textContent = '本次核对已结束，请查看各账号的结果。';
    busy = false; await refresh();
  });

  const matchesDialog = $('#matches-dialog');
  let matchRequestId = 0;
  function openMatches(record) {
    matchRequestId += 1; $('#matches-submit').disabled = false;
    $('#matches-id').value = record?.name || ''; $('#matches-region').value = record?.region || ''; $('#matches-results').replaceChildren(); $('#matches-message').textContent = '请输入游戏名、标签和目标区服。查询结果仅供查看，不会自动修改维护天数。';
    matchesDialog.showModal();
  }
  $('#open-matches').addEventListener('click', () => openMatches());
  $('#matches-close').addEventListener('click', () => matchesDialog.close());
  matchesDialog.addEventListener('close', () => { matchRequestId += 1; });
  $('#matches-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const requestId = ++matchRequestId; const button = $('#matches-submit'); button.disabled = true;
    $('#matches-message').textContent = '正在通过本机英雄联盟客户端查询…'; $('#matches-results').replaceChildren();
    try {
      const response = await fetch('http://127.0.0.1:8765/api/matches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ riotId: $('#matches-id').value.trim(), region: $('#matches-region').value.trim() }), signal: AbortSignal.timeout(30000) });
      const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || `查询失败（${response.status}）`);
      if (requestId !== matchRequestId) return;
      if (!Array.isArray(data.matches)) throw new Error('战绩数据格式不正确');
      $('#matches-message').textContent = `已返回 ${data.matches.length} 场近期对局。数据可能存在延迟或遗漏；是否符合维护资格请以客户端为准。`;
      if (typeof data.reason === 'string' && /重复|乱序|上限|发生变化/.test(data.reason)) $('#matches-message').textContent += ` ${data.reason}`;
      if (!data.matches.length) $('#matches-results').append(element('p', 'match-empty', '没有返回近期战绩。'));
      data.matches.forEach((match) => {
        const win = typeof match.win === 'boolean' ? match.win : null;
        const row = element('div', `match-row${win === null ? '' : win ? ' match-win' : ' match-loss'}`);
        const queueNames = { 400: '匹配征召', 420: '单双排', 430: '匹配', 440: '灵活组排', 450: '极地大乱斗', 490: '快速匹配', 1700: '斗魂竞技场' };
        const queue = queueNames[match.queueId] || `队列 ${String(match.queueId ?? '未知')}`;
        const start = match.startedAt ? new Date(match.startedAt) : null;
        const time = !start || Number.isNaN(start.getTime()) ? '时间未知' : start.toLocaleString('zh-CN');
        const duration = typeof match.durationSeconds === 'number' ? match.durationSeconds / 60 : match.startedAt && match.endedAt ? (Date.parse(match.endedAt) - Date.parse(match.startedAt)) / 60000 : NaN;
        const result = element('div', 'match-outcome', win === null ? '结果未知' : win ? '胜利' : '失败');
        const main = element('div', 'match-main');
        const champion = typeof match.championName === 'string' && match.championName.trim() ? match.championName : '英雄未知';
        main.append(element('strong', '', champion), element('span', '', queue));
        const kda = [match.kills, match.deaths, match.assists];
        if (kda.every((n) => Number.isInteger(n) && n >= 0)) main.append(element('span', 'match-kda', `${kda.join(' / ')} KDA`));
        const meta = element('div', 'match-meta', `${time}${Number.isFinite(duration) && duration >= 0 ? ` · ${Math.floor(duration)} 分钟` : ''} · 对局 ${String(match.gameId ?? '未知')}`);
        row.append(result, main, meta);
        $('#matches-results').append(row);
      });
    } catch (error) {
      if (requestId !== matchRequestId) return;
      $('#matches-message').textContent = error instanceof TypeError
        ? '无法连接本机查询程序。请展开上方“首次使用”按步骤启动，并保持窗口运行；浏览器的本地网络限制也可能阻止连接。'
        : error.name === 'TimeoutError' ? '查询超时，请确认游戏客户端和查询程序保持运行后重试。'
        : `无法查询战绩：${error.message}。请检查英雄联盟客户端和本机桥接程序是否正常运行。`;
    }
    finally { if (requestId === matchRequestId) button.disabled = false; }
  });
  setConnection(false, '正在连接共享服务…'); render(); refresh();
  setInterval(render, 60000);
})();
