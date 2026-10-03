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
| 「在线状态」 | 没有 | `users.last_seen`，登录 / `/api/me` / 读写存档时更新，60 秒内不重复写库 |
| 「改密码」 | 没有 | `POST /api/admin/user/pass` 生成新密码；密码是 PBKDF2 哈希，**原文无论如何都看不到** |

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

## 静态文件被边缘缓存 · 一个很隐蔽的坑

改完 `app.js` / `style.css` 上传后，线上首页拿到的 `?v=` 还是旧摘要。
`curl -sI https://jujishou.dpdns.org/` 返回的是 `cf-cache-status: HIT` +
`cache-control: public, max-age=0, must-revalidate`，可 Worker 里明明设了 `no-store`。

原因是 **Workers Assets 默认 `run_worker_first = false`**：请求只要命中静态文件，
就由 Assets 直接返回，Worker 的 `fetch` 根本不执行，所以 Worker 里设的任何响应头都不生效。

修法两步：

1. `wrangler.toml` 的 `[assets]` 加 `run_worker_first = true`；
2. Worker 的静态分支自己接管缓存头：HTML → `no-store` + `CDN-Cache-Control: no-store`；
   带 `?v=` 的 CSS/JS → `public, max-age=31536000, immutable`；其余 → `public, max-age=300`。

## 后台的「在线状态 / 详情 / 改密码」

- **在线状态**：`users.last_seen`，3 分钟内算「在线」（绿点），否则显示「N 分钟前 / N 小时前 / N 天前」，
  从没登录过显示「未登录过」。写入有三处：玩家登录成功、`/api/me`、读写存档；60 秒内的重复访问直接跳过。
- **详情面板**：点「详情」把存档翻译成人话 —— 账号信息、各卡池（抽数 / UR / SR / R / UR 保底计数）、
  图鉴（抽到过的卡 + 张数 + 稀有度配色）、最近 10 抽。原始 JSON 收在最底下的折叠里，默认不展开。
- **改密码**：密码存的是 PBKDF2 哈希（`pbkdf2$10000$<salt>$<hash>`），**技术上无法反推原文**，
  所以后台能做的只有「换一个新密码」。点了会用 `crypto.getRandomValues` 生成 8 位好念的新密码
  （字符集避开 `l/1/o/0`），返回一次给管理员，旧密码立刻失效。

## 换后台密钥（2026-10-03 换过一轮）

后台的管理密钥在 2026-10-03 换过一次：旧的那个之前贴进过聊天记录，先让补丁上线，
再 `wrangler secret delete ADMIN_HASH` 作废，确认空密钥也进不去了，随后用同一套流程
设了一个新的。**当前状态是能正常登录的**（2026-10-03 实测 `/api/login` 返回 `ok`，
`/api/admin/users` 能列出账号）。

想再换一次：

```bash
export CLOUDFLARE_API_TOKEN='...'
export CLOUDFLARE_ACCOUNT_ID='b33ea042ee8876a582238e82ce149d44'
printf '%s' '你的新密钥' | sha256sum          # 取摘要
npx wrangler secret put ADMIN_HASH            # 粘上面那串摘要
```

> ⚠️ **两个坑，都会让你「明明设了却登不进去」：**
>
> 1. 前端是把输入框内容 `.trim().toUpperCase()` 之后再算 SHA-256 的，
>    所以摘要必须对着**转大写、去空白**的那一版算。密钥里带小写字母的话，
>    按原样算出来的摘要永远对不上。`ADMIN_HASH` 存的必须是**摘要**，不是明文。
> 2. `wrangler secret put` 会吃掉行尾换行，用 `printf '%s'` 而不是 `echo`，
>    否则你会把那个换行也算进摘要里。

> 🐛 顺带修了一个真实的漏洞：原来那行是
> `if (!ctEq(key, String(env.ADMIN_HASH || '')))`，而 `ctEq('', '')` 返回 `true`。
> 也就是说，只要 `ADMIN_HASH` 被删成 `undefined`，**任何人提交一个空 key 都能登进后台**。
> 现在改成 `if (!key || !env.ADMIN_HASH || !ctEq(key, ...))`，空密钥显式挡掉
> （删密钥那次实测过：空 key 返回 `bad-key`）。

## 注册不再需要邀请码（2026-10-03）

`POST /api/register` 现在只要 `name` + `pass`，`form.code` 直接忽略，不再去 `invites` 表核对。
放开注册自然要防刷，所以加了一条按 IP 的限速：**`REG_MAX = 5` / `REG_WINDOW = 3600` 秒**，
用的是 `fails` 表，键写成 `reg:<ip>` 前缀（不跟后台密钥的失败计数撞在一起）。
数的是「成功开了几个号」，不是失败次数；超了返回 429 `{"err":"rate"}`。

删掉的两样东西：`validCode()` 函数，以及注册里那段 `SELECT ... FROM invites` + `UPDATE invites`。
`genCode()` 和后台那套「测试密钥」接口（`/api/admin/invites`、`/api/admin/invite/new`、
`/api/admin/invite/delete`）**都还在**，但已经跟注册没关系了——留着当历史，别再拿它当门禁用。

`invites` 表同理，没删，只是不再参与注册流程。
