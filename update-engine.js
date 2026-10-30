/* Recompute from the manual baseline; every new solo/duo game counts under the user's rule. */
(function (root) {
  'use strict';
  const DAY = 86400000;
  const SETTLEMENT_UTC = (15 * 60 + 55) * 60000; // 23:55 UTC+8
  function time(value, label) {
    const result = typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(result)) throw new Error(`${label}无效，请重新确认记录。`);
    return result;
  }
  function boundary(t) { return Math.floor((t - SETTLEMENT_UTC) / DAY); }
  function plan(record, data) {
    const base = time(record.baselineAt, '精确录入时间');
    if (record.queue !== '单双排') throw new Error('只支持更新明确标为单双排的记录。');
    const cap = record.tier === '大师及以上' ? 14 : record.tier === '钻石' ? 28 : 0;
    if (!cap) throw new Error('请先明确记录段位为钻石或大师及以上。');
    if (!Number.isInteger(record.days) || record.days < 0 || record.days > cap) throw new Error('录入天数超出该段位的范围，请重新确认。');
    if (!data || data.ok !== true || data.complete !== true || !Array.isArray(data.matches)) throw new Error('战绩未能覆盖录入时刻，暂不能计算；请稍后重试或重新确认天数。');
    const target = time(data.observedAt, '查询时刻');
    if (target < base) throw new Error('查询时刻早于录入时刻，请重试。');
    const seen = new Set();
    const decisions = [];
    for (const match of data.matches) {
      if (!match || typeof match.gameId !== 'string' || !/^\d+$/.test(match.gameId)) throw new Error('对局编号无效，无法安全更新。');
      if (seen.has(match.gameId)) throw new Error('战绩存在重复对局，无法安全更新。');
      seen.add(match.gameId);
      if (!Number.isInteger(match.queueId)) throw new Error('对局队列不明，无法安全更新。');
      const end = time(match.endedAt, '对局结束时间');
      if (match.queueId !== 420 || end <= base || end > target) continue;
      if ((end - SETTLEMENT_UTC) % DAY === 0) throw new Error('对局结束与结算时刻重合，请手动确认天数。');
      decisions.push({gameId: match.gameId, endedAt: match.endedAt, queueId: 420,
        wasAfk: typeof match.wasAfk === 'boolean' ? match.wasAfk : null,
        championName: typeof match.championName === 'string' ? match.championName : null});
    }
    decisions.sort((a,b) => Date.parse(a.endedAt) - Date.parse(b.endedAt) || a.gameId.localeCompare(b.gameId));
    return {targetAt: new Date(target).toISOString(), decisions, excludedCount: 0, settlements: Math.max(0, boundary(target) - boundary(base))};
  }
  function calculate(record, pending) {
    const base = time(record.baselineAt, '精确录入时间');
    const target = time(pending.targetAt, '查询时刻');
    const cap = record.tier === '大师及以上' ? 14 : record.tier === '钻石' ? 28 : 0;
    if (!cap || target < base || !Number.isInteger(record.days) || record.days < 0 || record.days > cap) throw new Error('基准记录无效。');
    let days = record.days, cursor = base, counted = 0;
    for (const match of pending.decisions) {
      const ended = time(match.endedAt, '对局结束时间');
      if (ended <= cursor || ended > target) throw new Error('对局时间顺序异常，请重试。');
      days = Math.max(0, days - Math.max(0, boundary(ended) - boundary(cursor)));
      days = Math.min(cap, days + 1);
      counted++;
      cursor = ended;
    }
    days = Math.max(0, days - Math.max(0, boundary(target) - boundary(cursor)));
    return {candidateDays: days, candidateAt: new Date(target).toISOString(),
      candidateSummary: `按当前规则自动计入单双排 ${counted} 场，每场加 1 天，上限 ${cap} 天；按北京时间 23:55 结算。战绩可能延迟或遗漏，结果为估算。`};
  }
  function decay(days, from, to) {
    const start = time(from, '记录时间'), end = time(to, '当前时间');
    return Math.max(0, days - Math.max(0, boundary(end) - boundary(start)));
  }
  const api = {plan, calculate, decay};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MaintenanceEngine = api;
})(globalThis);
