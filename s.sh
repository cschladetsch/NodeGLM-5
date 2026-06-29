#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$SCRIPT_DIR/s"

python3 - "$S" <<'EOF'
import sys
path = sys.argv[1]
content = open(path).read()

old_case = '''case "$KAI_WORKBENCH_BASE_URL" in
    http://localhost:11434|http://127.0.0.1:11434) ;;
    *) return ;;
  esac'''

new_case = '''case "$KAI_WORKBENCH_BASE_URL" in
    http://localhost:11434|http://localhost:11434/v1|\
    http://127.0.0.1:11434|http://127.0.0.1:11434/v1) ;;
    *) return ;;
  esac
  OLLAMA_BASE="${KAI_WORKBENCH_BASE_URL%/v1}"'''

old_health = '"$KAI_WORKBENCH_BASE_URL/api/version"'
new_health = '"$OLLAMA_BASE/api/version"'

assert old_case in content, "Could not find case block -- already patched or changed?"
content = content.replace(old_case, new_case)
assert content.count(old_health) >= 2, "Could not find health check URLs"
content = content.replace(old_health, new_health)

open(path, 'w').write(content)
print("Done.")
EOF

chmod +x "$S"
echo "Patched $S"
