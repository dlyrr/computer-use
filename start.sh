#!/usr/bin/env bash
# Run agent-overlay. Installs and builds on first use.
set -e
cd "$(dirname "$0")"

[ -d node_modules ] || { echo "Installing dependencies, this happens once..."; npm install; }
[ -f dist/overlay/main.js ] || { echo "Building..."; npm run build; }

exec ./node_modules/.bin/electron .
