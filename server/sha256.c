/* sha256.c —— SHA-256 / HMAC-SHA256 / PBKDF2-HMAC-SHA256 */
#include "sha256.h"
#include <string.h>

static const uint32_t K[64] = {
    0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
    0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
    0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
    0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
    0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
    0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
    0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
    0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
};

#define ROTR(x,n)  (((x) >> (n)) | ((x) << (32 - (n))))
#define CH(x,y,z)  (((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x,y,z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define BSIG0(x)   (ROTR(x,2)  ^ ROTR(x,13) ^ ROTR(x,22))
#define BSIG1(x)   (ROTR(x,6)  ^ ROTR(x,11) ^ ROTR(x,25))
#define SSIG0(x)   (ROTR(x,7)  ^ ROTR(x,18) ^ ((x) >> 3))
#define SSIG1(x)   (ROTR(x,17) ^ ROTR(x,19) ^ ((x) >> 10))

static void sha256_transform(sha256_ctx *c, const uint8_t *p)
{
    uint32_t w[64], a, b, d, e, f, g, h;
    uint32_t t1, t2, cc;
    int i;

    for (i = 0; i < 16; i++) {
        w[i] = ((uint32_t)p[i*4] << 24) | ((uint32_t)p[i*4+1] << 16) |
               ((uint32_t)p[i*4+2] << 8) | (uint32_t)p[i*4+3];
    }
    for (i = 16; i < 64; i++)
        w[i] = SSIG1(w[i-2]) + w[i-7] + SSIG0(w[i-15]) + w[i-16];

    a = c->state[0]; b = c->state[1]; cc = c->state[2]; d = c->state[3];
    e = c->state[4]; f = c->state[5]; g = c->state[6]; h = c->state[7];

    for (i = 0; i < 64; i++) {
        t1 = h + BSIG1(e) + CH(e, f, g) + K[i] + w[i];
        t2 = BSIG0(a) + MAJ(a, b, cc);
        h = g; g = f; f = e; e = d + t1;
        d = cc; cc = b; b = a; a = t1 + t2;
    }

    c->state[0] += a; c->state[1] += b; c->state[2] += cc; c->state[3] += d;
    c->state[4] += e; c->state[5] += f; c->state[6] += g; c->state[7] += h;
}

void sha256_init(sha256_ctx *c)
{
    c->state[0] = 0x6a09e667u; c->state[1] = 0xbb67ae85u;
    c->state[2] = 0x3c6ef372u; c->state[3] = 0xa54ff53au;
    c->state[4] = 0x510e527fu; c->state[5] = 0x9b05688cu;
    c->state[6] = 0x1f83d9abu; c->state[7] = 0x5be0cd19u;
    c->bitlen = 0;
    c->buflen = 0;
    memset(c->buf, 0, sizeof c->buf);
}

void sha256_update(sha256_ctx *c, const void *data, size_t len)
{
    const uint8_t *p = (const uint8_t *)data;

    c->bitlen += (uint64_t)len * 8u;

    if (c->buflen) {
        size_t need = 64 - c->buflen;
        size_t take = len < need ? len : need;
        memcpy(c->buf + c->buflen, p, take);
        c->buflen += take;
        p += take;
        len -= take;
        if (c->buflen == 64) {
            sha256_transform(c, c->buf);
            c->buflen = 0;
        }
    }
    while (len >= 64) {
        sha256_transform(c, p);
        p += 64;
        len -= 64;
    }
    if (len) {
        memcpy(c->buf, p, len);
        c->buflen = len;
    }
}

void sha256_final(sha256_ctx *c, uint8_t out[32])
{
    uint64_t bits = c->bitlen;
    uint8_t pad[72];
    size_t padlen;
    int i;

    /* 0x80 之后补零，直到 (buflen + 1 + padlen) % 64 == 56 */
    pad[0] = 0x80;
    {
        size_t rem = (size_t)((c->buflen + 1) % 64);
        padlen = (rem <= 56) ? (56 - rem) : (120 - rem);
    }
    memset(pad + 1, 0, padlen);
    /* 末尾 8 字节大端长度 */
    for (i = 0; i < 8; i++)
        pad[1 + padlen + i] = (uint8_t)(bits >> (56 - 8*i));

    sha256_update(c, pad, 1 + padlen + 8);
    /* 此时 bitlen 已被污染，但我们只取 state */

    for (i = 0; i < 8; i++) {
        out[i*4]   = (uint8_t)(c->state[i] >> 24);
        out[i*4+1] = (uint8_t)(c->state[i] >> 16);
        out[i*4+2] = (uint8_t)(c->state[i] >> 8);
        out[i*4+3] = (uint8_t)(c->state[i]);
    }
}

void sha256(const void *data, size_t len, uint8_t out[32])
{
    sha256_ctx c;
    sha256_init(&c);
    sha256_update(&c, data, len);
    sha256_final(&c, out);
}

void hmac_sha256(const uint8_t *key, size_t keylen,
                 const uint8_t *msg, size_t msglen,
                 uint8_t out[32])
{
    uint8_t k[64], ipad[64], opad[64], inner[32];
    sha256_ctx c;
    size_t i;

    memset(k, 0, sizeof k);
    if (keylen > 64) {
        sha256(key, keylen, k);          /* 长密钥先哈希，后面 32 字节补零 */
    } else if (keylen) {
        memcpy(k, key, keylen);
    }

    for (i = 0; i < 64; i++) {
        ipad[i] = k[i] ^ 0x36;
        opad[i] = k[i] ^ 0x5c;
    }

    sha256_init(&c);
    sha256_update(&c, ipad, 64);
    sha256_update(&c, msg, msglen);
    sha256_final(&c, inner);

    sha256_init(&c);
    sha256_update(&c, opad, 64);
    sha256_update(&c, inner, 32);
    sha256_final(&c, out);
}

void pbkdf2_sha256(const uint8_t *pw, size_t pwlen,
                   const uint8_t *salt, size_t saltlen,
                   uint32_t iters, uint8_t *out, size_t outlen)
{
    uint32_t block = 1;
    size_t done = 0;

    while (done < outlen) {
        uint8_t u[32], t[32], msg[512];
        uint32_t i;
        int j;

        if (saltlen + 4 > sizeof msg) saltlen = sizeof msg - 4;
        memcpy(msg, salt, saltlen);
        msg[saltlen + 0] = (uint8_t)(block >> 24);
        msg[saltlen + 1] = (uint8_t)(block >> 16);
        msg[saltlen + 2] = (uint8_t)(block >> 8);
        msg[saltlen + 3] = (uint8_t)(block);

        hmac_sha256(pw, pwlen, msg, saltlen + 4, u);
        memcpy(t, u, 32);

        for (i = 1; i < iters; i++) {
            hmac_sha256(pw, pwlen, u, 32, u);
            for (j = 0; j < 32; j++) t[j] ^= u[j];
        }

        {
            size_t take = outlen - done;
            if (take > 32) take = 32;
            memcpy(out + done, t, take);
            done += take;
        }
        block++;
    }
}

void to_hex(const uint8_t *in, size_t len, char *out)
{
    static const char d[] = "0123456789abcdef";
    size_t i;
    for (i = 0; i < len; i++) {
        out[i*2]   = d[(in[i] >> 4) & 0xf];
        out[i*2+1] = d[in[i] & 0xf];
    }
    out[len*2] = '\0';
}

static int hexval(char ch)
{
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
}

int from_hex(const char *hex, uint8_t *out, size_t outlen)
{
    size_t i, n = strlen(hex);
    if (n != outlen * 2) return -1;
    for (i = 0; i < outlen; i++) {
        int hi = hexval(hex[i*2]), lo = hexval(hex[i*2+1]);
        if (hi < 0 || lo < 0) return -1;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return 0;
}

int ct_eq(const void *a, const void *b, size_t n)
{
    const uint8_t *x = (const uint8_t *)a, *y = (const uint8_t *)b;
    uint8_t d = 0;
    size_t i;
    for (i = 0; i < n; i++) d |= (uint8_t)(x[i] ^ y[i]);
    return d == 0;
}

int hex_eq(const char *a, const char *b)
{
    size_t la = strlen(a), lb = strlen(b);
    if (la != lb) return 0;
    return ct_eq(a, b, la);
}
