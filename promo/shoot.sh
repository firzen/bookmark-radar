#!/bin/bash
# promo/shoot.sh — 一键生成 Chrome Web Store 宣传截图（中英各 3 张，1280×800）
# 用法：bash promo/shoot.sh
cd "$(dirname "$0")" || exit 1

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || CHROME="$(command -v google-chrome chromium 2>/dev/null | head -1)"
[ -x "$CHROME" ] || { echo "未找到 Chrome"; exit 1; }

mkdir -p screenshots/zh screenshots/en

for pair in "scene1-scan:1-scan" "scene2-report:2-report" "scene3-cleanup:3-cleanup"; do
  file="${pair%%:*}"
  out="${pair##*:}"
  for lang in zh en; do
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
      --force-device-scale-factor=1 --window-size=1280,800 \
      --screenshot="screenshots/$lang/$out.png" \
      "file://$PWD/$file.html?lang=$lang" 2>/dev/null
    echo "✓ screenshots/$lang/$out.png"
  done
done
