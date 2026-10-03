/* util.h —— 通用工具：文件、编解码、随机数 */
#ifndef GACHA_UTIL_H
#define GACHA_UTIL_H

#include <stddef.h>
#include <stdint.h>

void *xmalloc(size_t n);
void *xrealloc(void *p, size_t n);
char *xstrdup(const char *s);

/* 读整个文件；成功返回 malloc 的缓冲（调用者 free），*len 为长度；失败返回 NULL */
char *read_file(const char *path, size_t *len);
/* 原子写：先写同目录临时文件再 rename，避免半截文件 */
int   write_file_atomic(const char *path, const char *data, size_t len);
int   mkdir_p(const char *path, int mode);
int   file_exists(const char *path);

/* URL 解码：'%XX' 与 '+'。返回写入字节数，越界返回 -1 */
int url_decode(const char *in, size_t inlen, char *out, size_t outsz);
/* 从 form-urlencoded body 取 key 的值；找到返回 0，未找到 -1 */
int form_get(const char *body, size_t blen, const char *key, char *out, size_t outsz);
/* 取 query string 里 key 的值（调用前传入 ? 之后的部分） */
int query_get(const char *qs, const char *key, char *out, size_t outsz);
/* 把 src 转义成可安全放进 JSON 双引号内的形式（不含首尾引号） */
void json_escape(const char *src, size_t slen, char *out, size_t outsz);

int   rand_bytes(void *buf, size_t n);
long long now_sec(void);
/* 玩家/会话标识：6..64 位 [A-Za-z0-9_-] */
int   valid_pid(const char *s);
/* 只允许字母数字与 - _ . 的文件名，且不能是 "." / ".." */
int   safe_name(const char *s);

int   write_all(int fd, const void *buf, size_t len);
char *str_lower(char *s);

#endif /* GACHA_UTIL_H */
