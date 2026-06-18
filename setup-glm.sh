#!/usr/bin/env bash
set -e

DIR="$HOME/local/repos/glm-repl"
mkdir -p "$DIR"
cd "$DIR"

# ── package.json ──────────────────────────────────────────────────────────────
cat > package.json << 'PKGJSON'
{
  "name": "glm-repl-server",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "dev": "node server.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.19.2",
    "ws": "^8.17.0"
  }
}
PKGJSON

# ── server.js ─────────────────────────────────────────────────────────────────
cat > server.js << 'SERVERJS'
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

function safePath(rel) {
  const abs = path.resolve(SAFE_ROOT, rel || '');
  if (!abs.startsWith(SAFE_ROOT)) throw new Error('Path traversal denied');
  return abs;
}

// GLM proxy — streams SSE
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

  const url = new URL('/v1/chat/completions', GLM_BASE_URL);
  const lib = url.protocol === 'https:' ? require('https') : http;

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');

  const opts = {
    hostname: url.hostname,
    port:     url.port || (url.protocol === 'https:' ? 443 : 80),
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

// Filesystem
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
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/fs/read', (req, res) => {
  try {
    const abs  = safePath(req.query.path);
    const stat = fs.statSync(abs);
    if (stat.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'File > 2 MB' });
    res.json({ path: req.query.path, content: fs.readFileSync(abs, 'utf8') });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/fs/write', (req, res) => {
  try {
    fs.writeFileSync(safePath(req.body.path), req.body.content, 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// One-shot REPL
app.post('/api/repl/exec', (req, res) => {
  const { cmd, cwd, timeout } = req.body;
  if (!cmd) return res.status(400).json({ error: 'cmd required' });
  const safeCwd = (() => { try { return safePath(cwd || ''); } catch { return SAFE_ROOT; } })();
  exec(cmd, { cwd: safeCwd, timeout: Math.min(timeout || 10000, 30000), maxBuffer: 512 * 1024 },
    (err, stdout, stderr) => res.json({ stdout: stdout||'', stderr: stderr||'', exitCode: err ? (err.code??1) : 0 })
  );
});

// Streaming WebSocket REPL
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/api/repl/stream' });
wss.on('connection', (ws) => {
  let proc = null;
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'start') {
      const safeCwd = (() => { try { return safePath(msg.cwd||''); } catch { return SAFE_ROOT; } })();
      proc = spawn(msg.shell || '/bin/bash', [], { cwd: safeCwd });
      proc.stdout.on('data', d => ws.send(JSON.stringify({ type:'stdout', data: d.toString() })));
      proc.stderr.on('data', d => ws.send(JSON.stringify({ type:'stderr', data: d.toString() })));
      proc.on('close', code => ws.send(JSON.stringify({ type:'exit', code })));
      ws.send(JSON.stringify({ type:'ready', pid: proc.pid }));
    }
    if (msg.type === 'input' && proc) proc.stdin.write(msg.data);
    if (msg.type === 'kill'  && proc) proc.kill();
  });
  ws.on('close', () => { if (proc) proc.kill(); });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, glm: GLM_BASE_URL, root: SAFE_ROOT }));

server.listen(PORT, () =>
  console.log(`\n  GLM dev-server :${PORT}  →  GLM @ ${GLM_BASE_URL}  root=${SAFE_ROOT}\n`)
);
SERVERJS

# ── index.html ────────────────────────────────────────────────────────────────
cat > index.html << 'INDEXHTML'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>GLM-5.2 · Dev Console</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.24.5/babel.min.js"></script>
<style>
:root{--bg:#0c0c0f;--surface:#13131a;--raised:#1b1b26;--border:#2a2a3d;--accent:#7c6af7;--accent2:#34c8a0;--warn:#e07060;--text:#ddddf4;--muted:#6868a8;--mono:'JetBrains Mono','Fira Code',monospace;--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--radius:6px;--sidebar-w:220px}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--sans);font-size:14px;height:100vh;overflow:hidden;display:flex;flex-direction:column}
.header{display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;user-select:none}
.header-logo{font-size:18px;font-weight:700;letter-spacing:-.5px;color:var(--accent)}
.header-model{font-size:11px;color:var(--muted);font-family:var(--mono)}
.header-dot{width:8px;height:8px;border-radius:50%;background:#444;transition:background .4s;margin-left:auto}
.header-status{font-size:11px;color:var(--muted)}
.tabs{display:flex;gap:2px;padding:0 16px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0}
.tab{padding:8px 16px;cursor:pointer;font-size:12px;font-weight:600;letter-spacing:.5px;color:var(--muted);border-bottom:2px solid transparent;transition:color .15s,border-color .15s;text-transform:uppercase}
.tab.active{color:var(--text);border-bottom-color:var(--accent)}
.tab:hover:not(.active){color:var(--text)}
.workspace{display:flex;flex:1;overflow:hidden}
.sidebar{width:var(--sidebar-w);background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;flex-shrink:0}
.sidebar-header{padding:8px 12px;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}
.sidebar-path{padding:4px 12px;font-size:10px;font-family:var(--mono);color:var(--muted);background:var(--raised);border-bottom:1px solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sidebar-list{flex:1;overflow-y:auto;padding:4px 0}
.sidebar-entry{display:flex;align-items:center;gap:6px;padding:4px 12px;cursor:pointer;font-size:12px;font-family:var(--mono);color:var(--text);transition:background .1s;white-space:nowrap;overflow:hidden}
.sidebar-entry:hover{background:var(--raised)}
.sidebar-entry.selected{background:#2020358f;color:var(--accent)}
.sidebar-entry .name{overflow:hidden;text-overflow:ellipsis;flex:1}
.sidebar-entry .size{font-size:10px;color:var(--muted);flex-shrink:0}
.sidebar-inject{padding:8px;border-top:1px solid var(--border)}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.chat-messages{flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:16px}
.msg{display:flex;gap:12px;max-width:860px;width:100%;align-self:flex-start}
.msg.user{align-self:flex-end;flex-direction:row-reverse}
.msg-avatar{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;background:var(--accent);color:#fff}
.msg.user .msg-avatar{background:var(--raised);color:var(--muted)}
.msg-body{background:var(--raised);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;line-height:1.6;max-width:78%}
.msg.user .msg-body{background:#20203a;border-color:#3535608f}
.msg-body pre{background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:10px 12px;margin:8px 0;overflow-x:auto;font-family:var(--mono);font-size:12px;line-height:1.5}
.msg-body code{font-family:var(--mono);font-size:12px;background:#1a1a2e;padding:1px 4px;border-radius:3px}
.msg-body pre code{background:transparent;padding:0}
.thinking{font-size:11px;color:var(--muted);font-style:italic;border-left:2px solid var(--border);padding-left:8px;margin-bottom:8px}
.file-pill{display:inline-flex;align-items:center;gap:4px;background:#1e1e30;border:1px solid var(--border);border-radius:12px;padding:2px 8px;font-size:11px;font-family:var(--mono);color:var(--accent);margin-bottom:8px}
.file-pill button{background:none;border:none;color:var(--warn);cursor:pointer;padding:0 2px;font-size:13px;line-height:1}
.chat-input-area{padding:12px 24px 16px;border-top:1px solid var(--border);background:var(--surface);flex-shrink:0}
.chat-input-files{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.chat-input-row{display:flex;gap:8px;align-items:flex-end}
.chat-input-row textarea{flex:1;background:var(--raised);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--sans);font-size:14px;padding:10px 14px;resize:none;outline:none;min-height:44px;max-height:180px;transition:border-color .15s;line-height:1.5}
.chat-input-row textarea:focus{border-color:var(--accent)}
.btn{padding:10px 16px;border-radius:var(--radius);border:none;cursor:pointer;font-size:13px;font-weight:600;transition:opacity .15s,background .15s}
.btn:disabled{opacity:.4;cursor:default}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:not(:disabled):hover{opacity:.85}
.btn-ghost{background:var(--raised);color:var(--text);border:1px solid var(--border)}
.btn-ghost:not(:disabled):hover{border-color:var(--accent);color:var(--accent)}
.effort-row{display:flex;align-items:center;gap:8px;margin-top:8px}
.effort-label{font-size:11px;color:var(--muted)}
.effort-btn{padding:2px 8px;border-radius:10px;border:1px solid var(--border);background:none;color:var(--muted);font-size:11px;cursor:pointer;transition:all .15s}
.effort-btn.active{border-color:var(--accent);color:var(--accent);background:#2020388f}
.repl-panel{flex:1;display:flex;flex-direction:column;overflow:hidden}
.repl-toolbar{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0}
.repl-cwd{font-size:11px;font-family:var(--mono);color:var(--muted);flex:1}
.repl-output{flex:1;overflow-y:auto;padding:12px 16px;font-family:var(--mono);font-size:12px;line-height:1.6;background:var(--bg)}
.repl-line{display:flex;gap:8px}
.repl-line.cmd{color:var(--accent2);margin-top:6px}
.repl-line.out{color:var(--text)}
.repl-line.err{color:var(--warn)}
.repl-line.info{color:var(--muted);font-style:italic}
.repl-prompt{color:var(--muted)}
.repl-input-row{display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid var(--border);background:var(--surface);flex-shrink:0}
.repl-input-row input{flex:1;background:var(--raised);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--mono);font-size:13px;padding:8px 12px;outline:none;transition:border-color .15s}
.repl-input-row input:focus{border-color:var(--accent2)}
.file-viewer{flex:1;overflow:hidden;display:flex;flex-direction:column}
.file-viewer-header{padding:8px 16px;border-bottom:1px solid var(--border);background:var(--surface);font-family:var(--mono);font-size:12px;color:var(--muted);display:flex;align-items:center;gap:8px;flex-shrink:0}
.file-viewer-content{flex:1;overflow:auto;background:var(--bg);padding:16px;font-family:var(--mono);font-size:12px;line-height:1.7;white-space:pre;color:var(--text)}
.file-viewer-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px;flex-direction:column;gap:8px}
.file-viewer-empty .big{font-size:32px}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--muted)}
.md-h1,.md-h2,.md-h3{font-weight:700;margin:8px 0 4px;line-height:1.3}
.md-h1{font-size:18px}.md-h2{font-size:15px}.md-h3{font-size:13px}
.md-p{margin:4px 0}.md-ul{padding-left:20px;margin:4px 0}.md-li{margin:2px 0}
.md-hr{border:none;border-top:1px solid var(--border);margin:10px 0}
.md-blockquote{border-left:3px solid var(--accent);padding-left:10px;color:var(--muted);margin:6px 0}
</style>
</head>
<body>
<div id="root"></div>
<script type="text/babel">
const { useState, useEffect, useRef, useCallback } = React;
const API = 'http://localhost:3001';

function renderMarkdown(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const out = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) { code.push(lines[i]); i++; }
      out.push(<pre key={i}><code>{code.join('\n')}</code></pre>);
    } else if (line.startsWith('### ')) { out.push(<div key={i} className="md-h3">{inl(line.slice(4))}</div>);
    } else if (line.startsWith('## '))  { out.push(<div key={i} className="md-h2">{inl(line.slice(3))}</div>);
    } else if (line.startsWith('# '))   { out.push(<div key={i} className="md-h1">{inl(line.slice(2))}</div>);
    } else if (line.startsWith('> '))   { out.push(<div key={i} className="md-blockquote">{inl(line.slice(2))}</div>);
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      const items = [];
      while (i < lines.length && (lines[i].startsWith('- ')||lines[i].startsWith('* '))) {
        items.push(<li key={i} className="md-li">{inl(lines[i].slice(2))}</li>); i++;
      }
      out.push(<ul key={`ul${i}`} className="md-ul">{items}</ul>); continue;
    } else if (line.trim()==='---') { out.push(<hr key={i} className="md-hr"/>);
    } else if (line.trim()==='')   { out.push(<br key={i}/>);
    } else { out.push(<div key={i} className="md-p">{inl(line)}</div>); }
    i++;
  }
  return out;
}

function inl(text) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g).map((p,i) => {
    if (p.startsWith('**')&&p.endsWith('**')) return <strong key={i}>{p.slice(2,-2)}</strong>;
    if (p.startsWith('*')&&p.endsWith('*'))   return <em key={i}>{p.slice(1,-1)}</em>;
    if (p.startsWith('`')&&p.endsWith('`'))   return <code key={i}>{p.slice(1,-1)}</code>;
    return p;
  });
}

function fmt(b) {
  if (b==null) return '';
  if (b<1024) return b+'B';
  if (b<1048576) return (b/1024).toFixed(1)+'K';
  return (b/1048576).toFixed(1)+'M';
}

function FileBrowser({ onInject, onOpenFile }) {
  const [curPath, setCurPath] = useState('');
  const [entries, setEntries] = useState([]);
  const [selected, setSelected] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback((p) => {
    setErr(null);
    fetch(`${API}/api/fs/list?path=${encodeURIComponent(p)}`)
      .then(r=>r.json())
      .then(d=>{ if(d.error){setErr(d.error)}else{setEntries(d.entries);setCurPath(d.path)} })
      .catch(e=>setErr(e.message));
  }, []);

  useEffect(()=>{ load(''); },[load]);

  const click = (e) => {
    if (e.type==='dir') { load(curPath==='.'?e.name:`${curPath}/${e.name}`); }
    else {
      const fp = curPath==='.'?e.name:`${curPath}/${e.name}`;
      setSelected(fp); onOpenFile(fp);
    }
  };

  const goUp = () => { const p=curPath.split('/').filter(Boolean); p.pop(); load(p.join('/')||''); };

  return (
    <div className="sidebar">
      <div className="sidebar-header">📁 Files</div>
      <div className="sidebar-path" title={curPath}>~/{curPath}</div>
      {err && <div style={{padding:'8px 12px',color:'var(--warn)',fontSize:11}}>{err}</div>}
      <div className="sidebar-list">
        {curPath && curPath!=='.' && (
          <div className="sidebar-entry" onClick={goUp}>
            <span>↑</span><span className="name">..</span>
          </div>
        )}
        {entries.map(e=>{
          const fp = curPath==='.'?e.name:`${curPath}/${e.name}`;
          return (
            <div key={e.name} className={`sidebar-entry${selected===fp?' selected':''}`} onClick={()=>click(e)} title={e.name}>
              <span>{e.type==='dir'?'📂':'📄'}</span>
              <span className="name">{e.name}</span>
              {e.type==='file'&&<span className="size">{fmt(e.size)}</span>}
            </div>
          );
        })}
        {entries.length===0&&!err&&<div style={{padding:'8px 12px',color:'var(--muted)',fontSize:11}}>Empty</div>}
      </div>
      {selected && (
        <div className="sidebar-inject">
          <button className="btn btn-ghost" style={{width:'100%',fontSize:11,padding:'6px 8px'}} onClick={()=>onInject(selected)}>
            ↗ Inject to chat
          </button>
        </div>
      )}
    </div>
  );
}

function ReplPanel() {
  const [lines, setLines] = useState([{type:'info',text:'Shell REPL — commands run on your machine.'}]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [replCwd, setReplCwd] = useState('');
  const outRef = useRef(null);

  useEffect(()=>{ if(outRef.current) outRef.current.scrollTop=outRef.current.scrollHeight; },[lines]);

  const run = async (cmd) => {
    if (!cmd.trim()) return;
    setHistory(h=>[cmd,...h.slice(0,49)]); setHistIdx(-1);
    setLines(l=>[...l,{type:'cmd',text:cmd}]); setRunning(true);
    try {
      const r = await fetch(`${API}/api/repl/exec`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({cmd, cwd:replCwd, timeout:15000}),
      });
      const d = await r.json();
      if(d.stdout) d.stdout.split('\n').filter(Boolean).forEach(l=>setLines(ls=>[...ls,{type:'out',text:l}]));
      if(d.stderr) d.stderr.split('\n').filter(Boolean).forEach(l=>setLines(ls=>[...ls,{type:'err',text:l}]));
      setLines(ls=>[...ls,{type:'info',text:`exit ${d.exitCode}`}]);
      if (cmd.trim().startsWith('cd ')) {
        const dir = cmd.trim().slice(3).trim();
        setReplCwd(p=>dir.startsWith('/')?dir:(p?`${p}/${dir}`:dir));
      }
    } catch(e) { setLines(ls=>[...ls,{type:'err',text:e.message}]); }
    setRunning(false);
  };

  const onKey = (e) => {
    if (e.key==='Enter') { run(input); setInput(''); }
    else if (e.key==='ArrowUp') { const i=Math.min(histIdx+1,history.length-1); setHistIdx(i); setInput(history[i]||''); }
    else if (e.key==='ArrowDown') { const i=Math.max(histIdx-1,-1); setHistIdx(i); setInput(i===-1?'':history[i]); }
  };

  return (
    <div className="repl-panel">
      <div className="repl-toolbar">
        <span>⚡</span>
        <span className="repl-cwd">{replCwd||'~'}</span>
        <button className="btn btn-ghost" style={{fontSize:11,padding:'4px 8px'}} onClick={()=>setLines([{type:'info',text:'Cleared.'}])}>Clear</button>
      </div>
      <div className="repl-output" ref={outRef}>
        {lines.map((l,i)=>(
          <div key={i} className={`repl-line ${l.type}`}>
            {l.type==='cmd'&&<span className="repl-prompt">$</span>}
            <span>{l.text}</span>
          </div>
        ))}
        {running&&<div className="repl-line info"><span className="repl-prompt">▶</span><span>running…</span></div>}
      </div>
      <div className="repl-input-row">
        <span style={{color:'var(--accent2)',fontFamily:'var(--mono)',fontSize:13}}>$</span>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={onKey}
          placeholder="enter command…" disabled={running} autoFocus/>
        <button className="btn btn-ghost" style={{fontSize:12,padding:'7px 12px'}}
          onClick={()=>{run(input);setInput('');}} disabled={running||!input.trim()}>Run</button>
      </div>
    </div>
  );
}

function FileViewerPanel({ filePath }) {
  const [content, setContent] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(()=>{
    if (!filePath) { setContent(null); setErr(null); return; }
    setLoading(true); setErr(null); setContent(null);
    fetch(`${API}/api/fs/read?path=${encodeURIComponent(filePath)}`)
      .then(r=>r.json())
      .then(d=>{ if(d.error)setErr(d.error); else setContent(d.content); })
      .catch(e=>setErr(e.message))
      .finally(()=>setLoading(false));
  },[filePath]);

  if (!filePath) return (
    <div className="file-viewer-empty"><span className="big">📂</span><span>Select a file to view</span></div>
  );
  return (
    <div className="file-viewer">
      <div className="file-viewer-header">
        <span>📄</span>
        <span style={{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{filePath}</span>
        {content!=null&&<span style={{fontSize:10}}>{content.split('\n').length} lines</span>}
      </div>
      {loading&&<div className="file-viewer-empty"><span>Loading…</span></div>}
      {err&&<div className="file-viewer-empty" style={{color:'var(--warn)'}}><span>{err}</span></div>}
      {content!=null&&<div className="file-viewer-content">{content}</div>}
    </div>
  );
}

function ChatPanel({ injectedFile, onClearInject }) {
  const [messages, setMessages] = useState([
    {role:'assistant',content:'GLM-5.2 ready. Ask anything or inject a local file to discuss it.'}
  ]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [effort, setEffort] = useState('max');
  const [attached, setAttached] = useState([]);
  const endRef = useRef(null);
  const taRef  = useRef(null);

  useEffect(()=>{
    if (injectedFile) { setAttached(f=>f.includes(injectedFile)?f:[...f,injectedFile]); onClearInject(); }
  },[injectedFile]);

  useEffect(()=>{ endRef.current?.scrollIntoView({behavior:'smooth'}); },[messages]);

  useEffect(()=>{
    if (taRef.current) { taRef.current.style.height='auto'; taRef.current.style.height=Math.min(taRef.current.scrollHeight,180)+'px'; }
  },[input]);

  const send = async () => {
    if (!input.trim() && attached.length===0) return;
    if (streaming) return;
    let context = '';
    for (const fp of attached) {
      try {
        const r = await fetch(`${API}/api/fs/read?path=${encodeURIComponent(fp)}`);
        const d = await r.json();
        if (d.content) context += `\n\n<file path="${fp}">\n${d.content.slice(0,8000)}\n</file>`;
      } catch {}
    }
    const userContent = context ? `${input}\n${context}` : input;
    const displayMsg  = {role:'user', content:input, files:[...attached]};
    const userMsg     = {role:'user', content:userContent};
    setMessages(m=>[...m, displayMsg]);
    setInput(''); setAttached([]);
    const apiMessages = [
      ...messages.map(m=>({role:m.role, content:typeof m.content==='string'?m.content:m.content})),
      userMsg
    ];
    setStreaming(true);
    setMessages(m=>[...m,{role:'assistant',content:'',thinking:''}]);
    try {
      const res = await fetch(`${API}/api/chat`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ messages:apiMessages, reasoning_effort: effort==='off'?undefined:effort }),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder(); let buf='';
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        buf += dec.decode(value,{stream:true});
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw==='[DONE]') continue;
          try {
            const obj = JSON.parse(raw);
            const delta = obj.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.reasoning_content) setMessages(m=>{const c=[...m];c[c.length-1]={...c[c.length-1],thinking:(c[c.length-1].thinking||'')+delta.reasoning_content};return c;});
            if (delta.content) setMessages(m=>{const c=[...m];c[c.length-1]={...c[c.length-1],content:c[c.length-1].content+delta.content};return c;});
          } catch {}
        }
      }
    } catch(e) { setMessages(m=>{const c=[...m];c[c.length-1]={...c[c.length-1],content:`Error: ${e.message}`};return c;}); }
    setStreaming(false);
  };

  const onKeyDown = (e) => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();} };

  return (
    <div className="main">
      <div style={{display:'flex',alignItems:'center',gap:8,padding:'8px 24px',borderBottom:'1px solid var(--border)',background:'var(--surface)',fontSize:12,color:'var(--muted)',flexShrink:0}}>
        <span>GLM-5.2 · 1M context · MIT</span>
        <button className="btn btn-ghost" style={{marginLeft:'auto',fontSize:11,padding:'3px 8px'}}
          onClick={()=>setMessages([{role:'assistant',content:'Chat cleared.'}])}>Clear</button>
      </div>
      <div className="chat-messages">
        {messages.map((msg,i)=>(
          <div key={i} className={`msg ${msg.role}`}>
            <div className="msg-avatar">{msg.role==='user'?'U':'G'}</div>
            <div>
              {msg.files&&msg.files.length>0&&(
                <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:6}}>
                  {msg.files.map(f=><span key={f} className="file-pill">📄 {f.split('/').pop()}</span>)}
                </div>
              )}
              <div className="msg-body">
                {msg.thinking&&(
                  <div className="thinking">
                    <strong>Thinking</strong>
                    <div>{msg.thinking.length>300?msg.thinking.slice(0,300)+'…':msg.thinking}</div>
                  </div>
                )}
                {renderMarkdown(msg.content)}
                {msg.role==='assistant'&&streaming&&i===messages.length-1&&!msg.content&&<span style={{color:'var(--muted)'}}>▌</span>}
              </div>
            </div>
          </div>
        ))}
        <div ref={endRef}/>
      </div>
      <div className="chat-input-area">
        {attached.length>0&&(
          <div className="chat-input-files">
            {attached.map(f=>(
              <span key={f} className="file-pill">📄 {f.split('/').pop()}
                <button onClick={()=>setAttached(a=>a.filter(x=>x!==f))}>×</button>
              </span>
            ))}
          </div>
        )}
        <div className="chat-input-row">
          <textarea ref={taRef} value={input} onChange={e=>setInput(e.target.value)}
            onKeyDown={onKeyDown} placeholder="Message GLM-5.2… (Shift+Enter for newline)"
            disabled={streaming} rows={1}/>
          <button className="btn btn-primary" onClick={send}
            disabled={streaming||(!input.trim()&&attached.length===0)}>
            {streaming?'…':'↑'}
          </button>
        </div>
        <div className="effort-row">
          <span className="effort-label">Thinking:</span>
          {['max','high','off'].map(e=>(
            <button key={e} className={`effort-btn${effort===e?' active':''}`} onClick={()=>setEffort(e)}>{e}</button>
          ))}
          <span className="effort-label" style={{marginLeft:8}}>
            {effort==='max'?'Full reasoning':effort==='high'?'High (faster)':'Disabled'}
          </span>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [tab, setTab]         = useState('chat');
  const [status, setStatus]   = useState('checking');
  const [injected, setInj]    = useState(null);
  const [viewFile, setVF]     = useState(null);

  useEffect(()=>{
    const check = () => fetch(`${API}/api/health`).then(()=>setStatus('online')).catch(()=>setStatus('error'));
    check();
    const t = setInterval(check,8000);
    return ()=>clearInterval(t);
  },[]);

  const dotColor = status==='online'?'var(--accent2)':status==='error'?'var(--warn)':'#555';
  const dotShadow = status==='online'?'0 0 6px var(--accent2)':undefined;

  return (
    <>
      <div className="header">
        <span className="header-logo">GLM</span>
        <span className="header-model">5.2 · local</span>
        <span className="header-dot" style={{background:dotColor,boxShadow:dotShadow,marginLeft:'auto'}}/>
        <span className="header-status">{status}</span>
      </div>
      <div className="tabs">
        {[['chat','💬 Chat'],['repl','⚡ REPL'],['files','📂 Files']].map(([t,label])=>(
          <div key={t} className={`tab${tab===t?' active':''}`} onClick={()=>setTab(t)}>{label}</div>
        ))}
      </div>
      <div className="workspace">
        <FileBrowser onInject={fp=>{setInj(fp);setTab('chat');}} onOpenFile={setVF}/>
        <div className="main">
          {tab==='chat'  && <ChatPanel injectedFile={injected} onClearInject={()=>setInj(null)}/>}
          {tab==='repl'  && <ReplPanel/>}
          {tab==='files' && <FileViewerPanel filePath={viewFile}/>}
        </div>
      </div>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
</script>
</body>
</html>
INDEXHTML

# ── install and start ─────────────────────────────────────────────────────────
echo ""
echo "  Installing dependencies…"
npm install --silent

echo ""
echo "  ✓ glm-repl installed at $DIR"
echo ""
echo "  Open $DIR/index.html in your browser, then:"
echo "  GLM_BASE_URL=http://localhost:30000 node server.js"
echo ""

# Start the server (override GLM endpoint via env)
GLM_BASE_URL="${GLM_BASE_URL:-http://localhost:30000}" \
SAFE_ROOT="${SAFE_ROOT:-$HOME}" \
node server.js
