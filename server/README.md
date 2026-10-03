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
| GET | `/api/health` | 存活探测，供前端判断是否隐藏后台入口 |
| POST | `/api/login` | 表单 `key=<cred>`，成功则下发 `gsid` Cookie |
| POST | `/api/logout` | 清除会话 |
| GET | `/api/session` | 当前身份 |
| GET | `/api/save` | 取自己的存档；首次访问自动签发 `gpid` |
| POST | `/api/save` | 覆盖写入存档（JSON，≤128 KB） |
| GET | `/api/admin/overview` | 后台：玩家数、字节数、总抽数、服务器时间 |
| GET | `/api/admin/saves` | 后台：玩家存档列表（原文档转义成 JSON 字符串） |
| GET | `/api/admin/logs` | 后台：最近的审计日志 |

后台三个接口都要求 `gsid` Cookie，没有就是 401 —— 前端改不了这个事实。

## 安全措施

- **会话**：`<id>.<过期时间>.<HMAC-SHA256>`，HMAC 覆盖 `"scope|id|exp"`，密钥是 `session.key`。
  签名比对用常数时间比较。后台 Cookie 是 `HttpOnly` + `SameSite=Strict`，玩家 Cookie 是 `HttpOnly` + `SameSite=Lax`。
- **密钥**：PBKDF2-SHA256，120000 轮，32 字节随机盐。
- **限速**：同一 IP 在 600 秒内失败 5 次即 429，`fails.log` 超过 512 KB 自动只保留最近 1 小时。
- **路径穿越**：URL 先解码再检查，`..` 一律 404；已在真实服务上验证过 4 种编码变体。
- **注入**：写入前用 `json_quick_check()` 校验括号平衡、字符串闭合、转义与深度；
  读取时用 `json_escape()` 转义成 JSON 字符串再交给前端 `JSON.parse()`，不存在拼接。
- **越权**：玩家只能读写自己 `gpid` 对应的那份存档（文件名由服务端签发，不接受客户端指定）。
- **稳健性**：每个连接 `fork()` 一个子进程并 `alarm(25)`；请求头上限 16 KB、请求体上限 256 KB；
  写入用「临时文件 + rename + fsync」，中途断电不会留半个文件。
- **最小化二进制**：静态链接、无外部依赖，不引入任何需要联网或需要包管理器的组件。

## 已知边界

- **没有 HTTPS**。老系统上装 TLS 成本高，且当前用 IP 访问没有证书可用。
  在 HTTP 下，会话 Cookie 与登录凭证都可能被链路上的人看到。想真正安全，需要域名 + 证书 + 反向代理。
- 会话密钥与密钥记录以文件形式存在同一台机器上，拿到 root 的人可以冒充任何玩家。
- 服务端不做业务校验之外的限流（比如抽卡频率），只保护认证入口。

## 文件

```
server.c    请求解析、路由、静态托管、API、会话与限速
sha256.c    SHA-256 / HMAC-SHA256 / PBKDF2-SHA256，纯 C，无外部依赖
sha256.h
util.c      文件读写、URL 解码、JSON 转义与校验、随机数
util.h
build.sh    交叉编译脚本
```
