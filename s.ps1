#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

KAI_WORKBENCH_BASE_URL="${KAI_WORKBENCH_BASE_URL:-http://localhost:11434/v1}"
KAI_WORKBENCH_MODEL="${KAI_WORKBENCH_MODEL:-qwen2.5-coder:7b}"
SAFE_ROOT="${SAFE_ROOT:-$SCRIPT_DIR}"
APP_URL="${KAI_WORKBENCH_URL:-http://${HOST:-127.0.0.1}:${PORT:-3001}/}"
MODEL_CACHE_ROOT="${MODEL_CACHE_ROOT:-$HOME/.models}"
OLLAMA_MODELS="${OLLAMA_MODELS:-$MODEL_CACHE_ROOT/ollama}"
HF_HOME="${HF_HOME:-$MODEL_CACHE_ROOT/hf}"
OLLAMA_CONTEXT_LENGTH="${OLLAMA_CONTEXT_LENGTH:-2048}"
OLLAMA_KV_CACHE_TYPE="${OLLAMA_KV_CACHE_TYPE:-q8_0}"
OLLAMA_FLASH_ATTENTION="${OLLAMA_FLASH_ATTENTION:-1}"
OLLAMA_MAX_LOADED_MODELS="${OLLAMA_MAX_LOADED_MODELS:-1}"
OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-1}"
OLLAMA_GPU_OVERHEAD="${OLLAMA_GPU_OVERHEAD:-1073741824}"
mkdir -p "$OLLAMA_MODELS" "$HF_HOME"
export MODEL_CACHE_ROOT OLLAMA_MODELS HF_HOME OLLAMA_CONTEXT_LENGTH
export OLLAMA_KV_CACHE_TYPE OLLAMA_FLASH_ATTENTION OLLAMA_MAX_LOADED_MODELS
export OLLAMA_NUM_PARALLEL OLLAMA_GPU_OVERHEAD

ensure_ollama() {
  case "$KAI_WORKBENCH_BASE_URL" in
    http://localhost:11434|http://localhost:11434/v1|\
    http://127.0.0.1:11434|http://127.0.0.1:11434/v1) ;;
    *) return ;;
  esac
  OLLAMA_BASE="${KAI_WORKBENCH_BASE_URL%/v1}"

  if ! command -v ollama >/dev/null 2>&1; then
    echo "Error: Ollama is required for KAI_WORKBENCH_BASE_URL=$KAI_WORKBENCH_BASE_URL but is not installed." >&2
    exit 1
  fi

  if ! curl --silent --fail --max-time 2 "$OLLAMA_BASE/api/version" >/dev/null; then
    echo "Starting Ollama..."
    nohup ollama serve >"${TMPDIR:-/tmp}/kaiworkbench-ollama.log" 2>&1 &

    for _ in {1..30}; do
      if curl --silent --fail --max-time 2 "$OLLAMA_BASE/api/version" >/dev/null; then
        break
      fi
      sleep 1
    done
  else
    echo "Ollama already running; launcher memory settings only apply after restarting Ollama."
  fi

  if ! curl --silent --fail --max-time 2 "$OLLAMA_BASE/api/version" >/dev/null; then
    echo "Error: Ollama did not become ready. See ${TMPDIR:-/tmp}/kaiworkbench-ollama.log." >&2
    exit 1
  fi

  if ! ollama show "$KAI_WORKBENCH_MODEL" >/dev/null 2>&1; then
    echo "Error: Ollama model '$KAI_WORKBENCH_MODEL' is not installed. Run: ollama pull $KAI_WORKBENCH_MODEL" >&2
    exit 1
  fi

  echo "Ollama ready: $KAI_WORKBENCH_MODEL"
}

ensure_ollama

if pgrep -af "node src/server.js" >/dev/null 2>&1; then
  pgrep -f "node src/server.js" | xargs -r kill
fi

export KAI_WORKBENCH_BASE_URL KAI_WORKBENCH_MODEL SAFE_ROOT

npm start &
NODE_PID=$!
wait_for_server() {
  for _ in $(seq 1 60); do
    if curl --silent --fail --max-time 1 "${APP_URL%/}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}
if wait_for_server; then
  "$SCRIPT_DIR/Scripts/open-app-window.ps1" "$APP_URL"
else
  echo "Warning: server did not become ready at $APP_URL" >&2
fi
wait $NODE_PID
