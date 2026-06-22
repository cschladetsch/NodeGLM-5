#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GLM_BASE_URL="${GLM_BASE_URL:-http://localhost:11434}"
GLM_MODEL="${GLM_MODEL:-glm4:9b}"
SAFE_ROOT="${SAFE_ROOT:-$SCRIPT_DIR}"
APP_URL="${NODEGLM_URL:-http://${HOST:-127.0.0.1}:${PORT:-3001}/}"
MODEL_CACHE_ROOT="${MODEL_CACHE_ROOT:-$HOME/.models}"
OLLAMA_MODELS="${OLLAMA_MODELS:-$MODEL_CACHE_ROOT/ollama}"
HF_HOME="${HF_HOME:-$MODEL_CACHE_ROOT/hf}"
mkdir -p "$OLLAMA_MODELS" "$HF_HOME"
export MODEL_CACHE_ROOT OLLAMA_MODELS HF_HOME

ensure_ollama() {
  case "$GLM_BASE_URL" in
    http://localhost:11434|http://127.0.0.1:11434) ;;
    *) return ;;
  esac

  if ! command -v ollama >/dev/null 2>&1; then
    echo "Error: Ollama is required for GLM_BASE_URL=$GLM_BASE_URL but is not installed." >&2
    exit 1
  fi

  if ! curl --silent --fail --max-time 2 "$GLM_BASE_URL/api/version" >/dev/null; then
    echo "Starting Ollama..."
    nohup ollama serve >"${TMPDIR:-/tmp}/nodeglm-ollama.log" 2>&1 &

    for _ in {1..30}; do
      if curl --silent --fail --max-time 2 "$GLM_BASE_URL/api/version" >/dev/null; then
        break
      fi
      sleep 1
    done
  fi

  if ! curl --silent --fail --max-time 2 "$GLM_BASE_URL/api/version" >/dev/null; then
    echo "Error: Ollama did not become ready. See ${TMPDIR:-/tmp}/nodeglm-ollama.log." >&2
    exit 1
  fi

  if ! ollama show "$GLM_MODEL" >/dev/null 2>&1; then
    echo "Error: Ollama model '$GLM_MODEL' is not installed. Run: ollama pull $GLM_MODEL" >&2
    exit 1
  fi

  echo "Ollama ready: $GLM_MODEL"
}

ensure_ollama

if pgrep -af "node server.js" >/dev/null 2>&1; then
  pgrep -f "node server.js" | xargs -r kill
fi

export GLM_BASE_URL GLM_MODEL SAFE_ROOT
"$SCRIPT_DIR/Scripts/open-app-window.sh" "$APP_URL" &
exec npm start
