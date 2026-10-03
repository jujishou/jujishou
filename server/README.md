# gachad — 抽卡站的服务端

一个零依赖的 C 语言 HTTP 服务端，给「Jujishou测试」抽卡站提供**真正的**后台与存档：
认证在服务端校验，前端 F12 改不动，存档存在服务器上而不是浏览器里。

## 为什么手写

目标机器是一台 2015 年的 Alpine 3.2（musl 1.1.11、内核 3.18）：

- 没有 gcc / make / perl / python / node，也**没有可用的软件源**（v3.2 早已 EOL）
- 出站网络被重置，服务器**无法自己下载任何东西**
- 只有 BusyBox v1.23.2

所以后端必须是**一个静态链接的二进制**，由外部交叉编译后推上去。用 Node 或解释型 CGI 都走不通。

## 编译

```sh
./build.sh                 # 产出 gachad-x86_64
./build.sh /tmp/gachad     # 或指定输出路径
```

需要一份 x86_64 交叉工具链（本机是 aarch64，目标是 x86_64/musl）。准备工作见 `build.sh` 顶部注释，
约 39 MB，全部从本机 apt 源取，不依赖外网直连。

产物是 `ELF 64-bit LSB executable, x86-64, statically linked, stripped, for GNU/Linux 3.2.0`，
`readelf -d` 的 `NEEDED` 条目为 0 —— 不依赖目标机的任何动态库。构建可复现（相同源码得到相同 BuildID）。

本机自测编译（不交叉）：

```sh
gcc -O2 -Wall -Wextra -I. -o /tmp/gachad_native server.c sha256.c util.c
```

## 运行

```sh
# 1) 首次：写入后台密钥（参数是「凭证摘要」，见下）
./gachad initkey <cred>

# 2) 启动
GACHA_PORT=8080 GACHA_WWW=/opt/gacha/www GACHA_DATA=/opt/gacha/data ./gachad
```

环境变量都可省略，默认 `端口 8080`、`www=/opt/gacha/www`、`data=/opt/gacha/data`。

`data/` 目录里会出现：

| 文件 | 作用 |
| --- | --- |
| `admin.pass` | 后台密钥的 PBKDF2 记录（`pbkdf2$轮数$盐$哈希`） |
| `session.key` | 64 字节随机数，用于给会话 Cookie 签名；首次启动自动生成 |
| `saves/<pid>.json` | 每个玩家的存档，文件由服务端签发 id 命名 |
| `access.log` | 审计日志：`<时间> <IP> <方法> <路径> <状态码>` |
| `fails.log` | 登录失败记录，用于限速 |

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `GACHA_PORT` | `8080` | 监听端口 |
| `GACHA_WWW` | `/opt/gacha/www` | 静态文件目录 |
| `GACHA_DATA` | `/opt/gacha/data` | 数据目录（存档、账号、密钥、日志） |
| `GACHA_TRUST_PROXY` | 关 | 打开后从 Cloudflare 回源头取真实客户端 IP，见「安全措施」 |

## 两种 Cookie

| Cookie | 给谁 | 有效期 | 属性 |
| --- | --- | --- | --- |
| `gsid` | 管理员 | `SESS_TTL` = 7 天 | `HttpOnly; SameSite=Strict` |
| `guid` | 玩家 | `USER_TTL` = **365 天** | `HttpOnly; SameSite=Lax` |

玩家 Cookie 给一年，就是为了「输入过一次后就再也不用输入」。
两者的 token 都是 `<scope>.<过期时间>.<HMAC-SHA256>`；`check_token()` 校验时按 `USER_TTL` 放宽上限，
但管理员 token 自己签发时仍然只给 `SESS_TTL`，所以放宽不影响后台的安全性。

## 密钥为什么不直接存明文

前端把用户输入的密钥先做一次 SHA-256，得到 `cred`，**只把 cred 发出去**，明文密钥从不离开浏览器。
服务端拿到的 cred 再走 120000 轮 PBKDF2 加随机盐后落盘。

这样即使 `admin.pass` 被读走，也拿不到可用的登录凭证；网络上也不会出现明文密钥。

代价说清楚：这是 **HTTP** 环境（没有证书），能做到的是「明文密钥不外泄」，
但**做不到防重放** —— 抓到 cred 的人可以直接拿它登录。要根治必须上 HTTPS。

生成 cred：

```sh
printf '%s' '你的明文密钥' | sha256sum | awk '{print $1}'
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活探测，供前端判断是否隐藏后台入口；返回 `boot`（本次启动的毫秒号） |
| POST | `/api/login` | 管理员登录，表单 `key=<cred>`，成功则下发 `gsid` Cookie |
| POST | `/api/logout` | 清除管理员会话 |
| GET | `/api/session` | 当前管理员身份 |
| POST | `/api/register` | 注册，表单 `name` / `pass` / `code`（一次性密钥），成功则下发 `guid` Cookie |
| POST | `/api/player/login` | 玩家登录，表单 `name` / `pass`，成功则下发 `guid` Cookie |
| POST | `/api/player/logout` | 清除玩家会话 |
| GET | `/api/me` | 当前玩家身份：`{"ok":true,"signedIn":false}` 或 `{...,"signedIn":true,"name":...,"uid":...}` |
| GET | `/api/save` | 取自己的存档；**未登录 401** |
| POST | `/api/save` | 覆盖写入存档（JSON，≤128 KB）；**未登录 401** |
| GET | `/api/admin/overview` | 后台：玩家数、字节数、总抽数、启动时长、端口、www / data 路径、抽得最多的账号 |
| GET | `/api/admin/saves` | 后台：存档列表（原文档转义成 JSON 字符串） |
| GET | `/api/admin/users` | 后台：账号列表 `{uid,name,created,bytes,pulls,mtime}` |
| POST | `/api/admin/user/delete` | 后台：删账号，表单 `uid=`，连同它的存档一起删 |
| GET | `/api/admin/invites` | 后台：一次性密钥列表 `{code,used,uid,created,usedAt}` + `fresh`（还有几枚可用） |
| POST | `/api/admin/invite/new` | 后台：生成一枚一次性密钥，回 `{"ok":true,"code":"XXXX-XXXX-XXXX"}` |
| POST | `/api/admin/invite/delete` | 后台：删掉一枚密钥，表单 `code=` |
| GET | `/api/admin/logs` | 后台：最近的审计日志 |
| POST | `/api/admin/delete` | 后台：按 `pid=<id>` 删存档（账号系统之前的老接口，仍在） |
| POST | `/api/admin/restart` | 后台：硬重启整个服务端（见下） |

所有 `/api/admin/*` 都要求 `gsid` Cookie，没有就是 401 —— 前端改不了这个事实。
所有写操作（`login` / `register` / `player/login` / `player/logout` / `logout` / `save` 的 POST /
以及全部 `/api/admin/*` 的写接口）**只接受 POST**，用 GET 打它们会得到 405。

### 注册的状态码

| 码 | 什么情况 |
| --- | --- |
| 200 | 成功，已下发 `guid` |
| 400 | 用户名非法（<2 或 >32 字节、含控制字符或怪异符号）／密码短于 6 位 |
| 403 | 密钥不存在、已经被用过 |
| 409 | 用户名已经被注册 |

失败时**不会消耗密钥** —— 重名被拒之后那枚密钥还能给别人用。

### 账号是怎么存的

- 用户名先做 `user_norm()`：ASCII 转小写，其余字节原样（所以中文用户名不会被拆坏）
- `uid` = `sha256(归一化用户名)` 的前 16 字节 → 32 个 hex，**用它当文件名**，`<data>/users/<uid>.json`
- 密码行是 `pbkdf2$<iters>$<salt_hex>$<hash_hex>`，`PBKDF2_ITERS` = 120000；明文密码不落盘
- `/api/save` 未登录回 `401 {"ok":false,"err":"no-account","msg":"请先注册或登录"}`

### 一次性密钥

- 字符集是 **Crockford Base32**：`0123456789ABCDEFGHJKMNPQRSTVWXYZ`（32 个，去掉了易混的 `I/L/O/U`）
- 12 位随机 → 显示成 `XXXX-XXXX-XXXX`
- 存在 `<data>/invites/<CODE>.json`：`{"code":..,"uid":..,"used":0/1,"created":..,"usedAt":..}`
- 注册成功时 `invite_consume()` 把它标成已用并写上 `uid`；**重写文件前会先把原来的 `created` 读回来**，
  免得被冲成 0

不支持的扩展名一律 `application/octet-stream`；已认得 `.html/.css/.js/.json/.svg/.jpg/.png/.webp/.gif/.ico/.txt/.mp4/.webm/.woff2`。

## 重启是怎么实现的

每个连接由 `fork()` 出来的子进程处理，监听进程是它们的父进程。`POST /api/admin/restart` 走的顺序是：

1. 先把 `{"ok":true,"restarting":true}` 写出去，再 `shutdown(fd, SHUT_WR)`，让浏览器立刻拿到回执
2. 当前子进程 `fork()` 出一个「使者」，自己继续正常收尾
3. 使者 `setsid()` 离开原进程组，等 300 ms，然后 `killpg()` 把**整个旧进程组**连同监听进程一起 `SIGTERM` —— 挂在那儿的半截连接会一起断掉，这就是「硬」的地方
4. 最多等 5 秒确认旧组消失，再执行 `$GACHA_HOME/start.sh`；找不到脚本就退回 `execv` 自己

`GACHA_HOME` 是用 `readlink("/proc/self/exe")` 解析出来的，不用 `argv[0]` —— 服务器上是以 `./gachad` 启动的，`argv[0]` 里没有目录。
另外 `bind()` 会重试 10 次 × 300 ms，万一旧进程还没让出端口，新进程也不会立刻自杀。

**踩过的坑**：一开始直接 `execv("/proc/self/exe", ...)`，Linux 会把进程名设成路径的 basename，也就是 `exe`。
结果 `pkill -x gachad` / `pgrep -x gachad` 再也找不到这个进程，残留实例继续占着端口，下一次重启就 `bind: Address already in use` 然后退出。
所以必须先 `readlink` 拿到真实路径再 `execv`。

前端那边：`/api/health` 会带上本次启动的毫秒级 `boot` 号，页面每 15 秒比对一次，变了就 `location.reload()`。
再加上 `html`/`js`/`css` 一律返回 `Cache-Control: no-cache`，在线的人会在 15 秒内自动换到新版本。

## 安全措施

- **会话**：`<id>.<过期时间>.<HMAC-SHA256>`，HMAC 覆盖 `"scope|id|exp"`，密钥是 `session.key`。
  签名比对用常数时间比较。后台 Cookie 是 `HttpOnly` + `SameSite=Strict`，玩家 Cookie 是 `HttpOnly` + `SameSite=Lax`。
- **密钥**：PBKDF2-SHA256，120000 轮，32 字节随机盐。
- **账号密码**：同一套 PBKDF2 参数（120000 轮 + 32 字节随机盐），明文不落盘；
  用户名做大小写归一后再摘要成 `uid`，避免「Admin 和 admin 是两个人」这种坑。
- **限速**：同一 IP 在 600 秒内失败 5 次即 429，`fails.log` 超过 512 KB 自动只保留最近 1 小时。
- **反向代理**：`GACHA_TRUST_PROXY=1` 时，如果这条连接来自 Cloudflare 的回源段
  （内置 [官方 IPv4 列表](https://www.cloudflare.com/ips-v4) 15 个网段），就采信 `CF-Connecting-IP`
  （回落到 `X-Forwarded-For` 最左边那段）作为真实客户端 IP，用于审计日志和限速。
  取来的值还要过 `plausible_ip()` 才用。**对端不在 CF 段里时头会被直接丢掉** ——
  所以直连 38080 伪造 `CF-Connecting-IP` 没有用，日志里记的仍然是对端真实 IP。
- **路径穿越**：URL 先解码再检查，`..` 一律 404；已在真实服务上验证过 4 种编码变体。
- **注入**：写入前用 `json_quick_check()` 校验括号平衡、字符串闭合、转义与深度；
  读取时用 `json_escape()` 转义成 JSON 字符串再交给前端 `JSON.parse()`，不存在拼接。
- **越权**：玩家只能读写自己 `guid` 对应的那份存档（文件名是用户名摘要，由服务端自己算，不接受客户端指定）。
- **稳健性**：每个连接 `fork()` 一个子进程并 `alarm(25)`；请求头上限 16 KB、请求体上限 256 KB；
  写入用「临时文件 + rename + fsync」，中途断电不会留半个文件。
  不支持 `Transfer-Encoding: chunked`，见到就直接 400；没有 `Content-Length` 的 POST 按空 body 处理。
- **缓存**：`html` / `js` / `css` 返回 `no-cache`（保证更新后在线的人能换到新版本），图片和视频走 `max-age=3600`。
- **Range 请求**：静态文件支持 `bytes=N-M` / `bytes=N-` / `bytes=-N` 三种写法，
  命中就回 `206 Partial Content` + `Content-Range`，越界回 `416`；
  没有 Range 的请求照旧 `200`，但也会带 `Accept-Ranges: bytes`。
  视频尤其需要这个 —— Safari 看不到 `206` 会干脆不播。
- **最小化二进制**：静态链接、无外部依赖，不引入任何需要联网或需要包管理器的组件。

## 已知边界

- **没有 HTTPS**。老系统上装 TLS 成本高，且当前用 IP 访问没有证书可用。
  在 HTTP 下，会话 Cookie 与登录凭证都可能被链路上的人看到。想真正安全，需要域名 + 证书 + 反向代理。
- 会话密钥与密钥记录以文件形式存在同一台机器上，拿到 root 的人可以冒充任何账号。
- **没有找回密码**：密码忘了只能由管理员删号重建（后台账号列表里删掉，重新发密钥注册）。
  没有邮箱、没有验证码，这是故意的 —— 内测站点不需要那套东西。
- **没有登录失败锁定账号**，只有按 IP 的 429（600 秒内 5 次）。
  想暴力破解一个 6 位以上、走 PBKDF2 12 万轮的密码，代价远高于这个内测站的价值。
- 服务端不做业务校验之外的限流（比如抽卡频率），只保护认证入口。
- **重启会踢人**：`POST /api/admin/restart` 会掐断所有在线连接（包括发起者自己那条）。
  已经抽到一半没提交的存档会丢 —— 前端是节流 1.5 秒自动同步的，正常操作下不会踩到。
  重启本身没有频率限制，因为只有拿到密钥的管理员能用。

## 文件

```
server.c    请求解析、路由、静态托管、API、账号 / 一次性密钥、会话与限速
sha256.c    SHA-256 / HMAC-SHA256 / PBKDF2-SHA256，纯 C，无外部依赖
sha256.h
util.c      文件读写、URL 解码、JSON 转义与校验、随机数
util.h
build.sh    交叉编译脚本
```
