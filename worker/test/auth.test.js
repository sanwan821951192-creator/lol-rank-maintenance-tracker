import assert from 'node:assert/strict'
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import worker from '../src/index.js'

const WECHAT = {
  WECHAT_APP_ID: 'wx0123456789abcdef',
  WECHAT_APP_SECRET: 'test-provider-secret-only',
  WECHAT_REDIRECT_URI: 'https://example.invalid/api/auth/wechat/callback'
}
const PEPPER = randomBytes(32).toString('base64url')
const PASSWORD = 'Test-only Password! 123'
const hash = (value) => createHash('sha256').update(value).digest('base64url')

function database(schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  sqlite.exec(schema)
  return {
    sqlite,
    prepare(sql) {
      return {
        args: [],
        bind(...args) {
          this.args = args
          return this
        },
        async first() {
          return sqlite.prepare(sql).get(...this.args) || null
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...this.args) }
        },
        async run() {
          return { meta: { changes: Number(sqlite.prepare(sql).run(...this.args).changes) } }
        }
      }
    }
  }
}
function env() {
  return { DB: database(), AUTH_PASSWORD_PEPPER: PEPPER, ...WECHAT }
}
function request(path, method = 'GET', body, token, ip = '192.0.2.1') {
  return new Request('https://example.invalid' + path, {
    method,
    headers: {
      'CF-Connecting-IP': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
}
async function register(environment, username, ip = '192.0.2.1') {
  const response = await worker.fetch(
    request('/api/auth/register', 'POST', { username, password: PASSWORD }, null, ip),
    environment
  )
  assert.equal(response.status, 201)
  return response.json()
}
async function start(environment) {
  const codeVerifier = randomBytes(32).toString('base64url')
  const response = await worker.fetch(
    request('/api/auth/wechat/start', 'POST', {
      codeChallenge: hash(codeVerifier),
      codeChallengeMethod: 'S256'
    }),
    environment
  )
  assert.equal(response.status, 201)
  const transaction = await response.json(),
    authorization = new URL(transaction.authorizationUrl)
  assert.equal(
    authorization.origin + authorization.pathname,
    'https://open.weixin.qq.com/connect/qrconnect'
  )
  assert.equal(authorization.searchParams.get('scope'), 'snsapi_login')
  assert.equal(authorization.searchParams.get('redirect_uri'), WECHAT.WECHAT_REDIRECT_URI)
  assert.ok(!transaction.authorizationUrl.includes(WECHAT.WECHAT_APP_SECRET))
  return {
    transaction,
    proof: { loginId: transaction.loginId, codeVerifier },
    state: authorization.searchParams.get('state')
  }
}
function providerMock(t, openid = 'provider-verified-user-a') {
  return t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url.origin + url.pathname, 'https://api.weixin.qq.com/sns/oauth2/access_token')
    assert.equal(url.searchParams.get('appid'), WECHAT.WECHAT_APP_ID)
    assert.equal(url.searchParams.get('secret'), WECHAT.WECHAT_APP_SECRET)
    assert.equal(url.searchParams.get('grant_type'), 'authorization_code')
    return Response.json({
      openid,
      access_token: 'mock-provider-access-token',
      scope: 'snsapi_login',
      expires_in: 7200
    })
  })
}
const accountInput = {
  name: 'fixture#123',
  region: '比尔吉沃特',
  queue: '单双排',
  tier: '大师及以上',
  days: 7,
  baselineDate: '2025-01-02',
  baselineAt: '2025-01-01T16:30:00Z',
  note: ''
}

test('configuration exposes readiness only; setup is explicit and anonymous account access is closed', async () => {
  const environment = { DB: database() }
  const config = await worker.fetch(request('/api/auth/config'), environment)
  assert.deepEqual(await config.json(), {
    wechat: { enabled: false, reason: 'setup_required' },
    password: { enabled: false, reason: 'setup_required' }
  })
  for (const path of ['/api/auth/register', '/api/auth/login', '/api/auth/wechat/start']) {
    const response = await worker.fetch(request(path, 'POST', {}), environment)
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error.code, 'setup_not_ready')
  }
  for (const [path, method] of [
    ['/api/accounts', 'GET'],
    ['/api/accounts', 'POST'],
    ['/api/accounts/export', 'GET'],
    ['/api/auth/session', 'GET']
  ]) {
    assert.equal(
      (
        await worker.fetch(
          request(path, method, method === 'POST' ? accountInput : undefined),
          environment
        )
      ).status,
      401
    )
  }
  const preflight = await worker.fetch(request('/api/accounts', 'OPTIONS'), environment)
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Authorization/)
})

test('password registration normalizes username and enforces unique names without storing secrets', async () => {
  const environment = env()
  const results = await Promise.all(
    ['Alice', ' ALICE '].map((username) =>
      worker.fetch(
        request('/api/auth/register', 'POST', { username, password: PASSWORD }),
        environment
      )
    )
  )
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409])
  const session = await results.find((response) => response.status === 201).json()
  assert.equal(session.user.username, 'alice')
  assert.equal(session.user.provider, 'password')
  const row = environment.DB.sqlite.prepare('SELECT * FROM auth_users').get()
  assert.equal(row.password_iterations, 100000)
  assert.notEqual(row.password_hash, PASSWORD)
  assert.equal(row.password_salt.length, 43)
  const stored = JSON.stringify(environment.DB.sqlite.prepare('SELECT * FROM auth_sessions').all())
  assert.ok(!stored.includes(session.accessToken))
  assert.ok(!stored.includes(PEPPER))
  const login = await worker.fetch(
    request('/api/auth/login', 'POST', { username: 'ALICE', password: PASSWORD }),
    environment
  )
  assert.equal(login.status, 200)
  assert.equal((await login.json()).user.id, session.user.id)
  for (const [username, password] of [
    ['alice', 'Incorrect Password!'],
    ['nobody', 'Incorrect Password!']
  ]) {
    const response = await worker.fetch(
      request('/api/auth/login', 'POST', { username, password }),
      environment
    )
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, 'invalid_credentials')
  }
})

test('registration and login accept nonempty credentials without length or character rules', async () => {
  for (const { username, password } of [
    { username: 'a', password: '1' },
    { username: '  三晚 Friend 🎮  ', password: ' 秘密 ' },
    { username: "_'OR 1=1--", password: "'" },
    { username: '名字'.repeat(40), password: 'x'.repeat(200) },
    { username: '空白密码', password: ' \t ' }
  ]) {
    const environment = env()
    const created = await worker.fetch(
      request('/api/auth/register', 'POST', { username, password }),
      environment
    )
    assert.equal(created.status, 201)
    const session = await created.json()
    assert.equal(session.user.username, username.trim().toLowerCase())
    const login = await worker.fetch(
      request('/api/auth/login', 'POST', { username, password }),
      environment
    )
    assert.equal(login.status, 200)
    assert.equal((await login.json()).user.id, session.user.id)
    const duplicate = await worker.fetch(
      request('/api/auth/register', 'POST', {
        username: username.trim().toUpperCase(),
        password: 'another'
      }),
      environment
    )
    assert.equal(duplicate.status, 409)
    assert.equal((await duplicate.json()).error.code, 'username_taken')
    assert.equal(
      environment.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM auth_users').get().count,
      1
    )
    if (password.trim().length > 0 && password.trim() !== password) {
      assert.equal(
        (
          await worker.fetch(
            request('/api/auth/login', 'POST', { username, password: password.trim() }),
            environment
          )
        ).status,
        401
      )
    }
  }
})

test('only empty or non-string credentials are rejected and stored salts remain independent', async () => {
  const environment = env()
  for (const [index, body] of [
    { username: '', password: PASSWORD },
    { username: ' \t ', password: PASSWORD },
    { username: null, password: PASSWORD },
    { username: 1, password: PASSWORD },
    { username: 'valid', password: '' },
    { username: 'valid', password: null },
    { username: 'valid', password: 1 },
    {}
  ].entries()) {
    for (const route of ['/api/auth/register', '/api/auth/login']) {
      assert.equal(
        (
          await worker.fetch(
            request(route, 'POST', body, null, `192.0.2.${index + 2}`),
            environment
          )
        ).status,
        400
      )
    }
  }
  await register(environment, 'first-user', '192.0.2.8')
  await register(environment, 'second-user', '192.0.2.9')
  const rows = environment.DB.sqlite
    .prepare("SELECT password_salt,password_hash FROM auth_users WHERE provider='password'")
    .all()
  assert.notEqual(rows[0].password_salt, rows[1].password_salt)
  assert.notEqual(rows[0].password_hash, rows[1].password_hash)
})

test('existing normalized usernames and previously hashed passwords remain valid', async () => {
  const environment = env(),
    salt = randomBytes(32)
  const oldHash = pbkdf2Sync(
    createHmac('sha256', PEPPER).update(PASSWORD).digest(),
    salt,
    100000,
    32,
    'sha256'
  ).toString('base64url')
  environment.DB.sqlite
    .prepare(
      "INSERT INTO auth_users (id,provider,username,password_salt,password_hash,password_iterations,created_at) VALUES ('legacy-user','password','sanwan',?,?,100000,?)"
    )
    .run(salt.toString('base64url'), oldHash, Date.now() - 86400000)
  const response = await worker.fetch(
    request('/api/auth/login', 'POST', { username: ' SANWAN ', password: PASSWORD }),
    environment
  )
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).user, {
    id: 'legacy-user',
    provider: 'password',
    username: 'sanwan'
  })
  assert.equal(
    environment.DB.sqlite.prepare('SELECT password_hash FROM auth_users').get().password_hash,
    oldHash
  )
})

test('rate limits are database-atomic under concurrent username attempts and IP rotation cannot bypass username cap', async () => {
  const environment = env()
  const responses = await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      worker.fetch(
        request(
          '/api/auth/login',
          'POST',
          {
            username: 'same-user',
            password: PASSWORD
          },
          null,
          `192.0.2.${i + 1}`
        ),
        environment
      )
    )
  )
  assert.equal(responses.filter((response) => response.status === 401).length, 10)
  assert.equal(responses.filter((response) => response.status === 429).length, 6)
  const rows = environment.DB.sqlite
    .prepare('SELECT attempts FROM auth_rate_limits WHERE bucket_key=?')
    .get(hash('login:username:same-user'))
  assert.equal(rows.attempts, 10)
  environment.DB.sqlite.prepare('UPDATE auth_rate_limits SET window_start=0').run()
  assert.equal(
    (
      await worker.fetch(
        request('/api/auth/login', 'POST', { username: 'same-user', password: PASSWORD }),
        environment
      )
    ).status,
    401
  )
})

test('IP limit cannot be bypassed by changing usernames, including malformed requests', async () => {
  const environment = env()
  const responses = await Promise.all(
    Array.from({ length: 36 }, (_, i) =>
      worker.fetch(
        request('/api/auth/login', 'POST', {
          username: `name-${i}`,
          password: ''
        }),
        environment
      )
    )
  )
  assert.equal(responses.filter((response) => response.status === 400).length, 30)
  assert.equal(responses.filter((response) => response.status === 429).length, 6)
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await worker.fetch(
          request('/api/auth/register', 'POST', { username: `test-${i}`, password: '' }),
          environment
        )
      ).status,
      400
    )
  assert.equal(
    (
      await worker.fetch(
        request('/api/auth/register', 'POST', { username: 'sixth', password: PASSWORD }),
        environment
      )
    ).status,
    429
  )
})

test('sessions expire and logout revokes only that session without requiring WeChat configuration', async () => {
  const environment = { DB: database(), AUTH_PASSWORD_PEPPER: PEPPER }
  const first = await register(environment, 'session-user')
  const second = await (
    await worker.fetch(
      request('/api/auth/login', 'POST', { username: 'session-user', password: PASSWORD }),
      environment
    )
  ).json()
  assert.equal(
    (
      await worker.fetch(
        request('/api/auth/session', 'GET', undefined, first.accessToken),
        environment
      )
    ).status,
    200
  )
  assert.equal(
    (await worker.fetch(request('/api/auth/logout', 'POST', {}, first.accessToken), environment))
      .status,
    200
  )
  assert.equal(
    (await worker.fetch(request('/api/accounts', 'GET', undefined, first.accessToken), environment))
      .status,
    401
  )
  assert.equal(
    (
      await worker.fetch(
        request('/api/accounts', 'GET', undefined, second.accessToken),
        environment
      )
    ).status,
    200
  )
  environment.DB.sqlite.prepare('UPDATE auth_sessions SET expires_at=?').run(Date.now() - 1)
  assert.equal(
    (
      await worker.fetch(
        request('/api/auth/session', 'GET', undefined, second.accessToken),
        environment
      )
    ).status,
    401
  )
})

test('two users cannot read, export, edit, estimate or delete each others records or claim legacy rows', async () => {
  const environment = env(),
    alice = await register(environment, 'alice'),
    bob = await register(environment, 'bob')
  const created = await worker.fetch(
    request('/api/accounts', 'POST', accountInput, alice.accessToken),
    environment
  )
  assert.equal(created.status, 201)
  const { account } = await created.json(),
    path = `/api/accounts/${account.id}`
  for (const route of ['/api/accounts', '/api/accounts/export']) {
    assert.equal(
      (
        await (
          await worker.fetch(request(route, 'GET', undefined, alice.accessToken), environment)
        ).json()
      ).accounts.length,
      1
    )
    assert.equal(
      (
        await (
          await worker.fetch(request(route, 'GET', undefined, bob.accessToken), environment)
        ).json()
      ).accounts.length,
      0
    )
  }
  for (const [route, method, body] of [
    [path, 'GET'],
    [path, 'PUT', { ...accountInput, revision: 1 }],
    [path, 'DELETE', { revision: 1 }],
    [path + '/estimate', 'POST', {}]
  ]) {
    const response = await worker.fetch(request(route, method, body, bob.accessToken), environment)
    assert.equal(response.status, 404)
    assert.equal((await response.json()).error.code, 'NOT_FOUND')
  }
  const estimate = {
    revision: 1,
    candidateDays: 8,
    candidateAt: '2025-01-03T03:00:00Z',
    candidateSummary: 'fixture result',
    candidateReviews: {}
  }
  assert.equal(
    (
      await worker.fetch(
        request(path + '/estimate', 'POST', estimate, alice.accessToken),
        environment
      )
    ).status,
    200
  )
  assert.equal(
    (
      await worker.fetch(
        request(
          '/api/accounts',
          'POST',
          { ...accountInput, ownerId: bob.user.id },
          alice.accessToken
        ),
        environment
      )
    ).status,
    400
  )
  environment.DB.sqlite.prepare('UPDATE accounts SET owner_id=NULL WHERE id=?').run(account.id)
  for (const user of [alice, bob]) {
    assert.equal(
      (
        await (
          await worker.fetch(
            request('/api/accounts', 'GET', undefined, user.accessToken),
            environment
          )
        ).json()
      ).accounts.length,
      0
    )
    assert.equal(
      (
        await worker.fetch(
          request(
            path,
            'PUT',
            { ...accountInput, ownerId: user.user.id, revision: 2 },
            user.accessToken
          ),
          environment
        )
      ).status,
      404
    )
  }
  assert.equal(
    environment.DB.sqlite.prepare('SELECT revision FROM accounts WHERE id=?').get(account.id)
      .revision,
    2
  )
})

test('OAuth callback uses provider identity, one-time state and PKCE-protected one-time session exchange', async (t) => {
  const environment = env(),
    upstream = providerMock(t),
    { transaction, proof, state } = await start(environment)
  const stored = environment.DB.sqlite.prepare('SELECT * FROM auth_login_transactions').get()
  assert.equal(stored.state_hash, hash(state))
  assert.ok(!JSON.stringify(stored).includes(proof.codeVerifier))
  assert.equal(
    (
      await worker.fetch(
        request('/api/auth/wechat/poll', 'POST', { ...proof, codeVerifier: 'b'.repeat(43) }),
        environment
      )
    ).status,
    404
  )
  assert.equal(
    (
      await (
        await worker.fetch(request('/api/auth/wechat/poll', 'POST', proof), environment)
      ).json()
    ).status,
    'pending'
  )
  assert.equal(
    (await worker.fetch(request('/api/auth/wechat/exchange', 'POST', proof), environment)).status,
    409
  )
  assert.equal(
    (
      await worker.fetch(
        request('/api/auth/wechat/callback?state=' + 'x'.repeat(43) + '&code=code-a'),
        environment
      )
    ).status,
    400
  )
  const callback = '/api/auth/wechat/callback?state=' + state + '&code=code-a'
  assert.equal((await worker.fetch(request(callback), environment)).status, 200)
  assert.equal((await worker.fetch(request(callback), environment)).status, 400)
  assert.equal(upstream.mock.callCount(), 1)
  assert.equal(
    (
      await (
        await worker.fetch(request('/api/auth/wechat/poll', 'POST', proof), environment)
      ).json()
    ).status,
    'ready'
  )
  const exchanges = await Promise.all(
    [1, 2].map(() => worker.fetch(request('/api/auth/wechat/exchange', 'POST', proof), environment))
  )
  assert.deepEqual(exchanges.map((response) => response.status).sort(), [200, 404])
  const session = await exchanges.find((response) => response.status === 200).json()
  assert.equal(session.user.provider, 'wechat')
  assert.equal(
    (
      await worker.fetch(
        request('/api/auth/session', 'GET', undefined, session.accessToken),
        environment
      )
    ).status,
    200
  )
  assert.equal(
    environment.DB.sqlite
      .prepare('SELECT COUNT(*) AS n FROM auth_login_transactions WHERE id=?')
      .get(transaction.loginId).n,
    0
  )
  const dump =
    JSON.stringify(environment.DB.sqlite.prepare('SELECT * FROM auth_users').all()) +
    JSON.stringify(environment.DB.sqlite.prepare('SELECT * FROM auth_sessions').all())
  for (const secret of [
    session.accessToken,
    'provider-verified-user-a',
    'mock-provider-access-token',
    WECHAT.WECHAT_APP_SECRET
  ])
    assert.ok(!dump.includes(secret))
})

test('expired state and transaction cannot authorize a login; repeated provider code is rejected across states', async (t) => {
  const environment = env(),
    upstream = providerMock(t),
    first = await start(environment)
  environment.DB.sqlite
    .prepare('UPDATE auth_login_transactions SET expires_at=? WHERE id=?')
    .run(Date.now() - 1, first.transaction.loginId)
  assert.equal(
    (
      await worker.fetch(
        request(`/api/auth/wechat/callback?state=${first.state}&code=expired-code`),
        environment
      )
    ).status,
    400
  )
  assert.equal(
    (await worker.fetch(request('/api/auth/wechat/poll', 'POST', first.proof), environment)).status,
    404
  )
  assert.equal(upstream.mock.callCount(), 0)
  const second = await start(environment),
    third = await start(environment)
  assert.equal(
    (
      await worker.fetch(
        request(`/api/auth/wechat/callback?state=${second.state}&code=one-use-code`),
        environment
      )
    ).status,
    200
  )
  assert.equal(
    (
      await worker.fetch(
        request(`/api/auth/wechat/callback?state=${third.state}&code=one-use-code`),
        environment
      )
    ).status,
    400
  )
  assert.equal(upstream.mock.callCount(), 1)
})

test('provider failure never creates a session and cannot be retried with the consumed state', async (t) => {
  const environment = env(),
    flow = await start(environment)
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ errcode: 40029, errmsg: 'invalid code' })
  )
  const callback = `/api/auth/wechat/callback?state=${flow.state}&code=bad-code`
  assert.equal((await worker.fetch(request(callback), environment)).status, 502)
  assert.equal((await worker.fetch(request(callback), environment)).status, 400)
  assert.equal(
    (
      await (
        await worker.fetch(request('/api/auth/wechat/poll', 'POST', flow.proof), environment)
      ).json()
    ).status,
    'failed'
  )
  assert.equal(
    (await worker.fetch(request('/api/auth/wechat/exchange', 'POST', flow.proof), environment))
      .status,
    409
  )
  assert.equal(environment.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 0)
})

test('owner migration preserves all existing fields and never assigns the first registered user', async () => {
  const fullSchema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
  const oldSchema = fullSchema
    .slice(fullSchema.indexOf('CREATE TABLE IF NOT EXISTS accounts'))
    .replace('  owner_id TEXT REFERENCES auth_users(id),\r\n', '')
    .replace('  owner_id TEXT REFERENCES auth_users(id),\n', '')
    .replace(/CREATE INDEX IF NOT EXISTS accounts_owner_updated[^;]+;/, '')
  const db = database(oldSchema)
  db.sqlite
    .prepare(
      'INSERT INTO accounts (id,name,region,queue,tier,days,baseline_date,note,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(
      'legacy',
      'old-player',
      'old-region',
      '单双排',
      '大师及以上',
      7,
      '2025-01-01',
      'keep note',
      4,
      'old-created',
      'old-updated'
    )
  const before = { ...db.sqlite.prepare('SELECT * FROM accounts').get() }
  db.sqlite.exec(
    readFileSync(new URL('../migrations/0003_wechat_owners.sql', import.meta.url), 'utf8')
  )
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT * FROM accounts').get() },
    { ...before, owner_id: null }
  )
  const environment = { DB: db, AUTH_PASSWORD_PEPPER: PEPPER },
    session = await register(environment, 'first-ever')
  assert.deepEqual(
    (
      await (
        await worker.fetch(
          request('/api/accounts', 'GET', undefined, session.accessToken),
          environment
        )
      ).json()
    ).accounts,
    []
  )
  assert.equal(db.sqlite.prepare('SELECT owner_id FROM accounts').get().owner_id, null)
})
