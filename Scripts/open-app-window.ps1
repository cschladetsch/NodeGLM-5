#!/usr/bin/env bash
set -u

URL="${1:?usage: open-app-window.ps1 URL}"
ATTEMPTS="${KAI_WORKBENCH_WINDOW_WAIT_ATTEMPTS:-120}"

if [[ "${KAI_WORKBENCH_NO_WINDOW:-0}" == "1" ]]; then
  exit 0
fi

for ((attempt=0; attempt<ATTEMPTS; attempt++)); do
  if curl --silent --fail --max-time 1 "${URL%/}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! curl --silent --fail --max-time 1 "${URL%/}/api/health" >/dev/null 2>&1; then
  echo "Warning: KaiWorkbench did not become ready at $URL; not opening a window." >&2
  exit 0
fi

if [[ -n "${KAI_WORKBENCH_BROWSER:-}" ]]; then
  exec "$KAI_WORKBENCH_BROWSER" "--app=$URL"
fi

for browser in microsoft-edge microsoft-edge-stable google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$browser" >/dev/null 2>&1; then
    exec "$browser" "--app=$URL"
  fi
done

if command -v powershell.exe >/dev/null 2>&1; then
  exec powershell.exe -NoProfile -Command "Start-Process msedge.exe -ArgumentList '--app=$URL'"
fi
if command -v open >/dev/null 2>&1; then
  exec open -na "Google Chrome" --args "--app=$URL"
fi
if command -v xdg-open >/dev/null 2>&1; then
  exec xdg-open "$URL"
fi

echo "Warning: no supported browser or URL opener found for $URL." >&2