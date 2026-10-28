#!/usr/bin/env bash
# Screenshots of the built site, taken by headless Chrome on the MacBook (this WSL has no browser):
#   tools/images/screenshots.sh [out dir]      (default ~/.cache/fable/shots)
# Copies dist/ and tools/images/preview.mjs to the Mac over ssh, serves them there, shoots the pages
# listed below at 1440 px wide, full height, and copies the PNGs back. The Mac's address comes from
# ~/.cache/fable/mac-host.txt and is never printed.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/../.." && pwd)
OUT="${1:-$HOME/.cache/fable/shots}"
HOST=$(cat "$HOME/.cache/fable/mac-host.txt")
PAGES="/:home /zh/:zh /zh-tw/:tw /ja/:ja /road:road /about:about /docs:docs /docs/road:docs-road /docs/guide:guide /ja/docs:ja-docs"
tar -C "$HERE" -czf - dist tools/images/preview.mjs | ssh -o BatchMode=yes "$HOST" 'mkdir -p ~/work/site-preview && tar -xzf - -C ~/work/site-preview'
# The phone shots: headless Chrome will not lay a window out narrower than about 500 px, so each
# phone page is framed in an iframe exactly 390 px wide and the shot is cut to that width.
ssh -o BatchMode=yes "$HOST" "PAGES='$PAGES' bash -s" <<'REMOTE' 2>&1 | sed -E "s#$HOST#MAC#g"
export PATH=/opt/homebrew/bin:$PATH
cd ~/work/site-preview
pkill -f 'preview.mjs 4175' 2>/dev/null || true
(node tools/images/preview.mjs 4175 >/tmp/preview.log 2>&1 &)
sleep 1
C='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
rm -rf ~/work/shots; mkdir -p ~/work/shots
for p in $PAGES; do
  path="${p%%:*}"; name="${p##*:}"
  "$C" --headless=new --disable-gpu --hide-scrollbars --window-size=1440,6000 --screenshot="$HOME/work/shots/$name.png" "http://127.0.0.1:4175$path" >/dev/null 2>&1
  printf '<!doctype html><meta charset="utf-8"><body style="margin:0"><iframe src="%s" style="border:0;width:390px;height:8000px;display:block"></iframe>' "$path" > dist/__phone.html
  "$C" --headless=new --disable-gpu --hide-scrollbars --window-size=390,8000 --screenshot="$HOME/work/shots/$name-phone.png" "http://127.0.0.1:4175/__phone" >/dev/null 2>&1
done
rm -f dist/__phone.html
pkill -f 'preview.mjs 4175' 2>/dev/null || true
REMOTE
rm -rf "$OUT"; mkdir -p "$OUT"
ssh -o BatchMode=yes "$HOST" 'tar -czf - -C ~/work/shots .' 2>/dev/null | tar -xzf - -C "$OUT" 2>/dev/null
ls "$OUT"
