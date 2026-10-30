import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import worker from '../src/index.js'

// Exercise the actual SQL and Worker handler against an isolated in-memory SQLite database.
function database() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'))
  sqlite.prepare("INSERT INTO auth_users (id,provider,username,created_at) VALUES ('test-owner','password','fixture',?)").run(Date.now())
  sqlite.prepare("INSERT INTO auth_sessions (token_hash,owner_id,created_at,expires_at) VALUES (?,'test-owner',?,?)")
    .run(createHash('sha256').update(TEST_TOKEN).digest('base64url'), Date.now(), Date.now() + 3600000)
  return {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this },
        async first() { return sqlite.prepare(sql).get(...this.args) || null },
        async all() { return { results: sqlite.prepare(sql).all(...this.args) } },
        async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...this.args).changes) } } }
      }
    }
  }
}

const example = {
  name: '示例玩家#CN1', region: '艾欧尼亚', queue: '单双排', tier: '大师及以上',
  days: 7, baselineDate: '2026-10-30', note: ''
}
const TEST_TOKEN = 'swa_' + 'a'.repeat(43)

function request(path, method = 'GET', body) {
  return new Request('https://example.invalid' + path, {
    method, headers: { Authorization: `Bearer ${TEST_TOKEN}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
}

test('create, list, update and delete with revision conflicts', async () => {
  const env = { DB: database() }
  let res = await worker.fetch(request('/api/accounts', 'POST', example), env)
  assert.equal(res.status, 201)
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*')
  let { account } = await res.json()
  assert.equal(account.revision, 1)
  assert.equal(account.name, example.name)
  res = await worker.fetch(request('/api/accounts'), env)
  assert.equal((await res.json()).accounts.length, 1)
  res = await worker.fetch(request(`/api/accounts/${account.id}`, 'PUT', { ...example, days: 8, revision: 1 }), env)
  assert.equal(res.status, 200)
  account = (await res.json()).account
  assert.equal(account.revision, 2)
  assert.equal(account.days, 8)
  res = await worker.fetch(request(`/api/accounts/${account.id}`, 'PUT', { ...example, revision: 1 }), env)
  assert.equal(res.status, 409)
  assert.equal((await res.json()).error.code, 'CONFLICT')
  res = await worker.fetch(request(`/api/accounts/${account.id}`, 'DELETE', { revision: 1 }), env)
  assert.equal(res.status, 409)
  res = await worker.fetch(request(`/api/accounts/${account.id}`, 'DELETE', { revision: 2 }), env)
  assert.deepEqual(await res.json(), { ok: true })
  res = await worker.fetch(request(`/api/accounts/${account.id}`, 'DELETE', { revision: 2 }), env)
  assert.equal(res.status, 404)
})

test('rejects invalid dates, values, content type and oversized bodies', async () => {
  const env = { DB: database() }
  for (const input of [
    { ...example, baselineDate: '2026-02-30' },
    { ...example, days: -1 }, { ...example, days: 1.2 },
    { ...example, name: '  ' }, { ...example, tier: '王者' },
    { ...example, note: 'a'.repeat(301) }
  ]) {
    assert.equal((await worker.fetch(request('/api/accounts', 'POST', input), env)).status, 400)
  }
  assert.equal((await worker.fetch(new Request('https://example.invalid/api/accounts', {
    method: 'POST', headers: { Authorization: `Bearer ${TEST_TOKEN}` }, body: JSON.stringify(example)
  }), env)).status, 400)
  assert.equal((await worker.fetch(request('/api/accounts', 'POST', { ...example, extra: 'a'.repeat(66000) }), env)).status, 400)
  assert.equal((await worker.fetch(request('/api/accounts'), env)).status, 200)
})

test('preflight and unavailable database return useful responses', async () => {
  const preflight = await worker.fetch(request('/api/accounts', 'OPTIONS'), {})
  assert.equal(preflight.status, 204)
  assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /PUT/)
  const res = await worker.fetch(request('/api/accounts'), {})
  assert.equal(res.status, 503)
  assert.equal((await res.json()).error.code, 'DATABASE_UNAVAILABLE')
})

test('simultaneous edits from the same revision cannot silently overwrite each other', async () => {
  const env = { DB: database() }
  const created = await worker.fetch(request('/api/accounts', 'POST', example), env)
  const { account } = await created.json()
  const edits = await Promise.all([8, 9].map(days =>
    worker.fetch(request(`/api/accounts/${account.id}`, 'PUT', { ...example, days, revision: 1 }), env)))
  assert.deepEqual(edits.map(res => res.status).sort(), [200, 409])
  const list = await worker.fetch(request('/api/accounts'), env)
  const saved = (await list.json()).accounts[0]
  assert.equal(saved.revision, 2)
  assert.ok(saved.days === 8 || saved.days === 9)
})

test('schema rejects duplicate record ids', () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'))
  const insert = sqlite.prepare('INSERT INTO accounts (id,name,region,queue,tier,days,baseline_date,note,revision,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const values = ['id', 'name', 'region', '单双排', '未知', 1, '2026-10-30', '', 1, 'now', 'now']
  insert.run(...values)
  assert.throws(() => insert.run(...values), /UNIQUE constraint failed/)
})

test('migration preserves legacy data and leaves the precise baseline unknown', () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY,name TEXT,region TEXT,queue TEXT,tier TEXT,days INTEGER,baseline_date TEXT,note TEXT,revision INTEGER,created_at TEXT,updated_at TEXT);
    INSERT INTO accounts VALUES ('old','player','HN1','单双排','钻石',12,'2026-01-01','note',4,'a','b');`)
  sqlite.exec(readFileSync(new URL('../migrations/0001_precise_baseline_estimate.sql', import.meta.url), 'utf8'))
  const row = sqlite.prepare('SELECT * FROM accounts').get()
  assert.equal(row.days, 12); assert.equal(row.revision, 4); assert.equal(row.note, 'note')
  assert.equal(row.baseline_at, null); assert.equal(row.candidate_days, null); assert.equal(row.candidate_summary, null); assert.equal(row.candidate_reviews, null)
})

test('baseline validation and conditional estimate preserve the manual baseline', async () => {
  const env = { DB: database() }
  const input = { ...example, baselineDate: '2025-01-02', baselineAt: '2025-01-01T16:30:00.000Z' }
  assert.equal((await worker.fetch(request('/api/accounts', 'POST', { ...input, baselineAt: '2025-01-01T15:30:00Z' }), env)).status, 400)
  assert.equal((await worker.fetch(request('/api/accounts', 'POST', { ...input, baselineAt: '2025-02-30T16:30:00Z' }), env)).status, 400)
  let res = await worker.fetch(request('/api/accounts', 'POST', input), env)
  let { account } = await res.json()
  const estimate = { revision: 1, candidateDays: 8, candidateAt: '2025-01-03T03:00:00Z', candidateSummary: '候选结果，资格未核实', candidateReviews: { '123': { include: true, wasAfk: false, endedAt: '2025-01-02T16:00:00Z' }, '456': { include: false, wasAfk: null, endedAt: '2025-01-02T18:00:00Z' } } }
  res = await worker.fetch(request(`/api/accounts/${account.id}/estimate`, 'POST', { ...estimate, candidateAt: '2025-01-01T16:29:00Z' }), env)
  assert.equal(res.status, 400)
  const attempts = await Promise.all([8, 9].map(candidateDays => worker.fetch(request(`/api/accounts/${account.id}/estimate`, 'POST', { ...estimate, candidateDays }), env)))
  assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409])
  res = await worker.fetch(request('/api/accounts'), env); account = (await res.json()).accounts[0]
  assert.equal(account.days, 7); assert.equal(account.baselineAt, input.baselineAt); assert.equal(account.baselineDate, input.baselineDate)
  assert.equal(account.revision, 2); assert.equal(account.candidateStatus, 'estimate'); assert.ok([8, 9].includes(account.candidateDays))
  assert.deepEqual(account.candidateReviews, { '123': { include: true, wasAfk: false, endedAt: '2025-01-02T16:00:00.000Z' }, '456': { include: false, wasAfk: null, endedAt: '2025-01-02T18:00:00.000Z' } })
  assert.equal((await worker.fetch(request(`/api/accounts/${account.id}/estimate`, 'POST', estimate), env)).status, 409)
  res = await worker.fetch(request(`/api/accounts/${account.id}`, 'PUT', { ...input, days: 6, revision: 2 }), env)
  account = (await res.json()).account
  assert.equal(account.days, 6); assert.equal(account.candidateDays, null); assert.equal(account.candidateStatus, null); assert.equal(account.candidateReviews, null)
})

test('legacy client edit retains time only if the manual baseline is unchanged', async () => {
  const env = { DB: database() }
  const input = { ...example, baselineDate: '2025-01-02', baselineAt: '2025-01-01T16:30:00Z' }
  const created = await worker.fetch(request('/api/accounts', 'POST', input), env)
  let { account } = await created.json()
  const { baselineAt, ...legacyInput } = input
  let res = await worker.fetch(request(`/api/accounts/${account.id}`, 'PUT', { ...legacyInput, note: 'edited', revision: 1 }), env)
  account = (await res.json()).account
  assert.equal(account.baselineAt, '2025-01-01T16:30:00.000Z')
  res = await worker.fetch(request(`/api/accounts/${account.id}`, 'PUT', { ...legacyInput, days: 6, revision: 2 }), env)
  account = (await res.json()).account
  assert.equal(account.baselineAt, null)
  res = await worker.fetch(request(`/api/accounts/${account.id}/estimate`, 'POST', { revision: 3, candidateDays: 8, candidateAt: '2025-01-03T03:00:00Z', candidateSummary: 'estimate', candidateReviews: {} }), env)
  assert.equal(res.status, 400)
})

test('review evidence is bounded, valid and stored atomically with the candidate', async () => {
  const env = { DB: database() }
  const created = await worker.fetch(request('/api/accounts', 'POST', { ...example, baselineDate: '2025-01-02', baselineAt: '2025-01-01T16:30:00Z' }), env)
  const { account } = await created.json()
  const path = `/api/accounts/${account.id}/estimate`
  const base = { revision: 1, candidateDays: 9, candidateAt: '2025-01-03T03:00:00Z', candidateSummary: '人工核对' }
  const entry = { include: true, wasAfk: null, endedAt: '2025-01-02T00:00:00Z' }
  for (const reviews of [null, [], { abc: entry }, { '1': { ...entry, include: 'true' } },
    { '1': { ...entry, wasAfk: 'false' } }, { '1': { ...entry, extra: 1 } },
    { '1': { include: true, endedAt: entry.endedAt } }, { '1': { ...entry, endedAt: '2025-01-01T16:30:00Z' } },
    { '1': { ...entry, endedAt: '2025-01-04T00:00:00Z' } }, { ['1'.repeat(41)]: entry },
    Object.fromEntries(Array.from({ length: 201 }, (_, i) => [String(i), entry]))]) {
    assert.equal((await worker.fetch(request(path, 'POST', { ...base, candidateReviews: reviews }), env)).status, 400)
  }
  const reviews = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [String(i).padStart(40, '0'), entry]))
  const body = { ...base, candidateReviews: reviews }
  assert.ok(JSON.stringify(body).length > 16384)
  const result = await worker.fetch(request(path, 'POST', body), env)
  assert.equal(result.status, 200)
  const saved = (await result.json()).account
  assert.equal(saved.revision, 2); assert.equal(Object.keys(saved.candidateReviews).length, 200)
  assert.equal(saved.candidateReviews['0'.repeat(40)].wasAfk, null)
})

const rankProfile = { rankTier: 'DIAMOND', rankDivision: 'II', rankLp: 64, profileObservedAt: '2025-01-03T03:00:00.000Z' }

function profileOf(account) {
  return Object.fromEntries(Object.keys(rankProfile).map(key => [key, account[key]]))
}

test('rank migration retains existing baseline, candidate, note and revision without inventing rank', () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY,name TEXT,region TEXT,queue TEXT,tier TEXT,days INTEGER,baseline_date TEXT,note TEXT,revision INTEGER,created_at TEXT,updated_at TEXT);
    INSERT INTO accounts VALUES ('old','player','HN1','单双排','钻石',12,'2025-01-02','important note',4,'a','b');`)
  sqlite.exec(readFileSync(new URL('../migrations/0001_precise_baseline_estimate.sql', import.meta.url), 'utf8'))
  sqlite.exec(`UPDATE accounts SET baseline_at='2025-01-01T16:30:00.000Z',candidate_days=13,candidate_at='2025-01-03T03:00:00.000Z',candidate_status='estimate',candidate_summary='saved',candidate_reviews='{}'`)
  const before = { ...sqlite.prepare('SELECT * FROM accounts').get() }
  sqlite.exec(readFileSync(new URL('../migrations/0002_rank_profile.sql', import.meta.url), 'utf8'))
  assert.deepEqual({ ...sqlite.prepare('SELECT * FROM accounts').get() }, {
    ...before, rank_tier: null, rank_division: null, rank_lp: null, profile_observed_at: null
  })
})

test('rank snapshots round-trip, survive legacy same-account edits and clear on identity changes', async () => {
  const env = { DB: database() }
  const created = await worker.fetch(request('/api/accounts', 'POST', { ...example, ...rankProfile }), env)
  assert.equal(created.status, 201)
  let { account } = await created.json()
  assert.deepEqual(profileOf(account), rankProfile)
  let res = await worker.fetch(request(`/api/accounts/${account.id}`, 'PUT', { ...example, days: 8, note: 'manual edit', revision: 1 }), env)
  account = (await res.json()).account
  assert.deepEqual(profileOf(account), rankProfile)
  assert.equal(account.note, 'manual edit')
  res = await worker.fetch(request(`/api/accounts/${account.id}`, 'PUT', { ...example, region: '黑色玫瑰', revision: 2 }), env)
  account = (await res.json()).account
  assert.deepEqual(profileOf(account), { rankTier: null, rankDivision: null, rankLp: null, profileObservedAt: null })
  res = await worker.fetch(request(`/api/accounts/${account.id}`, 'PUT', { ...example, ...rankProfile, rankTier: 'CHALLENGER', rankDivision: null, rankLp: 1474, revision: 3 }), env)
  account = (await res.json()).account
  assert.equal(account.rankTier, 'CHALLENGER'); assert.equal(account.rankDivision, null); assert.equal(account.rankLp, 1474)
  const list = await worker.fetch(request('/api/accounts'), env)
  assert.deepEqual(profileOf((await list.json()).accounts[0]), profileOf(account))
})

test('missing rank remains unknown and invalid or partial snapshots cannot overwrite valid data', async () => {
  const env = { DB: database() }
  const legacy = await worker.fetch(request('/api/accounts', 'POST', example), env)
  assert.deepEqual(profileOf((await legacy.json()).account), { rankTier: null, rankDivision: null, rankLp: null, profileObservedAt: null })
  const created = await worker.fetch(request('/api/accounts', 'POST', { ...example, ...rankProfile }), env)
  const { account } = await created.json()
  for (const badProfile of [
    { rankTier: 'DIAMOND' }, { ...rankProfile, rankTier: '王者' },
    { ...rankProfile, rankDivision: 'V' }, { ...rankProfile, rankLp: -1 },
    { ...rankProfile, rankLp: 1.1 }, { ...rankProfile, rankLp: '64' },
    { ...rankProfile, rankLp: Number.MAX_SAFE_INTEGER + 1 },
    { ...rankProfile, profileObservedAt: '2025-02-30T03:00:00Z' },
    { ...rankProfile, profileObservedAt: null }, { ...rankProfile, rankTier: null },
    { ...rankProfile, rankTier: 'MASTER' },
    { ...rankProfile, rankTier: 'UNRANKED', rankDivision: null, rankLp: 0 }
  ]) {
    const res = await worker.fetch(request(`/api/accounts/${account.id}`, 'PUT', { ...example, ...badProfile, revision: 1 }), env)
    assert.equal(res.status, 400, JSON.stringify(badProfile))
  }
  const list = await worker.fetch(request('/api/accounts'), env)
  const unchanged = (await list.json()).accounts.find(row => row.id === account.id)
  assert.equal(unchanged.revision, 1)
  assert.deepEqual(profileOf(unchanged), rankProfile)
  const res = await worker.fetch(request(`/api/accounts/${account.id}`, 'PUT', {
    ...example, ...rankProfile, rankTier: 'UNRANKED', rankDivision: null, rankLp: null, revision: 1
  }), env)
  assert.equal(res.status, 200)
  const unranked = (await res.json()).account
  assert.equal(unranked.rankTier, 'UNRANKED'); assert.equal(unranked.rankLp, null)
})

test('estimate atomically refreshes rank while preserving baseline and refuses stale revisions', async () => {
  const env = { DB: database() }
  const created = await worker.fetch(request('/api/accounts', 'POST', {
    ...example, tier: '未知', ...rankProfile, baselineDate: '2025-01-02', baselineAt: '2025-01-01T16:30:00Z'
  }), env)
  let { account } = await created.json()
  const path = `/api/accounts/${account.id}/estimate`
  const estimate = { revision: 1, candidateDays: 9, candidateAt: '2025-01-03T03:00:00Z', candidateSummary: '查询新增两场', candidateReviews: {} }
  const refreshed = { rankTier: 'MASTER', rankDivision: null, rankLp: 120, profileObservedAt: '2025-01-03T03:00:00.000Z' }
  let res = await worker.fetch(request(path, 'POST', { ...estimate, ...refreshed }), env)
  assert.equal(res.status, 200)
  account = (await res.json()).account
  assert.deepEqual(profileOf(account), refreshed)
  assert.equal(account.revision, 2); assert.equal(account.candidateDays, 9)
  assert.equal(account.days, example.days); assert.equal(account.baselineAt, '2025-01-01T16:30:00.000Z')
  assert.equal(account.tier, '大师及以上')
  res = await worker.fetch(request(path, 'POST', { ...estimate, ...rankProfile }), env)
  assert.equal(res.status, 409)
  res = await worker.fetch(request(path, 'POST', { ...estimate, revision: 2, candidateDays: 10 }), env)
  assert.equal(res.status, 200)
  account = (await res.json()).account
  assert.deepEqual(profileOf(account), refreshed)
  assert.equal(account.candidateDays, 10)
  assert.equal(account.tier, '大师及以上')
  res = await worker.fetch(request(path, 'POST', { ...estimate, ...rankProfile, revision: 3 }), env)
  assert.equal(res.status, 200)
  account = (await res.json()).account
  assert.equal(account.tier, '钻石')
  assert.equal(account.days, example.days); assert.equal(account.baselineAt, '2025-01-01T16:30:00.000Z')
})
