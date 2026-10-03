# Cloudflare Workers 版后端

原来那台云服务器的机房会按 `Host` 拦掉「未备案域名」（Apache 返回 404，正文是「请联系机房域名过白」），
而且那台机器对海外完全不可达、平台也不给 80/443，所以域名和 HTTPS 在那边无论如何都成立不了。
这一份就是把后端整套搬到 Cloudflare Workers + D1 的版本，前端一行没改。

线上：**<https://jujishou.dpdns.org>**（HTTP 会自动 301 跳到 HTTPS）

## 文件

| 文件 | 作用 |
| --- | --- |
| `wrangler.toml` | Worker 配置：`name`、D1 绑定 `DB`、静态资源绑定 `ASSETS`、域名路由 |
| `schema.sql` | D1 建表脚本（6 张表） |
| `src/worker.js` | 全部后端逻辑（路由 / 会话 / 账号 / 密钥 / 存档 / 后台 / 限速 / 日志） |

## 部署

```bash
cd cf
npm install
export CLOUDFLARE_API_TOKEN='<你的 token>'
export CLOUDFLARE_ACCOUNT_ID='<账户 id>'

# 1. 建表（只需一次）
npx wrangler d1 execute gacha --file schema.sql --remote

# 2. 两个密钥（只需一次，换值就是换密钥）
npx wrangler secret put SESSION_SECRET   # 任意 32 字节随机串，用来签 Cookie
npx wrangler secret put ADMIN_HASH       # 后台密钥的 sha256 摘要
                                         # echo -n '你的后台密钥' | sha256sum

# 3. 发布
npx wrangler deploy
```

`public/` 由 `wrangler.toml` 的 `[assets]` 指定；当前部署时它是从仓库根拷过去的静态站点
（`index.html` / `app.js` / `style.css` / `.nojekyll` / `art/`）。

## 和 C 版后端的差异

| | C 版（云服务器） | Workers 版 |
| --- | --- | --- |
| 静态文件 | 自己读盘、带 `Range` 支持（视频拖动进度条要用） | `env.ASSETS` 直接托管 |
| 存储 | 服务器上的 JSON 文件 | D1 数据库（`users` / `invites` / `saves` / `logs` / `fails` / `meta`） |
| PBKDF2 轮数 | 120000 | **10000** —— Workers 免费版单请求 CPU 只有 10ms，12 万轮会被掐死 |
| 「重启网站」 | 真的重启进程 | 没有进程可重启，改成把 `meta.boot` 写成当前时间，前端轮询发现 `boot` 变了就刷新 |
| 真实 IP | 走 `CF-Connecting-IP`（要开 `GACHA_TRUST_PROXY`） | 天然就是 `CF-Connecting-IP` |

> ⚠️ 因为 PBKDF2 轮数不同，**老服务器上已注册的账号不能直接迁到这边**。
> 迁移当时老站 `users` 是空的，所以没有实际损失。新后端的口令记录里带着轮数
> （`pbkdf2$<iters>$<salt>$<hash>`），以后想提高轮数可以逐条升级。

## 域名是怎么接上的

这个 token 没有 Workers Domains 权限（调 `/accounts/{id}/workers/domains` 报
`10405 Method not allowed for this authentication scheme`），所以 `wrangler.toml` 里的
`routes = [{ custom_domain = true }]` **不会生效**。改用老的 Worker 路由机制，两步：

1. `POST /zones/$ZONE/dns_records` 建一条 proxied 的占位 A 记录（内容填 `192.0.2.1`，
   属于 TEST-NET，Cloudflare 永远不会真的回源到它）；
2. `POST /zones/$ZONE/workers/routes`，`{"pattern":"jujishou.dpdns.org/*","script":"jujishou-gacha"}`。

路由 + proxied DNS 与「自定义域名」效果等价。

## 另一个坑

`*.workers.dev` 在国内被 DNS 污染（解析到 `2a03:2880:...:face:b00c:...`，那是 Meta 的地址），
所以本机根本连不上 `jujishou-gacha.<subdomain>.workers.dev` —— **测试必须走自己的域名**。
