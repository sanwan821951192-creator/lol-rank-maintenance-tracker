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
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
    remainingBlock.append(element('div', 'meta-label', '估算剩余'), element('div', 'meta-value days-value', days === 0 ? '待确认' : `${days} 天`));
    const recordBlock = element('div', 'account-meta');
    recordBlock.append(element('div', 'meta-label', '记录日期 / 当时天数'), element('div', 'meta-value', `${record.baselineDate} · ${record.days} 天`));
    const actions = element('div', 'row-actions');
    for (const [action, label] of [['matches', '查看战绩'], ['edit', '编辑'], ['delete', '删除']]) {
      const button = element('button', 'icon-button', label); button.type = 'button'; button.dataset.action = action; button.dataset.id = record.id;
      button.disabled = !connected; button.setAttribute('aria-label', `${label} ${record.name} 的记录`); actions.append(button);
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
    fields.days.value = record?.days ?? ''; fields.recordedAt.max = localToday(); fields.recordedAt.value = record?.baselineDate || localToday(); fields.note.value = record?.note || '';
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
    const data = { name: fields.gameId.value.trim(), region: fields.server.value.trim(), queue: fields.queue.value, tier: fields.tier.value, days: Number(fields.days.value), baselineDate: fields.recordedAt.value, note: fields.note.value.trim() };
    if (!data.name || !data.region || !Number.isInteger(data.days) || data.days < 0 || data.days > 365 || !Number.isFinite(dayNumber(data.baselineDate)) || data.baselineDate > localToday()) {
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

  const matchesDialog = $('#matches-dialog');
  function openMatches(record) {
    $('#matches-id').value = record.name; $('#matches-region').value = record.region; $('#matches-results').replaceChildren(); $('#matches-message').textContent = '请输入 Riot ID（游戏名#标签）。需要在当前电脑启动查询桥接程序并授权本网站访问，记录区服须与已登录客户端一致。结果仅供查看，不自动修改天数。';
    matchesDialog.showModal();
  }
  $('#matches-close').addEventListener('click', () => matchesDialog.close());
  $('#matches-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = $('#matches-submit'); button.disabled = true;
    $('#matches-message').textContent = '正在通过本机英雄联盟客户端查询…'; $('#matches-results').replaceChildren();
    try {
      const response = await fetch('http://127.0.0.1:8765/api/matches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ riotId: $('#matches-id').value.trim(), region: $('#matches-region').value.trim() }), signal: AbortSignal.timeout(15000) });
      const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || `查询失败（${response.status}）`);
      if (!Array.isArray(data.matches)) throw new Error('战绩数据格式不正确');
      $('#matches-message').textContent = `${data.reason || '已获取近期战绩'}。近期查询不保证上游没有遗漏或延迟，也不能证明对局符合维护资格；不会自动修改天数。结束时间来自 SGP。`;
      if (!data.matches.length) $('#matches-results').append(element('p', 'match-empty', '没有返回近期战绩。'));
      data.matches.forEach((match) => {
        const row = element('div', 'match-row');
        const queue = match.queueId === 420 ? '单双排' : match.queueId === 440 ? '灵活组排' : `队列 ${String(match.queueId ?? '未知')}`;
        const start = new Date(match.startedAt); const end = new Date(match.endedAt); const time = Number.isNaN(start.getTime()) ? '时间未知' : start.toLocaleString('zh-CN');
        const endTime = Number.isNaN(end.getTime()) ? '未知' : end.toLocaleString('zh-CN');
        row.append(element('strong', '', queue), element('span', '', `开始 ${time}`), element('small', '', `结束 ${endTime} · 结果 ${String(match.result ?? '未知')} · 对局 ${String(match.gameId ?? '未知')}`)); $('#matches-results').append(row);
      });
    } catch (error) {
      $('#matches-message').textContent = error instanceof TypeError
        ? '无法连接本机查询程序。请确认本机桥接程序已启动并允许当前网站访问；浏览器的本地网络限制也可能阻止连接。'
        : `无法查询战绩：${error.message}。请检查英雄联盟客户端和本机桥接程序是否正常运行。`;
    }
    finally { button.disabled = false; }
  });
  setConnection(false, '正在连接共享服务…'); render(); refresh();
  setInterval(render, 60000);
})();
