# 峡谷维护簿

英雄联盟国服账号维护记录与近期战绩查询工具。前端可部署在 GitHub Pages，共享记录由 Cloudflare Worker 和 D1 保存；本机桥接程序只读连接登录中的英雄联盟客户端。

## 当前状态

- 按人工填写的日期和天数估算剩余天数；不代表官方维护结算时间。
- 多人共享已连接 Cloudflare Worker 和 D1；自行部署时可参照 `worker/`，再在 `config.js` 修改 Worker 地址。
- 查询近期战绩需要当前访问者的电脑启动 `bridge/`，并在已登录的客户端连接下运行。
- 客户端战绩分页尚未验证完整，查询仅用于展示，不会自动加天，也没有后台定时任务。
- 任何访客可增删改共享记录；请勿填写游戏密码或任何凭证，定期导出备份。

部署步骤见 `worker/README.md`，本机查询步骤见 `bridge/README.md`。如果通过 GitHub 网页下载，请先解压仓库中的 `lol-maintenance-components.zip`，其中包含这两个目录。
