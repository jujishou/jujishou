-- 星海抽卡 · Cloudflare D1 表结构
-- 对应原 C 服务端 <data>/users/*.json、<data>/invites/*.json、<data>/saves/*.json

CREATE TABLE IF NOT EXISTS users (
  uid        TEXT PRIMARY KEY,        -- sha256(name_norm) 前 16 字节的 hex
  name       TEXT NOT NULL,           -- 原样用户名（可能是中文）
  name_norm  TEXT NOT NULL UNIQUE,    -- ASCII 小写归一化，查重与登录用
  pass       TEXT NOT NULL,           -- pbkdf2$<iters>$<salt_hex>$<hash_hex>
  created    INTEGER NOT NULL,
  -- 最后一次在网站上活动的时间（秒）。后台靠它显示「在线 / 几分钟前」。
  -- 只在登录、/api/me、读写存档时更新，且 60 秒内不重复写库。
  last_seen  INTEGER NOT NULL DEFAULT 0
);

-- 已经在跑的库要补这一列（新库走上面的 CREATE TABLE 就有了）：
--   ALTER TABLE users ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,        -- XXXX-XXXX-XXXX
  used       INTEGER NOT NULL DEFAULT 0,
  uid        TEXT,
  created    INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE TABLE IF NOT EXISTS saves (
  uid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,           -- 前端 state 的 JSON 原文
  bytes      INTEGER NOT NULL,
  total      INTEGER NOT NULL DEFAULT 0,  -- 抽数
  mtime      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  t          INTEGER NOT NULL,
  line       TEXT NOT NULL            -- "<时间> <ip> <METHOD> <path> <状态码>"
);
CREATE INDEX IF NOT EXISTS idx_logs_t ON logs(t DESC);

CREATE TABLE IF NOT EXISTS fails (
  ip         TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0,
  first      INTEGER NOT NULL,
  locked     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL
);
