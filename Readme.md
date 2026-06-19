# GLM Code Console

Browser-based coding agent, file browser, and shell REPL for a local
OpenAI-compatible GLM endpoint.

## Architecture

```
index.html  (React, CDN)
    │  HTTP
    ▼
server.js   (Express)
    │  HTTP (OpenAI-compat)
    ▼
Local inference (Ollama / SGLang / vLLM)
```

The browser cannot touch your filesystem directly — the Node server acts as the
bridge, with a configurable `SAFE_ROOT` to sandbox file access.

## Prerequisites

1. **A model running locally** behind an OpenAI-compatible endpoint. The
   defaults are Ollama at `http://localhost:11434` with model `glm4:9b`.

   ```bash
   # SGLang example (override GLM_BASE_URL and GLM_MODEL when starting Node)
   python -m sglang.launch_server \
     --model-path zai-org/GLM-5.2-FP8 \
     --port 30000
   ```

2. **Node.js 18+**

## Setup

```bash
npm install
```

## Run

```bash
# Default: Ollama at localhost:11434, filesystem root = $HOME
npm run dev

# Custom GLM endpoint and sandbox root
GLM_BASE_URL=http://192.168.1.10:30000 GLM_MODEL=GLM-5.2 \
  SAFE_ROOT=/home/user/projects node server.js
```

Open `http://localhost:3001/` in a browser. Opening `index.html` directly via
`file://` is also supported for local use.

## Features

- **Coding agent** — streamed chat with sequential shell, read, and write tools
- **Write approval** — previews a unified diff before any agent file write
- **Ace file editor** — Monokai theme, Vim bindings, syntax modes, and direct save
- **File browser** sidebar — click to edit, or inject up to 8 KB into chat context
- **Shell REPL** — one-shot exec with cwd tracking, command history (↑/↓)
- **Connection status** — polls `/api/health` every 8 s

## Environment variables

| Variable       | Default                | Description                          |
|----------------|------------------------|--------------------------------------|
| `GLM_BASE_URL` | `http://localhost:11434` | OpenAI-compatible base URL            |
| `GLM_MODEL`    | `glm4:9b`               | Model identifier sent to the endpoint |
| `SAFE_ROOT`    | `$HOME`                | Filesystem sandbox root              |
| `PORT`         | `3001`                 | Express port                         |

## Security note

File tools enforce `SAFE_ROOT`. Shell commands run as the current user and are
not OS-sandboxed, so a shell command can still access paths outside `SAFE_ROOT`.
Do not expose this server to untrusted users or networks.

## Tests

```bash
npm test
```

The suite includes API, filesystem security, Ace configuration, and Microsoft
Edge end-to-end coverage. The Edge test runs when both Edge and `msedgedriver`
are on `PATH`; use `EDGE_BIN` and `MSEDGEDRIVER` to provide explicit paths.
