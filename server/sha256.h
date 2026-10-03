/* sha256.h —— 自包含的 SHA-256 / HMAC-SHA256 / PBKDF2 实现
 * 不依赖任何外部库，便于静态交叉编译后丢到裸机上跑。
 */
#ifndef GACHA_SHA256_H
#define GACHA_SHA256_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint32_t state[8];
    uint64_t bitlen;
    uint8_t  buf[64];
    size_t   buflen;
} sha256_ctx;

void sha256_init(sha256_ctx *c);
void sha256_update(sha256_ctx *c, const void *data, size_t len);
void sha256_final(sha256_ctx *c, uint8_t out[32]);
void sha256(const void *data, size_t len, uint8_t out[32]);

void hmac_sha256(const uint8_t *key, size_t keylen,
                 const uint8_t *msg, size_t msglen,
                 uint8_t out[32]);

/* outlen 任意；iters 建议 >= 100000 */
void pbkdf2_sha256(const uint8_t *pw, size_t pwlen,
                   const uint8_t *salt, size_t saltlen,
                   uint32_t iters, uint8_t *out, size_t outlen);

/* out 需至少 2*len+1 字节 */
void to_hex(const uint8_t *in, size_t len, char *out);
int  from_hex(const char *hex, uint8_t *out, size_t outlen);

/* 常数时间比较，防时序侧信道 */
int  ct_eq(const void *a, const void *b, size_t n);
int  hex_eq(const char *a, const char *b);

#endif /* GACHA_SHA256_H */
