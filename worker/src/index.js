import { authRoute, authenticate } from './auth.js'

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
}

const COLUMNS = `id, name, region, queue, tier, days,
  rank_tier AS rankTier, rank_division AS rankDivision, rank_lp AS rankLp, profile_observed_at AS profileObservedAt,
  baseline_date AS baselineDate, baseline_at AS baselineAt, note, revision,
  candidate_days AS candidateDays, candidate_at AS candidateAt,
  candidate_status AS candidateStatus, candidate_summary AS candidateSummary, candidate_reviews AS candidateReviews,
  created_at AS createdAt, updated_at AS updatedAt`
const QUEUES = new Set(['单双排', '灵活组排', '未知'])
const TIERS = new Set(['钻石', '大师及以上', '未知'])
const RANK_TIERS = new Set(['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER', 'UNRANKED'])
const RANK_DIVISIONS = new Set(['I', 'II', 'III', 'IV'])
const PROFILE_FIELDS = ['rankTier', 'rankDivision', 'rankLp', 'profileObservedAt']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' }
  })
}

function error(status, code, message) {
  return json({ error: { code, message } }, status)
}

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function canonicalInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) return null
  return parsed.toISOString()
}

function localDate(instant) {
  return new Date(Date.parse(instant) + 8 * 3600000).toISOString().slice(0, 10)
}

// A profile is one observation. Partial snapshots must not mix data from different queries.
function validateProfile(input) {
  const provided = PROFILE_FIELDS.some(field => Object.hasOwn(input, field))
  if (!provided) return { provided: false, rankTier: null, rankDivision: null, rankLp: null, profileObservedAt: null }
  if (!PROFILE_FIELDS.every(field => Object.hasOwn(input, field))) return null
  const { rankTier, rankDivision, rankLp } = input
  const profileObservedAt = input.profileObservedAt === null ? null : canonicalInstant(input.profileObservedAt)
  if (!(rankTier === null || RANK_TIERS.has(rankTier)) ||
      !(rankDivision === null || RANK_DIVISIONS.has(rankDivision)) ||
      !(rankLp === null || (Number.isSafeInteger(rankLp) && rankLp >= 0)) ||
      (input.profileObservedAt !== null && !profileObservedAt)) return null
  if (rankTier === null && (rankDivision !== null || rankLp !== null)) return null
  if (rankTier !== null && !profileObservedAt) return null
  if (rankTier === 'UNRANKED' && (rankDivision !== null || rankLp !== null)) return null
  if (['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(rankTier) && rankDivision !== null) return null
  return { provided: true, rankTier, rankDivision, rankLp, profileObservedAt }
}

function validateReviews(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > 200) return null
  const result = Object.create(null)
  for (const [id, review] of entries) {
    if (!/^\d{1,40}$/.test(id) || !review || typeof review !== 'object' || Array.isArray(review) ||
        Object.keys(review).length !== 3 || typeof review.include !== 'boolean' ||
        !(review.wasAfk === null || typeof review.wasAfk === 'boolean') ||
        !Object.hasOwn(review, 'wasAfk')) return null
    const endedAt = canonicalInstant(review.endedAt)
    if (!endedAt) return null
    result[id] = { include: review.include, wasAfk: review.wasAfk, endedAt }
  }
  return result
}

function unpackAccount(row) {
  if (!row) return null
  if (row.candidateReviews === null) return row
  const parsed = validateReviews(JSON.parse(row.candidateReviews))
  if (!parsed) throw new Error('Invalid stored reviews')
  return { ...row, candidateReviews: parsed }
}

function validate(input, needsRevision) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  if (['owner', 'ownerId', 'owner_id'].some(field => Object.hasOwn(input, field))) return null
  const { name, region, queue, tier, days, baselineDate, note, revision } = input
  const baselineProvided = Object.hasOwn(input, 'baselineAt')
  const baselineAt = input.baselineAt == null ? null : canonicalInstant(input.baselineAt)
  const profile = validateProfile(input)
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 ||
      typeof region !== 'string' || !region.trim() || region.trim().length > 50 ||
      !QUEUES.has(queue) || !TIERS.has(tier) ||
      !Number.isInteger(days) || days < 0 || days > 365 || !isDate(baselineDate) ||
      typeof note !== 'string' || note.length > 300 ||
      (input.baselineAt != null && (!baselineAt || localDate(baselineAt) !== baselineDate)) ||
      (needsRevision && (!Number.isSafeInteger(revision) || revision < 1)) || !profile) return null
  return { name: name.trim(), region: region.trim(), queue, tier, days, baselineDate, baselineAt, baselineProvided, note, revision, profile }
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('Content-Type') || '')) return null
  // A header check also avoids reading clearly oversized requests into memory.
  const length = request.headers.get('Content-Length')
  if (length && Number(length) > 65536) return null
  const text = await request.text()
  if (new TextEncoder().encode(text).length > 65536) return null
  try { return JSON.parse(text) } catch { return null }
}

async function getAccount(db, id, ownerId) {
  return unpackAccount(await db.prepare(`SELECT ${COLUMNS} FROM accounts WHERE id = ? AND owner_id = ?`).bind(id, ownerId).first())
}

async function missingOrConflict(db, id, ownerId) {
  const found = await db.prepare('SELECT id FROM accounts WHERE id = ? AND owner_id = ?').bind(id, ownerId).first()
  return found
    ? error(409, 'CONFLICT', '数据已被其他人修改，请刷新后重试。')
    : error(404, 'NOT_FOUND', '账号记录不存在。')
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS })
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/$/, '')
    // Configuration is safe to inspect before the database or credentials are provisioned.
    if (path === '/api/auth/config' && request.method === 'GET') return authRoute(request, env, path, { json, error, readBody })
    if (!env.DB) return error(503, 'DATABASE_UNAVAILABLE', '账号数据库尚未配置。')
    const match = path.match(/^\/api\/accounts\/([^/]+)$/)
    const estimateMatch = path.match(/^\/api\/accounts\/([^/]+)\/estimate$/)
    try {
      const authResponse = await authRoute(request, env, path, { json, error, readBody })
      if (authResponse) return authResponse
      const session = await authenticate(request, env.DB)
      if (!session) return error(401, 'unauthorized', '请先登录。')
      const ownerId = session.ownerId
      if (path === '/api/accounts' && request.method === 'GET') {
        const result = await env.DB.prepare(`SELECT ${COLUMNS} FROM accounts WHERE owner_id=? ORDER BY updated_at DESC, id`).bind(ownerId).all()
        return json({ accounts: (result.results || []).map(unpackAccount) })
      }
      if (path === '/api/accounts/export' && request.method === 'GET') {
        const result = await env.DB.prepare(`SELECT ${COLUMNS} FROM accounts WHERE owner_id=? ORDER BY updated_at DESC, id`).bind(ownerId).all()
        return json({ version: 2, exportedAt: new Date().toISOString(), accounts: (result.results || []).map(unpackAccount) })
      }
      if (match && UUID.test(match[1]) && request.method === 'GET') {
        const account = await getAccount(env.DB, match[1], ownerId)
        return account ? json({ account }) : error(404, 'NOT_FOUND', '账号记录不存在。')
      }
      if (path === '/api/accounts' && request.method === 'POST') {
        const data = validate(await readBody(request), false)
        if (!data) return error(400, 'INVALID_INPUT', '请检查账号、大区、排位类型、段位、天数及日期。')
        const id = crypto.randomUUID()
        const now = new Date().toISOString()
        await env.DB.prepare(`INSERT INTO accounts
          (id,name,region,queue,tier,days,baseline_date,baseline_at,note,revision,created_at,updated_at,rank_tier,rank_division,rank_lp,profile_observed_at,owner_id)
          VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)`)
          .bind(id, data.name, data.region, data.queue, data.tier, data.days, data.baselineDate, data.baselineAt, data.note, now, now,
            data.profile.rankTier, data.profile.rankDivision, data.profile.rankLp, data.profile.profileObservedAt, ownerId).run()
        return json({ account: await getAccount(env.DB, id, ownerId) }, 201)
      }
      if (match && UUID.test(match[1]) && request.method === 'PUT') {
        if (!await getAccount(env.DB, match[1], ownerId)) return error(404, 'NOT_FOUND', '账号记录不存在。')
        const data = validate(await readBody(request), true)
        if (!data) return error(400, 'INVALID_INPUT', '请检查输入内容和记录版本。')
        const now = new Date().toISOString()
        const result = await env.DB.prepare(`UPDATE accounts SET name=?,region=?,queue=?,tier=?,days=?,
          baseline_date=?,baseline_at=CASE WHEN ? THEN ? WHEN name=? AND region=? AND queue=? AND tier=? AND days=? AND baseline_date=? THEN baseline_at ELSE NULL END,
          note=?,candidate_days=NULL,candidate_at=NULL,candidate_status=NULL,candidate_summary=NULL,candidate_reviews=NULL,
          rank_tier=CASE WHEN ? THEN ? WHEN name=? AND region=? AND queue=? THEN rank_tier ELSE NULL END,
          rank_division=CASE WHEN ? THEN ? WHEN name=? AND region=? AND queue=? THEN rank_division ELSE NULL END,
          rank_lp=CASE WHEN ? THEN ? WHEN name=? AND region=? AND queue=? THEN rank_lp ELSE NULL END,
          profile_observed_at=CASE WHEN ? THEN ? WHEN name=? AND region=? AND queue=? THEN profile_observed_at ELSE NULL END,
          revision=revision+1,updated_at=? WHERE id=? AND revision=? AND owner_id=?`)
          .bind(data.name, data.region, data.queue, data.tier, data.days, data.baselineDate,
            data.baselineProvided ? 1 : 0, data.baselineAt, data.name, data.region, data.queue, data.tier, data.days, data.baselineDate,
            data.note,
            ...PROFILE_FIELDS.flatMap(field => [data.profile.provided ? 1 : 0, data.profile[field], data.name, data.region, data.queue]),
            now, match[1], data.revision, ownerId).run()
        if (!result.meta?.changes) return await missingOrConflict(env.DB, match[1], ownerId)
        return json({ account: await getAccount(env.DB, match[1], ownerId) })
      }
      if (estimateMatch && UUID.test(estimateMatch[1]) && request.method === 'POST') {
        const id = estimateMatch[1]
        const account = await getAccount(env.DB, id, ownerId)
        if (!account) return error(404, 'NOT_FOUND', '账号记录不存在。')
        const body = await readBody(request)
        const candidateAt = canonicalInstant(body?.candidateAt)
        const reviews = validateReviews(body?.candidateReviews)
        const profile = body && typeof body === 'object' && !Array.isArray(body) ? validateProfile(body) : null
        if (!body || ['owner', 'ownerId', 'owner_id'].some(field => Object.hasOwn(body, field)) || !Number.isSafeInteger(body.revision) || body.revision < 1 ||
            !Number.isInteger(body.candidateDays) || body.candidateDays < 0 || body.candidateDays > 365 ||
            !candidateAt || !reviews || !profile || typeof body.candidateSummary !== 'string' || !body.candidateSummary.trim() || body.candidateSummary.length > 2000) {
          return error(400, 'INVALID_INPUT', '请检查估算天数、时刻、说明和记录版本。')
        }
        if (account.revision !== body.revision) return await missingOrConflict(env.DB, id, ownerId)
        if (!account.baselineAt || candidateAt < account.baselineAt || candidateAt > new Date().toISOString()) {
          return error(400, 'INVALID_BASELINE', '请先确认精确基准时间，估算时间须不早于基准且不晚于当前时间。')
        }
        if (Object.values(reviews).some(review => review.endedAt <= account.baselineAt || review.endedAt > candidateAt)) {
          return error(400, 'INVALID_INPUT', '核对对局时间须晚于基准且不晚于查询时刻。')
        }
        const now = new Date().toISOString()
        const observedTier = profile.rankTier === 'DIAMOND' ? '钻石'
          : ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(profile.rankTier) ? '大师及以上' : null
        const result = await env.DB.prepare(`UPDATE accounts SET candidate_days=?,candidate_at=?,candidate_status='estimate',candidate_summary=?,candidate_reviews=?,
          tier=CASE WHEN ? THEN ? ELSE tier END,
          rank_tier=CASE WHEN ? THEN ? ELSE rank_tier END,
          rank_division=CASE WHEN ? THEN ? ELSE rank_division END,
          rank_lp=CASE WHEN ? THEN ? ELSE rank_lp END,
          profile_observed_at=CASE WHEN ? THEN ? ELSE profile_observed_at END,
          revision=revision+1,updated_at=?
          WHERE id=? AND revision=? AND owner_id=? AND baseline_at IS NOT NULL AND baseline_at<=?`)
          .bind(body.candidateDays, candidateAt, body.candidateSummary.trim(), JSON.stringify(reviews),
            observedTier !== null ? 1 : 0, observedTier,
            ...PROFILE_FIELDS.flatMap(field => [profile.provided ? 1 : 0, profile[field]]),
            now, id, body.revision, ownerId, candidateAt).run()
        if (!result.meta?.changes) return await missingOrConflict(env.DB, id, ownerId)
        return json({ account: await getAccount(env.DB, id, ownerId) })
      }
      if (match && UUID.test(match[1]) && request.method === 'DELETE') {
        if (!await getAccount(env.DB, match[1], ownerId)) return error(404, 'NOT_FOUND', '账号记录不存在。')
        const body = await readBody(request)
        if (!body || !Number.isSafeInteger(body.revision) || body.revision < 1) {
          return error(400, 'INVALID_INPUT', '删除时需要提供有效的记录版本。')
        }
        const result = await env.DB.prepare('DELETE FROM accounts WHERE id=? AND revision=? AND owner_id=?')
          .bind(match[1], body.revision, ownerId).run()
        if (!result.meta?.changes) return await missingOrConflict(env.DB, match[1], ownerId)
        return json({ ok: true })
      }
      return error(404, 'NOT_FOUND', '接口不存在。')
    } catch {
      return error(500, 'SERVER_ERROR', '个人记录服务暂时不可用，请稍后重试。')
    }
  }
}
