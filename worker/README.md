# 三晚助手个人账号数据后端

这是三晚助手使用的 Cloudflare Worker + D1 后端。每个已登录用户只能访问自己的账号记录；旧匿名接口已关闭。静态页面提供界面，Worker 负责认证、校验请求和读写 D1；它们需要分别部署。此目录不包含真实账号数据、凭据或生产数据库编号。认证合同、配置和旧数据归属操作见 [AUTH.md](AUTH.md)。

## 部署前提

1. 注册并登录 Cloudflare，启用 Workers 和 D1。免费额度和可用性以 Cloudflare 当前说明为准：[D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)、[Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)。
2. 安装包含 npm 和 npx 的 Node.js。以下命令在 PowerShell 中、此 `worker` 目录执行。当前仓库的 `database_id` 是占位符，必须替换。

```powershell
npx wrangler login
npx wrangler d1 create lol-maintenance
```

将创建命令输出的数据库 ID 填入 `wrangler.toml` 的 `database_id`。不要填写访问令牌。

```powershell
npx wrangler d1 execute lol-maintenance --remote --file=./schema.sql
npx wrangler secret put AUTH_PASSWORD_PEPPER
npx wrangler deploy
```

`AUTH_PASSWORD_PEPPER` 使用安全随机生成的至少32字节密钥的 base64url 表示，作为 Worker Secret 保存，勿写入源码或前端。部署成功后，将 Worker 根地址填入前端配置的 `API_BASE`。匿名请求 `/api/accounts` 必须返回401；登录成功后，新用户的列表为空。本地测试运行 `node --test test/*.test.js`（Node.js 版本需支持 `node:sqlite`）。本地测试不等于已验证云端部署。Dashboard 编辑器仅接受单文件时先 `npm install`、`npm run build`，粘贴 `dist/worker.js`；不要只粘贴包含 import 的 `src/index.js`。

已有数据库不要再次执行新建用的 `schema.sql` 来代替迁移。先备份并确认目标数据库，再对使用原始 schema 的数据库执行一次 `migrations/0001_precise_baseline_estimate.sql`，之后部署新 Worker；该增量迁移不会猜测旧记录的精确时刻。不要对已经按新 `schema.sql` 创建的库执行此迁移，也不要重复执行该迁移。

已经包含精确基准和估算字段的旧数据库，需要执行一次 `migrations/0002_rank_profile.sql`，再部署当前 Worker。此迁移只添加四个可空的段位字段，不修改账号、手动天数、精确基准或估算结果。先检查 `PRAGMA table_info(accounts)`，已有 `rank_tier` 等四列的库无需重复执行；新建库直接使用当前 `schema.sql`，无需再运行上述迁移。

个人数据版本还需要在已完成0001、0002的库执行一次 `migrations/0003_wechat_owners.sql`，再配置密码密钥及部署新 Worker。它仅添加认证表和可空 `owner_id`，不会删除或分配旧账号。新用户不会自动领取旧记录。执行前备份数据库和核实表结构；当前 `schema.sql` 新建的库不重复执行迁移。

## 数据及访问方式

账号密码没有专门的长度或字符限制：用户名trim并转小写后须非空且唯一，密码须为非空字符串并按原文验证（包括空格）。通用64 KiB请求体上限仍适用。此校验调整只需更新Worker代码，不迁移或重写已有用户、密码和维护记录。

所有账号接口要求 `Authorization: Bearer <accessToken>`，只读写服务端会话绑定用户的记录。客户端不得指定owner；跨用户和未归属的记录统一返回404。过期或无效会话返回401。CORS允许显式Authorization请求头，不使用跨站认证Cookie。不要把游戏密码、客户端令牌或其他私密信息写入账号、备注、GitHub、前端配置或 Worker 日志。

接口统一使用 JSON，`Content-Type: application/json`。时间是 ISO 8601 UTC，`baselineDate` 是人工输入基准日期（`YYYY-MM-DD`）。

| 请求                               | 用途                                    | 成功结果                                            |
| ---------------------------------- | --------------------------------------- | --------------------------------------------------- |
| `GET /api/accounts`                | 读取自己的全部记录                      | `{"accounts":[...]}`                                |
| `GET /api/accounts/export`         | 导出自己的记录                          | `{"version":2,"exportedAt":"...","accounts":[...]}` |
| `POST /api/accounts`               | 新增记录                                | HTTP 201，`{"account":{...}}`                       |
| `PUT /api/accounts/{id}`           | 更新已有记录，提交完整字段及 `revision` | `{"account":{...}}`                                 |
| `POST /api/accounts/{id}/estimate` | 以当前 `revision` 条件保存独立估算结果  | `{"account":{...}}`                                 |
| `DELETE /api/accounts/{id}`        | 删除记录，请求体为 `{"revision":1}`     | `{"ok":true}`                                       |

新增及更新字段：`name`（1–100 字符）、`region`（1–50 字符）、`queue`（`单双排` / `灵活组排` / `未知`）、`tier`（`钻石` / `大师及以上` / `未知`）、`days`（0–365 整数）、`baselineDate`（有效日期）、`note`（0–300 字符）。更新和删除使用读取到的整数 `revision`。版本不符返回 HTTP 409，需要重新读取后再决定如何处理；记录不存在返回 404，输入错误返回 400。错误格式为 `{"error":{"code":"...","message":"..."}}`。

新增和更新还可提交 `baselineAt`：人工确认的精确时间，使用 UTC ISO 8601（例如 `2025-01-01T16:30:00Z`）；它对应的北京时间日期必须与 `baselineDate` 一致。`null` 表示未知。旧客户端省略该字段时，只有账号、区服、队列、段位、天数和日期均未变才保留原基准时刻，否则清空。任何普通 PUT 都清空已有估算，以免基准改变后展示陈旧结果。

新增、更新和估算请求都可提交完整段位快照：`rankTier`（`IRON` / `BRONZE` / `SILVER` / `GOLD` / `PLATINUM` / `EMERALD` / `DIAMOND` / `MASTER` / `GRANDMASTER` / `CHALLENGER` / `UNRANKED` / `null`）、`rankDivision`（`I` / `II` / `III` / `IV` / `null`）、`rankLp`（非负安全整数或 `null`）、`profileObservedAt`（UTC ISO 8601 或 `null`）。提供任一个字段时必须同时提供四个；有明确段位时必须有查询时间。大师以上没有小段，`rankDivision` 应为 `null`；明确未定级 `UNRANKED` 的小段和分数应为 `null`。未查到的信息使用 `null`，不当作 0 分或未定级。旧记录的四个字段均为 `null`。省略快照的同账号编辑保留已有快照，改动账号名、区服或队列会清空；省略快照的估算更新保留已有快照。快照与其所属请求按同一个 `revision` 原子保存，不能覆盖其他访问者较新的修改。估算请求中查询到的 `DIAMOND` 会同步将维护规则类别 `tier` 更新为 `钻石`，`MASTER` / `GRANDMASTER` / `CHALLENGER` 同步更新为 `大师及以上`，以便兼容旧记录的未知类别；其它或缺失段位不改写类别。此过程不改变人工基准天数和基准时间。

估算请求体示例：`{"revision":1,"candidateDays":8,"candidateAt":"2025-01-03T03:00:00Z","candidateSummary":"候选结果，资格未核实","candidateReviews":{"123":{"include":true,"wasAfk":null,"endedAt":"2025-01-02T00:00:00Z"}}}`。`candidateDays` 为 0–365 的整数；`candidateAt` 不得早于精确基准或晚于服务端当前时间；`candidateSummary` 为 1–2000 字符的非空文本。记录必须已有精确基准。`candidateReviews` 必填（无对局时使用 `{}`），最多 200 条，每个键是最多 40 位的数字对局 ID；值只允许 `include`（布尔）、`wasAfk`（布尔或 null）和 `endedAt`（UTC 时刻，须晚于基准并不晚于查询时刻）。普通 PUT 会清除估算与核对记录。请求体上限 64 KiB。

保存成功后返回 `candidateDays`、`candidateAt`、`candidateStatus: "estimate"`、`candidateSummary` 和已保存的 `candidateReviews` 对象。这些字段和人工基准 `days`、`baselineDate`、`baselineAt` 分开存储；版本冲突返回 409。估算字段由本人客户端提供，Worker 不连接战绩服务，也不验证其计算或对局资格；因此它们不是官方维护天数或核实证据。只有记录所属用户可以修改，版本号用于防止同一用户多端意外覆盖。
