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
#define PBKDF2_ITERS  120000
#define LOGIN_WINDOW  600
#define LOGIN_MAXFAIL 5
#define CONN_TIMEOUT  25

static const char *g_www  = "/opt/gacha/www";
static const char *g_data = "/opt/gacha/data";
static int         g_port = 8080;

static char    g_saves_dir[512];
static char    g_admin_file[512];
static char    g_secret_file[512];
static char    g_log_file[512];
static char    g_fail_file[512];
static uint8_t g_secret[64];

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
    case 400: reason = "Bad Request"; break;
    case 401: reason = "Unauthorized"; break;
    case 403: reason = "Forbidden"; break;
    case 404: reason = "Not Found"; break;
    case 405: reason = "Method Not Allowed"; break;
    case 413: reason = "Payload Too Large"; break;
    case 414: reason = "URI Too Long"; break;
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
    int    has_clen = 0, bad = 0, rc = 0;

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
                } else if (!strcasecmp(line, "Cookie")) {
                    snprintf(r->cookie, sizeof r->cookie, "%s", val);
                }
            }
        }
    }

    if (bad) { rc = -2; goto out; }
    if (!strcasecmp(r->method, "POST") && !has_clen) { rc = -3; goto out; }

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
    if (exp <= 0 || exp > now_sec() + SESS_TTL + 300) return 0;

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
static int serve_static(int fd, const char *rawpath)
{
    char path[1024], full[1200];
    size_t len = 0;
    char *data;
    const char *cache;

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

    if (strstr(path, ".html")) cache = "Cache-Control: no-cache\r\n";
    else cache = "Cache-Control: public, max-age=3600\r\n";

    send_body(fd, 200, mime_of(full), data, len, cache);
    free(data);
    return 200;
}

/* ---------- 存档 ---------- */
static int current_pid(const req_t *r, char *pid, size_t psz)
{
    char tok[512];
    if (cookie_get(r->cookie, "gpid", tok, sizeof tok) != 0) return 0;
    if (!check_token("pid", tok, pid, psz, NULL)) return 0;
    if (!valid_pid(pid)) return 0;
    return 1;
}

static int api_get_save(int fd, const req_t *r)
{
    char pid[128], file[700], tok[512], hdr[800];

    if (current_pid(r, pid, sizeof pid)) {
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

    /* 新玩家：签发 pid cookie */
    {
        uint8_t rnd[16];
        char hex[33], newpid[40];
        if (rand_bytes(rnd, sizeof rnd) != 0) {
            send_json(fd, 500, "{\"ok\":false,\"err\":\"rand\"}");
            return 500;
        }
        to_hex(rnd, sizeof rnd, hex);
        snprintf(newpid, sizeof newpid, "p%s", hex);
        make_token("pid", newpid, now_sec() + SESS_TTL, tok, sizeof tok);
        snprintf(hdr, sizeof hdr,
                 "Set-Cookie: gpid=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Lax\r\n"
                 "Cache-Control: no-store\r\n",
                 tok, SESS_TTL);
        send_body(fd, 200, "application/json; charset=utf-8",
                  "{\"ok\":true,\"save\":null}", 24, hdr);
    }
    return 200;
}

static int api_put_save(int fd, const req_t *r)
{
    char pid[128], file[700];

    if (!current_pid(r, pid, sizeof pid)) {
        send_json(fd, 403, "{\"ok\":false,\"err\":\"no-session\"}");
        return 403;
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
    char out[1024];
    long long now = now_sec();

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
                    if (p) total_pulls += strtol(p + 8, NULL, 10);
                    free(d);
                }
            }
        }
        closedir(dir);
    }

    snprintf(out, sizeof out,
             "{\"ok\":true,\"players\":%ld,\"bytes\":%ld,\"pulls\":%ld,"
             "\"serverTime\":%lld,\"port\":%d}",
             players, total_bytes, total_pulls, now, g_port);
    send_json(fd, 200, out);
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
        snprintf(out, sizeof out, "{\"ok\":true,\"t\":%lld}", now_sec());
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
        !strcmp(r->path, "/api/admin/logs")) {
        if (!authed) {
            access_log(ip, r->method, r->path, 401);
            send_json(fd, 401, "{\"ok\":false,\"err\":\"unauthorized\"}");
            return;
        }
        access_log(ip, r->method, r->path, 200);
        if (!strcmp(r->path, "/api/admin/overview")) api_admin_overview(fd);
        else if (!strcmp(r->path, "/api/admin/saves")) api_admin_saves(fd);
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
        int code = serve_static(fd, r->path);
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

    if ((e = getenv("GACHA_PORT")) != NULL) g_port = atoi(e);
    if ((e = getenv("GACHA_WWW"))  != NULL) g_www  = e;
    if ((e = getenv("GACHA_DATA")) != NULL) g_data = e;
    if (g_port <= 0 || g_port > 65535) g_port = 8080;

    snprintf(g_saves_dir,  sizeof g_saves_dir,  "%s/saves",      g_data);
    snprintf(g_admin_file, sizeof g_admin_file, "%s/admin.pass", g_data);
    snprintf(g_secret_file,sizeof g_secret_file,"%s/session.key",g_data);
    snprintf(g_log_file,   sizeof g_log_file,   "%s/access.log", g_data);
    snprintf(g_fail_file,  sizeof g_fail_file,  "%s/fails.log",  g_data);

    if (argc > 1 && !strcmp(argv[1], "initkey")) {
        if (argc < 3) { fprintf(stderr, "用法: gachad initkey <明文密钥>\n"); return 2; }
        mkdir_p(g_data, 0750);
        if (secret_load_or_create() != 0) { fprintf(stderr, "无法生成会话密钥\n"); return 1; }
        if (admin_key_init(argv[2]) != 0) { fprintf(stderr, "无法写入密钥文件\n"); return 1; }
        printf("已写入 %s（%d 轮 PBKDF2）\n", g_admin_file, PBKDF2_ITERS);
        return 0;
    }

    if (mkdir_p(g_data, 0750) != 0) { perror("mkdir data"); return 1; }
    if (mkdir_p(g_saves_dir, 0750) != 0) { perror("mkdir saves"); return 1; }
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

    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof addr) != 0) {
        perror("bind"); return 1;
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
