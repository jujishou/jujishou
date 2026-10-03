#!/bin/sh
# 改完前端之后跑一下：把 index.html 里的 ?v= 换成 app.js + style.css 的内容摘要。
# 这样 app.js 的 URL 会随内容变化，浏览器不会抱着旧缓存不放。
set -e
cd "$(dirname "$0")"
V=$(cat app.js style.css | sha256sum | cut -c1-10)
python3 - "$V" <<'PY'
import sys, re
v = sys.argv[1]
p = 'index.html'
s = open(p, encoding='utf-8').read()
s = re.sub(r'href="style\.css(\?v=[0-9a-f]+)?"', f'href="style.css?v={v}"', s)
s = re.sub(r'src="app\.js(\?v=[0-9a-f]+)?"', f'src="app.js?v={v}"', s)
open(p, 'w', encoding='utf-8').write(s)
print(f"index.html 版本号 -> {v}")
PY
