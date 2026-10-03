#!/bin/sh
# 交叉编译出服务器用的 x86_64 静态二进制。
# 本机是 aarch64（Debian），目标机是 x86_64 musl（Alpine 3.2）。
#
# 首次准备工具链（约 39 MB，走本机 apt 源）：
#   mkdir -p /tmp/xdeb && cd /tmp/xdeb
#   apt-get download gcc-x86-64-linux-gnu gcc-14-x86-64-linux-gnu cpp-14-x86-64-linux-gnu \
#     binutils-x86-64-linux-gnu libc6-dev-amd64-cross libgcc-14-dev-amd64-cross linux-libc-dev-amd64-cross
#   mkdir -p ~/xcross && for f in /tmp/xdeb/*.deb; do dpkg -x "$f" ~/xcross; done
#
# 用法：./build.sh [输出路径]
set -e
OUT="${1:-./gachad-x86_64}"
XCROSS="${XCROSS:-$HOME/xcross}"
export LD_LIBRARY_PATH="$XCROSS/usr/lib/aarch64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
CC="$XCROSS/usr/bin/x86_64-linux-gnu-gcc"
[ -x "$CC" ] || { echo "交叉编译器不存在：$CC（见本文件顶部的工具链准备步骤）" >&2; exit 1; }

"$CC" -static -O2 -s -Wall -I. -o "$OUT" server.c sha256.c util.c
echo "已生成：$OUT"
ls -la "$OUT"
file "$OUT" 2>/dev/null || true
