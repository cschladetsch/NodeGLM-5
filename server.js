/**
 * GLM-5.2 Dev Server
 * Proxies chat to local GLM (SGLang/vLLM OpenAI-compat endpoint),
 * exposes filesystem browsing and a sandboxed shell REPL.
 *
 * Usage:
 *   GLM_BASE_URL=http://localhost:30000 node server.js
 */

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const { exec, spawn } = require('child_process');
const http    = require('http');
const { WebSocketServer } = require('ws');

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

const GLM_BASE_URL = process.env.GLM_BASE_URL || 'http://localhost:30000';
const SAFE_ROOT    = process.env.SAFE_ROOT    || process.env.HOME || '/tmp';
const PORT         = process.env.PORT         || 3001;

// ── helpers ────────────────────────────────────────────────────────────────

function safePath(rel) {
  const abs = path.resolve(SAFE_ROOT, rel || '');
  if (!abs.startsWith(SAFE_ROOT)) throw new Error('Path traversal denied');
  return abs;
}

// ── GLM proxy ──────────────────────────────────────────────────────────────

/**
 * POST /api/chat
 * Body: standard OpenAI messages array + optional params
 * Streams SSE back to client.
 */
app.post('/api/chat', async (req, res) => {
  const { messages, model, temperature, max_tokens, reasoning_effort } = req.body;

  const payload = JSON.stringify({
    model:            model            || 'GLM-5.2',
    messages,
    temperature:      temperature      ?? 0.7,
    max_tokens:       max_tokens       ?? 4096,
    stream:           true,
    reasoning_effort: reasoning_effort || undefined,
  });

  const url    = new URL('/v1/chat/completions', GLM_BASE_URL);
  const isHttps = url.protocol === 'https:';
  const lib    = isHttps ? require('https') : http;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const opts = {
    hostname: url.hostname,
    port:     url.port || (isHttps ? 443 : 80),
    path:     url.pathname,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  };

  const upstream = lib.request(opts, (uRes) => {
    uRes.on('data', chunk => res.write(chunk));
    uRes.on('end',  ()    => res.end());
  });

  upstream.on('error', (err) => {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  });

  upstream.write(payload);
  upstream.end();
});

// ── filesystem ────────────────────────────────────────────────────────────

app.get('/api/fs/list', (req, res) => {
  try {
    const abs = safePath(req.query.path || '');
    const entries = fs.readdirSync(abs, { withFileTypes: true }).map(e => ({
      name:  e.name,
      type:  e.isDirectory() ? 'dir' : 'file',
      size:  e.isFile() ? fs.statSync(path.join(abs, e.name)).size : null,
      mtime: fs.statSync(path.join(abs, e.name)).mtime,
    }));
    res.json({ path: path.relative(SAFE_ROOT, abs) || '.', entries });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/fs/read', (req, res) => {
  try {
    const abs = safePath(req.query.path);
    const stat = fs.statSync(abs);
    if (stat.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'File > 2 MB; use /api/fs/read?path=...&start=N&end=M' });
    const content = fs.readFileSync(abs, 'utf8');
    res.json({ path: req.query.path, content });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/fs/write', (req, res) => {
  try {
    const abs = safePath(req.body.path);
    fs.writeFileSync(abs, req.body.content, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── REPL (HTTP, one-shot) ──────────────────────────────────────────────────

app.post('/api/repl/exec', (req, res) => {
  const { cmd, cwd, timeout } = req.body;
  if (!cmd) return res.status(400).json({ error: 'cmd required' });

  const safeCwd = (() => { try { return safePath(cwd || ''); } catch { return SAFE_ROOT; } })();
  const ms      = Math.min(timeout || 10000, 30000);

  exec(cmd, { cwd: safeCwd, timeout: ms, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
    res.json({
      stdout: stdout || '',
      stderr: stderr || '',
      exitCode: err ? (err.code ?? 1) : 0,
    });
  });
});

// ── WebSocket streaming REPL ───────────────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/api/repl/stream' });

wss.on('connection', (ws) => {
  let proc = null;

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);

    if (msg.type === 'start') {
      const safeCwd = (() => { try { return safePath(msg.cwd || ''); } catch { return SAFE_ROOT; } })();
      proc = spawn(msg.shell || '/bin/bash', [], { cwd: safeCwd });

      proc.stdout.on('data', d => ws.send(JSON.stringify({ type: 'stdout', data: d.toString() })));
      proc.stderr.on('data', d => ws.send(JSON.stringify({ type: 'stderr', data: d.toString() })));
      proc.on('close',  code => ws.send(JSON.stringify({ type: 'exit', code })));

      ws.send(JSON.stringify({ type: 'ready', pid: proc.pid }));
    }

    if (msg.type === 'input' && proc) {
      proc.stdin.write(msg.data);
    }

    if (msg.type === 'kill' && proc) {
      proc.kill();
    }
  });

  ws.on('close', () => { if (proc) proc.kill(); });
});

// ── health ────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => res.json({ ok: true, glm: GLM_BASE_URL, root: SAFE_ROOT }));

server.listen(PORT, () => console.log(`GLM dev-server on :${PORT}  →  GLM @ ${GLM_BASE_URL}  root=${SAFE_ROOT}`));
