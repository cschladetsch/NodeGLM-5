# GLM-5.2 Dev Console

React-based chat + file browser + shell REPL for local GLM-5.2 inference.

## Architecture

```
index.html  (React, CDN)
    │  HTTP
    ▼
server.js   (Express + ws)
    │  HTTP (OpenAI-compat)
    ▼
GLM-5.2 local inference  (SGLang / vLLM)
```

The browser cannot touch your filesystem directly — the Node server acts as the
bridge, with a configurable `SAFE_ROOT` to sandbox file access.

## Prerequisites

1. **GLM-5.2 running locally** via SGLang or vLLM with an OpenAI-compatible
   endpoint (default: `http://localhost:30000`).

   ```bash
   # SGLang example
   python -m sglang.launch_server \
     --model-path zai-org/GLM-5.2-FP8 \
     --port 30000
   ```

2. **Node.js 18+**

## Setup

```bash
cd glm-repl
npm install
```

## Run

```bash
# Default: GLM at localhost:30000, filesystem root = $HOME
npm run dev

# Custom GLM endpoint and sandbox root
GLM_BASE_URL=http://192.168.1.10:30000 SAFE_ROOT=/home/user/projects node server.js
```

Open `index.html` directly in a browser (file:// is fine — the app talks to
localhost:3001).

## Features

- **Chat** — full streaming with markdown rendering, file injection into context
- **Thinking control** — max / high / off via `reasoning_effort`
- **File browser** sidebar — click to view, click "Inject to chat" to paste file
  content into the next message (up to 8 KB per file, truncated at 8000 chars)
- **Shell REPL** — one-shot exec with cwd tracking, command history (↑/↓)
- **Connection status** — polls `/api/health` every 8 s

## Environment variables

| Variable       | Default                | Description                          |
|----------------|------------------------|--------------------------------------|
| `GLM_BASE_URL` | `http://localhost:30000` | SGLang / vLLM OpenAI-compat base URL |
| `SAFE_ROOT`    | `$HOME`                | Filesystem sandbox root              |
| `PORT`         | `3001`                 | Express port                         |

## Security note

`SAFE_ROOT` prevents path traversal outside the configured root, but the shell
REPL runs commands as the current user with no further sandboxing. Do not expose
`server.js` to untrusted networks.
