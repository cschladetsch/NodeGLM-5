# NodeGLM-5 Code Console

NodeGLM-5 is a local, browser-based coding workspace for OpenAI-compatible
inference servers. It combines streamed chat, an approval-gated agent tool loop,
a filesystem browser, an Ace editor, a Bash REPL, and optional CppKAI language
consoles in one page.

## Architecture

```mermaid
flowchart LR
    Browser["Browser UI (React + Ace)"]
    Server["Node server (Express + WebSocket bridge)"]
    Model["OpenAI-compatible endpoint (Ollama, SGLang, or vLLM)"]
    Files["Workspace files under SAFE_ROOT"]
    Memory["Fact memory file"]
    Shell["Bash subprocesses"]
    Kai["CppKAI runtime (Pi, Rho, Debug, Tree)"]

    Browser <-->|HTTP and SSE| Server
    Browser <-->|WebSocket bridge| Server
    Server <-->|models and chat completions| Model
    Server <-->|validated paths| Files
    Server <-->|read and write learned facts| Memory
    Server <-->|commands| Shell
    Server <-->|pseudo-terminal| Kai
```

The browser has no direct filesystem access. `server.js` validates file paths,
tracks each browser session's working directory and selected model, extracts
explicit user facts into persisted memory, proxies model traffic, and starts
local subprocesses. `index.html` contains the client UI. The complete HTTP,
SSE, NDJSON, WebSocket, static route, and upstream model API reference is
maintained in [API.md](API.md).

## Requirements

- Node.js 18 or newer
- An OpenAI-compatible model endpoint that implements `/v1/models` and
  `/v1/chat/completions`
- Bash for the shell and agent command tools
- Optional: CppKAI built at `Ext/CppKAI/Bin/Console` for the Pi, Rho, Debug,
  and Tree tabs
- Optional: Microsoft Edge and `msedgedriver` for the browser end-to-end test

The default endpoint is Ollama at `http://localhost:11434`, using the
`qwen2.5-coder:7b` coding model. The launcher uses a 2048-token context and
memory-conservative Ollama defaults so it can run on an 8 GB GPU with CPU
offload when needed. If Ollama is already running before `./s` starts, restart
Ollama so those memory settings take effect.

## Install

```bash
git clone --recurse-submodules <repository-url>
cd NodeGLM-5
npm install
```

For an existing clone, initialize the optional integrations with:

```bash
git submodule update --init --recursive
```

## Run

The launcher creates the configured model-cache directories, starts a local
Ollama server when necessary, checks that the selected Ollama model is installed,
stops an existing `node server.js` process, and then runs the application. It
opens the UI in a standalone browser window when the server becomes ready and
uses this repository as the default workspace, allowing NodeGLM to inspect and
modify its own implementation:

```bash
./s
```

Set `NODEGLM_NO_WINDOW=1` to disable automatic window creation, or set
`NODEGLM_BROWSER` to a browser executable that supports `--app`. The page may
also be opened directly from `index.html`; the server must still be running and
the default CORS policy must allow the resulting `null` origin.

To run without the launcher:

```bash
npm start
```

To use another inference server or workspace root:

```bash
GLM_BASE_URL=http://127.0.0.1:30000 \
GLM_MODEL=GLM-5.2 \
SAFE_ROOT=/home/user/projects \
npm start
```

For example, an SGLang endpoint can be started separately with:

```bash
python -m sglang.launch_server \
  --model-path zai-org/GLM-5.2-FP8 \
  --port 30000
```

## Workspace

The UI has three persistent columns:

- **File browser:** browses from the current session directory, hides dotfiles by
  default, opens files in the editor, and can inject up to 8 KB into chat.
- **Chat and editor:** streams model responses, runs the bounded agent loop, and
  remembers up to 100 messages in browser-local storage, tracks explicit user
  facts in server-side memory, and edits files with Ace, Monokai, Vim bindings,
  syntax modes, and `Ctrl-S` or `Command-S` save.
- **Tools:** provides Bash plus a persistent CppKAI runtime with Pi, Rho,
  executor-attached Debug, and executor-attached Tree views.

Each browser session has its own current directory and selected model. A
successful `cd` in Bash or through the Chat Box updates the shared directory
used by Chat tools, Bash, and the file browser for that session. A `cd ...`
entered directly in Chat is routed through the normal command-approval flow
without asking the model to interpret it. Browser conversation memory survives
page reloads, server-side fact memory survives server restarts, and both can be
cleared from the chat input. Server-side working directory and model sessions
expire after 24 hours when capacity cleanup runs and are lost when the server
restarts.

## Memory

NodeGLM keeps two different forms of memory:

- **Conversation memory:** the browser stores up to 100 stable chat messages in
  `localStorage` so a page reload does not erase the visible transcript.
- **Fact memory:** the server extracts explicit personal facts from user
  messages, stores them in `.nodeglm-memory.json` under `SAFE_ROOT`, and injects
  them into future model requests as a separate system message.

Fact extraction is intentionally conservative. It captures forms such as
`my name is ...`, `call me ...`, `my <thing> is ...`, `I am based in ...`, and
`remember that ...`. It does not summarize arbitrary conversation turns. The
chat footer shows the current fact count, and **Clear memory** clears both the
browser transcript and the persisted fact file.

```mermaid
flowchart TD
    UserMsg["User message"] --> Extract["Extract explicit facts"]
    Extract --> Dedupe["Normalize and deduplicate"]
    Dedupe --> Store["Persist fact memory under SAFE_ROOT"]
    Store --> Session["Refresh session memory"]
    Session --> Prompt["Build memory system message"]
    Prompt --> Model["OpenAI-compatible chat completion"]
    Clear["Clear memory button"] --> ClearLocal["Remove browser transcript"]
    Clear --> ClearServer["Clear server fact memory"]
    ClearServer --> Store
```

Only explicit user-provided facts are stored. The memory file is ignored by Git
to avoid accidentally committing personal data. Set `NODEGLM_MEMORY_FILE` to
move the persisted fact store elsewhere.

## Agent Tool Flow

The model can request `read_file`, `write_file`, or `bash`. Reads execute
immediately. Commands and writes pause for explicit approval; proposed writes
show a unified diff before anything is changed. The client stops a run after
eight tool steps.

Stable general-knowledge questions are answered directly when the model is
confident. Network-capable tools remain available for explicit lookups,
time-sensitive information, and verification. The current `[cwd: ...]` marker
is authoritative model context; shell-shaped requests such as `cd`, `pwd`, and
`ls` are expected to use the Bash tool.

```mermaid
sequenceDiagram
    participant User
    participant UI as Browser UI
    participant API as Node server
    participant LLM as Model endpoint
    participant Local as Filesystem or Bash

    User->>UI: Send request
    UI->>API: Send chat request
    API->>API: Extract and persist explicit facts
    API->>API: Add memory system message when facts exist
    API->>LLM: Stream chat completion
    LLM-->>UI: Tool request via SSE
    alt read_file
        UI->>API: Read requested file
        API->>Local: Read validated path
        Local-->>UI: File content
    else bash or write_file
        UI->>API: Preview write diff when applicable
        UI-->>User: Request approval
        User->>UI: Approve or reject
        opt approved
            UI->>API: Execute command or confirm write
            API->>Local: Run approved operation
            Local-->>UI: Result
        end
    end
    UI->>API: Continue with TOOL_RESULT
    API->>LLM: Next streamed completion
    LLM-->>User: Final response
```

## Filesystem Boundary

```mermaid
flowchart TB
    Input["Browser or model path"] --> Resolve["Resolve against session cwd"]
    Resolve --> Existing["Find closest existing ancestor"]
    Existing --> Canonical["Canonicalize symlinks with realpath"]
    Canonical --> Check{"Inside SAFE_ROOT?"}
    Check -->|Yes| Operation["Read, preview, or write"]
    Check -->|No| Reject["Reject: Outside sandbox"]

    Root["SAFE_ROOT boundary"] -.-> Check
```

Agent file reads are limited to 4 MB, browser file reads to 2 MB, and JSON
request bodies to 16 MB. New paths are checked through their closest existing
ancestor so a symlink cannot be used to escape `SAFE_ROOT`.

`SAFE_ROOT` constrains the file APIs only. Bash commands run as the server's OS
user and are not sandboxed, even when launched through the approval flow.

## Configuration

Browser-only settings live in `ui-config.json`. Set
`requestProgressDelaySeconds` to the number of seconds a chat request may run
before its spinner, progress bar, and elapsed timer appear.

| Variable | Default | Purpose |
|---|---|---|
| `GLM_BASE_URL` | `http://localhost:11434` | OpenAI-compatible endpoint base URL |
| `GLM_MODEL` | `qwen2.5-coder:7b` | Initial model for new sessions |
| `GLM_TIMEOUT_MS` | `120000` | Chat request timeout; minimum 1000 ms |
| `GLM_FIRST_BYTE_TIMEOUT_MS` | `90000` | Time allowed for a model stream to begin; minimum 1000 ms |
| `GLM_MAX_TOKENS` | `4096` | Completion token limit; minimum 256 |
| `GLM_HISTORY_MESSAGES` | `40` | Recent chat messages forwarded; minimum 4 |
| `SAFE_ROOT` | `$HOME` | Root allowed by browser and agent file APIs |
| `NODEGLM_MEMORY_FILE` | `$SAFE_ROOT/.nodeglm-memory.json` | Persisted explicit fact memory |
| `PORT` | `3001` | HTTP port |
| `HOST` | `127.0.0.1` | HTTP bind address |
| `GLM_ALLOWED_ORIGINS` | local app URLs and `null` | Comma-separated CORS and WebSocket origins |
| `MODEL_CACHE_ROOT` | `~/.models` | Cache root created by `./s` |
| `OLLAMA_MODELS` | `~/.models/ollama` | Ollama cache exported by `./s` |
| `OLLAMA_CONTEXT_LENGTH` | `2048` | Context limit used by launcher-managed Ollama |
| `OLLAMA_KV_CACHE_TYPE` | `q8_0` | Lower-memory KV cache used by launcher-managed Ollama |
| `OLLAMA_GPU_OVERHEAD` | `1073741824` | VRAM reserved so Ollama can offload layers instead of overcommitting |
| `OLLAMA_MAX_LOADED_MODELS` | `1` | Prevent multiple models competing for VRAM |
| `OLLAMA_NUM_PARALLEL` | `1` | Prevent concurrent requests duplicating context memory |
| `HF_HOME` | `~/.models/hf` | Hugging Face cache exported by `./s` |
| `MS_DIR` | `~/local/repos/CppLmmModelStore` | CppLmmModelStore checkout reported by the UI |
| `DEEPSEEK_MODEL_HOME` | platform data directory | ModelStore directory listed by the UI |
| `KAI_DIR` | `Ext/CppKAI` | CppKAI checkout |
| `ENET_DIR` | `Ext/ENet` | ENet checkout linked into CppKAI when needed |
| `KAI_CONSOLE` | `Ext/CppKAI/Bin/Console` | CppKAI console executable |

The model selector lists models returned by the active endpoint. Selecting a
model changes only the current browser session; it does not install or load a
model on the inference server.

## API

See [API.md](API.md) for the complete NodeGLM API reference, including HTTP
endpoints, Server-Sent Events, model-install NDJSON, the CppKAI WebSocket
protocol, static routes, request/response shapes, status codes, limits, and the
upstream OpenAI-compatible model API contract.

## CppKAI Runtime Views

Pi, Rho, Debug, and Tree are views over one session-owned CppKAI runtime. The
runtime survives panel and websocket reconnections and expires with the browser
session. Pi prints the complete data stack after each command. Stack entries
are shown top-first, with `[0]` on the physical bottom line; floating-point
values use the normal neutral value color.

Debug and Tree never assume a single Executor. Each has an independent dropdown
populated from all live `Executor` objects in the runtime Registry:

- **Debug** targets `step`, `continue`, `stack`, and `clear` actions at the
  selected Executor handle.
- **Tree** renders the selected Executor's own `Tree*`, root, scope, and bounded
  child hierarchy.

The websocket accepts request-ID-correlated `inspect_tree` and validated
`debug_action` messages. Requests and newline-delimited JSON responses share a
dedicated duplex control file descriptor; stdout and stderr remain terminal
streams. KAI initializes its native `Logger`; snapshot lifecycle, debugger
attachments and actions, and failures are recorded through that logging system.

## Security

The server binds to loopback by default. Do not bind `HOST` to a network
interface without adding authentication, transport security, and OS-level
process isolation. In particular:

- Bash can access anything available to the server user; `SAFE_ROOT` does not
  restrict shell commands.
- Browser editor saves are direct writes and do not use the agent diff approval
  flow.
- Fact memory is persisted as plaintext JSON. Keep `SAFE_ROOT` or
  `NODEGLM_MEMORY_FILE` on local storage you trust, and clear memory before
  sharing a workspace.
- CORS is an origin check, not authentication.
- The CppKAI WebSocket starts a local executable with the server user's
  permissions.

## Tests

```bash
npm test
```

The Node test suite covers API validation, path traversal and symlink defenses,
session isolation, working-directory propagation, model selection, fact-memory
extraction and clearing, write diffs, executor inspection/debug wiring, Tree
rendering, UI wiring, and editor configuration. The Edge end-to-end test runs only when
Edge and `msedgedriver` are available on `PATH`; set `EDGE_BIN` and
`MSEDGEDRIVER` to use explicit executable paths.

## Troubleshooting

- **No models found:** verify that `GLM_BASE_URL/v1/models` returns an
  OpenAI-compatible model list.
- **CUDA buffer allocation fails:** close other GPU-heavy applications, stop any
  already-running Ollama daemon, and restart with `./s` so the 2048-token
  context, quantized KV cache, single-model loading, and CPU offload settings
  apply. If `qwen2.5-coder:7b` still cannot allocate on an 8 GB card, choose a
  smaller installed model from the header.
- **Ollama model is not installed:** run `ollama pull <model>` before `./s`.
- **Port already in use:** stop the existing server or set another `PORT`.
- **Outside sandbox:** choose a path under `SAFE_ROOT`; symlink escapes are
  intentionally rejected.
- **Wrong remembered fact:** click **Clear memory** in the chat footer, or edit
  or remove `.nodeglm-memory.json` under `SAFE_ROOT` while the server is stopped.
- **CppKAI Console is not built:** initialize the submodules and build the
  executable configured by `KAI_CONSOLE`.
- **Origin not allowed:** add the exact browser origin to
  `GLM_ALLOWED_ORIGINS`.
