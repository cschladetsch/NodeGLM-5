#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ ! -d node_modules || package-lock.json -nt node_modules ]]; then
  npm ci
fi

if npm run | grep -qE '^  build$'; then
  npm run build
fi

npm test