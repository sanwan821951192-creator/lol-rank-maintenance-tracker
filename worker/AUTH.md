# 认证与个人数据合同

密码登录可在配置服务器密钥后启用。微信登录代码已接入，但必须先拥有审核通过的网站应用、微信登录权限和批准的回调域名；无配置不生成假二维码，也不模拟登录成功。所有认证请求和账号数据请求必须使用HTTPS。

## 账号密码

- `GET /api/auth/config` 总是返回可公开的开关：`{"password":{"enabled":true},"wechat":{"enabled":false,"reason":"setup_required"}}`。未配置相应服务时为 `false`，不返回密钥。
- `POST /api/auth/register` / `POST /api/auth/login`：JSON `{username,password,rememberMe?}`。用户名和密码必须是字符串。用户名先trim并转小写，结果非空且注册时唯一；密码只拒绝空字符串，原样参与哈希，不trim，因此空格也是密码的一部分。账号密码不限制长度或字符类型，可以使用单字符、中文、符号和空格。所有接口仍使用通用的64 KiB请求体上限，不截断输入；超限请求会被拒绝。
- 只有 `rememberMe` 严格为布尔 `true` 时，新密码会话永久有效但可退出撤销，响应 `expiresAt:null`；`false`、省略或其它类型均为2小时，不做truthy转换。此字段不影响密码验证、用户归属或限流。
- 此规则变更不修改已有用户名、密码哈希或账号归属；已有账号继续使用原密码登录，无需数据库迁移或重新设置密钥。
- 注册成功201、登录成功200：`{accessToken,tokenType:"Bearer",expiresAt,user:{id,provider:"password",username}}`。此user.id来自服务器，不接受客户端指定身份。
- 格式错误400 `invalid_credentials`；重复用户名409 `username_taken`；用户名或密码错误统一401 `invalid_credentials`；超限429 `rate_limited`；服务未配置503 `setup_not_ready`。
- 注册每IP最多5次/小时、每规范化用户名5次/小时；登录每IP30次/15分钟、每规范化用户名10次/15分钟。失败和成功都计数。D1 UPSERT条件和RETURNING保证并发计数原子性；无`CF-Connecting-IP`时使用共享受限桶，不信任`X-Forwarded-For`。这些限制不是浏览器内计数。
- 每个密码使用独立32字节随机salt，先用服务器pepper做HMAC-SHA256，再经PBKDF2-SHA256迭代100000次产生32字节哈希。密码、pepper和原始会话token不入库、不记日志。`AUTH_PASSWORD_PEPPER`必须作为Worker Secret提供，格式为32字节或更多随机数据的base64url（43–128字符）。丢失或直接替换它将使旧密码无法验证；应安全备份并制定重置流程后再轮换。
- 当前不包含自助密码找回或微信与密码账号合并。相同名称不表示相同用户，不能据此合并归属。

## 微信登录

Worker Secret：`WECHAT_APP_SECRET`。配置项：`WECHAT_APP_ID`（网站应用AppID）、`WECHAT_REDIRECT_URI`（HTTPS固定回调完整地址，路径必须为 `/api/auth/wechat/callback`，无query/hash/用户名密码）。不要把AppSecret放到桌面包、GitHub或配置JSON。

1. 客户端用安全随机数生成43–128字符base64url `codeVerifier`，只在发起登录的客户端保留；`codeChallenge=base64url(SHA256(codeVerifier))`。
2. `POST /api/auth/wechat/start`：`{codeChallenge,codeChallengeMethod:"S256"}`。成功201返回 `{loginId,authorizationUrl,expiresAt,pollIntervalMs:2000}`，事务5分钟过期。URL是官方 `https://open.weixin.qq.com/connect/qrconnect`，scope固定`snsapi_login`，state为256位随机数，服务器只存其SHA256。每IP最多20次/15分钟。
3. 客户端打开官方authorizationUrl。微信回调 `/api/auth/wechat/callback?code=...&state=...`。服务端原子消费state，向官方code换token接口发送AppID/AppSecret/code；仅信任微信返回的openid，按AppID+openid的SHA256映射内部用户UUID。code另外存短期哈希阻止跨事务重复使用。微信access/refresh token不保存，也不返回客户端。不请求昵称头像。
4. `POST /api/auth/wechat/poll`：`{loginId,codeVerifier}`，返回 `{status:"pending"|"ready"|"failed",expiresAt}`。错误证明或过期事务均404 `login_not_found`。
5. ready后 `POST /api/auth/wechat/exchange`，请求体同poll。一次性消费事务后返回 `{accessToken,tokenType:"Bearer",expiresAt,user:{id,provider:"wechat"}}`；重复领取404，未完成授权409 `login_not_ready`。

这里的S256证明保护桌面端领取会话；它不是声称微信qrconnect原生支持PKCE。state和code只在服务端验证，不把回调页传入的用户ID当成身份。回调HTML不携带会话token，有no-store、no-referrer和禁止外部资源的CSP。微信未配置时start/callback/poll/exchange返回503 `setup_not_ready`，但不影响密码用户的正常会话。

## 会话和数据隔离

会话为256位随机opaque bearer token。密码注册或登录勾选记住登录时不自动过期，响应 `expiresAt:null`，D1的 `expires_at=0` 表示永久会话，仍可退出撤销。过期清理明确排除0。未勾选时有效2小时；微信交换始终为2小时，不读取记住登录选项。有限会话的到期时间从签发时固定计算，查询会话或访问记录不会续期，也不提供refresh token。D1只存token的SHA256、内部owner和过期时间。升级此规则不修改已有有限会话的到期时间（包括旧2小时或30天会话），不需要数据库迁移或修改密钥。

- `GET /api/auth/session`：Bearer认证后返回 `{user:{id,provider,username?},expiresAt}`，有效会话不要求微信已配置。
- `POST /api/auth/logout`：Bearer认证，撤销当前token，返回 `{ok:true}`。
- 所有accounts的读取、单条读取、新增、编辑、估算、删除和导出都按服务端session.owner过滤。跨owner、`owner_id IS NULL`或不存在统一404；无会话401。
- 修改仍需revision；它仅防并发覆盖，不承担身份认证。`ownerId`等字段不属于账号请求合同。
- 未勾选记住登录时，客户端仅在内存或本次窗口sessionStorage保存token；勾选时可持久保存会话token和 `expiresAt`（永久会话为null），桌面端优先使用操作系统加密存储。再次打开时先调用session验证，过期或撤销则清除；null应明确识别为永久，不视为缺失、无效日期或1970年。退出应撤销当前服务器会话并清空本地缓存和token。不要保存密码、把Bearer放URL或记录到日志。关闭登录窗口应丢弃未完成verifier。

## 既有记录归属迁移（仅运维）

0003只新增可空owner列，已有记录保留NULL，不在任何用户列表出现，也不能由普通用户抢占。不要做“第一个注册用户自动领取”，不要按昵称、IP或客户端提交的owner认领。

1. 备份数据库，核实既有记录的全部字段及数量，先部署和验证认证。保留备份于受控位置，勿上传GitHub。
2. 让真实用户在正式客户端注册/登录。通过本人确认的账号与本次会话资料确认目标内部UUID；运维只在控制台查询 `auth_users` 的 `id,provider,username,created_at`，不要查询/公开密码哈希、salt或token_hash。
3. 用户明确确认旧记录属于自己后，运维使用参数化SQL（控制台中仅替换已经核实的值），逐条定向分配，并保留变更前后数量证据：

```sql
UPDATE accounts SET owner_id = ?
WHERE id = ? AND owner_id IS NULL
  AND EXISTS (SELECT 1 FROM auth_users WHERE id = ?);
```

三个绑定参数依次为目标内部用户UUID、已确认的旧记录UUID、同一目标用户UUID。不要更新days/baseline/revision/备注，不要批量给所有旧记录设同一owner。检查每条changes恰好为1；归属已存在时停下核实，不覆盖。运营迁移没有公开HTTP接口。

## 官方协议依据与验证边界

- [微信网站应用微信登录指南](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html)：2026-10-30直接读取同站`.md`内容，核实审核要求、qrconnect/snsapi_login、服务端code交换、code10分钟有效且一次性。当前用户没有审核完成的应用，不能声称真实微信登录已验证。
- [Cloudflare Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)：PBKDF2/HMAC原生支持；[workerd维护者关于PBKDF2迭代限制的说明](https://github.com/cloudflare/workerd/issues/1346)记录生产上限问题，因此本实现使用100000次并要求服务端pepper。实际Cloudflare套餐CPU可用性仍要以部署后的真实注册/登录验证为准。
- [D1 SQL执行](https://developers.cloudflare.com/d1/worker-api/d1-database/)：认证状态消费和限流用单条条件写入保证原子性。

测试使用隔离内存SQLite、真实WebCrypto和模拟微信HTTP响应，验证租户隔离、过期、并发限流和重放保护；模拟微信仅存在测试文件中，不存在生产绕过开关。不要把本地测试结果描述成微信官方审核通过或真实微信联调完成。
