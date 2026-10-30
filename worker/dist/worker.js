// src/auth.js
var LOGIN_TTL_MS = 5 * 60 * 1e3;
var SESSION_TTL_MS = 2 * 60 * 60 * 1e3;
var CODE_TTL_MS = 10 * 60 * 1e3;
var RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;
var VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
var PASSWORD_ITERATIONS = 1e5;
function passwordReady(env) {
  return typeof env.AUTH_PASSWORD_PEPPER === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(env.AUTH_PASSWORD_PEPPER);
}
function usernameOf(input) {
  if (typeof input !== "string") return null;
  const username = input.trim().toLowerCase();
  return username || null;
}
function passwordValid(value) {
  return typeof value === "string" && value.length > 0;
}
async function passwordHash(password, salt, pepper) {
  const pepperKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const secretInput = await crypto.subtle.sign(
    "HMAC",
    pepperKey,
    new TextEncoder().encode(password)
  );
  const key = await crypto.subtle.importKey("raw", secretInput, "PBKDF2", false, ["deriveBits"]);
  return base64url(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: Uint8Array.from(
            atob(salt.replace(/-/g, "+").replace(/_/g, "/") + "="),
            (char) => char.charCodeAt(0)
          ),
          iterations: PASSWORD_ITERATIONS
        },
        key,
        256
      )
    )
  );
}
function sameHash(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length)
    return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
async function consumeLimit(db, key, limit, windowMs) {
  const now = Date.now(), windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db.prepare(
    `INSERT INTO auth_rate_limits (bucket_key,window_start,attempts,expires_at) VALUES (?,?,1,?)
    ON CONFLICT(bucket_key) DO UPDATE SET attempts=CASE WHEN window_start=excluded.window_start THEN attempts+1 ELSE 1 END,
      window_start=excluded.window_start,expires_at=excluded.expires_at
    WHERE window_start<>excluded.window_start OR attempts<? RETURNING attempts`
  ).bind(await hashSecret(key), windowStart, windowStart + windowMs, limit).first();
  return Boolean(row);
}
async function passwordRateLimit(request, db, username, register) {
  const ip = request.headers.get("CF-Connecting-IP") || "unavailable";
  await db.prepare("DELETE FROM auth_rate_limits WHERE expires_at<=?").bind(Date.now()).run();
  const action = register ? "register" : "login", windowMs = register ? 36e5 : 9e5;
  const ipAllowed = await consumeLimit(db, `${action}:ip:${ip}`, register ? 5 : 30, windowMs);
  if (!ipAllowed) return false;
  return consumeLimit(db, `${action}:username:${username}`, register ? 5 : 10, windowMs);
}
async function issueSession(db, ownerId, provider, username, json2, status = 200) {
  const accessToken = `swa_${randomValue()}`, now = Date.now(), expiresAt = now + SESSION_TTL_MS;
  await db.prepare("DELETE FROM auth_sessions WHERE expires_at<=?").bind(now).run();
  await db.prepare(
    "INSERT INTO auth_sessions (token_hash,owner_id,created_at,expires_at) VALUES (?,?,?,?)"
  ).bind(await hashSecret(accessToken), ownerId, now, expiresAt).run();
  const user = { id: ownerId, provider, ...username ? { username } : {} };
  return json2(
    { accessToken, tokenType: "Bearer", expiresAt: new Date(expiresAt).toISOString(), user },
    status
  );
}
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomValue() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
async function hashSecret(value) {
  return base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
  );
}
function authConfig(env) {
  if (typeof env.WECHAT_APP_ID !== "string" || !/^wx[a-z0-9]{16}$/i.test(env.WECHAT_APP_ID) || typeof env.WECHAT_APP_SECRET !== "string" || env.WECHAT_APP_SECRET.length < 16 || env.WECHAT_APP_SECRET.length > 256)
    return null;
  try {
    const callback = new URL(env.WECHAT_REDIRECT_URI);
    if (callback.protocol !== "https:" || callback.username || callback.password || callback.search || callback.hash || callback.pathname !== "/api/auth/wechat/callback")
      return null;
    return {
      appId: env.WECHAT_APP_ID,
      appSecret: env.WECHAT_APP_SECRET,
      redirectUri: callback.href
    };
  } catch {
    return null;
  }
}
async function authenticate(request, db) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer (swa_[A-Za-z0-9_-]{43})$/);
  if (!match) return null;
  const sessionHash = await hashSecret(match[1]);
  const session = await db.prepare(
    `SELECT s.owner_id AS ownerId, s.expires_at AS expiresAt, u.provider, u.username
    FROM auth_sessions s JOIN auth_users u ON u.id=s.owner_id WHERE s.token_hash=? AND s.expires_at>?`
  ).bind(sessionHash, Date.now()).first();
  return session ? { ...session, sessionHash } : null;
}
function callbackPage(message, status = 200) {
  return new Response(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>\u4E09\u665A\u52A9\u624B\u5FAE\u4FE1\u767B\u5F55</title><body><h1>\u4E09\u665A\u52A9\u624B</h1><p>${message}</p></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
      }
    }
  );
}
async function markFailed(db, loginId) {
  await db.prepare(
    "UPDATE auth_login_transactions SET status='failed',owner_id=NULL WHERE id=? AND status='processing'"
  ).bind(loginId).run();
}
async function findTransaction(db, body) {
  if (!body || typeof body !== "object" || !RANDOM_VALUE.test(body.loginId || "") || !VERIFIER.test(body.codeVerifier || ""))
    return null;
  const challenge = await hashSecret(body.codeVerifier);
  return db.prepare(
    `SELECT id,status,expires_at AS expiresAt,owner_id AS ownerId FROM auth_login_transactions
    WHERE id=? AND code_challenge=? AND expires_at>?`
  ).bind(body.loginId, challenge, Date.now()).first();
}
async function authRoute(request, env, path, { json: json2, error: error2, readBody: readBody2 }) {
  if (path === "/api/auth/config" && request.method === "GET") {
    return json2({
      wechat: authConfig(env) ? { enabled: true } : { enabled: false, reason: "setup_required" },
      password: passwordReady(env) ? { enabled: true } : { enabled: false, reason: "setup_required" }
    });
  }
  if (!path.startsWith("/api/auth/")) return null;
  if (path === "/api/auth/session" && request.method === "GET" || path === "/api/auth/logout" && request.method === "POST") {
    const session = await authenticate(request, env.DB);
    if (!session) return error2(401, "unauthorized", "\u8BF7\u5148\u767B\u5F55\u3002");
    if (path.endsWith("/logout")) {
      await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash=? AND owner_id=?").bind(session.sessionHash, session.ownerId).run();
      return json2({ ok: true });
    }
    return json2({
      user: {
        id: session.ownerId,
        provider: session.provider,
        ...session.username ? { username: session.username } : {}
      },
      expiresAt: new Date(session.expiresAt).toISOString()
    });
  }
  if ((path === "/api/auth/register" || path === "/api/auth/login") && request.method === "POST") {
    if (!passwordReady(env))
      return error2(503, "setup_not_ready", "\u8D26\u53F7\u767B\u5F55\u5C1A\u672A\u5B8C\u6210\u914D\u7F6E\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u3002");
    const body = await readBody2(request), username = usernameOf(body?.username), register = path.endsWith("/register");
    if (!await passwordRateLimit(request, env.DB, username || "<invalid>", register))
      return error2(429, "rate_limited", "\u5C1D\u8BD5\u6B21\u6570\u8FC7\u591A\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002");
    if (!username || !passwordValid(body?.password))
      return error2(400, "invalid_credentials", "\u8BF7\u8F93\u5165\u975E\u7A7A\u7684\u7528\u6237\u540D\u548C\u5BC6\u7801\u3002");
    if (register) {
      const id = crypto.randomUUID(), salt = randomValue();
      const hash2 = await passwordHash(body.password, salt, env.AUTH_PASSWORD_PEPPER);
      const inserted = await env.DB.prepare(
        `INSERT OR IGNORE INTO auth_users
        (id,provider,username,password_salt,password_hash,password_iterations,created_at) VALUES (?,'password',?,?,?,?,?)`
      ).bind(id, username, salt, hash2, PASSWORD_ITERATIONS, Date.now()).run();
      if (!inserted.meta?.changes)
        return error2(409, "username_taken", "\u8BE5\u7528\u6237\u540D\u5DF2\u88AB\u4F7F\u7528\uFF0C\u8BF7\u6362\u4E00\u4E2A\u3002");
      return issueSession(env.DB, id, "password", username, json2, 201);
    }
    const user = await env.DB.prepare(
      `SELECT id,username,password_salt AS salt,password_hash AS passwordHash,password_iterations AS iterations
      FROM auth_users WHERE username=? AND provider='password'`
    ).bind(username).first();
    const hash = await passwordHash(
      body.password,
      user?.salt || "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      env.AUTH_PASSWORD_PEPPER
    );
    if (!user || user.iterations !== PASSWORD_ITERATIONS || !sameHash(hash, user.passwordHash))
      return error2(401, "invalid_credentials", "\u7528\u6237\u540D\u6216\u5BC6\u7801\u9519\u8BEF\u3002");
    return issueSession(env.DB, user.id, "password", user.username, json2);
  }
  const config = authConfig(env);
  if (!config) return error2(503, "setup_not_ready", "\u5FAE\u4FE1\u767B\u5F55\u5C1A\u672A\u5B8C\u6210\u914D\u7F6E\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u3002");
  if (path === "/api/auth/wechat/start" && request.method === "POST") {
    const body = await readBody2(request);
    if (!body || body.codeChallengeMethod !== "S256" || !RANDOM_VALUE.test(body.codeChallenge || "")) {
      return error2(400, "invalid_login_request", "\u767B\u5F55\u8BF7\u6C42\u65E0\u6548\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u767B\u5F55\u3002");
    }
    const now = Date.now();
    if (!await consumeLimit(
      env.DB,
      `wechat-start:ip:${request.headers.get("CF-Connecting-IP") || "unavailable"}`,
      20,
      9e5
    )) {
      return error2(429, "rate_limited", "\u5C1D\u8BD5\u6B21\u6570\u8FC7\u591A\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002");
    }
    await env.DB.prepare("DELETE FROM auth_login_transactions WHERE expires_at<=?").bind(now).run();
    await env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at<=?").bind(now).run();
    await env.DB.prepare("DELETE FROM auth_oauth_codes WHERE expires_at<=?").bind(now).run();
    const loginId = randomValue(), state = randomValue(), expiresAt = now + LOGIN_TTL_MS;
    await env.DB.prepare(
      `INSERT INTO auth_login_transactions
      (id,state_hash,code_challenge,wechat_app_id,status,created_at,expires_at) VALUES (?,?,?,?,'pending',?,?)`
    ).bind(loginId, await hashSecret(state), body.codeChallenge, config.appId, now, expiresAt).run();
    const authorization = new URL("https://open.weixin.qq.com/connect/qrconnect");
    authorization.search = new URLSearchParams({
      appid: config.appId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: "snsapi_login",
      state
    }).toString();
    authorization.hash = "wechat_redirect";
    return json2(
      {
        loginId,
        authorizationUrl: authorization.href,
        expiresAt: new Date(expiresAt).toISOString(),
        pollIntervalMs: 2e3
      },
      201
    );
  }
  if (path === "/api/auth/wechat/callback" && request.method === "GET") {
    const url = new URL(request.url), states = url.searchParams.getAll("state"), codes = url.searchParams.getAll("code");
    if (states.length !== 1 || !RANDOM_VALUE.test(states[0]))
      return callbackPage("\u767B\u5F55\u8BF7\u6C42\u5DF2\u5931\u6548\uFF0C\u8BF7\u56DE\u5230\u4E09\u665A\u52A9\u624B\u91CD\u65B0\u767B\u5F55\u3002", 400);
    const transaction = await env.DB.prepare(
      `UPDATE auth_login_transactions SET status='processing'
      WHERE state_hash=? AND wechat_app_id=? AND status='pending' AND expires_at>? RETURNING id`
    ).bind(await hashSecret(states[0]), config.appId, Date.now()).first();
    if (!transaction) return callbackPage("\u767B\u5F55\u8BF7\u6C42\u5DF2\u5931\u6548\uFF0C\u8BF7\u56DE\u5230\u4E09\u665A\u52A9\u624B\u91CD\u65B0\u767B\u5F55\u3002", 400);
    if (codes.length !== 1 || !/^[A-Za-z0-9_-]{1,256}$/.test(codes[0])) {
      await markFailed(env.DB, transaction.id);
      return callbackPage("\u5FAE\u4FE1\u6388\u6743\u672A\u5B8C\u6210\uFF0C\u8BF7\u56DE\u5230\u4E09\u665A\u52A9\u624B\u91CD\u65B0\u767B\u5F55\u3002", 400);
    }
    const claim = await env.DB.prepare(
      "INSERT OR IGNORE INTO auth_oauth_codes (code_hash,expires_at) VALUES (?,?)"
    ).bind(await hashSecret(`${config.appId}\0${codes[0]}`), Date.now() + CODE_TTL_MS).run();
    if (!claim.meta?.changes) {
      await markFailed(env.DB, transaction.id);
      return callbackPage("\u767B\u5F55\u8BF7\u6C42\u5DF2\u5931\u6548\uFF0C\u8BF7\u56DE\u5230\u4E09\u665A\u52A9\u624B\u91CD\u65B0\u767B\u5F55\u3002", 400);
    }
    try {
      const endpoint = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
      endpoint.search = new URLSearchParams({
        appid: config.appId,
        secret: config.appSecret,
        code: codes[0],
        grant_type: "authorization_code"
      }).toString();
      const response = await fetch(endpoint, {
        redirect: "error",
        signal: AbortSignal.timeout(1e4)
      });
      if (!response.ok) throw new Error("Provider rejected authorization");
      const result = await response.json();
      if (result.errcode || typeof result.openid !== "string" || !result.openid || result.openid.length > 128 || typeof result.access_token !== "string" || !result.access_token || typeof result.scope !== "string" || !result.scope.split(",").includes("snsapi_login"))
        throw new Error("Invalid provider response");
      const subjectHash = await hashSecret(`${config.appId}\0${result.openid}`);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO auth_users (id,wechat_subject_hash,created_at) VALUES (?,?,?)"
      ).bind(crypto.randomUUID(), subjectHash, Date.now()).run();
      const user = await env.DB.prepare("SELECT id FROM auth_users WHERE wechat_subject_hash=?").bind(subjectHash).first();
      const saved = await env.DB.prepare(
        `UPDATE auth_login_transactions SET status='ready',owner_id=?
        WHERE id=? AND status='processing' AND expires_at>?`
      ).bind(user.id, transaction.id, Date.now()).run();
      if (!saved.meta?.changes) return callbackPage("\u767B\u5F55\u8BF7\u6C42\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u56DE\u5230\u4E09\u665A\u52A9\u624B\u91CD\u65B0\u767B\u5F55\u3002", 400);
      return callbackPage("\u5FAE\u4FE1\u767B\u5F55\u6210\u529F\uFF0C\u8BF7\u56DE\u5230\u4E09\u665A\u52A9\u624B\u3002\u6B64\u9875\u9762\u53EF\u4EE5\u5173\u95ED\u3002");
    } catch {
      await markFailed(env.DB, transaction.id);
      return callbackPage("\u6682\u65F6\u65E0\u6CD5\u5B8C\u6210\u5FAE\u4FE1\u767B\u5F55\uFF0C\u8BF7\u56DE\u5230\u4E09\u665A\u52A9\u624B\u91CD\u65B0\u767B\u5F55\u3002", 502);
    }
  }
  if ((path === "/api/auth/wechat/poll" || path === "/api/auth/wechat/exchange") && request.method === "POST") {
    const body = await readBody2(request), transaction = await findTransaction(env.DB, body);
    if (!transaction) return error2(404, "login_not_found", "\u767B\u5F55\u8BF7\u6C42\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002");
    if (path.endsWith("/poll")) {
      return json2({
        status: transaction.status === "processing" ? "pending" : transaction.status,
        expiresAt: new Date(transaction.expiresAt).toISOString()
      });
    }
    if (transaction.status !== "ready") return error2(409, "login_not_ready", "\u5FAE\u4FE1\u6388\u6743\u5C1A\u672A\u5B8C\u6210\u3002");
    const claimed = await env.DB.prepare(
      `DELETE FROM auth_login_transactions WHERE id=? AND code_challenge=?
      AND status='ready' AND expires_at>? RETURNING owner_id AS ownerId`
    ).bind(body.loginId, await hashSecret(body.codeVerifier), Date.now()).first();
    if (!claimed) return error2(404, "login_not_found", "\u767B\u5F55\u8BF7\u6C42\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002");
    return issueSession(env.DB, claimed.ownerId, "wechat", null, json2);
  }
  return error2(404, "NOT_FOUND", "\u63A5\u53E3\u4E0D\u5B58\u5728\u3002");
}

// src/index.js
var HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};
var COLUMNS = `id, name, region, queue, tier, days,
  rank_tier AS rankTier, rank_division AS rankDivision, rank_lp AS rankLp, profile_observed_at AS profileObservedAt,
  baseline_date AS baselineDate, baseline_at AS baselineAt, note, revision,
  candidate_days AS candidateDays, candidate_at AS candidateAt,
  candidate_status AS candidateStatus, candidate_summary AS candidateSummary, candidate_reviews AS candidateReviews,
  created_at AS createdAt, updated_at AS updatedAt`;
var QUEUES = /* @__PURE__ */ new Set(["\u5355\u53CC\u6392", "\u7075\u6D3B\u7EC4\u6392", "\u672A\u77E5"]);
var TIERS = /* @__PURE__ */ new Set(["\u94BB\u77F3", "\u5927\u5E08\u53CA\u4EE5\u4E0A", "\u672A\u77E5"]);
var RANK_TIERS = /* @__PURE__ */ new Set(["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER", "UNRANKED"]);
var RANK_DIVISIONS = /* @__PURE__ */ new Set(["I", "II", "III", "IV"]);
var PROFILE_FIELDS = ["rankTier", "rankDivision", "rankLp", "profileObservedAt"];
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" }
  });
}
function error(status, code, message) {
  return json({ error: { code, message } }, status);
}
function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = /* @__PURE__ */ new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function canonicalInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return parsed.toISOString();
}
function localDate(instant) {
  return new Date(Date.parse(instant) + 8 * 36e5).toISOString().slice(0, 10);
}
function validateProfile(input) {
  const provided = PROFILE_FIELDS.some((field) => Object.hasOwn(input, field));
  if (!provided) return { provided: false, rankTier: null, rankDivision: null, rankLp: null, profileObservedAt: null };
  if (!PROFILE_FIELDS.every((field) => Object.hasOwn(input, field))) return null;
  const { rankTier, rankDivision, rankLp } = input;
  const profileObservedAt = input.profileObservedAt === null ? null : canonicalInstant(input.profileObservedAt);
  if (!(rankTier === null || RANK_TIERS.has(rankTier)) || !(rankDivision === null || RANK_DIVISIONS.has(rankDivision)) || !(rankLp === null || Number.isSafeInteger(rankLp) && rankLp >= 0) || input.profileObservedAt !== null && !profileObservedAt) return null;
  if (rankTier === null && (rankDivision !== null || rankLp !== null)) return null;
  if (rankTier !== null && !profileObservedAt) return null;
  if (rankTier === "UNRANKED" && (rankDivision !== null || rankLp !== null)) return null;
  if (["MASTER", "GRANDMASTER", "CHALLENGER"].includes(rankTier) && rankDivision !== null) return null;
  return { provided: true, rankTier, rankDivision, rankLp, profileObservedAt };
}
function validateReviews(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 200) return null;
  const result = /* @__PURE__ */ Object.create(null);
  for (const [id, review] of entries) {
    if (!/^\d{1,40}$/.test(id) || !review || typeof review !== "object" || Array.isArray(review) || Object.keys(review).length !== 3 || typeof review.include !== "boolean" || !(review.wasAfk === null || typeof review.wasAfk === "boolean") || !Object.hasOwn(review, "wasAfk")) return null;
    const endedAt = canonicalInstant(review.endedAt);
    if (!endedAt) return null;
    result[id] = { include: review.include, wasAfk: review.wasAfk, endedAt };
  }
  return result;
}
function unpackAccount(row) {
  if (!row) return null;
  if (row.candidateReviews === null) return row;
  const parsed = validateReviews(JSON.parse(row.candidateReviews));
  if (!parsed) throw new Error("Invalid stored reviews");
  return { ...row, candidateReviews: parsed };
}
function validate(input, needsRevision) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (["owner", "ownerId", "owner_id"].some((field) => Object.hasOwn(input, field))) return null;
  const { name, region, queue, tier, days, baselineDate, note, revision } = input;
  const baselineProvided = Object.hasOwn(input, "baselineAt");
  const baselineAt = input.baselineAt == null ? null : canonicalInstant(input.baselineAt);
  const profile = validateProfile(input);
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100 || typeof region !== "string" || !region.trim() || region.trim().length > 50 || !QUEUES.has(queue) || !TIERS.has(tier) || !Number.isInteger(days) || days < 0 || days > 365 || !isDate(baselineDate) || typeof note !== "string" || note.length > 300 || input.baselineAt != null && (!baselineAt || localDate(baselineAt) !== baselineDate) || needsRevision && (!Number.isSafeInteger(revision) || revision < 1) || !profile) return null;
  return { name: name.trim(), region: region.trim(), queue, tier, days, baselineDate, baselineAt, baselineProvided, note, revision, profile };
}
async function readBody(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("Content-Type") || "")) return null;
  const length = request.headers.get("Content-Length");
  if (length && Number(length) > 65536) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 65536) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
async function getAccount(db, id, ownerId) {
  return unpackAccount(await db.prepare(`SELECT ${COLUMNS} FROM accounts WHERE id = ? AND owner_id = ?`).bind(id, ownerId).first());
}
async function missingOrConflict(db, id, ownerId) {
  const found = await db.prepare("SELECT id FROM accounts WHERE id = ? AND owner_id = ?").bind(id, ownerId).first();
  return found ? error(409, "CONFLICT", "\u6570\u636E\u5DF2\u88AB\u5176\u4ED6\u4EBA\u4FEE\u6539\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u3002") : error(404, "NOT_FOUND", "\u8D26\u53F7\u8BB0\u5F55\u4E0D\u5B58\u5728\u3002");
}
var index_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");
    if (path === "/api/auth/config" && request.method === "GET") return authRoute(request, env, path, { json, error, readBody });
    if (!env.DB) return error(503, "DATABASE_UNAVAILABLE", "\u8D26\u53F7\u6570\u636E\u5E93\u5C1A\u672A\u914D\u7F6E\u3002");
    const match = path.match(/^\/api\/accounts\/([^/]+)$/);
    const estimateMatch = path.match(/^\/api\/accounts\/([^/]+)\/estimate$/);
    try {
      const authResponse = await authRoute(request, env, path, { json, error, readBody });
      if (authResponse) return authResponse;
      const session = await authenticate(request, env.DB);
      if (!session) return error(401, "unauthorized", "\u8BF7\u5148\u767B\u5F55\u3002");
      const ownerId = session.ownerId;
      if (path === "/api/accounts" && request.method === "GET") {
        const result = await env.DB.prepare(`SELECT ${COLUMNS} FROM accounts WHERE owner_id=? ORDER BY updated_at DESC, id`).bind(ownerId).all();
        return json({ accounts: (result.results || []).map(unpackAccount) });
      }
      if (path === "/api/accounts/export" && request.method === "GET") {
        const result = await env.DB.prepare(`SELECT ${COLUMNS} FROM accounts WHERE owner_id=? ORDER BY updated_at DESC, id`).bind(ownerId).all();
        return json({ version: 2, exportedAt: (/* @__PURE__ */ new Date()).toISOString(), accounts: (result.results || []).map(unpackAccount) });
      }
      if (match && UUID.test(match[1]) && request.method === "GET") {
        const account = await getAccount(env.DB, match[1], ownerId);
        return account ? json({ account }) : error(404, "NOT_FOUND", "\u8D26\u53F7\u8BB0\u5F55\u4E0D\u5B58\u5728\u3002");
      }
      if (path === "/api/accounts" && request.method === "POST") {
        const data = validate(await readBody(request), false);
        if (!data) return error(400, "INVALID_INPUT", "\u8BF7\u68C0\u67E5\u8D26\u53F7\u3001\u5927\u533A\u3001\u6392\u4F4D\u7C7B\u578B\u3001\u6BB5\u4F4D\u3001\u5929\u6570\u53CA\u65E5\u671F\u3002");
        const id = crypto.randomUUID();
        const now = (/* @__PURE__ */ new Date()).toISOString();
        await env.DB.prepare(`INSERT INTO accounts
          (id,name,region,queue,tier,days,baseline_date,baseline_at,note,revision,created_at,updated_at,rank_tier,rank_division,rank_lp,profile_observed_at,owner_id)
          VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)`).bind(
          id,
          data.name,
          data.region,
          data.queue,
          data.tier,
          data.days,
          data.baselineDate,
          data.baselineAt,
          data.note,
          now,
          now,
          data.profile.rankTier,
          data.profile.rankDivision,
          data.profile.rankLp,
          data.profile.profileObservedAt,
          ownerId
        ).run();
        return json({ account: await getAccount(env.DB, id, ownerId) }, 201);
      }
      if (match && UUID.test(match[1]) && request.method === "PUT") {
        if (!await getAccount(env.DB, match[1], ownerId)) return error(404, "NOT_FOUND", "\u8D26\u53F7\u8BB0\u5F55\u4E0D\u5B58\u5728\u3002");
        const data = validate(await readBody(request), true);
        if (!data) return error(400, "INVALID_INPUT", "\u8BF7\u68C0\u67E5\u8F93\u5165\u5185\u5BB9\u548C\u8BB0\u5F55\u7248\u672C\u3002");
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const result = await env.DB.prepare(`UPDATE accounts SET name=?,region=?,queue=?,tier=?,days=?,
          baseline_date=?,baseline_at=CASE WHEN ? THEN ? WHEN name=? AND region=? AND queue=? AND tier=? AND days=? AND baseline_date=? THEN baseline_at ELSE NULL END,
          note=?,candidate_days=NULL,candidate_at=NULL,candidate_status=NULL,candidate_summary=NULL,candidate_reviews=NULL,
          rank_tier=CASE WHEN ? THEN ? WHEN name=? AND region=? AND queue=? THEN rank_tier ELSE NULL END,
          rank_division=CASE WHEN ? THEN ? WHEN name=? AND region=? AND queue=? THEN rank_division ELSE NULL END,
          rank_lp=CASE WHEN ? THEN ? WHEN name=? AND region=? AND queue=? THEN rank_lp ELSE NULL END,
          profile_observed_at=CASE WHEN ? THEN ? WHEN name=? AND region=? AND queue=? THEN profile_observed_at ELSE NULL END,
          revision=revision+1,updated_at=? WHERE id=? AND revision=? AND owner_id=?`).bind(
          data.name,
          data.region,
          data.queue,
          data.tier,
          data.days,
          data.baselineDate,
          data.baselineProvided ? 1 : 0,
          data.baselineAt,
          data.name,
          data.region,
          data.queue,
          data.tier,
          data.days,
          data.baselineDate,
          data.note,
          ...PROFILE_FIELDS.flatMap((field) => [data.profile.provided ? 1 : 0, data.profile[field], data.name, data.region, data.queue]),
          now,
          match[1],
          data.revision,
          ownerId
        ).run();
        if (!result.meta?.changes) return await missingOrConflict(env.DB, match[1], ownerId);
        return json({ account: await getAccount(env.DB, match[1], ownerId) });
      }
      if (estimateMatch && UUID.test(estimateMatch[1]) && request.method === "POST") {
        const id = estimateMatch[1];
        const account = await getAccount(env.DB, id, ownerId);
        if (!account) return error(404, "NOT_FOUND", "\u8D26\u53F7\u8BB0\u5F55\u4E0D\u5B58\u5728\u3002");
        const body = await readBody(request);
        const candidateAt = canonicalInstant(body?.candidateAt);
        const reviews = validateReviews(body?.candidateReviews);
        const profile = body && typeof body === "object" && !Array.isArray(body) ? validateProfile(body) : null;
        if (!body || ["owner", "ownerId", "owner_id"].some((field) => Object.hasOwn(body, field)) || !Number.isSafeInteger(body.revision) || body.revision < 1 || !Number.isInteger(body.candidateDays) || body.candidateDays < 0 || body.candidateDays > 365 || !candidateAt || !reviews || !profile || typeof body.candidateSummary !== "string" || !body.candidateSummary.trim() || body.candidateSummary.length > 2e3) {
          return error(400, "INVALID_INPUT", "\u8BF7\u68C0\u67E5\u4F30\u7B97\u5929\u6570\u3001\u65F6\u523B\u3001\u8BF4\u660E\u548C\u8BB0\u5F55\u7248\u672C\u3002");
        }
        if (account.revision !== body.revision) return await missingOrConflict(env.DB, id, ownerId);
        if (!account.baselineAt || candidateAt < account.baselineAt || candidateAt > (/* @__PURE__ */ new Date()).toISOString()) {
          return error(400, "INVALID_BASELINE", "\u8BF7\u5148\u786E\u8BA4\u7CBE\u786E\u57FA\u51C6\u65F6\u95F4\uFF0C\u4F30\u7B97\u65F6\u95F4\u987B\u4E0D\u65E9\u4E8E\u57FA\u51C6\u4E14\u4E0D\u665A\u4E8E\u5F53\u524D\u65F6\u95F4\u3002");
        }
        if (Object.values(reviews).some((review) => review.endedAt <= account.baselineAt || review.endedAt > candidateAt)) {
          return error(400, "INVALID_INPUT", "\u6838\u5BF9\u5BF9\u5C40\u65F6\u95F4\u987B\u665A\u4E8E\u57FA\u51C6\u4E14\u4E0D\u665A\u4E8E\u67E5\u8BE2\u65F6\u523B\u3002");
        }
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const observedTier = profile.rankTier === "DIAMOND" ? "\u94BB\u77F3" : ["MASTER", "GRANDMASTER", "CHALLENGER"].includes(profile.rankTier) ? "\u5927\u5E08\u53CA\u4EE5\u4E0A" : null;
        const result = await env.DB.prepare(`UPDATE accounts SET candidate_days=?,candidate_at=?,candidate_status='estimate',candidate_summary=?,candidate_reviews=?,
          tier=CASE WHEN ? THEN ? ELSE tier END,
          rank_tier=CASE WHEN ? THEN ? ELSE rank_tier END,
          rank_division=CASE WHEN ? THEN ? ELSE rank_division END,
          rank_lp=CASE WHEN ? THEN ? ELSE rank_lp END,
          profile_observed_at=CASE WHEN ? THEN ? ELSE profile_observed_at END,
          revision=revision+1,updated_at=?
          WHERE id=? AND revision=? AND owner_id=? AND baseline_at IS NOT NULL AND baseline_at<=?`).bind(
          body.candidateDays,
          candidateAt,
          body.candidateSummary.trim(),
          JSON.stringify(reviews),
          observedTier !== null ? 1 : 0,
          observedTier,
          ...PROFILE_FIELDS.flatMap((field) => [profile.provided ? 1 : 0, profile[field]]),
          now,
          id,
          body.revision,
          ownerId,
          candidateAt
        ).run();
        if (!result.meta?.changes) return await missingOrConflict(env.DB, id, ownerId);
        return json({ account: await getAccount(env.DB, id, ownerId) });
      }
      if (match && UUID.test(match[1]) && request.method === "DELETE") {
        if (!await getAccount(env.DB, match[1], ownerId)) return error(404, "NOT_FOUND", "\u8D26\u53F7\u8BB0\u5F55\u4E0D\u5B58\u5728\u3002");
        const body = await readBody(request);
        if (!body || !Number.isSafeInteger(body.revision) || body.revision < 1) {
          return error(400, "INVALID_INPUT", "\u5220\u9664\u65F6\u9700\u8981\u63D0\u4F9B\u6709\u6548\u7684\u8BB0\u5F55\u7248\u672C\u3002");
        }
        const result = await env.DB.prepare("DELETE FROM accounts WHERE id=? AND revision=? AND owner_id=?").bind(match[1], body.revision, ownerId).run();
        if (!result.meta?.changes) return await missingOrConflict(env.DB, match[1], ownerId);
        return json({ ok: true });
      }
      return error(404, "NOT_FOUND", "\u63A5\u53E3\u4E0D\u5B58\u5728\u3002");
    } catch {
      return error(500, "SERVER_ERROR", "\u4E2A\u4EBA\u8BB0\u5F55\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
    }
  }
};
export {
  index_default as default
};
