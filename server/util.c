/* util.c */
#include "util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <sys/stat.h>
#include <sys/types.h>

void *xmalloc(size_t n)
{
    void *p = malloc(n ? n : 1);
    if (!p) { fprintf(stderr, "fatal: out of memory\n"); exit(1); }
    return p;
}

void *xrealloc(void *p, size_t n)
{
    void *q = realloc(p, n ? n : 1);
    if (!q) { fprintf(stderr, "fatal: out of memory\n"); exit(1); }
    return q;
}

char *xstrdup(const char *s)
{
    size_t n = strlen(s);
    char *p = (char *)xmalloc(n + 1);
    memcpy(p, s, n + 1);
    return p;
}

char *read_file(const char *path, size_t *len)
{
    FILE *f = fopen(path, "rb");
    char *buf = NULL;
    size_t cap = 0, used = 0;

    if (!f) return NULL;
    for (;;) {
        size_t n;
        if (used + 65536 + 1 > cap) {
            cap = cap ? cap * 2 : 131072;
            if (used + 65536 + 1 > cap) cap = used + 65536 + 1;
            buf = (char *)xrealloc(buf, cap);
        }
        n = fread(buf + used, 1, 65536, f);
        used += n;
        if (n < 65536) break;
    }
    fclose(f);
    if (!buf) buf = (char *)xmalloc(1);
    buf[used] = '\0';
    if (len) *len = used;
    return buf;
}

int write_file_atomic(const char *path, const char *data, size_t len)
{
    char tmp[1024];
    int fd, n;
    size_t done = 0;

    if (snprintf(tmp, sizeof tmp, "%s.tmp.%d", path, (int)getpid()) >= (int)sizeof tmp)
        return -1;

    fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0640);
    if (fd < 0) return -1;

    while (done < len) {
        n = (int)write(fd, data + done, len - done);
        if (n < 0) {
            if (errno == EINTR) continue;
            close(fd); unlink(tmp); return -1;
        }
        done += (size_t)n;
    }
    if (fsync(fd) != 0) { /* 某些 FS 不支持，忽略 */ }
    close(fd);

    if (rename(tmp, path) != 0) { unlink(tmp); return -1; }
    return 0;
}

int file_exists(const char *path)
{
    struct stat st;
    return stat(path, &st) == 0;
}

int mkdir_p(const char *path, int mode)
{
    char buf[1024];
    size_t i, n = strlen(path);

    if (n >= sizeof buf) return -1;
    memcpy(buf, path, n + 1);
    if (n && buf[n-1] == '/') buf[n-1] = '\0';

    for (i = 1; buf[i]; i++) {
        if (buf[i] == '/') {
            buf[i] = '\0';
            if (mkdir(buf, (mode_t)mode) != 0 && errno != EEXIST) return -1;
            buf[i] = '/';
        }
    }
    if (mkdir(buf, (mode_t)mode) != 0 && errno != EEXIST) return -1;
    return 0;
}

static int hexv(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

int url_decode(const char *in, size_t inlen, char *out, size_t outsz)
{
    size_t i = 0, o = 0;

    while (i < inlen) {
        int c = (unsigned char)in[i];
        if (c == '%' && i + 2 < inlen) {
            int hi = hexv(in[i+1]), lo = hexv(in[i+2]);
            if (hi < 0 || lo < 0) return -1;
            c = (hi << 4) | lo;
            i += 3;
        } else if (c == '+') {
            c = ' ';
            i++;
        } else {
            i++;
        }
        if (o + 1 >= outsz) return -1;
        out[o++] = (char)c;
    }
    out[o] = '\0';
    return (int)o;
}

int query_get(const char *qs, const char *key, char *out, size_t outsz)
{
    size_t klen = strlen(key), pos = 0, qlen = strlen(qs);

    while (pos <= qlen) {
        size_t end = pos;
        size_t eq;
        while (end < qlen && qs[end] != '&') end++;
        /* 字段 = qs[pos..end) */
        eq = pos;
        while (eq < end && qs[eq] != '=') eq++;
        if (eq - pos == klen && memcmp(qs + pos, key, klen) == 0) {
            if (eq == end) { if (outsz) out[0] = '\0'; return 0; }
            return url_decode(qs + eq + 1, end - eq - 1, out, outsz) < 0 ? -1 : 0;
        }
        if (end >= qlen) break;
        pos = end + 1;
    }
    return -1;
}

int form_get(const char *body, size_t blen, const char *key, char *out, size_t outsz)
{
    size_t klen = strlen(key), pos = 0;

    while (pos <= blen) {
        size_t end = pos, eq;
        while (end < blen && body[end] != '&') end++;
        eq = pos;
        while (eq < end && body[eq] != '=') eq++;
        if (eq - pos == klen && memcmp(body + pos, key, klen) == 0) {
            if (eq == end) { if (outsz) out[0] = '\0'; return 0; }
            return url_decode(body + eq + 1, end - eq - 1, out, outsz) < 0 ? -1 : 0;
        }
        if (end >= blen) break;
        pos = end + 1;
    }
    return -1;
}

void json_escape(const char *src, size_t slen, char *out, size_t outsz)
{
    size_t i, o = 0;

    for (i = 0; i < slen && o + 7 < outsz; i++) {
        unsigned char c = (unsigned char)src[i];
        switch (c) {
        case '"':  out[o++] = '\\'; out[o++] = '"';  break;
        case '\\': out[o++] = '\\'; out[o++] = '\\'; break;
        case '\n': out[o++] = '\\'; out[o++] = 'n';  break;
        case '\r': out[o++] = '\\'; out[o++] = 'r';  break;
        case '\t': out[o++] = '\\'; out[o++] = 't';  break;
        case '\b': out[o++] = '\\'; out[o++] = 'b';  break;
        case '\f': out[o++] = '\\'; out[o++] = 'f';  break;
        default:
            if (c < 0x20) {
                static const char hx[] = "0123456789abcdef";
                out[o++] = '\\'; out[o++] = 'u'; out[o++] = '0'; out[o++] = '0';
                out[o++] = hx[(c >> 4) & 0xf];
                out[o++] = hx[c & 0xf];
            } else {
                out[o++] = (char)c;
            }
        }
    }
    out[o] = '\0';
}

int rand_bytes(void *buf, size_t n)
{
    static int fd = -1;
    size_t done = 0;

    if (fd < 0) {
        fd = open("/dev/urandom", O_RDONLY);
        if (fd < 0) return -1;
    }
    while (done < n) {
        ssize_t r = read(fd, (char *)buf + done, n - done);
        if (r < 0) { if (errno == EINTR) continue; return -1; }
        if (r == 0) return -1;
        done += (size_t)r;
    }
    return 0;
}

long long now_sec(void)
{
    return (long long)time(NULL);
}

int valid_pid(const char *s)
{
    size_t i, n = strlen(s);
    if (n < 6 || n > 64) return 0;
    for (i = 0; i < n; i++) {
        char c = s[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '-' || c == '_'))
            return 0;
    }
    return 1;
}

int safe_name(const char *s)
{
    size_t i, n = strlen(s);
    if (n == 0 || n > 128) return 0;
    if (strcmp(s, ".") == 0 || strcmp(s, "..") == 0) return 0;
    for (i = 0; i < n; i++) {
        char c = s[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.'))
            return 0;
    }
    return 1;
}

int write_all(int fd, const void *buf, size_t len)
{
    const char *p = (const char *)buf;
    size_t done = 0;

    while (done < len) {
        ssize_t n = write(fd, p + done, len - done);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) return -1;
        done += (size_t)n;
    }
    return 0;
}

char *str_lower(char *s)
{
    char *p;
    for (p = s; *p; p++)
        if (*p >= 'A' && *p <= 'Z') *p = (char)(*p - 'A' + 'a');
    return s;
}
