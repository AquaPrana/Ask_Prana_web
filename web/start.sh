#!/usr/bin/env bash
# Ask Prana website - run locally on macOS/Linux (needs Node.js 20.19+ or 22.12+)
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js from https://nodejs.org first."; exit 1; }
[ -d node_modules ] || npm install
npm run dev
