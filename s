#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if pgrep -af "node server.js" >/dev/null 2>&1; then
  pgrep -f "node server.js" | xargs -r kill
fi

exec npm start
