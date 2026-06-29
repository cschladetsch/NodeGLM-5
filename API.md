# KaiWorkbench API

This document is the canonical API reference for KaiWorkbench. It covers the
Express HTTP API, streaming responses, the CppKAI WebSocket bridge, browser
static routes, and the upstream OpenAI-compatible model API expected by the
server.

## Base URL

By default the application listens on:

```text
http://127.0.0.1:3001
```

The bind address and port are controlled by `HOST` and `PORT`.

## Common Rules

- Request and response bodies are JSON unless an endpoint says otherwise.
- The server accepts JSON request bodies up to 16 MB.
- `/api/*` routes accept an optional session id as `sid` in the query string or
  JSON body.
- A valid `sid` is 1 to 128 characters and may contain letters, digits, `.`,
  `_`, and `-`.
- CORS and WebSocket origin checks use `KAI_WORKBENCH_ALLOWED_ORIGINS`.
- Error responses are generally JSON:

```json
{"error":"message"}
```

## Static Routes

### `GET /`

Returns `index.html`.

### `GET /index.html`

Returns `index.html`.

### `GET /ui-config.json`

Returns the validated UI configuration.

Response:

```json
{"requestProgressDelaySeconds":3}
```

## Chat

### `POST /api/chat`

Proxies a streaming chat completion to the configured OpenAI-compatible model
endpoint. The response is Server-Sent Events forwarded from the upstream model.

Request:

```json
{
  "sid": "browser-session",
  "messages": [
    {"role": "user", "content": "Explain this repository"}
  ]
}
```

Rules:

- `messages` must be a non-empty array.
- The last message must have string `content`.
- The server extracts explicit memory facts from the last message.
- The server appends the authoritative session cwd marker to the last message.
- Only the last `KAI_WORKBENCH_HISTORY_MESSAGES` messages are forwarded upstream.
- The selected session model is used.

Success response:

```text
Content-Type: text/event-stream

data: {"choices":[{"delta":{"content":"..."}}]}

data: [DONE]
```

Streamed error response:

```text
data: {"error":"Model endpoint closed without streaming a response"}
```

Status codes:

| Status | Meaning |
|---|---|
| `400` | Invalid request shape |
| `200` | SSE stream started; upstream errors are sent as SSE error payloads |

## Agent Tool Endpoints

The chat UI uses these endpoints to execute model-requested tools. Reads run
immediately. Bash commands and writes are approval-gated in the browser.

### `POST /api/tool/bash`

Runs a Bash command in the session cwd and updates the session cwd to the final
working directory when possible.

Request:

```json
{"sid":"browser-session","cmd":"pwd"}
```

Response:

```json
{
  "stdout": "/home/user/project\n",
  "stderr": "",
  "exitCode": 0,
  "cwd": "/home/user/project"
}
```

Notes:

- Commands run as the server OS user.
- `SAFE_ROOT` does not sandbox Bash.
- Default timeout is 20 seconds.

### `POST /api/tool/read_file`

Reads an agent-requested file relative to the session cwd.

Request:

```json
{"sid":"browser-session","path":"src/app.js"}
```

Response:

```json
{"content":"file text","path":"/absolute/path/src/app.js"}
```

Limits:

- File size must be 4 MB or smaller.
- Paths must resolve inside `SAFE_ROOT`.

### `POST /api/tool/write_file/diff`

Builds a unified diff for a proposed agent write. This endpoint does not change
the file.

Request:

```json
{"sid":"browser-session","path":"src/app.js","content":"new file text"}
```

Response:

```json
{
  "path": "/absolute/path/src/app.js",
  "patch": "Index: ...",
  "isNew": false
}
```

### `POST /api/tool/write_file/confirm`

Applies an approved agent write.

Request:

```json
{"sid":"browser-session","path":"src/app.js","content":"new file text"}
```

Response:

```json
{"ok":true,"path":"/absolute/path/src/app.js"}
```

Rules:

- `content` must be a string.
- Parent directories are created as needed.
- Paths must resolve inside `SAFE_ROOT`.

## Bash REPL

### `POST /api/repl/exec`

Runs a one-shot Bash command for the dedicated Bash panel.

Request:

```json
{"cmd":"ls","cwd":"/home/user/project","timeout":10000}
```

Response:

```json
{
  "stdout": "README.md\n",
  "stderr": "",
  "exitCode": 0,
  "cwd": "/home/user/project"
}
```

Rules:

- `cmd` is required.
- `cwd` is resolved through the same `SAFE_ROOT` path validator.
- `timeout` is capped at 30000 ms.

## Session

### `GET /api/session`

Returns the session cwd, selected model, root, and fact memory.

Query:

```text
sid=browser-session
```

Response:

```json
{
  "cwd": "/home/user/project",
  "model": "qwen2.5-coder:7b",
  "root": "/home/user",
  "memory": ["The user prefers Vim"]
}
```

### `POST /api/session/cwd`

Changes the session cwd.

Request:

```json
{"sid":"browser-session","path":"subdir"}
```

Response:

```json
{"ok":true,"cwd":"/home/user/project/subdir"}
```

Rules:

- `path` must resolve inside `SAFE_ROOT`.
- The resolved path must be a directory.

### `POST /api/session/model`

Selects the model for one session.

Request:

```json
{"sid":"browser-session","model":"qwen2.5-coder:7b"}
```

Response:

```json
{"ok":true,"model":"qwen2.5-coder:7b"}
```

Rules:

- The model must be present in the upstream `/v1/models` response.
- Upstream model-list failures return `502`.

## Memory

### `GET /api/memory`

Returns persisted fact memory and refreshes active sessions from disk.

Query:

```text
sid=browser-session
```

Response:

```json
{"memory":["The user prefers direct answers"]}
```

### `PUT /api/memory`

Replaces persisted fact memory.

Request:

```json
{"sid":"browser-session","memory":["The user prefers direct answers"]}
```

Response:

```json
{"ok":true,"memory":["The user prefers direct answers"]}
```

Rules:

- `memory` must be an array.
- Facts are normalized, deduplicated, and capped.

### `POST /api/memory/clear`

Clears persisted fact memory for all active sessions.

Request:

```json
{"sid":"browser-session"}
```

Response:

```json
{"ok":true,"memory":[]}
```

## Browser Filesystem

These endpoints back the file browser and editor. Paths resolve relative to the
session cwd unless absolute.

### `GET /api/fs/list`

Lists a directory.

Query:

```text
sid=browser-session&path=src
```

Response:

```json
{
  "path": "src",
  "abs": "/home/user/project/src",
  "cwd": "/home/user/project",
  "entries": [
    {"name":"index.js","type":"file","size":1234},
    {"name":"lib","type":"dir","size":null}
  ]
}
```

### `GET /api/fs/read`

Reads a file for the browser editor.

Query:

```text
sid=browser-session&path=src/index.js
```

Response:

```json
{"content":"file text"}
```

Limits:

- File size must be 2 MB or smaller.
- Paths must resolve inside `SAFE_ROOT`.

### `POST /api/fs/write`

Saves browser editor content.

Request:

```json
{"sid":"browser-session","path":"src/index.js","content":"file text"}
```

Response:

```json
{"ok":true,"path":"src/index.js"}
```

Rules:

- `content` must be a string.
- This endpoint writes directly and does not use the agent diff approval flow.

## Models

### `GET /api/models`

Lists installed upstream models and KaiWorkbench's recommended model metadata.

Query:

```text
sid=browser-session
```

Response:

```json
{
  "models": ["qwen2.5-coder:7b"],
  "modelInfo": [
    {
      "id": "qwen2.5-coder:7b",
      "label": "Qwen Coder 7B",
      "vram": "~6-9 GB",
      "ram": "~10 GB",
      "fit": "Default coding model",
      "installed": true
    }
  ],
  "selected": "qwen2.5-coder:7b"
}
```

Status codes:

| Status | Meaning |
|---|---|
| `200` | Model list returned |
| `502` | Upstream model endpoint failed |

### `POST /api/models/install`

Installs one of KaiWorkbench's recommended models through local Ollama. The response
is newline-delimited JSON.

Request:

```json
{"model":"qwen2.5-coder:7b"}
```

Response:

```text
Content-Type: application/x-ndjson

{"type":"start","model":"qwen2.5-coder:7b","target":"/home/user/.models/ollama","statusText":"Fetching model manifest"}
{"type":"progress","statusText":"Downloading model layers","text":"pulling ...\n","percent":42}
{"type":"done","ok":true,"model":"qwen2.5-coder:7b","target":"/home/user/.models/ollama","models":["qwen2.5-coder:7b"],"modelInfo":[],"output":"...","percent":100}
```

Error event:

```json
{"type":"error","error":"message","target":"/home/user/.models/ollama","model":"qwen2.5-coder:7b","output":"..."}
```

Rules:

- `model` must be one of `RECOMMENDED_MODELS`.
- The upstream endpoint must be local Ollama.
- Client abort sends `SIGTERM` to the `ollama pull` process.

### `GET /api/modelstore`

Reports local CppLmmModelStore state.

Response:

```json
{
  "base": "/home/user/.local/share/deepseek/models",
  "models": ["model-a"],
  "ms_dir": "/home/user/local/repos/CppLmmModelStore",
  "ms_built": true
}
```

## Local Image Open

### `POST /api/open/image`

Opens a chat image with the operating system's native image handler.

Request for a dragged data URL image:

```json
{
  "sid": "browser-session",
  "src": "data:image/png;base64,...",
  "name": "screenshot.png",
  "type": "image/png"
}
```

Request for a remote image URL:

```json
{"sid":"browser-session","src":"https://example.com/image.png","name":"image.png"}
```

Response for a data URL:

```json
{
  "ok": true,
  "path": "/tmp/kaiworkbench-image-abc123/screenshot.png",
  "mime": "image/png",
  "size": 12345,
  "opened": {"command":"xdg-open"}
}
```

Response for an HTTP URL:

```json
{"ok":true,"target":"https://example.com/image.png","opened":{"command":"xdg-open"}}
```

Rules:

- `src` is required.
- Data URL images must be base64 `data:image/...`.
- Data URL payloads are capped at 8 MB.
- Native opener command is chosen from `open`, `cmd.exe /c start`, `wslview`,
  `xdg-open`, or `gio open` depending on platform.

## Health And Resources

### `GET /api/health`

Checks the upstream model endpoint and reports active settings.

Query:

```text
sid=browser-session
```

Success response:

```json
{
  "ok": true,
  "inference": true,
  "model": "qwen2.5-coder:7b",
  "ollama": "http://localhost:11434",
  "root": "/home/user"
}
```

Failure response:

```json
{
  "ok": false,
  "inference": false,
  "model": "qwen2.5-coder:7b",
  "ollama": "http://localhost:11434",
  "root": "/home/user",
  "error": "connect ECONNREFUSED"
}
```

### `GET /api/resources`

Reports GPU VRAM and system RAM usage.

Response:

```json
{
  "vram": {
    "available": true,
    "source": "nvidia-smi",
    "appScope": "KaiWorkbench process tree plus local Ollama",
    "gpus": [],
    "total": {"appUsedMiB": 0, "usedMiB": 0, "totalMiB": 0}
  },
  "ram": {
    "available": true,
    "source": "node-os",
    "total": {"appUsedMiB": 100, "usedMiB": 1000, "totalMiB": 32000, "freeMiB": 31000}
  }
}
```

When `nvidia-smi` is not available, `vram.available` is `false` and includes an
`error` field.

## CppKAI WebSocket

### `WS /api/kai?sid=...`

Attaches the browser to its session-owned CppKAI runtime. The server validates
the WebSocket origin against `KAI_WORKBENCH_ALLOWED_ORIGINS`.

Client messages are JSON text frames.

#### Start Runtime

Request:

```json
{"type":"start","mode":"pi"}
```

Valid `mode` values:

- `pi`
- `rho`
- `debugger`

Response:

```json
{"type":"ready","data":"pi"}
```

If the configured CppKAI console is not built:

```json
{"type":"error","data":"CppKAI Console is not built"}
```

#### Send Console Input

Request:

```json
{"type":"input","data":"1 2 +"}
```

The server writes `data` plus a newline to the CppKAI process stdin.

#### Inspect Executor Tree

Request:

```json
{"type":"inspect_tree","id":"request-1"}
```

Rules:

- `id` must be a valid request id: letters, digits, `.`, `_`, `-`, max 128.
- Duplicate pending request ids are rejected.
- Requests time out after 30 seconds.

Response shape is produced by CppKAI and forwarded as:

```json
{"type":"tree","data":{"type":"tree","id":"request-1","executors":[]}}
```

Malformed or timeout errors are sent as:

```json
{"type":"error","data":"CppKAI request request-1 timed out"}
```

#### Debug Action

Request:

```json
{
  "type": "debug_action",
  "id": "request-2",
  "executorId": "1",
  "action": "step"
}
```

Valid `action` values:

- `step`
- `continue`
- `stack`
- `clear`

Rules:

- `executorId` must contain only digits.
- `id` follows the same request-id rules as `inspect_tree`.

Response shape is produced by CppKAI and forwarded with its native `type` and
payload.

#### Stop Runtime

Request:

```json
{"type":"stop"}
```

The server terminates the session-owned CppKAI process.

#### Server-Originated Events

The server may send:

```json
{"type":"stdout","data":"..."}
{"type":"stderr","data":"..."}
{"type":"error","data":"..."}
{"type":"exit","data":0}
```

## Upstream Model API

KaiWorkbench expects `KAI_WORKBENCH_BASE_URL` to expose an OpenAI-compatible API.

### `GET {KAI_WORKBENCH_BASE_URL}/v1/models`

Expected response:

```json
{
  "data": [
    {"id": "qwen2.5-coder:7b"}
  ]
}
```

KaiWorkbench extracts and sorts the string `id` values.

### `POST {KAI_WORKBENCH_BASE_URL}/v1/chat/completions`

KaiWorkbench sends:

```json
{
  "model": "qwen2.5-coder:7b",
  "messages": [
    {"role":"system","content":"..."},
    {"role":"user","content":"..."}
  ],
  "temperature": 0.1,
  "max_tokens": 4096,
  "stream": true
}
```

Expected response is an OpenAI-compatible streaming SSE chat completion. KaiWorkbench
forwards upstream chunks to the browser.

## Path Validation

The `safe()` path validator applies to browser filesystem endpoints and agent
file tools:

1. Resolve relative paths against the session cwd, or another endpoint-specific
   base directory.
2. Expand leading `~` to the server user's home directory.
3. Walk upward to the closest existing ancestor.
4. Canonicalize that ancestor with `realpath`.
5. Reattach missing path segments.
6. Reject the path unless it is `SAFE_ROOT` or a descendant of `SAFE_ROOT`.

This prevents `..` traversal and symlink escapes for file APIs. Bash remains
outside this sandbox and runs with the server user's permissions.

## Session Lifetime

The server keeps session state in memory:

- cwd
- selected model
- fact memory snapshot
- last-used timestamp

Sessions expire after 24 hours when capacity cleanup runs. Session state is lost
when the server restarts, except persisted fact memory.
