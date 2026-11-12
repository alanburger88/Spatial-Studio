#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/verify_pack.py
if [[ "${1:-}" == "--app" ]]; then
  python3 scripts/verify_app.py --base-url "${API_URL:-http://127.0.0.1:3001}" --web-url "${WEB_URL:-http://127.0.0.1:5173}"
  if [[ -f package.json ]]; then
    pnpm lint
    pnpm typecheck
    pnpm test
    pnpm e2e
    pnpm build
  else
    echo 'FAIL: no application package.json' >&2
    exit 1
  fi
fi
