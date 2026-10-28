#!/bin/bash
# Render single frames to stills/ for review.
# usage: scripts/still.sh frame...   (set CHROME=/path/to/chrome-headless-shell to pick a browser)
cd "$(dirname "$0")/.."
browser=()
[ -n "$CHROME" ] && browser=(--browser-executable="$CHROME")
nice -n 10 npx remotion bundle src/index.ts --out-dir build >/dev/null 2>&1
mkdir -p stills
for fr in "$@"; do
  nice -n 10 npx remotion still build Promo stills/f$fr.png --frame=$fr "${browser[@]}" --log=error 2>&1 | grep -v notice | tail -2
done
