# tools 项目说明

纯静态工具站（HTML 单文件集合），部署在 Cloudflare Pages，并通过 GitHub 仓库自动部署。

## 站点与仓库

- 线上地址：https://tools-9qk.pages.dev，并绑定自定义域名 https://tools.earlmind.com（Cloudflare Pages，绑定 GitHub 仓库 `earlzhang/tools`，push 到 main 自动部署）
- 页面均为独立 HTML，可直接双击本地打开（前后端分离，无构建步骤）
- `vendor/`：自托管三方库（`tailwind-browser.js` @4.3.3、`vue.global.min.js` @3.5.38、`echarts.min.js` @5.5.1），新页面默认引用本地 vendor 而非 CDN；升级时从 jsdelivr 下载对应版本替换文件即可
- `hemingway-bench.html`：Hemingway Bench 榜单页（总榜 + 中国模型分榜 + 点击模型看排名走势），数据来自同源 `/api/history`，本地双击打开时自动回退 workers.dev 接口

## Cloudflare 服务清单

| 服务 | 用途 | 说明 |
| --- | --- | --- |
| Pages | 静态站托管 | 仓库根目录的 HTML 文件即站点内容，GitHub push 自动部署 |
| Workers | `hemingway-bench-watcher` | 定时抓取 Hemingway Bench 榜单 + 邮件提醒，代码在 `cf-worker/`，**与 Pages 相互独立，需单独用 wrangler 部署**（Pages 不支持 Cron Trigger） |
| D1 | 数据库 `hemingway-db` | 存储榜单历史快照（snapshots + entries 两表），有变化才新增快照 |
| Workers Cron Triggers | 定时任务 | 每天 UTC 0:00（北京 8:00）触发，配置在 `cf-worker/wrangler.jsonc` |
| Secrets | 密钥管理 | `RESEND_API_KEY`、`TRIGGER_SECRET`，通过 `wrangler secret put` 设置，不入库 |
| DNS（earlmind.com） | Resend 发信域名验证 | SPF/DKIM 记录；另开启了 Email Routing（收件转发，与 Worker 发信无关） |

## hemingway-bench-watcher Worker

- 地址：https://hemingway-bench-watcher.earlzhang.workers.dev
- 源码：`cf-worker/`（wrangler.jsonc + src/index.ts，无第三方依赖）
- 功能：每天北京 8:00（cron `0 0 * * *`）抓取 https://surgehq.ai/benchmarks/hemingway-bench ，与 D1 最新快照对比；有变化则存新快照（含时间戳，保留完整历史）并通过 Resend 发明细邮件到 earlzhang@163.com；无变化不存储不发信；解析失败发 ⚠️ 告警邮件
- 手动触发：`curl "https://hemingway-bench-watcher.earlzhang.workers.dev/trigger?key=<TRIGGER_SECRET>"`（加 `&force=1` 无变化时也发当前榜单邮件）
- 只读 API：`GET /api/history` 返回全部快照+条目 JSON（CORS `*`）；为绕开 workers.dev 国内直连问题，已绑定自定义路由 `tools.earlmind.com/api/*`（在 `wrangler.jsonc` routes，Worker 路由优先于 Pages，同站 `/api/*` 会被 Worker 拦截）
- 数据表：`snapshots(id, captured_at)` + `entries(snapshot_id, rank, brand, model, score, score_low, score_high)`，建表 SQL 见 `cf-worker/schema.sql`
- 发件：Resend，发件地址 `bench@earlmind.com`（域名已在 Resend 验证，DKIM/SPF 记录在 Cloudflare DNS）

## 常用命令

```bash
cd cf-worker
npx wrangler deploy                      # 部署 Worker
npx wrangler tail                        # 实时查看线上日志
npx wrangler d1 execute hemingway-db --remote --command "SELECT ..."   # 查远程 D1
npx wrangler d1 execute hemingway-db --local  --file=schema.sql        # 本地 D1 建表
npx wrangler dev                         # 本地开发（secrets 用 .dev.vars，已 gitignore）
```

## 注意事项

- `cf-worker/.dev.vars`、`.wrangler/` 含本地密钥/缓存，已在 .gitignore 中排除
- Worker 代码不含任何密钥；修改后需 `npx wrangler deploy` 手动部署（未配置 CI 自动部署）
- surgehq.ai 为 Webflow 静态渲染，解析依赖行容器类名 `lead-rank-table-list-row-wrap`，页面改版会导致告警邮件
