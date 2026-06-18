#!/usr/bin/env bash
# glm-code — agentic coding assistant, GLM-4 9B local
set -e

DIR="$HOME/local/repos/glm-code"
MODEL="glm4:9b"
OLLAMA_PORT=11434
NODE_PORT=3001
MS_DIR="$HOME/local/repos/CppLmmModelStore"

G="\033[32m"; B="\033[34m"; R="\033[31m"; X="\033[0m"
ok()   { echo -e "${G}✓${X} $*"; }
info() { echo -e "${B}→${X} $*"; }
die()  { echo -e "${R}✗${X} $*"; exit 1; }

# ── Ollama ─────────────────────────────────────────────────────────────────
if ! command -v ollama &>/dev/null; then
  info "Installing Ollama…"; curl -fsSL https://ollama.com/install.sh | sh
fi
ok "Ollama found"

if ! curl -sf http://localhost:${OLLAMA_PORT}/api/tags &>/dev/null; then
  info "Starting ollama serve…"
  ollama serve &>/tmp/ollama.log &
  for i in $(seq 1 20); do
    sleep 1; curl -sf http://localhost:${OLLAMA_PORT}/api/tags &>/dev/null && break
    [ $i -eq 20 ] && die "Ollama failed — check /tmp/ollama.log"
  done
fi
ok "Ollama on :${OLLAMA_PORT}"

if ! ollama list 2>/dev/null | grep -q "${MODEL%:*}"; then
  info "Pulling ${MODEL} (~5.5 GB)…"; ollama pull "$MODEL"
fi
ok "Model ${MODEL} ready"

# ── CppLmmModelStore ───────────────────────────────────────────────────────
if [ ! -d "$MS_DIR" ]; then
  info "Cloning CppLmmModelStore…"
  mkdir -p "$(dirname "$MS_DIR")"
  git clone https://github.com/cschladetsch/CppLmmModelStore "$MS_DIR"
fi

if [ ! -f "$MS_DIR/build/libModelStore.a" ] && [ ! -f "$MS_DIR/build/libModelStore.so" ]; then
  info "Building CppLmmModelStore…"
  cmake -S "$MS_DIR" -B "$MS_DIR/build" -DMODELSTORE_ALLOW_FETCHCONTENT=ON -DCMAKE_BUILD_TYPE=Release -Wno-dev 2>/dev/null
  cmake --build "$MS_DIR/build" --parallel "$(nproc)" 2>/dev/null
  ok "ModelStore built"
else
  ok "ModelStore already built"
fi

# ── Node.js ────────────────────────────────────────────────────────────────
command -v node &>/dev/null || die "Node.js not found."
ok "Node $(node --version)"

# ── App files ──────────────────────────────────────────────────────────────
mkdir -p "$DIR" && cd "$DIR"

cat > package.json << 'PKGJSON'
{"name":"glm-code","version":"1.0.0","main":"server.js","dependencies":{"cors":"^2.8.5","express":"^4.19.2","ws":"^8.17.0","diff":"^5.2.0"}}
PKGJSON

# ── server.js ──────────────────────────────────────────────────────────────
cat > server.js << 'SERVERJS'
const express=require('express'),cors=require('cors'),fs=require('fs'),path=require('path'),os=require('os'),http=require('http');
const {exec}=require('child_process');
const {WebSocketServer}=require('ws');
const Diff=require('diff');

const app=express();
app.use(cors());
app.use(express.json({limit:'16mb'}));

const OLLAMA=process.env.GLM_BASE_URL||'http://localhost:11434';
const ROOT  =process.env.SAFE_ROOT   ||process.env.HOME||'/tmp';
const PORT  =process.env.PORT        ||3001;
const MODEL =process.env.GLM_MODEL   ||'glm4:9b';
const MS_DIR=process.env.MS_DIR      ||path.join(os.homedir(),'local/repos/CppLmmModelStore');

const sessions={};
function sess(sid){if(!sessions[sid])sessions[sid]={cwd:ROOT};return sessions[sid];}
function safe(p){
  const abs=path.resolve(ROOT,(p||'').replace(/^~/,os.homedir()));
  if(!abs.startsWith(ROOT))throw new Error('Outside sandbox');
  return abs;
}
function run(cmd,cwd,timeout=20000){
  return new Promise(res=>exec(cmd,{cwd,timeout,maxBuffer:2*1024*1024,shell:'/bin/bash'},
    (e,o,r)=>res({stdout:o||'',stderr:r||'',exitCode:e?(e.code??1):0})));
}

// ModelStore
function msBase(){
  return process.env.DEEPSEEK_MODEL_HOME||
    (process.env.XDG_DATA_HOME?path.join(process.env.XDG_DATA_HOME,'deepseek','models')
      :path.join(os.homedir(),'.local','share','deepseek','models'));
}
app.get('/api/modelstore',(_req,res)=>{
  const base=msBase();
  let models=[];
  try{if(fs.existsSync(base))models=fs.readdirSync(base,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name);}catch{}
  res.json({base,models,ms_dir:MS_DIR,ms_built:fs.existsSync(path.join(MS_DIR,'build'))});
});

// System prompt — tuned for GLM-4 9B's actual behaviour
// Uses a simpler JSON tool format that small models handle more reliably
const SYSTEM=`You are GLM-Code, an autonomous software engineering agent with full shell access.

To perform actions you MUST emit tool calls using this EXACT format — no other format is accepted:

TOOL:bash
CMD:the shell command here
END_TOOL

TOOL:read_file
PATH:path/to/file
END_TOOL

TOOL:write_file
PATH:path/to/file
CONTENT:
(full file content here)
END_TOOL

TOOL:done
SUMMARY:what was accomplished
END_TOOL

Rules:
- Emit ONE tool call at a time. Wait for the result before the next.
- Think step by step before acting. State your plan in plain text, then emit the tool.
- For write_file, the user will see a diff and must confirm before the file is saved.
- Read a file before writing it if you need to know its current content.
- After reading tool results, decide: continue with another tool, or emit TOOL:done.
- Never emit markdown code fences. Never explain the tool format to the user.
`;

app.post('/api/chat',(req,res)=>{
  const {messages,sid}=req.body;
  const s=sess(sid||'default');
  const last=messages[messages.length-1];
  const augmented=[...messages.slice(0,-1),{...last,content:last.content+`\n\n[cwd: ${s.cwd}]`}];
  const payload=JSON.stringify({
    model:MODEL,
    messages:[{role:'system',content:SYSTEM},...augmented],
    temperature:0.15,
    max_tokens:2048,
    stream:true,
  });
  const url=new URL('/v1/chat/completions',OLLAMA);
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  const up=http.request({hostname:url.hostname,port:url.port||80,path:url.pathname,method:'POST',
    headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},
    r=>{r.on('data',c=>res.write(c));r.on('end',()=>res.end());});
  up.on('error',e=>{res.write(`data: ${JSON.stringify({error:e.message})}\n\n`);res.end();});
  up.write(payload);up.end();
});

// Tool endpoints
app.post('/api/tool/bash',async(req,res)=>{
  const{cmd,sid}=req.body;
  if(!cmd)return res.status(400).json({error:'cmd required'});
  const s=sess(sid||'default');
  const cdm=cmd.trim().match(/^cd(?:\s+(.+))?$/);
  if(cdm){
    const tgt=(cdm[1]||'~').replace(/^~/,os.homedir());
    const resolved=path.resolve(s.cwd,tgt);
    try{
      if(!fs.statSync(resolved).isDirectory())throw new Error('not a directory');
      s.cwd=resolved;return res.json({stdout:'',stderr:'',exitCode:0,cwd:s.cwd});
    }catch{return res.json({stdout:'',stderr:`cd: ${tgt}: no such directory`,exitCode:1,cwd:s.cwd});}
  }
  const r=await run(cmd,s.cwd);
  res.json({...r,cwd:s.cwd});
});

app.post('/api/tool/read_file',(req,res)=>{
  try{
    const abs=safe(req.body.path);
    if(fs.statSync(abs).size>4*1024*1024)return res.status(413).json({error:'File > 4 MB'});
    res.json({content:fs.readFileSync(abs,'utf8'),path:abs});
  }catch(e){res.status(400).json({error:e.message});}
});

app.post('/api/tool/write_file/diff',(req,res)=>{
  try{
    const abs=safe(req.body.path);const next=req.body.content||'';
    let prev='';try{prev=fs.readFileSync(abs,'utf8');}catch{}
    res.json({path:abs,patch:Diff.createPatch(abs,prev,next,'current','proposed'),isNew:prev===''});
  }catch(e){res.status(400).json({error:e.message});}
});

app.post('/api/tool/write_file/confirm',(req,res)=>{
  try{
    const abs=safe(req.body.path);
    fs.mkdirSync(path.dirname(abs),{recursive:true});
    fs.writeFileSync(abs,req.body.content,'utf8');
    res.json({ok:true,path:abs});
  }catch(e){res.status(400).json({error:e.message});}
});

app.get('/api/fs/list',(req,res)=>{
  try{
    const abs=safe(req.query.path||'');
    const entries=fs.readdirSync(abs,{withFileTypes:true})
      .map(e=>({name:e.name,type:e.isDirectory()?'dir':'file',size:e.isFile()?fs.statSync(path.join(abs,e.name)).size:null}))
      .sort((a,b)=>a.type===b.type?a.name.localeCompare(b.name):a.type==='dir'?-1:1);
    res.json({path:path.relative(ROOT,abs)||'.',entries});
  }catch(e){res.status(400).json({error:e.message});}
});

app.get('/api/fs/read',(req,res)=>{
  try{
    const abs=safe(req.query.path);
    if(fs.statSync(abs).size>2*1024*1024)return res.status(413).json({error:'File > 2 MB'});
    res.json({content:fs.readFileSync(abs,'utf8')});
  }catch(e){res.status(400).json({error:e.message});}
});

app.get('/api/health',(_,res)=>res.json({ok:true,model:MODEL,ollama:OLLAMA,root:ROOT}));

const server=http.createServer(app);
server.listen(PORT,()=>console.log(`  glm-code :${PORT}  model=${MODEL}  root=${ROOT}`));
SERVERJS

# ── index.html ─────────────────────────────────────────────────────────────
cat > index.html << 'INDEXHTML'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>GLM-Code</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.24.5/babel.min.js"></script>
<style>
:root{--bg:#0a0a0d;--sf:#111116;--ra:#18181f;--bd:#252535;--ac:#7c6af7;--g:#2dd4a0;--w:#f06060;--y:#f0c060;--tx:#e0e0f0;--mu:#555588;--mo:'JetBrains Mono','Fira Code',monospace;--sa:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--r:5px}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body,#root{height:100%;overflow:hidden}
body{background:var(--bg);color:var(--tx);font-family:var(--sa);font-size:13px;display:flex;flex-direction:column}
.app{display:flex;flex-direction:column;height:100%}
.titlebar{display:flex;align-items:center;gap:10px;padding:7px 14px;background:var(--sf);border-bottom:1px solid var(--bd);flex-shrink:0}
.logo{font-size:15px;font-weight:800;letter-spacing:-1px;color:var(--ac)}
.sub{font-size:10px;color:var(--mu);font-family:var(--mo)}
.spacer{flex:1}
.dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.dot.on{background:var(--g);box-shadow:0 0 5px var(--g)}.dot.chk{background:#555}.dot.err{background:var(--w)}
.ms-badge{font-size:10px;font-family:var(--mo);padding:2px 7px;border:1px solid var(--bd);border-radius:10px;cursor:pointer;color:var(--mu)}
.ms-badge.ok{border-color:var(--g);color:var(--g)}
.layout{display:flex;flex:1;overflow:hidden}
.sidebar{width:200px;background:var(--sf);border-right:1px solid var(--bd);display:flex;flex-direction:column;flex-shrink:0;overflow:hidden}
.center{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.right{width:360px;background:var(--sf);border-left:1px solid var(--bd);display:flex;flex-direction:column;flex-shrink:0;overflow:hidden}
.plabel{padding:6px 12px;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--mu);border-bottom:1px solid var(--bd);flex-shrink:0}
.cwd-bar{padding:4px 10px;font-size:10px;font-family:var(--mo);color:var(--mu);background:var(--ra);border-bottom:1px solid var(--bd);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0}
.ftree{flex:1;overflow-y:auto;padding:4px 0}
.fte{display:flex;align-items:center;gap:5px;padding:3px 10px;cursor:pointer;font-size:11px;font-family:var(--mo);color:var(--tx);white-space:nowrap;overflow:hidden;transition:background .1s}
.fte:hover{background:var(--ra)}.fte.sel{background:#2020408f;color:var(--ac)}
.fte .nm{overflow:hidden;text-overflow:ellipsis;flex:1}.fte .sz{font-size:9px;color:var(--mu);flex-shrink:0}
.tabs{display:flex;border-bottom:1px solid var(--bd);background:var(--sf);flex-shrink:0}
.tab{padding:7px 13px;cursor:pointer;font-size:11px;font-weight:600;letter-spacing:.4px;color:var(--mu);border-bottom:2px solid transparent;text-transform:uppercase;transition:color .15s,border-color .15s}
.tab.a{color:var(--tx);border-bottom-color:var(--ac)}.tab:hover:not(.a){color:var(--tx)}
/* chat */
.chat{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.msg-wrap{display:flex;flex-direction:column;gap:5px}
.msg-hdr{font-size:11px;font-weight:700;font-family:var(--mo);display:flex;align-items:center;gap:8px}
.msg-hdr.agent{color:var(--ac)}.msg-hdr.user{color:var(--g)}
.streaming-dot{animation:blink 1s infinite;color:var(--y)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.msg-text{background:var(--ra);border:1px solid var(--bd);border-radius:var(--r);padding:9px 12px;line-height:1.65;font-size:13px;white-space:pre-wrap;word-break:break-word}
.msg-text.agent{border-color:#30305088}
/* tool blocks */
.tool-wrap{border:1px solid var(--bd);border-radius:var(--r);overflow:hidden;margin-top:4px;font-family:var(--mo);font-size:12px}
.tool-hdr{display:flex;align-items:center;gap:8px;padding:5px 10px;background:#1c1c2c;cursor:pointer;border-bottom:1px solid var(--bd)}
.tool-name{color:var(--ac);font-weight:700}.tool-arg{color:var(--mu);font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tool-status{margin-left:auto;font-size:10px;font-weight:700}
.tool-status.running{color:var(--y)}.tool-status.ok{color:var(--g)}.tool-status.err{color:var(--w)}.tool-status.waiting{color:var(--y)}
.tool-body{background:var(--bg);padding:8px 10px;max-height:280px;overflow-y:auto;white-space:pre-wrap;line-height:1.5;color:var(--tx);font-size:12px}
.tool-body.err{color:var(--w)}
/* diff */
.diff-view{background:var(--bg);padding:8px 10px;max-height:260px;overflow-y:auto;font-family:var(--mo);font-size:11px;line-height:1.55}
.d-add{color:#5dd45d;background:#0d1f0d}.d-del{color:#e05555;background:#1f0d0d}.d-ctx{color:var(--mu)}
.diff-actions{display:flex;gap:8px;padding:7px 10px;background:#1c1c2c;border-top:1px solid var(--bd);align-items:center}
/* input */
.input-area{padding:10px 14px;border-top:1px solid var(--bd);background:var(--sf);flex-shrink:0}
.input-row{display:flex;gap:8px;align-items:flex-end}
.input-row textarea{flex:1;background:var(--ra);border:1px solid var(--bd);border-radius:var(--r);color:var(--tx);font-family:var(--sa);font-size:13px;padding:8px 12px;resize:none;outline:none;min-height:38px;max-height:140px;line-height:1.5;transition:border-color .15s}
.input-row textarea:focus{border-color:var(--ac)}
.agent-status{font-size:10px;color:var(--mu);margin-top:5px;height:14px}
/* buttons */
.btn{padding:7px 13px;border-radius:var(--r);border:none;cursor:pointer;font-size:12px;font-weight:700;letter-spacing:.3px;transition:opacity .15s}
.btn:disabled{opacity:.35;cursor:default}
.bp{background:var(--ac);color:#fff}.bp:not(:disabled):hover{opacity:.85}
.bg{background:var(--ra);border:1px solid var(--bd);color:var(--tx)}.bg:not(:disabled):hover{border-color:var(--ac);color:var(--ac)}
.bs{background:transparent;border:1px solid var(--g);color:var(--g);font-size:11px;padding:4px 9px}
.bw{background:transparent;border:1px solid var(--w);color:var(--w);font-size:11px;padding:4px 9px}
/* right panels */
.rp{flex:1;display:flex;flex-direction:column;overflow:hidden}
.term-out{flex:1;overflow-y:auto;padding:10px 12px;font-family:var(--mo);font-size:12px;line-height:1.55;background:var(--bg)}
.tl{display:flex;gap:6px;word-break:break-all}
.tl.cmd{color:var(--g);margin-top:4px}.tl.out{color:var(--tx)}.tl.err{color:var(--w)}.tl.info{color:var(--mu);font-style:italic}
.tpr{color:var(--mu);flex-shrink:0}
.term-input{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--bd);background:var(--sf);flex-shrink:0}
.term-input input{flex:1;background:var(--ra);border:1px solid var(--bd);border-radius:var(--r);color:var(--tx);font-family:var(--mo);font-size:12px;padding:6px 10px;outline:none;transition:border-color .15s}
.term-input input:focus{border-color:var(--g)}
.fvc{flex:1;overflow:auto;padding:12px;font-family:var(--mo);font-size:12px;line-height:1.7;white-space:pre;color:var(--tx);background:var(--bg)}
.ms-panel{padding:12px;display:flex;flex-direction:column;gap:10px;overflow-y:auto}
.ms-label{font-size:10px;color:var(--mu);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.ms-val{font-size:11px;font-family:var(--mo);color:var(--tx);word-break:break-all}
.ms-model{padding:4px 8px;background:var(--ra);border:1px solid var(--bd);border-radius:3px;font-size:11px;font-family:var(--mo);margin-top:3px}
::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--bd);border-radius:3px}
</style>
</head>
<body>
<div id="root"></div>
<script type="text/babel">
const {useState,useEffect,useRef,useCallback}=React;
const API='http://localhost:3001';
const SID=Math.random().toString(36).slice(2);

// ── Tool parser — line-oriented format for GLM-4's reliability ─────────────
function parseTools(text){
  const tools=[];
  // Match TOOL:name ... END_TOOL blocks
  const re=/TOOL:(\w+)\n([\s\S]*?)END_TOOL/g;
  let m;
  while((m=re.exec(text))!==null){
    const name=m[1];const body=m[2];
    const getField=(f)=>{
      // CMD:, PATH:, SUMMARY: are single-line; CONTENT: takes everything after it
      if(f==='CONTENT'){
        const idx=body.indexOf('CONTENT:\n');
        return idx>=0?body.slice(idx+9).trimEnd():null;
      }
      const r=new RegExp(`^${f}:(.*)$`,'m');const x=r.exec(body);
      return x?x[1].trim():null;
    };
    tools.push({name,cmd:getField('CMD'),path:getField('PATH'),content:getField('CONTENT'),summary:getField('SUMMARY')});
  }
  return tools;
}

function stripTools(text){
  return text.replace(/TOOL:\w+\n[\s\S]*?END_TOOL/g,'').trim();
}

function fmt(b){if(b==null)return'';if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'K';return(b/1048576).toFixed(1)+'M';}
function homify(p){if(!p)return'~';const m=p.match(/^\/home\/[^/]+/);return m?p.replace(m[0],'~'):p;}

// ── DiffView ──────────────────────────────────────────────────────────────
function DiffView({patch}){
  if(!patch)return null;
  return(
    <div className="diff-view">
      {patch.split('\n').map((line,i)=>{
        const c=line.startsWith('+')?'d-add':line.startsWith('-')?'d-del':'d-ctx';
        return<div key={i} className={c}>{line||' '}</div>;
      })}
    </div>
  );
}

// ── ToolBlock ─────────────────────────────────────────────────────────────
function ToolBlock({tool,result,onConfirm,onReject}){
  const [open,setOpen]=useState(true);
  const running=result===null;
  const waiting=result?.needsConfirm;
  const statusCls=running?'running':waiting?'waiting':result?.error?'err':'ok';
  const statusTxt=running?'running…':waiting?'awaiting confirm':result?.error?'error':'✓';
  const arg=tool.cmd||tool.path||tool.summary||'';

  return(
    <div className="tool-wrap">
      <div className="tool-hdr" onClick={()=>setOpen(o=>!o)}>
        <span style={{color:'var(--mu)',fontSize:10}}>{open?'▾':'▸'}</span>
        <span className="tool-name">{tool.name}</span>
        <span className="tool-arg">{arg}</span>
        <span className={`tool-status ${statusCls}`}>{statusTxt}</span>
      </div>
      {open&&(
        <>
          {/* write_file: show diff + confirm buttons */}
          {tool.name==='write_file'&&result?.patch&&(
            <>
              <DiffView patch={result.patch}/>
              {result.needsConfirm&&(
                <div className="diff-actions">
                  <span style={{flex:1,fontSize:11,color:'var(--mu)'}}>Apply this write?</span>
                  <button className="btn bs" onClick={onConfirm}>✓ Apply</button>
                  <button className="btn bw" onClick={onReject}>✗ Reject</button>
                </div>
              )}
              {result.applied&&<div style={{padding:'5px 10px',fontSize:11,color:'var(--g)'}}>✓ Applied to disk</div>}
              {result.rejected&&<div style={{padding:'5px 10px',fontSize:11,color:'var(--w)'}}>✗ Rejected by user</div>}
            </>
          )}
          {/* all other tools */}
          {tool.name!=='write_file'&&result&&(
            <div className={`tool-body${result.error?' err':''}`}>
              {result.error   &&result.error}
              {result.stdout  &&result.stdout}
              {result.stderr  &&<span style={{color:'var(--w)'}}>{result.stderr}</span>}
              {result.content &&result.content.slice(0,3000)+(result.content.length>3000?'\n…truncated':'')}
              {tool.name==='done'&&<span style={{color:'var(--g)'}}>✓ {tool.summary}</span>}
            </div>
          )}
          {running&&<div className="tool-body" style={{color:'var(--y)'}}>running…</div>}
        </>
      )}
    </div>
  );
}

// ── FileTree ──────────────────────────────────────────────────────────────
function FileTree({onOpen}){
  const [cur,setCur]=useState('');const [ents,setEnts]=useState([]);const [sel,setSel]=useState(null);const [err,setErr]=useState(null);
  const load=useCallback(p=>{
    setErr(null);
    fetch(`${API}/api/fs/list?path=${encodeURIComponent(p)}`).then(r=>r.json())
      .then(d=>{if(d.error)setErr(d.error);else{setEnts(d.entries);setCur(d.path);}}).catch(e=>setErr(e.message));
  },[]);
  useEffect(()=>{load('');},[load]);
  const click=e=>{
    if(e.type==='dir')load(cur==='.'?e.name:`${cur}/${e.name}`);
    else{const fp=cur==='.'?e.name:`${cur}/${e.name}`;setSel(fp);onOpen(fp);}
  };
  const up=()=>{const p=cur.split('/').filter(Boolean);p.pop();load(p.join('/')||'');};
  return(
    <>
      <div className="cwd-bar">~/{cur}</div>
      {err&&<div style={{padding:'5px 10px',color:'var(--w)',fontSize:10}}>{err}</div>}
      <div className="ftree">
        {cur&&cur!=='.'&&<div className="fte" onClick={up}><span>↑</span><span className="nm">..</span></div>}
        {ents.map(e=>{const fp=cur==='.'?e.name:`${cur}/${e.name}`;return(
          <div key={e.name} className={`fte${sel===fp?' sel':''}`} onClick={()=>click(e)} title={e.name}>
            <span>{e.type==='dir'?'📂':'📄'}</span><span className="nm">{e.name}</span>
            {e.type==='file'&&<span className="sz">{fmt(e.size)}</span>}
          </div>
        );})}
        {ents.length===0&&!err&&<div style={{padding:'5px 10px',color:'var(--mu)',fontSize:10}}>Empty</div>}
      </div>
    </>
  );
}

// ── BashPanel ─────────────────────────────────────────────────────────────
function BashPanel(){
  const [lines,setLines]=useState([{t:'info',s:'Bash REPL — server-side cwd, ↑↓ history.'}]);
  const [inp,setInp]=useState('');const [running,setRunning]=useState(false);
  const [hist,setHist]=useState([]);const [hi,setHi]=useState(-1);const [cwd,setCwd]=useState('~');
  const outRef=useRef(null);
  const add=(t,s)=>setLines(l=>[...l,{t,s}]);
  useEffect(()=>{if(outRef.current)outRef.current.scrollTop=outRef.current.scrollHeight;},[lines]);
  const run=async cmd=>{
    if(!cmd.trim())return;
    setHist(h=>[cmd,...h.slice(0,199)]);setHi(-1);add('cmd',cmd);setRunning(true);
    try{
      const r=await fetch(`${API}/api/tool/bash`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd,sid:SID})});
      const d=await r.json();
      if(d.cwd)setCwd(homify(d.cwd));
      if(d.stdout)d.stdout.split('\n').filter(Boolean).forEach(s=>add('out',s));
      if(d.stderr)d.stderr.split('\n').filter(Boolean).forEach(s=>add('err',s));
      add('info',`exit ${d.exitCode}`);
    }catch(e){add('err',e.message);}
    setRunning(false);
  };
  const onKey=e=>{
    if(e.key==='Enter'){run(inp);setInp('');}
    else if(e.key==='ArrowUp'){const i=Math.min(hi+1,hist.length-1);setHi(i);setInp(hist[i]||'');}
    else if(e.key==='ArrowDown'){const i=Math.max(hi-1,-1);setHi(i);setInp(i===-1?'':hist[i]);}
  };
  return(
    <>
      <div style={{padding:'4px 12px',borderBottom:'1px solid var(--bd)',background:'var(--sf)',fontSize:10,fontFamily:'var(--mo)',color:'var(--g)',flexShrink:0}}>{cwd}</div>
      <div className="term-out" ref={outRef}>
        {lines.map((l,i)=><div key={i} className={`tl ${l.t}`}>{l.t==='cmd'&&<span className="tpr">$</span>}<span style={{whiteSpace:'pre-wrap'}}>{l.s}</span></div>)}
        {running&&<div className="tl info"><span className="tpr">▶</span><span>running…</span></div>}
      </div>
      <div className="term-input">
        <span style={{color:'var(--g)',fontFamily:'var(--mo)',fontSize:12,flexShrink:0}}>$</span>
        <input value={inp} onChange={e=>setInp(e.target.value)} onKeyDown={onKey} placeholder="command… (↑↓ history)" disabled={running} autoFocus/>
        <button className="btn bg" style={{fontSize:11,padding:'5px 9px'}} onClick={()=>{run(inp);setInp('');}} disabled={running||!inp.trim()}>Run</button>
        <button className="btn bg" style={{fontSize:11,padding:'5px 8px'}} onClick={()=>setLines([{t:'info',s:'Cleared.'}])}>Clr</button>
      </div>
    </>
  );
}

// ── MSPanel ───────────────────────────────────────────────────────────────
function MSPanel(){
  const [info,setInfo]=useState(null);
  useEffect(()=>{fetch(`${API}/api/modelstore`).then(r=>r.json()).then(setInfo).catch(()=>{});},[]);
  if(!info)return<div style={{padding:12,color:'var(--mu)',fontSize:11}}>Loading…</div>;
  return(
    <div className="ms-panel">
      <div><div className="ms-label">Store root</div><div className="ms-val">{homify(info.base)}</div></div>
      <div><div className="ms-label">Source dir</div><div className="ms-val">{homify(info.ms_dir)}</div></div>
      <div><div className="ms-label">Built</div><div className="ms-val" style={{color:info.ms_built?'var(--g)':'var(--w)'}}>{info.ms_built?'Yes':'No'}</div></div>
      <div>
        <div className="ms-label">Models ({info.models.length})</div>
        {info.models.length===0&&<div style={{fontSize:11,color:'var(--mu)',marginTop:4}}>None found — store is empty</div>}
        {info.models.map(m=><div key={m} className="ms-model">📦 {m}</div>)}
      </div>
    </div>
  );
}

// ── FileViewPanel ─────────────────────────────────────────────────────────
function FileViewPanel({fp}){
  const [content,setContent]=useState(null);const [err,setErr]=useState(null);
  useEffect(()=>{
    if(!fp){setContent(null);setErr(null);return;}
    fetch(`${API}/api/fs/read?path=${encodeURIComponent(fp)}`).then(r=>r.json())
      .then(d=>{if(d.error)setErr(d.error);else setContent(d.content);}).catch(e=>setErr(e.message));
  },[fp]);
  if(!fp)return<div style={{padding:14,color:'var(--mu)',fontSize:12}}>Select a file from the explorer</div>;
  return(
    <>
      <div style={{padding:'4px 12px',borderBottom:'1px solid var(--bd)',background:'var(--sf)',fontSize:10,fontFamily:'var(--mo)',color:'var(--mu)',flexShrink:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{fp}</div>
      {err&&<div style={{padding:12,color:'var(--w)',fontSize:11}}>{err}</div>}
      {content!=null&&<div className="fvc">{content}</div>}
    </>
  );
}

// ── AgentChat ─────────────────────────────────────────────────────────────
function AgentChat(){
  // msgs = [{role:'user'|'agent', text:string, tools:[{...tool, result:null|{...}}]}]
  const [msgs,setMsgs]=useState([]);
  const [apiHistory,setApiHistory]=useState([]);
  const [inp,setInp]=useState('');
  const [busy,setBusy]=useState(false);
  const [statusLine,setStatusLine]=useState('');
  const endRef=useRef(null);
  const taRef=useRef(null);
  const pendingWrite=useRef(null);
  const apiHistRef=useRef([]);  // keep ref in sync for callbacks

  useEffect(()=>{endRef.current?.scrollIntoView({behavior:'smooth'});},[msgs]);
  useEffect(()=>{if(taRef.current){taRef.current.style.height='auto';taRef.current.style.height=Math.min(taRef.current.scrollHeight,140)+'px';}},[inp]);
  useEffect(()=>{apiHistRef.current=apiHistory;},[apiHistory]);

  const addMsg=m=>{ let idx; setMsgs(ms=>{idx=ms.length;return[...ms,m];}); return idx; };
  // Use functional update pattern to get stable index
  const patchMsg=(idx,fn)=>setMsgs(ms=>{const c=[...ms];c[idx]=fn(c[idx]);return c;});
  const patchTool=(msgIdx,ti,fn)=>setMsgs(ms=>{
    const c=[...ms];const t=[...c[msgIdx].tools];t[ti]=fn(t[ti]);c[msgIdx]={...c[msgIdx],tools:t};return c;
  });

  // Stream one LLM response; returns full text
  const streamGLM=async(history)=>{
    const res=await fetch(`${API}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({messages:history,sid:SID})});
    let full='';
    const reader=res.body.getReader();const dec=new TextDecoder();let buf='';
    // Insert placeholder agent message first
    let msgIdx=null;
    setMsgs(ms=>{msgIdx=ms.length;return[...ms,{role:'agent',text:'',tools:[],streaming:true}];});
    // Wait one tick so msgIdx is settled
    await new Promise(r=>setTimeout(r,0));

    while(true){
      const{done,value}=await reader.read();if(done)break;
      buf+=dec.decode(value,{stream:true});const ls=buf.split('\n');buf=ls.pop();
      for(const line of ls){
        if(!line.startsWith('data: '))continue;const raw=line.slice(6).trim();if(raw==='[DONE]')continue;
        try{const obj=JSON.parse(raw);const d=obj.choices?.[0]?.delta;if(!d?.content)continue;
          full+=d.content;
          // Show cleaned text while streaming
          setMsgs(ms=>{
            const c=[...ms];
            // find last agent streaming msg
            const i=c.map(m=>m.streaming).lastIndexOf(true);
            if(i>=0)c[i]={...c[i],text:stripTools(full)};
            return c;
          });
        }catch{}
      }
    }
    // Mark done streaming, attach parsed tools
    const tools=parseTools(full);
    setMsgs(ms=>{
      const c=[...ms];
      const i=c.map(m=>m.streaming).lastIndexOf(true);
      if(i>=0)c[i]={...c[i],streaming:false,text:stripTools(full),tools:tools.map(t=>({...t,result:null}))};
      // return msgIdx too
      msgIdx=i;
      return c;
    });
    await new Promise(r=>setTimeout(r,0));
    return{full,tools,msgIdx};
  };

  const execTool=async(tool,msgIdx,ti)=>{
    let resultStr='';
    try{
      if(tool.name==='bash'){
        setStatusLine(`Running: ${tool.cmd}`);
        const r=await fetch(`${API}/api/tool/bash`,{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({cmd:tool.cmd,sid:SID})});
        const d=await r.json();
        patchTool(msgIdx,ti,t=>({...t,result:{stdout:d.stdout,stderr:d.stderr,exitCode:d.exitCode}}));
        resultStr=`exit ${d.exitCode}\nstdout:\n${d.stdout||'(empty)'}${d.stderr?'\nstderr:\n'+d.stderr:''}`;
      }
      else if(tool.name==='read_file'){
        setStatusLine(`Reading: ${tool.path}`);
        const r=await fetch(`${API}/api/fs/read?path=${encodeURIComponent(tool.path||'')}`);
        const d=await r.json();
        if(d.error){patchTool(msgIdx,ti,t=>({...t,result:{error:d.error}}));resultStr='Error: '+d.error;}
        else{patchTool(msgIdx,ti,t=>({...t,result:{content:d.content}}));resultStr=d.content.slice(0,4000)+(d.content.length>4000?'\n…truncated':'');}
      }
      else if(tool.name==='write_file'){
        setStatusLine(`Preparing diff for: ${tool.path}`);
        const r=await fetch(`${API}/api/tool/write_file/diff`,{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({path:tool.path,content:tool.content||''})});
        const d=await r.json();
        if(d.error){patchTool(msgIdx,ti,t=>({...t,result:{error:d.error}}));resultStr='Error: '+d.error;}
        else{
          patchTool(msgIdx,ti,t=>({...t,result:{patch:d.patch,needsConfirm:true,path:d.path}}));
          pendingWrite.current={msgIdx,ti,path:d.path,content:tool.content||''};
          return '[PAUSE_FOR_CONFIRM]';
        }
      }
      else if(tool.name==='done'){
        patchTool(msgIdx,ti,t=>({...t,result:{done:true}}));
        resultStr='Done: '+tool.summary;
        return '[DONE]';
      }
    }catch(e){
      patchTool(msgIdx,ti,t=>({...t,result:{error:e.message}}));
      resultStr='Error: '+e.message;
    }
    return resultStr;
  };

  const agentLoop=async(history)=>{
    setBusy(true);let h=[...history];
    for(let iter=0;iter<12;iter++){
      setStatusLine(`Thinking… (step ${iter+1})`);
      let full,tools,msgIdx;
      try{{const r=await streamGLM(h);full=r.full;tools=r.tools;msgIdx=r.msgIdx;}}catch(e){
        setStatusLine('Error: '+e.message);setBusy(false);return;
      }
      h.push({role:'assistant',content:full});

      if(tools.length===0){
        // No tools: GLM gave a plain text response — done
        setApiHistory(h);setStatusLine('');setBusy(false);return;
      }

      let toolResults='';let paused=false;let done=false;
      for(let ti=0;ti<tools.length;ti++){
        const r=await execTool(tools[ti],msgIdx,ti);
        if(r==='[PAUSE_FOR_CONFIRM]'){paused=true;setApiHistory(h);setBusy(false);setStatusLine('Waiting for your confirmation…');return;}
        if(r==='[DONE]'){done=true;break;}
        toolResults+=`<result tool="${tools[ti].name}">\n${r}\n</result>\n`;
      }

      if(done){setApiHistory(h);setStatusLine('');setBusy(false);return;}
      h.push({role:'user',content:`[Tool results]\n${toolResults}\nContinue.`});
    }
    setApiHistory(h);setStatusLine('');setBusy(false);
  };

  const resumeAfterWrite=async(applied,path,content)=>{
    const pw=pendingWrite.current;if(!pw)return;
    let resultStr;
    if(applied){
      const r=await fetch(`${API}/api/tool/write_file/confirm`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({path:pw.path,content:pw.content})});
      const d=await r.json();
      patchTool(pw.msgIdx,pw.ti,t=>({...t,result:{...t.result,needsConfirm:false,applied:!!d.ok}}));
      resultStr=`File written: ${pw.path}`;
    }else{
      patchTool(pw.msgIdx,pw.ti,t=>({...t,result:{...t.result,needsConfirm:false,rejected:true}}));
      resultStr='User rejected the write. Do NOT retry this write.';
    }
    pendingWrite.current=null;
    const h=[...apiHistRef.current,{role:'user',content:`[Tool results]\n<result tool="write_file">\n${resultStr}\n</result>\nContinue.`}];
    setBusy(true);
    await agentLoop(h);
  };

  const send=async()=>{
    if(!inp.trim()||busy)return;
    const text=inp;setInp('');
    setMsgs(ms=>[...ms,{role:'user',text,tools:[],streaming:false}]);
    const h=[...apiHistRef.current,{role:'user',content:text}];
    setApiHistory(h);
    await agentLoop(h);
  };

  return(
    <>
      <div className="chat">
        {msgs.length===0&&(
          <div style={{padding:'12px 4px',color:'var(--mu)',fontSize:12,lineHeight:1.7}}>
            <strong style={{color:'var(--ac)'}}>GLM-Code</strong> — autonomous coding agent.<br/>
            Describe a task. GLM will plan, execute bash, read/write files.<br/>
            File writes show a unified diff and require your confirmation.
          </div>
        )}
        {msgs.map((msg,mi)=>(
          <div key={mi} className="msg-wrap">
            <div className={`msg-hdr ${msg.role}`}>
              <span>{msg.role==='agent'?'GLM-Code':'You'}</span>
              {msg.streaming&&<span className="streaming-dot">●</span>}
            </div>
            {msg.text&&<div className={`msg-text${msg.role==='agent'?' agent':''}`}>{msg.text}{msg.streaming&&<span style={{color:'var(--mu)'}}>▌</span>}</div>}
            {msg.tools.map((tool,ti)=>(
              <ToolBlock key={ti} tool={tool} result={tool.result}
                onConfirm={()=>resumeAfterWrite(true)}
                onReject={()=>resumeAfterWrite(false)}/>
            ))}
          </div>
        ))}
        <div ref={endRef}/>
      </div>
      <div className="input-area">
        <div className="input-row">
          <textarea ref={taRef} value={inp} onChange={e=>setInp(e.target.value)}
            onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}}}
            placeholder="Describe a task… (Shift+Enter = newline)" disabled={busy} rows={1}/>
          <button className="btn bp" onClick={send} disabled={busy||!inp.trim()}>{busy?'…':'↑'}</button>
        </div>
        <div className="agent-status">{statusLine}</div>
      </div>
    </>
  );
}

// ── App ───────────────────────────────────────────────────────────────────
function App(){
  const [status,setStatus]=useState('chk');
  const [msOk,setMsOk]=useState(false);
  const [rtab,setRtab]=useState('bash');
  const [openFile,setOpenFile]=useState(null);

  useEffect(()=>{
    const chk=()=>{
      fetch(`${API}/api/health`).then(()=>setStatus('on')).catch(()=>setStatus('err'));
      fetch(`${API}/api/modelstore`).then(r=>r.json()).then(d=>setMsOk(d.ms_built||false)).catch(()=>{});
    };
    chk();const t=setInterval(chk,10000);return()=>clearInterval(t);
  },[]);

  const handleOpen=fp=>{setOpenFile(fp);setRtab('file');};

  return(
    <div className="app">
      <div className="titlebar">
        <span className="logo">GLM</span>
        <span className="sub">Code · 4 9B · local</span>
        <span className="spacer"/>
        <span className="ms-badge" style={msOk?{borderColor:'var(--g)',color:'var(--g)'}:{}} onClick={()=>setRtab('ms')}>
          ModelStore {msOk?'●':'○'}
        </span>
        <span className="dot" style={{background:status==='on'?'var(--g)':status==='err'?'var(--w)':'#555',boxShadow:status==='on'?'0 0 5px var(--g)':undefined}}/>
        <span style={{fontSize:10,color:'var(--mu)'}}>{status==='on'?'online':status==='err'?'offline':'…'}</span>
      </div>
      <div className="layout">
        <div className="sidebar">
          <div className="plabel">Explorer</div>
          <FileTree onOpen={handleOpen}/>
        </div>
        <div className="center">
          <AgentChat/>
        </div>
        <div className="right">
          <div className="tabs">
            {[['bash','⚡ Bash'],['file','📄 File'],['ms','📦 Store']].map(([t,l])=>(
              <div key={t} className={`tab${rtab===t?' a':''}`} onClick={()=>setRtab(t)}>{l}</div>
            ))}
          </div>
          <div className="rp">
            {rtab==='bash'&&<BashPanel/>}
            {rtab==='file'&&<FileViewPanel fp={openFile}/>}
            {rtab==='ms'  &&<MSPanel/>}
          </div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
</script>
</body>
</html>
INDEXHTML

# ── npm install ────────────────────────────────────────────────────────────
[ ! -d node_modules ] && { info "Installing Node dependencies…"; npm install --silent; }
ok "Node dependencies ready"

# ── Open browser ───────────────────────────────────────────────────────────
HTML="$DIR/index.html"
if grep -qi microsoft /proc/version 2>/dev/null; then
  (cmd.exe /c start "" "$(wslpath -w "$HTML")" 2>/dev/null || true) &
else
  (xdg-open "$HTML" 2>/dev/null || open "$HTML" 2>/dev/null || true) &
fi

echo ""
echo -e "${G}  glm-code ready.${X}"
echo -e "  App:    file://${HTML}"
echo -e "  Server: http://localhost:${NODE_PORT}"
echo -e "  Model:  ${MODEL} via Ollama\n"

GLM_BASE_URL="http://localhost:${OLLAMA_PORT}" GLM_MODEL="$MODEL" SAFE_ROOT="$HOME" MS_DIR="$MS_DIR" node server.js
