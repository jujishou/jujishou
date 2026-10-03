/* server.c —— 抽卡站服务端：静态托管 + 服务端认证后台 + 存档 API
 *
 * 设计目标：
 *   - 零依赖静态二进制，能在 2015 年的 Alpine + musl（BusyBox 1.23）上跑
 *   - 后台密钥用 PBKDF2-SHA256 验证，明文密钥不落盘
 *   - 会话用 HMAC-SHA256 签名的 Cookie，客户端伪造无效
 *   - 所有外部输入都做长度与字符集校验，杜绝路径穿越与注入
 *   - fork-per-connection，天然隔离
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <time.h>
#include <ctype.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <dirent.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#include "sha256.h"
#include "util.h"

/* ---------- 配置 ---------- */
#define REQ_HDR_MAX   16384
#define BODY_MAX      (256 * 1024)
#define SAVE_MAX      (128 * 1024)
#define SESS_TTL      (7 * 24 * 3600)
/* 玩家会话管一年：密钥/账号只输一次，之后这台设备直接进 */
#define USER_TTL      (365LL * 24 * 3600)
#define PBKDF2_ITERS  120000
#define LOGIN_WINDOW  600
#define LOGIN_MAXFAIL 5
#define CONN_TIMEOUT  25

static const char *g_www  = "/opt/gacha/www";
static const char *g_data = "/opt/gacha/data";
static int         g_port = 8080;
static char       *g_argv0 = NULL;   /* argv[0]，自我重启时用来重新执行自己 */
static char        g_home[4096];     /* 程序所在目录，重启时用它找 start.sh */
/* 前面挂了反向代理（Cloudflare）时打开：从 CF-Connecting-IP / X-Forwarded-For
   取真实客户端 IP，用于审计日志和登录限速。默认关 —— 直连时如果信任这些头，
   任何人都能伪造 IP 来绕过限速。 */
static int         g_trust_proxy = 0;

static char    g_saves_dir[512];
static char    g_users_dir[512];
static char    g_admin_file[512];
static char    g_secret_file[512];
static char    g_log_file[512];
static char    g_fail_file[512];
static uint8_t g_secret[64];
static long long g_start_time = 0;
/* 每次进程启动都换一个毫秒级的「启动号」。前端轮询 /api/health 比对它，
   一旦变了就说明服务端重启过，自动刷新页面去取新版本。
   刻意不用秒级的 g_start_time：重启很快时有可能落在同一秒里，那就白等了。 */
static long long g_boot_id = 0;

/* ---------- 基础输出 ---------- */
static void raw(int fd, const char *s) { write_all(fd, s, strlen(s)); }

static const char *mime_of(const char *path)
{
    const char *dot = strrchr(path, '.');
    if (!dot) return "application/octet-stream";
    if (!strcasecmp(dot, ".html") || !strcasecmp(dot, ".htm")) return "text/html; charset=utf-8";
    if (!strcasecmp(dot, ".css"))   return "text/css; charset=utf-8";
    if (!strcasecmp(dot, ".js"))    return "application/javascript; charset=utf-8";
    if (!strcasecmp(dot, ".json"))  return "application/json; charset=utf-8";
    if (!strcasecmp(dot, ".svg"))   return "image/svg+xml";
    if (!strcasecmp(dot, ".jpg") || !strcasecmp(dot, ".jpeg")) return "image/jpeg";
    if (!strcasecmp(dot, ".png"))   return "image/png";
    if (!strcasecmp(dot, ".webp"))  return "image/webp";
    if (!strcasecmp(dot, ".gif"))   return "image/gif";
    if (!strcasecmp(dot, ".ico"))   return "image/x-icon";
    if (!strcasecmp(dot, ".txt"))   return "text/plain; charset=utf-8";
    if (!strcasecmp(dot, ".mp4"))   return "video/mp4";
    if (!strcasecmp(dot, ".webm"))  return "video/webm";
    if (!strcasecmp(dot, ".woff2")) return "font/woff2";
    return "application/octet-stream";
}

static void send_head(int fd, int code, const char *ctype, size_t len,
                      const char *extra)
{
    char buf[1280];
    const char *reason = "Error";
    switch (code) {
    case 200: reason = "OK"; break;
    case 204: reason = "No Content"; break;
    case 206: reason = "Partial Content"; break;
    case 400: reason = "Bad Request"; break;
    case 401: reason = "Unauthorized"; break;
    case 403: reason = "Forbidden"; break;
    case 404: reason = "Not Found"; break;
    case 405: reason = "Method Not Allowed"; break;
    case 413: reason = "Payload Too Large"; break;
    case 414: reason = "URI Too Long"; break;
    case 416: reason = "Range Not Satisfiable"; break;
    case 429: reason = "Too Many Requests"; break;
    case 500: reason = "Internal Server Error"; break;
    default: break;
    }
    snprintf(buf, sizeof buf,
             "HTTP/1.1 %d %s\r\n"
             "Server: gachad\r\n"
             "Content-Type: %s\r\n"
             "Content-Length: %lu\r\n"
             "X-Content-Type-Options: nosniff\r\n"
             "X-Frame-Options: SAMEORIGIN\r\n"
             "Referrer-Policy: same-origin\r\n"
             "Connection: close\r\n"
             "%s"
             "\r\n",
             code, reason, ctype, (unsigned long)len, extra ? extra : "");
    raw(fd, buf);
}

static void send_body(int fd, int code, const char *ctype,
                      const char *body, size_t len, const char *extra)
{
    send_head(fd, code, ctype, len, extra);
    if (body && len) write_all(fd, body, len);
}

static void send_text(int fd, int code, const char *msg)
{
    send_body(fd, code, "text/plain; charset=utf-8", msg, strlen(msg), NULL);
}

static void send_json(int fd, int code, const char *json)
{
    send_body(fd, code, "application/json; charset=utf-8",
              json, strlen(json), "Cache-Control: no-store\r\n");
}

/* ---------- 请求 ---------- */
typedef struct {
    char   method[16];
    char   path[1024];
    char   query[2048];
    char   cookie[2048];
    char   range[128];      /* Range 请求头，视频要用 */
    char   fwd_ip[64];      /* 反代（Cloudflare）报上来的真实 IP，仅在信任时采用 */
    char  *body;
    size_t bodylen;
} req_t;

static void req_free(req_t *r) { if (r->body) { free(r->body); r->body = NULL; } }

/* 返回 0 成功；-1 连接错误；-2 过大；-3 格式错误 */
static int read_request(int fd, req_t *r)
{
    char  *buf = (char *)xmalloc(REQ_HDR_MAX + 1);
    size_t used = 0, hdr_end = 0, hdr_skip = 0;
    char  *hdr = NULL, *rest = NULL;
    size_t clen = 0;
    int    has_clen = 0, has_te = 0, bad = 0, rc = 0;

    memset(r, 0, sizeof *r);

    while (used < REQ_HDR_MAX) {
        ssize_t n = read(fd, buf + used, REQ_HDR_MAX - used);
        char *p;
        if (n < 0) { if (errno == EINTR) continue; rc = -1; goto out; }
        if (n == 0) break;
        used += (size_t)n;
        buf[used] = '\0';
        p = strstr(buf, "\r\n\r\n");
        if (p) { hdr_end = (size_t)(p - buf); hdr_skip = 4; break; }
        p = strstr(buf, "\n\n");
        if (p) { hdr_end = (size_t)(p - buf); hdr_skip = 2; break; }
    }
    if (!hdr_end) { rc = -3; goto out; }

    /* 把 header 单独复制出来解析，不动 buf 里的原始字节 */
    hdr = (char *)xmalloc(hdr_end + 1);
    memcpy(hdr, buf, hdr_end);
    hdr[hdr_end] = '\0';

    /* 第一行 */
    {
        char *nl = strchr(hdr, '\n');
        char *sp1, *sp2;
        if (!nl) { rc = -3; goto out; }
        *nl = '\0';
        rest = nl + 1;                 /* 后续头部从这里开始 */
        { size_t ll = strlen(hdr); if (ll && hdr[ll-1] == '\r') hdr[ll-1] = '\0'; }

        sp1 = strchr(hdr, ' ');
        if (!sp1) { rc = -3; goto out; }
        if ((size_t)(sp1 - hdr) >= sizeof r->method) { rc = -3; goto out; }
        memcpy(r->method, hdr, (size_t)(sp1 - hdr));
        r->method[sp1 - hdr] = '\0';

        sp2 = strchr(sp1 + 1, ' ');
        if (sp2) *sp2 = '\0';

        {
            const char *target = sp1 + 1;
            const char *qm = strchr(target, '?');
            if (qm) {
                size_t plen = (size_t)(qm - target);
                if (plen >= sizeof r->path) { rc = -3; goto out; }
                memcpy(r->path, target, plen);
                r->path[plen] = '\0';
                snprintf(r->query, sizeof r->query, "%s", qm + 1);
            } else {
                snprintf(r->path, sizeof r->path, "%s", target);
            }
        }
    }

    /* 其余头部 */
    {
        char *p = rest;
        while (p && *p) {
            char *e = strchr(p, '\n');
            char *line = p;
            if (e) { *e = '\0'; p = e + 1; } else p = NULL;
            { size_t ll = strlen(line); if (ll && line[ll-1] == '\r') line[ll-1] = '\0'; }
            if (!*line) break;
            {
                char *colon = strchr(line, ':');
                char *val;
                if (!colon) continue;
                *colon = '\0';
                val = colon + 1;
                while (*val == ' ' || *val == '\t') val++;

                if (!strcasecmp(line, "Content-Length")) {
                    long v = strtol(val, NULL, 10);
                    if (v < 0 || v > BODY_MAX) bad = 1;
                    else { clen = (size_t)v; has_clen = 1; }
                } else if (!strcasecmp(line, "Transfer-Encoding")) {
                    has_te = 1;          /* 不支持 chunked，见到就拒 */
                } else if (!strcasecmp(line, "Cookie")) {
                    snprintf(r->cookie, sizeof r->cookie, "%s", val);
                } else if (!strcasecmp(line, "Range")) {
                    snprintf(r->range, sizeof r->range, "%s", val);
                } else if (!strcasecmp(line, "CF-Connecting-IP")) {
                    /* 只有信任反代时才会真正采用，见 trust_proxy_ip() */
                    snprintf(r->fwd_ip, sizeof r->fwd_ip, "%s", val);
                } else if (!strcasecmp(line, "X-Forwarded-For") && !r->fwd_ip[0]) {
                    /* 只取最左边那段（最靠近客户端的那个） */
                    size_t k = 0;
                    while (val[k] && val[k] != ',' && k < sizeof r->fwd_ip - 1) {
                        r->fwd_ip[k] = val[k];
                        k++;
                    }
                    r->fwd_ip[k] = '\0';
                    while (k && (r->fwd_ip[k-1] == ' ' || r->fwd_ip[k-1] == '\t')) r->fwd_ip[--k] = '\0';
                }
            }
        }
    }

    if (bad) { rc = -2; goto out; }
    if (has_te) { rc = -3; goto out; }   /* 不支持 chunked 传输 */

    /* 注意：POST 不带 Content-Length 是合法的「空 body」，
     * 很多客户端（含 curl -X POST）就是这么发的，不能拒。 */

    /* body */
    if (!strcasecmp(r->method, "POST") && clen > 0) {
        size_t have;
        size_t body_off = hdr_end + hdr_skip;

        if (body_off > used) body_off = used;
        have = used - body_off;

        r->body = (char *)xmalloc(clen + 1);
        if (have > clen) have = clen;
        memcpy(r->body, buf + body_off, have);
        r->bodylen = have;

        while (r->bodylen < clen) {
            ssize_t n = read(fd, r->body + r->bodylen, clen - r->bodylen);
            if (n < 0) { if (errno == EINTR) continue; rc = -1; goto out; }
            if (n == 0) break;
            r->bodylen += (size_t)n;
        }
        r->body[r->bodylen] = '\0';
    } else {
        r->body = (char *)xmalloc(1);
        r->body[0] = '\0';
        r->bodylen = 0;
    }

out:
    (void)has_clen;   /* 只用于诊断，body 长度由 clen 决定 */
    free(buf);
    if (hdr) free(hdr);
    if (rc) req_free(r);
    return rc;
}

/* ---------- Cookie ---------- */
static int cookie_get(const char *cookie, const char *key, char *out, size_t outsz)
{
    size_t klen = strlen(key);
    const char *p = cookie;

    while (p && *p) {
        const char *eq, *semi;
        while (*p == ' ' || *p == ';' || *p == '\t') p++;
        if (!*p) break;
        eq = strchr(p, '=');
        semi = strchr(p, ';');
        if (!eq || (semi && eq > semi)) { if (semi) { p = semi + 1; continue; } break; }
        if ((size_t)(eq - p) == klen && memcmp(p, key, klen) == 0) {
            size_t vlen = semi ? (size_t)(semi - eq - 1) : strlen(eq + 1);
            if (vlen >= outsz) vlen = outsz - 1;
            memcpy(out, eq + 1, vlen);
            out[vlen] = '\0';
            return 0;
        }
        p = semi ? semi + 1 : eq + strlen(eq);
    }
    return -1;
}

/* ---------- 会话 token ---------- */
static void make_token(const char *scope, const char *id, long long exp,
                       char *out, size_t outsz)
{
    char msg[256];
    uint8_t mac[32];
    char hex[65];
    snprintf(msg, sizeof msg, "%s|%s|%lld", scope, id, exp);
    hmac_sha256(g_secret, sizeof g_secret, (const uint8_t *)msg, strlen(msg), mac);
    to_hex(mac, 32, hex);
    snprintf(out, outsz, "%s.%lld.%s", id, exp, hex);
}

/* 校验并取回 id（不含过期校验范围由调用方决定） */
static int check_token(const char *scope, const char *tok,
                       char *id_out, size_t idsz, int *expired)
{
    char work[256], msg[512], hex[65];
    char *dot1, *dot2;
    uint8_t mac[32];
    long long exp;

    if (!tok || strlen(tok) >= sizeof work) return 0;
    snprintf(work, sizeof work, "%s", tok);

    dot1 = strchr(work, '.');
    if (!dot1) return 0;
    *dot1 = '\0';
    dot2 = strchr(dot1 + 1, '.');
    if (!dot2) return 0;
    *dot2 = '\0';

    exp = atoll(dot1 + 1);
    if (exp <= 0 || exp > now_sec() + USER_TTL + 300) return 0;

    snprintf(msg, sizeof msg, "%s|%s|%lld", scope, work, exp);
    hmac_sha256(g_secret, sizeof g_secret, (const uint8_t *)msg, strlen(msg), mac);
    to_hex(mac, 32, hex);
    if (strlen(dot2 + 1) != 64 || !ct_eq(hex, dot2 + 1, 64)) return 0;

    if (exp < now_sec()) { if (expired) *expired = 1; return 0; }
    if (strlen(work) >= idsz) return 0;
    snprintf(id_out, idsz, "%s", work);
    return 1;
}

/* ---------- JSON 粗校验：挡住明显畸形输入，避免存储层被塞垃圾 ---------- */
static int json_quick_check(const char *s, size_t len)
{
    size_t i;
    int depth = 0, instr = 0, esc = 0;
    char open = 0;

    if (len < 2 || len > SAVE_MAX) return 0;
    for (i = 0; i < len; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c == 0) return 0;
        if (instr) {
            if (esc) esc = 0;
            else if (c == '\\') esc = 1;
            else if (c == '"') instr = 0;
            else if (c < 0x20) return 0;
            continue;
        }
        if (c == '"') { instr = 1; continue; }
        if (c == '{' || c == '[') {
            if (depth == 0) open = (char)c;
            if (++depth > 32) return 0;
            continue;
        }
        if (c == '}' || c == ']') {
            if (--depth < 0) return 0;
            continue;
        }
    }
    if (depth != 0 || instr) return 0;
    if (open == '{' && s[len-1] != '}') return 0;
    if (open == '[' && s[len-1] != ']') return 0;
    return open != 0;
}

/* ---------- 管理员密钥（PBKDF2） ---------- */
static int admin_key_init(const char *plain)
{
    uint8_t salt[32], dk[32];
    char shex[65], dhex[65], line[256];

    if (rand_bytes(salt, sizeof salt) != 0) return -1;
    pbkdf2_sha256((const uint8_t *)plain, strlen(plain), salt, sizeof salt,
                  PBKDF2_ITERS, dk, sizeof dk);
    to_hex(salt, sizeof salt, shex);
    to_hex(dk, sizeof dk, dhex);
    snprintf(line, sizeof line, "pbkdf2$%d$%s$%s\n", PBKDF2_ITERS, shex, dhex);
    return write_file_atomic(g_admin_file, line, strlen(line));
}

static int admin_key_check(const char *plain)
{
    size_t len = 0;
    char *c = read_file(g_admin_file, &len);
    char *p1, *p2, *p3;
    uint32_t iters;
    uint8_t salt[32], want[32], got[32];
    int ok = 0;

    if (!c) return 0;
    if (strncmp(c, "pbkdf2$", 7) != 0) { free(c); return 0; }
    p1 = c + 7;
    p2 = strchr(p1, '$');
    if (!p2) { free(c); return 0; }
    *p2 = '\0';
    p3 = strchr(p2 + 1, '$');
    if (!p3) { free(c); return 0; }
    *p3 = '\0';

    iters = (uint32_t)strtoul(p1, NULL, 10);
    if (iters < 1000 || iters > 5000000) { free(c); return 0; }
    if (from_hex(p2 + 1, salt, 32) != 0) { free(c); return 0; }
    {
        char *nl = strchr(p3 + 1, '\n');
        if (nl) *nl = '\0';
    }
    if (from_hex(p3 + 1, want, 32) != 0) { free(c); return 0; }

    pbkdf2_sha256((const uint8_t *)plain, strlen(plain), salt, 32, iters, got, 32);
    ok = ct_eq(got, want, 32);
    free(c);
    return ok;
}


/* ---------- 账号 ---------- */

/* 把明文口令做成一行可存盘记录：pbkdf2$轮数$盐$摘要 */
static int pw_make_line(const char *plain, char *out, size_t outsz)
{
    uint8_t salt[32], dk[32];
    char shex[65], dhex[65];

    if (rand_bytes(salt, sizeof salt) != 0) return -1;
    pbkdf2_sha256((const uint8_t *)plain, strlen(plain), salt, sizeof salt,
                  PBKDF2_ITERS, dk, sizeof dk);
    to_hex(salt, sizeof salt, shex);
    to_hex(dk, sizeof dk, dhex);
    snprintf(out, outsz, "pbkdf2$%d$%s$%s", PBKDF2_ITERS, shex, dhex);
    return 0;
}

/* 用存盘记录去校验明文口令 */
static int pw_check_line(const char *plain, const char *line)
{
    char buf[512];
    char *p1, *p2, *p3, *nl;
    uint32_t iters;
    uint8_t salt[32], want[32], got[32];
    int ok;

    if (!line) return 0;
    snprintf(buf, sizeof buf, "%s", line);
    if (strncmp(buf, "pbkdf2$", 7) != 0) return 0;

    p1 = buf + 7;
    p2 = strchr(p1, '$');
    if (!p2) return 0;
    *p2 = '\0';
    p3 = strchr(p2 + 1, '$');
    if (!p3) return 0;
    *p3 = '\0';

    iters = (uint32_t)strtoul(p1, NULL, 10);
    if (iters < 1000 || iters > 5000000) return 0;
    if (from_hex(p2 + 1, salt, 32) != 0) return 0;

    nl = strchr(p3 + 1, '\n');
    if (nl) *nl = '\0';
    if (from_hex(p3 + 1, want, 32) != 0) return 0;

    pbkdf2_sha256((const uint8_t *)plain, strlen(plain), salt, 32, iters, got, 32);
    ok = ct_eq(got, want, 32);
    return ok;
}

/* 用户名归一化：ASCII 转小写，其余字节原样。用来算 uid，
   这样 Alice 和 alice 是同一个账号，中文也不会被拆坏。 */
static void user_norm(const char *in, char *out, size_t outsz)
{
    size_t i = 0;
    while (in[i] && i + 1 < outsz) {
        unsigned char c = (unsigned char)in[i];
        out[i] = (c >= 'A' && c <= 'Z') ? (char)(c + 32) : (char)c;
        i++;
    }
    out[i] = '\0';
}

/* 用户名：2~32 字节；ASCII 只允许字母数字下划线连字符；
   >=0x80 的字节放行（中文、日文等 UTF-8）；控制字符一律拒。 */
static int valid_username(const char *n)
{
    size_t len, i;
    if (!n) return 0;
    len = strlen(n);
    if (len < 2 || len > 32) return 0;
    for (i = 0; i < len; i++) {
        unsigned char c = (unsigned char)n[i];
        if (c < 0x20 || c == 0x7f) return 0;
        if (c < 0x80 && !(isalnum(c) || c == '_' || c == '-')) return 0;
    }
    return 1;
}

static int valid_password(const char *p)
{
    size_t len;
    if (!p) return 0;
    len = strlen(p);
    return len >= 6 && len <= 128;
}

/* 用户名 → uid：sha256(归一化名字) 的前 16 字节，32 个 hex。
   用摘要而不是原名字做文件名，省掉一整套转义问题。 */
static void user_uid(const char *name, char *out /* >= 33 字节 */)
{
    char norm[128];
    uint8_t d[32];
    char hex[65];
    user_norm(name, norm, sizeof norm);
    sha256(norm, strlen(norm), d);
    to_hex(d, 32, hex);
    memcpy(out, hex, 32);
    out[32] = '\0';
}

static void user_path(const char *uid, char *out, size_t outsz)
{
    snprintf(out, outsz, "%s/%s.json", g_users_dir, uid);
}

static int user_exists(const char *uid)
{
    char f[700];
    user_path(uid, f, sizeof f);
    return file_exists(f);
}

/* 读用户记录里的 "name" 字段；没有就返回 0 */
static int user_read_name(const char *uid, char *out, size_t outsz)
{
    char f[700], *c, *p;
    size_t len = 0;

    user_path(uid, f, sizeof f);
    c = read_file(f, &len);
    if (!c) return 0;
    p = strstr(c, "\"name\":\"");
    if (!p) { free(c); return 0; }
    p += 8;
    {
        size_t i = 0;
        while (p[i] && p[i] != '"' && i + 1 < outsz) {
            if (p[i] == '\\' && p[i + 1]) i++;      /* 跳过转义 */
            out[i] = p[i];
            i++;
        }
        out[i] = '\0';
    }
    free(c);
    return out[0] != '\0';
}

/* 建账号。成功 0，并把 uid / 展示名写出去。 */
static int user_create(const char *name, const char *pass,
                       char *uid_out, size_t uidsz,
                       char *name_out, size_t namesz)
{
    char uid[64], f[700], name_esc[256], line[512], body[900], tmp[600];
    char *existing;

    user_uid(name, uid);
    if (user_exists(uid)) return -2;                 /* 已存在 */

    if (pw_make_line(pass, line, sizeof line) != 0) return -1;

    json_escape(name, strlen(name), name_esc, sizeof name_esc);
    snprintf(body, sizeof body,
             "{\"name\":\"%s\",\"pass\":\"%s\",\"created\":%lld}",
             name_esc, line, now_sec());
    user_path(uid, f, sizeof f);
    if (write_file_atomic(f, body, strlen(body)) != 0) return -1;

    snprintf(uid_out, uidsz, "%s", uid);
    if (name_out && namesz) snprintf(name_out, namesz, "%s", name);
    (void)tmp;
    (void)existing;
    return 0;
}

/* 校验账号口令。成功 0，失败 -1（账号不存在或口令不对）。 */
static int user_auth(const char *name, const char *pass,
                     char *uid_out, size_t uidsz)
{
    char uid[64], f[700];
    size_t len = 0;
    char *c, *p;
    int ok = 0;

    user_uid(name, uid);
    user_path(uid, f, sizeof f);
    c = read_file(f, &len);
    if (!c) return -1;

    p = strstr(c, "\"pass\":\"");
    if (p) {
        char rec[512];
        size_t i = 0;
        p += 8;
        while (p[i] && p[i] != '"' && i + 1 < sizeof rec) {
            if (p[i] == '\\' && p[i + 1]) i++;
            rec[i] = p[i];
            i++;
        }
        rec[i] = '\0';
        ok = pw_check_line(pass, rec);
    }
    free(c);

    if (!ok) return -1;
    snprintf(uid_out, uidsz, "%s", uid);
    return 0;
}

/* ---------- 登录限速 ---------- */
static int login_fails_recent(const char *ip)
{
    size_t len = 0;
    char *c = read_file(g_fail_file, &len);
    long long cut = now_sec() - LOGIN_WINDOW;
    int cnt = 0;
    char *p;

    if (!c) return 0;
    p = c;
    while (p && *p) {
        char *nl = strchr(p, '\n');
        char ipe[64];
        long long ts;
        if (nl) *nl = '\0';
        if (sscanf(p, "%63s %lld", ipe, &ts) == 2) {
            if (ts >= cut && strcmp(ipe, ip) == 0) cnt++;
        }
        p = nl ? nl + 1 : NULL;
    }
    free(c);
    return cnt;
}

static void login_fail_record(const char *ip)
{
    char line[128];
    int fd;
    struct stat st;

    if (stat(g_fail_file, &st) == 0 && st.st_size > 512 * 1024) {
        /* 文件太大了：只保留最近一小时的记录 */
        size_t len = 0;
        char *c = read_file(g_fail_file, &len);
        if (c) {
            long long cut = now_sec() - 3600;
            char *out = (char *)xmalloc(len + 1);
            size_t o = 0;
            char *p = c;
            while (p && *p) {
                char *nl = strchr(p, '\n');
                char ipe[64];
                long long ts;
                if (nl) *nl = '\0';
                if (sscanf(p, "%63s %lld", ipe, &ts) == 2 && ts >= cut) {
                    int w = snprintf(out + o, len + 1 - o, "%s %lld\n", ipe, ts);
                    if (w > 0) o += (size_t)w;
                }
                p = nl ? nl + 1 : NULL;
            }
            write_file_atomic(g_fail_file, out, o);
            free(out);
            free(c);
        }
    }

    fd = open(g_fail_file, O_WRONLY | O_CREAT | O_APPEND, 0640);
    if (fd < 0) return;
    snprintf(line, sizeof line, "%s %lld\n", ip, now_sec());
    write_all(fd, line, strlen(line));
    close(fd);
}

/* ---------- 审计日志 ---------- */

/* 反代报上来的 IP 只信「长得像 IP」的：数字 / a-f / 点 / 冒号，2~63 字节。
   校验一遍是必须的 —— 这些值会进日志和限速表，不能带着换行或空格进来。 */
static int plausible_ip(const char *s)
{
    size_t i, n = strlen(s);
    if (n < 2 || n >= 64) return 0;
    for (i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (!(isdigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
              || c == '.' || c == ':'))
            return 0;
    }
    return 1;
}

/* Cloudflare 的回源 IP 段，来自 https://www.cloudflare.com/ips-v4
   段列表变了要跟着更新 —— 不过它几年才动一次。 */
static const char *g_cf_nets[] = {
    "173.245.48.0/20",  "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18",  "108.162.192.0/18","190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15",  "104.16.0.0/13",
    "104.24.0.0/14",    "172.64.0.0/13",   "131.0.72.0/22",   NULL
};

/* "a.b.c.d" 在不在 "x.y.z.w/n" 里面。只认 IPv4。 */
static int ipv4_in_cidr(const char *ip, const char *cidr)
{
    unsigned a, b, c, d, o1, o2, o3, o4, bits, mask;
    if (sscanf(ip, "%u.%u.%u.%u", &a, &b, &c, &d) != 4) return 0;
    if (sscanf(cidr, "%u.%u.%u.%u/%u", &o1, &o2, &o3, &o4, &bits) != 5) return 0;
    if (a > 255 || b > 255 || c > 255 || d > 255) return 0;
    if (o1 > 255 || o2 > 255 || o3 > 255 || o4 > 255) return 0;
    if (bits > 32) return 0;
    /* bits == 0 时不能写 0xFFFFFFFFu << 32，那是未定义行为 */
    mask = bits ? (0xFFFFFFFFu << (32 - bits)) : 0u;
    return (((a << 24) | (b << 16) | (c << 8) | d) & mask)
        == (((o1 << 24) | (o2 << 16) | (o3 << 8) | o4) & mask);
}

static int is_cloudflare_ip(const char *ip)
{
    size_t i;
    for (i = 0; g_cf_nets[i]; i++)
        if (ipv4_in_cidr(ip, g_cf_nets[i])) return 1;
    return 0;
}

static void access_log(const char *ip, const char *method,
                       const char *path, int code)
{
    char line[1400];
    int fd = open(g_log_file, O_WRONLY | O_CREAT | O_APPEND, 0640);
    if (fd < 0) return;
    snprintf(line, sizeof line, "%lld %s %s %s %d\n",
             now_sec(), ip, method, path, code);
    write_all(fd, line, strlen(line));
    close(fd);
}

/* ---------- 静态文件 ---------- */

/* 支持 Range 请求。视频（尤其 Safari）看不到 206 就干脆不播，
   所以这块不能省：解析 bytes=N-M / bytes=N- / bytes=-N 三种写法。
   返回 1 表示已经回过响应（206 或 416），0 表示当作没有 Range 全量发。 */
static int serve_range(int fd, const char *ctype, const char *data, size_t len,
                       const char *range, const char *cache, int *code_out)
{
    long long start = 0, end = 0;
    const char *p;
    char hdr[512];

    if (!range || !*range) return 0;
    if (strncasecmp(range, "bytes=", 6) != 0) return 0;
    p = range + 6;

    if (*p == '-') {                      /* bytes=-N：最后 N 字节 */
        long long n = atoll(p + 1);
        if (n <= 0) return 0;
        start = (long long)len - n;
        if (start < 0) start = 0;
        end = (long long)len - 1;
    } else {
        const char *dash = strchr(p, '-');
        start = atoll(p);
        if (!dash) return 0;
        if (dash[1] >= '0' && dash[1] <= '9') end = atoll(dash + 1);
        else end = (long long)len - 1;    /* bytes=N-：到文件尾 */
    }

    if (start < 0 || start > end || start >= (long long)len) {
        snprintf(hdr, sizeof hdr, "Content-Range: bytes */%lu\r\n%s",
                 (unsigned long)len, cache ? cache : "");
        send_head(fd, 416, "text/plain; charset=utf-8", 0, hdr);
        if (code_out) *code_out = 416;
        return 1;
    }
    if (end > (long long)len - 1) end = (long long)len - 1;

    snprintf(hdr, sizeof hdr,
             "Accept-Ranges: bytes\r\n"
             "Content-Range: bytes %lld-%lld/%lu\r\n"
             "%s",
             start, end, (unsigned long)len, cache ? cache : "");
    send_head(fd, 206, ctype, (size_t)(end - start + 1), hdr);
    write_all(fd, data + start, (size_t)(end - start + 1));
    if (code_out) *code_out = 206;
    return 1;
}

static int serve_static(int fd, const char *rawpath, const char *range)
{
    char path[1024], full[1200];
    size_t len = 0;
    char *data;
    const char *cache;
    const char *ctype;

    if (strlen(rawpath) >= sizeof path) {
        send_text(fd, 414, "414 URI Too Long");
        return 414;
    }
    if (url_decode(rawpath, strlen(rawpath), path, sizeof path) < 0) {
        send_text(fd, 400, "400 Bad Request");
        return 400;
    }
    if (!strcmp(path, "/")) snprintf(path, sizeof path, "/index.html");
    if (strstr(path, "..") || strchr(path, '\0') == NULL) {
        send_text(fd, 404, "404 Not Found");
        return 404;
    }
    if (strlen(path) >= sizeof full - strlen(g_www) - 2) {
        send_text(fd, 404, "404 Not Found");
        return 404;
    }
    snprintf(full, sizeof full, "%s%s", g_www, path);

    data = read_file(full, &len);
    if (!data) {
        send_text(fd, 404, "404 Not Found");
        return 404;
    }

    /* 页面与脚本每次都要回源确认，否则后台点了「重启网站」之后，
       老用户的浏览器还会抱着缓存里的旧版本不走。图片带内容哈希含义，
       换图会改文件名，所以给长缓存。 */
    if (strstr(path, ".html") || strstr(path, ".js") || strstr(path, ".css"))
        cache = "Cache-Control: no-cache\r\n";
    else
        cache = "Cache-Control: public, max-age=3600\r\n";

    ctype = mime_of(full);

    {
        int rcode = 200;
        if (serve_range(fd, ctype, data, len, range, cache, &rcode)) {
            free(data);
            return rcode;
        }
    }

    {
        char extra[160];
        snprintf(extra, sizeof extra, "Accept-Ranges: bytes\r\n%s", cache);
        send_body(fd, 200, ctype, data, len, extra);
    }
    free(data);
    return 200;
}


/* ---------- 一次性邀请密钥 ---------- */
/* 测试期入场券：每枚密钥只能拿去注册一个账号，用完即废。
   文件名就是密钥本身（字符集里没有路径危险字符）。 */
static void invite_path(const char *code, char *out, size_t outsz)
{
    snprintf(out, outsz, "%s/invites/%s.json", g_data, code);
}

static void gen_invite_code(char *out, size_t outsz)
{
    /* Crockford Base32：32 个字符，去掉了 I/L/O/U，不会看混。
       之前写成 31 个字符，CS[31] 取到 '\0' 把密钥截短了。 */
    static const char CS[] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    uint8_t r[16];
    char raw[13];
    int i;

    if (rand_bytes(r, sizeof r) != 0) { out[0] = '\0'; return; }
    for (i = 0; i < 12; i++) raw[i] = CS[r[i] & 31];
    raw[12] = '\0';
    snprintf(out, outsz, "%.4s-%.4s-%.4s", raw, raw + 4, raw + 8);
}

/* 密钥合法字符：字母数字与连字符，长度固定 */
static int valid_invite_code(const char *c)
{
    size_t i, n;
    if (!c) return 0;
    n = strlen(c);
    if (n < 8 || n > 32) return 0;
    for (i = 0; i < n; i++) {
        unsigned char ch = (unsigned char)c[i];
        if (!(isalnum(ch) || ch == '-')) return 0;
    }
    return 1;
}

/* 密钥存在且还没被用过 */
static int invite_is_fresh(const char *code)
{
    char f[700];
    size_t len = 0;
    char *c;
    int fresh;

    if (!valid_invite_code(code)) return 0;
    invite_path(code, f, sizeof f);
    c = read_file(f, &len);
    if (!c) return 0;
    fresh = (strstr(c, "\"used\":1") == NULL);
    free(c);
    return fresh;
}

/* 把密钥标记成已用，写上使用者 uid */
static int invite_consume(const char *code, const char *uid)
{
    char f[700], body[512], esc[128];
    long long created = 0;
    size_t len = 0;
    char *c;

    json_escape(uid, strlen(uid), esc, sizeof esc);
    invite_path(code, f, sizeof f);

    /* 保留原来的签发时间，别被这次写入冲掉 */
    c = read_file(f, &len);
    if (c) {
        char *p = strstr(c, "\"created\":");
        if (p) created = atoll(p + 10);
        free(c);
    }
    snprintf(body, sizeof body,
             "{\"code\":\"%s\",\"uid\":\"%s\",\"used\":1,"
             "\"created\":%lld,\"usedAt\":%lld}\n",
             code, esc, created, now_sec());
    return write_file_atomic(f, body, strlen(body));
}

static int invite_create(char *out, size_t outsz)
{
    char code[64], f[700], body[512];
    int tries;

    for (tries = 0; tries < 8; tries++) {
        gen_invite_code(code, sizeof code);
        if (!code[0]) return -1;
        invite_path(code, f, sizeof f);
        if (file_exists(f)) continue;                  /* 撞了就重来 */
        snprintf(body, sizeof body,
                 "{\"code\":\"%s\",\"uid\":\"\",\"used\":0,\"created\":%lld}\n",
                 code, now_sec());
        if (write_file_atomic(f, body, strlen(body)) != 0) return -1;
        snprintf(out, outsz, "%s", code);
        return 0;
    }
    return -1;
}

/* ---------- 玩家会话 ---------- */
static int current_user(const req_t *r, char *uid, size_t usz)
{
    char tok[512];
    if (cookie_get(r->cookie, "guid", tok, sizeof tok) != 0) return 0;
    if (!check_token("user", tok, uid, usz, NULL)) return 0;
    if (!valid_pid(uid)) return 0;
    return 1;
}

static void send_user_cookie(int fd, const char *uid, char *hdr, size_t hdrsz)
{
    char tok[512];
    make_token("user", uid, now_sec() + USER_TTL, tok, sizeof tok);
    snprintf(hdr, hdrsz,
             "Set-Cookie: guid=%s; Path=/; Max-Age=%lld; HttpOnly; SameSite=Lax\r\n"
             "Cache-Control: no-store\r\n",
             tok, (long long)USER_TTL);
}

/* 老玩家（还带着旧 gpid）注册时，把他在本机攒的存档搬进新账号 */
static void adopt_legacy_save(const req_t *r, const char *uid)
{
    char tok[512], pid[128], from[700], to[700];
    size_t len = 0;
    char *d;

    if (cookie_get(r->cookie, "gpid", tok, sizeof tok) != 0) return;
    if (!check_token("pid", tok, pid, sizeof pid, NULL)) return;
    if (!valid_pid(pid)) return;

    snprintf(to, sizeof to, "%s/%s.json", g_saves_dir, uid);
    if (file_exists(to)) return;                       /* 新号已有存档就别覆盖 */
    snprintf(from, sizeof from, "%s/%s.json", g_saves_dir, pid);
    d = read_file(from, &len);
    if (!d) return;
    write_file_atomic(to, d, len);
    free(d);
}

/* POST /api/register  表单：name, pass, code */
static int api_register(int fd, const req_t *r)
{
    char name[128], pass[256], code[64], uid[64], hdr[800], out[900];
    char name_esc[400];
    int rc;

    if (form_get(r->body, r->bodylen, "name", name, sizeof name) != 0 ||
        form_get(r->body, r->bodylen, "pass", pass, sizeof pass) != 0) {
        send_json(fd, 400, "{\"ok\":false,\"err\":\"missing\",\"msg\":\"请填写用户名和密码\"}");
        return 400;
    }
    if (form_get(r->body, r->bodylen, "code", code, sizeof code) != 0)
        code[0] = '\0';

    if (!valid_username(name)) {
        send_json(fd, 400, "{\"ok\":false,\"err\":\"bad-name\","
                           "\"msg\":\"用户名 2~32 位，只能用字母、数字、下划线、连字符或中文\"}");
        return 400;
    }
    if (!valid_password(pass)) {
        send_json(fd, 400, "{\"ok\":false,\"err\":\"bad-pass\","
                           "\"msg\":\"密码至少 6 位\"}");
        return 400;
    }
    if (!invite_is_fresh(code)) {
        send_json(fd, 403, "{\"ok\":false,\"err\":\"bad-code\","
                           "\"msg\":\"密钥无效或已经被用过了\"}");
        return 403;
    }

    rc = user_create(name, pass, uid, sizeof uid, NULL, 0);
    if (rc == -2) {
        send_json(fd, 409, "{\"ok\":false,\"err\":\"taken\",\"msg\":\"这个名字已经有人用了\"}");
        return 409;
    }
    if (rc != 0) {
        send_json(fd, 500, "{\"ok\":false,\"err\":\"write\",\"msg\":\"写入失败\"}");
        return 500;
    }
    invite_consume(code, uid);
    adopt_legacy_save(r, uid);
    send_user_cookie(fd, uid, hdr, sizeof hdr);

    json_escape(name, strlen(name), name_esc, sizeof name_esc);
    snprintf(out, sizeof out, "{\"ok\":true,\"name\":\"%s\"}", name_esc);
    send_body(fd, 200, "application/json; charset=utf-8", out, strlen(out), hdr);
    return 200;
}

/* POST /api/player/login  表单：name, pass */
static int api_player_login(int fd, const req_t *r)
{
    char name[128], pass[256], uid[64], hdr[800], out[900], name_esc[400];

    if (form_get(r->body, r->bodylen, "name", name, sizeof name) != 0 ||
        form_get(r->body, r->bodylen, "pass", pass, sizeof pass) != 0) {
        send_json(fd, 400, "{\"ok\":false,\"err\":\"missing\",\"msg\":\"请填写用户名和密码\"}");
        return 400;
    }
    if (user_auth(name, pass, uid, sizeof uid) != 0) {
        send_json(fd, 401, "{\"ok\":false,\"err\":\"bad-login\",\"msg\":\"用户名或密码不对\"}");
        return 401;
    }
    send_user_cookie(fd, uid, hdr, sizeof hdr);
    if (!user_read_name(uid, name_esc, sizeof name_esc))
        snprintf(name_esc, sizeof name_esc, "%s", name);
    {
        char esc[400];
        json_escape(name_esc, strlen(name_esc), esc, sizeof esc);
        snprintf(out, sizeof out, "{\"ok\":true,\"name\":\"%s\"}", esc);
    }
    send_body(fd, 200, "application/json; charset=utf-8", out, strlen(out), hdr);
    return 200;
}

/* GET /api/me —— 没登录就 ok:false，前端据此弹门禁 */
static void api_me(int fd, const req_t *r)
{
    char uid[64], name[128], esc[400], out[700];

    if (!current_user(r, uid, sizeof uid)) {
        send_json(fd, 200, "{\"ok\":true,\"signedIn\":false}");
        return;
    }
    if (!user_read_name(uid, name, sizeof name))
        snprintf(name, sizeof name, "%s", uid);
    json_escape(name, strlen(name), esc, sizeof esc);
    snprintf(out, sizeof out, "{\"ok\":true,\"signedIn\":true,\"name\":\"%s\",\"uid\":\"%s\"}",
             esc, uid);
    send_json(fd, 200, out);
}

/* ---------- 存档 ---------- */
static int api_get_save(int fd, const req_t *r)
{
    char pid[128], file[700];

    if (!current_user(r, pid, sizeof pid)) {
        send_json(fd, 401, "{\"ok\":false,\"err\":\"no-account\",\"msg\":\"请先注册或登录\"}");
        return 401;
    }
    {
        size_t len = 0;
        char *d;
        snprintf(file, sizeof file, "%s/%s.json", g_saves_dir, pid);
        d = read_file(file, &len);
        if (d) {
            char *out = (char *)xmalloc(len + 64);
            sprintf(out, "{\"ok\":true,\"save\":%s}", d);
            send_json(fd, 200, out);
            free(out);
            free(d);
            return 200;
        }
        send_json(fd, 200, "{\"ok\":true,\"save\":null}");
        return 200;
    }

    return 200;
}

static int api_put_save(int fd, const req_t *r)
{
    char pid[128], file[700];

    if (!current_user(r, pid, sizeof pid)) {
        send_json(fd, 401, "{\"ok\":false,\"err\":\"no-account\",\"msg\":\"请先注册或登录\"}");
        return 401;
    }
    if (!r->body || r->bodylen == 0) {
        send_json(fd, 400, "{\"ok\":false,\"err\":\"empty\"}");
        return 400;
    }
    if (!json_quick_check(r->body, r->bodylen)) {
        send_json(fd, 400, "{\"ok\":false,\"err\":\"bad-json\"}");
        return 400;
    }
    snprintf(file, sizeof file, "%s/%s.json", g_saves_dir, pid);
    if (write_file_atomic(file, r->body, r->bodylen) != 0) {
        send_json(fd, 500, "{\"ok\":false,\"err\":\"write\"}");
        return 500;
    }
    {
        char out[128];
        snprintf(out, sizeof out, "{\"ok\":true,\"bytes\":%lu}", (unsigned long)r->bodylen);
        send_json(fd, 200, out);
    }
    return 200;
}

/* ---------- 后台 API ---------- */
/* 把存档原文安全地塞进 JSON 字符串（用于传输，前端再 JSON.parse） */
static void api_admin_saves(int fd)
{
    DIR *dir;
    struct dirent *de;
    char *out;
    size_t cap = 8192, used = 0;
    int count = 0;

    out = (char *)xmalloc(cap);
    used += (size_t)snprintf(out + used, cap - used, "{\"ok\":true,\"players\":[");

    dir = opendir(g_saves_dir);
    if (dir) {
        while ((de = readdir(dir)) != NULL) {
            size_t nlen = strlen(de->d_name);
            char pid[128], file[700];
            size_t len = 0;
            char *d;

            if (nlen < 6 || strcmp(de->d_name + nlen - 5, ".json") != 0) continue;
            if (nlen - 5 >= sizeof pid) continue;
            memcpy(pid, de->d_name, nlen - 5);
            pid[nlen - 5] = '\0';
            if (!valid_pid(pid)) continue;

            snprintf(file, sizeof file, "%s/%s", g_saves_dir, de->d_name);
            d = read_file(file, &len);
            if (!d) continue;

            if (count >= 200) { free(d); break; }   /* 上限，避免大响应 */

            {
                char *esc = (char *)xmalloc(len * 6 + 16);
                struct stat st;
                stat(file, &st);
                json_escape(d, len, esc, len * 6 + 16);

                for (;;) {
                    size_t need = strlen(esc) + 256;
                    if (used + need < cap) break;
                    cap *= 2;
                    out = (char *)xrealloc(out, cap);
                }
                used += (size_t)snprintf(out + used, cap - used,
                    "%s{\"id\":\"%s\",\"bytes\":%ld,\"raw\":\"%s\"}",
                    count ? "," : "", pid, (long)st.st_size, esc);
                free(esc);
            }
            free(d);
            count++;
        }
        closedir(dir);
    }
    used += (size_t)snprintf(out + used, cap - used, "],\"count\":%d}", count);
    send_json(fd, 200, out);
    free(out);
}

static void api_admin_overview(int fd)
{
    DIR *dir;
    struct dirent *de;
    long players = 0, total_bytes = 0, total_pulls = 0;
    char out[2048];
    long long now = now_sec();
    long max_pulls = 0;
    char newest_pid[128] = "";

    dir = opendir(g_saves_dir);
    if (dir) {
        while ((de = readdir(dir)) != NULL) {
            size_t nlen = strlen(de->d_name);
            char file[700];
            struct stat st;
            if (nlen < 6 || strcmp(de->d_name + nlen - 5, ".json") != 0) continue;
            snprintf(file, sizeof file, "%s/%s", g_saves_dir, de->d_name);
            if (stat(file, &st) != 0) continue;
            players++;
            total_bytes += (long)st.st_size;
            {
                size_t len = 0;
                char *d = read_file(file, &len);
                if (d) {
                    char *p = strstr(d, "\"total\":");
                    if (p) {
                        long v = strtol(p + 8, NULL, 10);
                        total_pulls += v;
                        if (v > max_pulls) {
                            max_pulls = v;
                            if (nlen - 5 < sizeof newest_pid) {
                                memcpy(newest_pid, de->d_name, nlen - 5);
                                newest_pid[nlen - 5] = '\0';
                            }
                        }
                    }
                    free(d);
                }
            }
        }
        closedir(dir);
    }

    snprintf(out, sizeof out,
             "{\"ok\":true,\"players\":%ld,\"bytes\":%ld,\"pulls\":%ld,"
             "\"serverTime\":%lld,\"port\":%d,\"uptimeSec\":%lld,"
             "\"www\":\"%s\",\"data\":\"%s\","
             "\"topPid\":\"%s\",\"topPulls\":%ld}",
             players, total_bytes, total_pulls, now, g_port,
             g_start_time ? now - g_start_time : 0,
             g_www, g_data, newest_pid, max_pulls);
    send_json(fd, 200, out);
}


/* ---------- 后台：账号与密钥 ---------- */

/* 从用户记录里抠出 created 字段 */
static long long user_created(const char *uid)
{
    char f[700], *c, *p;
    size_t len = 0;
    long long v = 0;
    user_path(uid, f, sizeof f);
    c = read_file(f, &len);
    if (!c) return 0;
    p = strstr(c, "\"created\":");
    if (p) v = atoll(p + 10);
    free(c);
    return v;
}

/* 账号列表：用户名、注册时间、存档体积、抽数、最后活动 */
static void api_admin_users(int fd)
{
    DIR *dir;
    struct dirent *de;
    char *out;
    size_t cap = 65536, used = 0;
    int n = 0;

    out = (char *)xmalloc(cap);
    used += (size_t)snprintf(out + used, cap - used, "{\"ok\":true,\"users\":[");

    dir = opendir(g_users_dir);
    if (dir) {
        while ((de = readdir(dir)) != NULL) {
            char uid[64], name[128], esc[400], sf[700];
            char *dot;
            size_t nlen = strlen(de->d_name);
            struct stat st;
            long long bytes = 0, mtime = 0, pulls = 0;

            if (de->d_name[0] == '.' || nlen < 8) continue;
            dot = strrchr(de->d_name, '.');
            if (!dot || strcmp(dot, ".json") != 0) continue;
            snprintf(uid, sizeof uid, "%.*s", (int)(dot - de->d_name), de->d_name);

            if (!user_read_name(uid, name, sizeof name))
                snprintf(name, sizeof name, "%s", uid);
            json_escape(name, strlen(name), esc, sizeof esc);

            snprintf(sf, sizeof sf, "%s/%s.json", g_saves_dir, uid);
            if (stat(sf, &st) == 0) {
                size_t slen = 0;
                char *sd = read_file(sf, &slen);
                bytes = (long long)st.st_size;
                mtime = (long long)st.st_mtime;
                if (sd) {
                    /* 前端存档里总抽数字段叫 total，不叫 pulls */
                    char *pp = strstr(sd, "\"total\":");
                    if (pp) pulls = atoll(pp + 8);
                    free(sd);
                }
            }

            if (n) used += (size_t)snprintf(out + used, cap - used, ",");
            used += (size_t)snprintf(out + used, cap - used,
                "{\"uid\":\"%s\",\"name\":\"%s\",\"created\":%lld,"
                "\"bytes\":%lld,\"pulls\":%lld,\"mtime\":%lld}",
                uid, esc, user_created(uid), bytes, pulls, mtime);
            n++;
            if (used > cap - 2048) break;
        }
        closedir(dir);
    }
    used += (size_t)snprintf(out + used, cap - used, "],\"count\":%d}", n);
    send_json(fd, 200, out);
    free(out);
}

static int api_admin_user_delete(int fd, const req_t *r)
{
    char uid[128], uf[700], sf[700];

    if (form_get(r->body, r->bodylen, "uid", uid, sizeof uid) != 0 || !uid[0] ||
        !valid_pid(uid)) {
        send_json(fd, 400, "{\"ok\":false,\"err\":\"bad-uid\",\"msg\":\"账号标识不合法\"}");
        return 400;
    }
    user_path(uid, uf, sizeof uf);
    if (unlink(uf) != 0) {
        send_json(fd, 404, "{\"ok\":false,\"err\":\"not-found\",\"msg\":\"账号不存在\"}");
        return 404;
    }
    snprintf(sf, sizeof sf, "%s/%s.json", g_saves_dir, uid);
    unlink(sf);
    send_json(fd, 200, "{\"ok\":true,\"deleted\":true}");
    return 200;
}

/* 密钥列表：默认只回还没用过的，加 all=1 连已用的也回 */
static void api_admin_invites(int fd)
{
    DIR *dir;
    struct dirent *de;
    char idir[600];
    char *out;
    size_t cap = 32768, used = 0;
    int n = 0, fresh = 0;

    snprintf(idir, sizeof idir, "%s/invites", g_data);
    out = (char *)xmalloc(cap);
    used += (size_t)snprintf(out + used, cap - used, "{\"ok\":true,\"invites\":[");

    dir = opendir(idir);
    if (dir) {
        while ((de = readdir(dir)) != NULL) {
            char f[700], *c, *dot;
            size_t len = 0, nlen = strlen(de->d_name);
            int usedflag = 0;
            long long created = 0, usedAt = 0;
            char useduid[64] = "";

            if (de->d_name[0] == '.' || nlen < 8) continue;
            dot = strrchr(de->d_name, '.');
            if (!dot || strcmp(dot, ".json") != 0) continue;

            snprintf(f, sizeof f, "%s/%s", idir, de->d_name);
            c = read_file(f, &len);
            if (!c) continue;
            {
                char *p;
                if (strstr(c, "\"used\":1")) usedflag = 1;
                p = strstr(c, "\"created\":"); if (p) created = atoll(p + 10);
                p = strstr(c, "\"usedAt\":");  if (p) usedAt  = atoll(p + 9);
                p = strstr(c, "\"uid\":\"");
                if (p) {
                    size_t i = 0;
                    p += 7;
                    while (p[i] && p[i] != '"' && i + 1 < sizeof useduid) { useduid[i] = p[i]; i++; }
                    useduid[i] = '\0';
                }
            }
            free(c);

            /* 没用的排前面：单独的 fresh 列表让前端好摆 */
            if (!usedflag) fresh++;
            if (n) used += (size_t)snprintf(out + used, cap - used, ",");
            used += (size_t)snprintf(out + used, cap - used,
                "{\"code\":\"%.*s\",\"used\":%d,\"uid\":\"%s\","
                "\"created\":%lld,\"usedAt\":%lld}",
                (int)(dot - de->d_name), de->d_name, usedflag, useduid, created, usedAt);
            n++;
            if (used > cap - 1024) break;
        }
        closedir(dir);
    }
    used += (size_t)snprintf(out + used, cap - used,
                             "],\"count\":%d,\"fresh\":%d}", n, fresh);
    send_json(fd, 200, out);
    free(out);
}

static int api_admin_invite_new(int fd, const req_t *r)
{
    char code[64], out[200];
    (void)r;
    if (invite_create(code, sizeof code) != 0) {
        send_json(fd, 500, "{\"ok\":false,\"err\":\"write\",\"msg\":\"生成失败\"}");
        return 500;
    }
    snprintf(out, sizeof out, "{\"ok\":true,\"code\":\"%s\"}", code);
    send_json(fd, 200, out);
    return 200;
}

static int api_admin_invite_delete(int fd, const req_t *r)
{
    char code[64], f[700];

    if (form_get(r->body, r->bodylen, "code", code, sizeof code) != 0 ||
        !valid_invite_code(code)) {
        send_json(fd, 400, "{\"ok\":false,\"err\":\"bad-code\"}");
        return 400;
    }
    invite_path(code, f, sizeof f);
    if (unlink(f) != 0) {
        send_json(fd, 404, "{\"ok\":false,\"err\":\"not-found\"}");
        return 404;
    }
    send_json(fd, 200, "{\"ok\":true,\"deleted\":true}");
    return 200;
}

/* 删除单个玩家存档；pid 必须通过 valid_pid，杜绝路径穿越 */
static int api_admin_delete(int fd, const req_t *r)
{
    char pid[128], file[700];

    if (form_get(r->body, r->bodylen, "pid", pid, sizeof pid) != 0 || !pid[0]) {
        send_json(fd, 400, "{\"ok\":false,\"err\":\"no-pid\",\"msg\":\"缺少 pid\"}");
        return 400;
    }
    if (!valid_pid(pid)) {
        send_json(fd, 400, "{\"ok\":false,\"err\":\"bad-pid\",\"msg\":\"pid 不合法\"}");
        return 400;
    }
    snprintf(file, sizeof file, "%s/%s.json", g_saves_dir, pid);
    if (unlink(file) != 0) {
        send_json(fd, 404, "{\"ok\":false,\"err\":\"not-found\",\"msg\":\"存档不存在\"}");
        return 404;
    }
    send_json(fd, 200, "{\"ok\":true,\"deleted\":true}");
    return 200;
}

static void api_admin_logs(int fd)
{
    size_t len = 0;
    char *c = read_file(g_log_file, &len);
    char *out;
    size_t used = 0, cap;
    int n = 0;
    char *p;

    if (!c) { send_json(fd, 200, "{\"ok\":true,\"logs\":[]}"); return; }

    /* 只保留最后 200 行 */
    {
        int lines = 0;
        for (p = c; *p; p++) if (*p == '\n') lines++;
        p = c;
        while (lines > 200 && *p) { if (*p == '\n') lines--; p++; }
        if (lines > 200) p = c;
    }

    cap = strlen(p) * 6 + 256;
    out = (char *)xmalloc(cap);
    used += (size_t)snprintf(out + used, cap - used, "{\"ok\":true,\"logs\":[");
    while (p && *p) {
        char *nl = strchr(p, '\n');
        char *esc;
        if (nl) *nl = '\0';
        if (*p) {
            esc = (char *)xmalloc(strlen(p) * 6 + 16);
            json_escape(p, strlen(p), esc, strlen(p) * 6 + 16);
            if (used + strlen(esc) + 32 < cap)
                used += (size_t)snprintf(out + used, cap - used, "%s\"%s\"", n ? "," : "", esc);
            free(esc);
            n++;
        }
        p = nl ? nl + 1 : NULL;
    }
    used += (size_t)snprintf(out + used, cap - used, "]}");
    send_json(fd, 200, out);
    free(out);
    free(c);
}

/* ---------- 硬重启 ----------
 *
 * 后台点「重启网站」时走这里。语义是「把所有人连同我自己一起端掉，重新来过」：
 *
 *   1. 请求子进程先把 200 响应推出去、关掉连接，客户端不会看到半截请求；
 *   2. fork 出一个「使者」进程，它 setsid() 另立门户，脱离旧进程组；
 *   3. 使者把整个旧进程组一次性 SIGTERM —— 监听进程和所有正在处理请求的子
 *      进程全部断掉，也就是「全部人的连接直接掐断」；
 *   4. 等旧组彻底消失、端口让出来，使者再拉起新的服务端：有 start.sh 就交给
 *      它（顺带轮转日志），没有就自己 execv 重新执行。
 *
 * 不依赖外部守护进程，也不需要 systemd/openrc。
 */
static void restart_self(void)
{
    pid_t listener = getppid();
    pid_t old_pg   = getpgrp();
    pid_t d;

    d = fork();
    if (d < 0) return;      /* fork 不出来就算了，服务照常跑 */
    if (d > 0) return;      /* 原请求子进程继续收尾 */

    /* --- 以下只在使者进程里执行 --- */
    alarm(0);               /* 取消继承来的连接超时闹钟 */
    setsid();               /* 另立进程组，免得被下面那一刀顺手带走 */

    /* 给请求子进程 0.3 秒，把响应和 access.log 收干净 */
    usleep(300000);

    /* 整组端掉：监听进程 + 所有正在处理的连接 */
    killpg(old_pg, SIGTERM);
    if (listener > 1) kill(listener, SIGTERM);

    /* 最多等 5 秒，直到旧进程组真的消失、端口让出来 */
    for (int i = 0; i < 50; i++) {
        if (killpg(old_pg, 0) != 0 && errno == ESRCH) break;
        usleep(100000);
    }

    /* 首选 start.sh：它顺带轮转日志，并按老规矩 setsid 拉起新进程 */
    if (g_home[0]) {
        char script[4200];
        snprintf(script, sizeof script, "%s/start.sh", g_home);
        if (access(script, X_OK) == 0)
            execl("/bin/sh", "sh", script, (char *)NULL);
    }

    if (g_argv0) {
        char *av[2];
        char exe[4096];
        ssize_t n;

        av[0] = g_argv0;
        av[1] = NULL;

        /* 先读出 /proc/self/exe 的真实路径再 execv。
         * 直接把 "/proc/self/exe" 交给 execv 也能起来，但内核会把进程名取成
         * "exe"，之后 pkill -x gachad / pgrep -x gachad 就找不到它了。 */
        n = readlink("/proc/self/exe", exe, sizeof exe - 1);
        if (n > 0) {
            exe[n] = '\0';
            execv(exe, av);
        }
        execv(g_argv0, av);            /* 兜底：按原来启动时的路径 */
    }

    _exit(127);          /* 走到这里说明所有重启手段都失败了 */
}

static int api_admin_restart(int fd, const req_t *r)
{
    (void)r;
    send_json(fd, 200, "{\"ok\":true,\"restarting\":true}");
    shutdown(fd, SHUT_WR);   /* 立刻把响应推给客户端，不等进程收尾 */
    restart_self();
    return 200;
}

/* ---------- 路由 ---------- */
static void handle(int fd, req_t *r, const char *ip)
{
    int is_get = !strcasecmp(r->method, "GET");
    int is_post = !strcasecmp(r->method, "POST");
    char tok[512], id[128];
    int authed;

    authed = cookie_get(r->cookie, "gsid", tok, sizeof tok) == 0 &&
             check_token("admin", tok, id, sizeof id, NULL);

    /* --- 健康检查 --- */
    if (is_get && !strcmp(r->path, "/api/health")) {
        char out[128];
        snprintf(out, sizeof out, "{\"ok\":true,\"t\":%lld,\"boot\":%lld}",
                 now_sec(), g_boot_id);
        access_log(ip, r->method, r->path, 200);
        send_json(fd, 200, out);
        return;
    }

    /* --- 登录 --- */
    if (is_post && !strcmp(r->path, "/api/login")) {
        char key[256];
        if (login_fails_recent(ip) >= LOGIN_MAXFAIL) {
            access_log(ip, r->method, r->path, 429);
            send_json(fd, 429, "{\"ok\":false,\"err\":\"too-many\",\"msg\":\"尝试过于频繁，请稍后再试\"}");
            return;
        }
        if (form_get(r->body, r->bodylen, "key", key, sizeof key) != 0 || !key[0]) {
            access_log(ip, r->method, r->path, 400);
            send_json(fd, 400, "{\"ok\":false,\"err\":\"no-key\"}");
            return;
        }
        if (!admin_key_check(key)) {
            login_fail_record(ip);
            access_log(ip, r->method, r->path, 401);
            send_json(fd, 401, "{\"ok\":false,\"err\":\"bad-key\",\"msg\":\"密钥不正确\"}");
            return;
        }
        make_token("admin", "root", now_sec() + SESS_TTL, tok, sizeof tok);
        {
            char hdr[800];
            snprintf(hdr, sizeof hdr,
                     "Set-Cookie: gsid=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Strict\r\n"
                     "Cache-Control: no-store\r\n",
                     tok, SESS_TTL);
            access_log(ip, r->method, r->path, 200);
            send_body(fd, 200, "application/json; charset=utf-8",
                      "{\"ok\":true}", 11, hdr);
        }
        return;
    }

    if (is_post && !strcmp(r->path, "/api/register")) {
        int rc = api_register(fd, r);
        access_log(ip, r->method, r->path, rc);
        return;
    }
    if (is_post && !strcmp(r->path, "/api/player/login")) {
        int rc = api_player_login(fd, r);
        access_log(ip, r->method, r->path, rc);
        return;
    }
    if (is_post && !strcmp(r->path, "/api/player/logout")) {
        access_log(ip, r->method, r->path, 200);
        send_body(fd, 200, "application/json; charset=utf-8",
                  "{\"ok\":true}", 11,
                  "Set-Cookie: guid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax\r\n"
                  "Cache-Control: no-store\r\n");
        return;
    }
    if (is_get && !strcmp(r->path, "/api/me")) {
        access_log(ip, r->method, r->path, 200);
        api_me(fd, r);
        return;
    }
    if (is_post && !strcmp(r->path, "/api/logout")) {
        access_log(ip, r->method, r->path, 200);
        send_body(fd, 200, "application/json; charset=utf-8",
                  "{\"ok\":true}", 11,
                  "Set-Cookie: gsid=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict\r\n"
                  "Cache-Control: no-store\r\n");
        return;
    }

    if (is_get && !strcmp(r->path, "/api/session")) {
        char out[64];
        snprintf(out, sizeof out, "{\"ok\":true,\"admin\":%s}", authed ? "true" : "false");
        access_log(ip, r->method, r->path, 200);
        send_json(fd, 200, out);
        return;
    }

    /* --- 存档 --- */
    if (is_get && !strcmp(r->path, "/api/save")) {
        int code = api_get_save(fd, r);
        access_log(ip, r->method, r->path, code);
        return;
    }
    if (is_post && !strcmp(r->path, "/api/save")) {
        int code = api_put_save(fd, r);
        access_log(ip, r->method, r->path, code);
        return;
    }

    /* --- 后台 --- */
    if (!strcmp(r->path, "/api/admin/overview") ||
        !strcmp(r->path, "/api/admin/saves") ||
        !strcmp(r->path, "/api/admin/logs") ||
        !strcmp(r->path, "/api/admin/delete") ||
        !strcmp(r->path, "/api/admin/users") ||
        !strcmp(r->path, "/api/admin/user/delete") ||
        !strcmp(r->path, "/api/admin/invites") ||
        !strcmp(r->path, "/api/admin/invite/new") ||
        !strcmp(r->path, "/api/admin/invite/delete") ||
        !strcmp(r->path, "/api/admin/restart")) {
        if (!authed) {
            access_log(ip, r->method, r->path, 401);
            send_json(fd, 401, "{\"ok\":false,\"err\":\"unauthorized\"}");
            return;
        }
        /* 这两个是写操作，必须是 POST */
        if (!strcmp(r->path, "/api/admin/delete") ||
            !strcmp(r->path, "/api/admin/user/delete") ||
            !strcmp(r->path, "/api/admin/invite/new") ||
            !strcmp(r->path, "/api/admin/invite/delete") ||
            !strcmp(r->path, "/api/admin/restart")) {
            int code;
            if (!is_post) {
                access_log(ip, r->method, r->path, 405);
                send_text(fd, 405, "405 Method Not Allowed");
                return;
            }
            if (!strcmp(r->path, "/api/admin/delete"))            code = api_admin_delete(fd, r);
            else if (!strcmp(r->path, "/api/admin/user/delete"))  code = api_admin_user_delete(fd, r);
            else if (!strcmp(r->path, "/api/admin/invite/new"))   code = api_admin_invite_new(fd, r);
            else if (!strcmp(r->path, "/api/admin/invite/delete")) code = api_admin_invite_delete(fd, r);
            else                                                  code = api_admin_restart(fd, r);
            access_log(ip, r->method, r->path, code);
            return;
        }
        access_log(ip, r->method, r->path, 200);
        if (!strcmp(r->path, "/api/admin/overview")) api_admin_overview(fd);
        else if (!strcmp(r->path, "/api/admin/saves")) api_admin_saves(fd);
        else if (!strcmp(r->path, "/api/admin/users")) api_admin_users(fd);
        else if (!strcmp(r->path, "/api/admin/invites")) api_admin_invites(fd);
        else api_admin_logs(fd);
        return;
    }

    if (r->path[0] == '/' && strncmp(r->path, "/api/", 5) == 0) {
        access_log(ip, r->method, r->path, 404);
        send_json(fd, 404, "{\"ok\":false,\"err\":\"no-such-api\"}");
        return;
    }

    if (!is_get) {
        access_log(ip, r->method, r->path, 405);
        send_text(fd, 405, "405 Method Not Allowed");
        return;
    }

    {
        int code = serve_static(fd, r->path, r->range);
        access_log(ip, r->method, r->path, code);
    }
}

/* ---------- 秘密与会话密钥 ---------- */
static int secret_load_or_create(void)
{
    size_t len = 0;
    char *c = read_file(g_secret_file, &len);

    if (c && len >= 128) {
        char *nl = strchr(c, '\n');
        if (nl) *nl = '\0';
        if (from_hex(c, g_secret, sizeof g_secret) == 0) { free(c); return 0; }
    }
    if (c) free(c);

    if (rand_bytes(g_secret, sizeof g_secret) != 0) return -1;
    {
        char hex[129];
        to_hex(g_secret, sizeof g_secret, hex);
        strcat(hex, "\n");
        if (write_file_atomic(g_secret_file, hex, strlen(hex)) != 0) return -1;
    }
    return 0;
}

/* ---------- main ---------- */
int main(int argc, char **argv)
{
    int listen_fd, opt = 1;
    struct sockaddr_in addr;
    const char *e;

    g_argv0 = argv[0];   /* 自我重启时要靠它把服务端重新拉起来 */

    /* 程序所在目录：重启时按这个路径去找 start.sh。
     * argv[0] 常常是 "./gachad" 这种相对写法，靠不住，所以优先用
     * /proc/self/exe 解析出的真实路径。 */
    {
        char exe[4096];
        ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1);
        char *slash;
        if (n > 0) {
            exe[n] = '\0';
            slash = strrchr(exe, '/');
            if (slash) *slash = '\0';
            snprintf(g_home, sizeof g_home, "%s", exe);
        } else {
            snprintf(g_home, sizeof g_home, "%s", argv[0]);
            slash = strrchr(g_home, '/');
            if (slash) *slash = '\0';
            else snprintf(g_home, sizeof g_home, ".");
        }
    }

    if ((e = getenv("GACHA_PORT")) != NULL) g_port = atoi(e);
    if ((e = getenv("GACHA_WWW"))  != NULL) g_www  = e;
    if ((e = getenv("GACHA_DATA")) != NULL) g_data = e;
    if ((e = getenv("GACHA_TRUST_PROXY")) != NULL && *e && strcmp(e, "0") != 0)
        g_trust_proxy = 1;
    if (g_port <= 0 || g_port > 65535) g_port = 8080;
    g_start_time = now_sec();
    {
        struct timeval tv;
        if (gettimeofday(&tv, NULL) == 0)
            g_boot_id = (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
        else
            g_boot_id = g_start_time * 1000;
    }

    snprintf(g_saves_dir,  sizeof g_saves_dir,  "%s/saves",      g_data);
    snprintf(g_users_dir,  sizeof g_users_dir,  "%s/users",      g_data);
    snprintf(g_admin_file, sizeof g_admin_file, "%s/admin.pass", g_data);
    snprintf(g_secret_file,sizeof g_secret_file,"%s/session.key",g_data);
    snprintf(g_log_file,   sizeof g_log_file,   "%s/access.log", g_data);
    snprintf(g_fail_file,  sizeof g_fail_file,  "%s/fails.log",  g_data);

    if (argc > 1 && !strcmp(argv[1], "initkey")) {
        if (argc < 3) { fprintf(stderr, "用法: gachad initkey <cred>\n"
                                        "  cred = 浏览器端算出的 SHA-256 摘要，即：\n"
                                        "  printf '%%s' '明文密钥' | sha256sum | awk '{print $1}'\n"); return 2; }
        mkdir_p(g_data, 0750);
        if (secret_load_or_create() != 0) { fprintf(stderr, "无法生成会话密钥\n"); return 1; }
        if (admin_key_init(argv[2]) != 0) { fprintf(stderr, "无法写入密钥文件\n"); return 1; }
        printf("已写入 %s（%d 轮 PBKDF2）\n", g_admin_file, PBKDF2_ITERS);
        return 0;
    }

    if (mkdir_p(g_data, 0750) != 0) { perror("mkdir data"); return 1; }
    if (mkdir_p(g_saves_dir, 0750) != 0) { perror("mkdir saves"); return 1; }
    if (mkdir_p(g_users_dir, 0750) != 0) { perror("mkdir users"); return 1; }
    {
        char idir[600];
        snprintf(idir, sizeof idir, "%s/invites", g_data);
        if (mkdir_p(idir, 0750) != 0) { perror("mkdir invites"); return 1; }
    }
    if (secret_load_or_create() != 0) { perror("secret"); return 1; }
    if (!file_exists(g_admin_file)) {
        fprintf(stderr, "警告: %s 不存在，后台无法登录。请先执行: gachad initkey <密钥>\n",
                g_admin_file);
    }

    signal(SIGCHLD, SIG_IGN);
    signal(SIGPIPE, SIG_IGN);

    listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd < 0) { perror("socket"); return 1; }
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof opt);

    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons((uint16_t)g_port);

    /* 重启时旧进程可能还没把端口完全让出来，重试几次再放弃 */
    {
        int bound = 0;
        for (int i = 0; i < 10; i++) {
            if (bind(listen_fd, (struct sockaddr *)&addr, sizeof addr) == 0) { bound = 1; break; }
            if (errno != EADDRINUSE) break;
            usleep(300000);
        }
        if (!bound) { perror("bind"); return 1; }
    }
    if (listen(listen_fd, 64) != 0) { perror("listen"); return 1; }

    fprintf(stderr, "gachad 已启动: 端口 %d, www=%s, data=%s\n", g_port, g_www, g_data);

    for (;;) {
        struct sockaddr_in peer;
        socklen_t plen = sizeof peer;
        int cfd = accept(listen_fd, (struct sockaddr *)&peer, &plen);
        char ip[64];

        if (cfd < 0) {
            if (errno == EINTR || errno == ECONNABORTED) continue;
            if (errno == EMFILE || errno == ENFILE) { sleep(1); continue; }
            break;
        }

        snprintf(ip, sizeof ip, "%s", inet_ntoa(peer.sin_addr));

        if (fork() == 0) {
            req_t r;
            int rc;
            close(listen_fd);
            alarm(CONN_TIMEOUT);
            rc = read_request(cfd, &r);
            /* 前面有反代（Cloudflare）时用它报的真实 IP，日志和限速才不会把所有人
               当成同一台机器。但只在两个条件同时成立时才采信：
                 ① GACHA_TRUST_PROXY 开着；
                 ② 这条连接确实来自 Cloudflare 的回源段。
               所以直连 38080 的人伪造 CF-Connecting-IP 也没用 —— 对端 IP 不是 CF，
               头会被直接丢掉。 */
            if (rc == 0 && g_trust_proxy && is_cloudflare_ip(ip) && plausible_ip(r.fwd_ip))
                snprintf(ip, sizeof ip, "%s", r.fwd_ip);
            if (rc == 0) handle(cfd, &r, ip);
            else if (rc == -2) send_text(cfd, 413, "413 Payload Too Large");
            else if (rc == -3) send_text(cfd, 400, "400 Bad Request");
            req_free(&r);
            shutdown(cfd, SHUT_WR);
            close(cfd);
            _exit(0);
        }
        close(cfd);
    }

    close(listen_fd);
    return 0;
}
