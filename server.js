const express=require('express'),cors=require('cors'),fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),https=require('https');
const {exec}=require('child_process');
const Diff=require('diff');

const app=express();
app.use(cors());
app.use(express.json({limit:'16mb'}));

app.get(['/', '/index.html'],(_req,res)=>res.sendFile(path.join(__dirname,'index.html')));

const OLLAMA=process.env.GLM_BASE_URL||'http://localhost:11434';
const ROOT  =fs.realpathSync(path.resolve(process.env.SAFE_ROOT||process.env.HOME||'/tmp'));
const PORT  =process.env.PORT        ||3001;
const MODEL =process.env.GLM_MODEL   ||'glm4:9b';
const MS_DIR=process.env.MS_DIR      ||path.join(os.homedir(),'local/repos/CppLmmModelStore');

// Sessions: cwd tracked per SID
const sessions={};
function sess(sid){
  if(!sessions[sid])sessions[sid]={cwd:ROOT};
  return sessions[sid];
}

function safe(p, baseCwd){
  // Resolve relative paths against the session cwd, not ROOT
  const base = baseCwd || ROOT;
  const expanded = (p||'').replace(/^~/,os.homedir());
  let abs = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(base, expanded);
  // Canonicalize the closest existing ancestor so symlinks cannot escape ROOT,
  // including when the final file does not exist yet.
  const missing=[];
  while(!fs.existsSync(abs)){
    const parent=path.dirname(abs);
    if(parent===abs)break;
    missing.unshift(path.basename(abs));
    abs=parent;
  }
  abs=path.join(fs.realpathSync(abs),...missing);
  if(abs!==ROOT&&!abs.startsWith(ROOT+path.sep))throw new Error('Outside sandbox: '+abs);
  return abs;
}

function run(cmd,cwd,timeout=20000){
  return new Promise(res=>exec(cmd,{cwd,timeout,maxBuffer:2*1024*1024,shell:'/bin/bash'},
    (e,o,r)=>res({stdout:o||'',stderr:r||'',exitCode:e?(e.code??1):0})));
}

// ModelStore
function msBase(){
  return process.env.DEEPSEEK_MODEL_HOME||
    (process.env.XDG_DATA_HOME
      ?path.join(process.env.XDG_DATA_HOME,'deepseek','models')
      :path.join(os.homedir(),'.local','share','deepseek','models'));
}
app.get('/api/modelstore',(_req,res)=>{
  const base=msBase();
  let models=[];
  try{if(fs.existsSync(base))models=fs.readdirSync(base,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name);}catch{}
  res.json({base,models,ms_dir:MS_DIR,ms_built:fs.existsSync(path.join(MS_DIR,'build'))});
});

// System prompt — explicit about path resolution and cwd
const SYSTEM=`You are GLM-Code, an autonomous software engineering agent with full shell access.

To perform actions emit tool calls using EXACTLY this format:

TOOL:bash
CMD:the shell command here
END_TOOL

TOOL:read_file
PATH:path/to/file
END_TOOL

TOOL:write_file
PATH:path/to/file
CONTENT:
full file content here
END_TOOL

TOOL:done
SUMMARY:what was accomplished
END_TOOL

Critical rules:
- Emit ONE tool call per response, then stop and wait for the result.
- Do NOT emit tool calls as plain prose or inside sentences. Use the exact format above.
- bash CMD runs in the current working directory shown in [cwd:...].
- read_file PATH is resolved relative to [cwd:...] if not absolute.
- To change directory use: TOOL:bash / CMD:cd /some/path / END_TOOL — this updates the cwd for all subsequent tools.
- Read a file before writing it if you need to know its current content.
- After each tool result, decide: emit another tool, or emit TOOL:done.
- Never emit markdown fences.
`;

app.post('/api/chat',(req,res)=>{
  const {messages,sid}=req.body;
  if(!Array.isArray(messages)||messages.length===0)
    return res.status(400).json({error:'messages must be a non-empty array'});
  const s=sess(sid||'default');
  const last=messages[messages.length-1];
  if(!last||typeof last.content!=='string')
    return res.status(400).json({error:'last message must have string content'});
  const augmented=[...messages.slice(0,-1),
    {...last,content:last.content+`\n\n[cwd: ${s.cwd}]`}];
  const payload=JSON.stringify({
    model:MODEL,
    messages:[{role:'system',content:SYSTEM},...augmented],
    temperature:0.1,
    max_tokens:1024,
    stream:true,
  });
  const url=new URL('/v1/chat/completions',OLLAMA);
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  const transport=url.protocol==='https:'?https:http;
  const up=transport.request({hostname:url.hostname,port:url.port||(url.protocol==='https:'?443:80),path:url.pathname,method:'POST',
    headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},
    r=>{r.on('data',c=>res.write(c));r.on('end',()=>res.end());});
  up.on('error',e=>{res.write(`data: ${JSON.stringify({error:e.message})}\n\n`);res.end();});
  up.write(payload);up.end();
});

// bash — handles cd, updates session cwd
app.post('/api/tool/bash',async(req,res)=>{
  const{cmd,sid}=req.body;
  if(!cmd)return res.status(400).json({error:'cmd required'});
  const s=sess(sid||'default');

  // Strip leading/trailing whitespace and handle multiline (take first non-empty line as cmd)
  const cleanCmd=cmd.trim().split('\n').map(l=>l.trim()).filter(Boolean).join(' && ');

  // Handle cd specially
  const cdMatch=cleanCmd.match(/^cd\s+(.+)$/);
  if(cdMatch){
    const tgt=cdMatch[1].trim().replace(/^~/,os.homedir());
    try{
      const resolved=safe(tgt,s.cwd);
      if(!fs.statSync(resolved).isDirectory())
        return res.json({stdout:'',stderr:`cd: not a directory: ${tgt}`,exitCode:1,cwd:s.cwd});
      s.cwd=resolved;
      return res.json({stdout:`cwd is now ${resolved}`,stderr:'',exitCode:0,cwd:s.cwd});
    }catch(e){
      const message=/Outside sandbox/.test(e.message)?'outside sandbox':`no such directory: ${tgt}`;
      return res.json({stdout:'',stderr:`cd: ${message}`,exitCode:1,cwd:s.cwd});
    }
  }

  const r=await run(cleanCmd,s.cwd);
  res.json({...r,cwd:s.cwd});
});

// read_file — resolves relative to session cwd
app.post('/api/tool/read_file',(req,res)=>{
  const{path:p,sid}=req.body;
  const s=sess(sid||'default');
  try{
    const abs=safe(p,s.cwd);
    if(fs.statSync(abs).size>4*1024*1024)return res.status(413).json({error:'File > 4 MB'});
    res.json({content:fs.readFileSync(abs,'utf8'),path:abs});
  }catch(e){res.status(400).json({error:e.message});}
});

// write_file diff — resolves relative to session cwd
app.post('/api/tool/write_file/diff',(req,res)=>{
  const{path:p,content,sid}=req.body;
  const s=sess(sid||'default');
  try{
    const abs=safe(p,s.cwd);
    const next=content||'';
    let prev='';try{prev=fs.readFileSync(abs,'utf8');}catch{}
    res.json({path:abs,patch:Diff.createPatch(abs,prev,next,'current','proposed'),isNew:prev===''});
  }catch(e){res.status(400).json({error:e.message});}
});

app.post('/api/tool/write_file/confirm',(req,res)=>{
  const s=sess(req.body.sid||'default');
  try{
    const abs=safe(req.body.path,s.cwd);
    if(typeof req.body.content!=='string')throw new Error('content must be a string');
    fs.mkdirSync(path.dirname(abs),{recursive:true});
    fs.writeFileSync(abs,req.body.content,'utf8');
    res.json({ok:true,path:abs});
  }catch(e){res.status(400).json({error:e.message});}
});

// Backward-compatible one-shot REPL used by the dedicated REPL tab.
app.post('/api/repl/exec',async(req,res)=>{
  const{cmd,cwd,timeout}=req.body;
  if(!cmd)return res.status(400).json({error:'cmd required'});
  try{
    const runCwd=safe(cwd||'');
    const result=await run(cmd,runCwd,Math.min(Number(timeout)||10000,30000));
    res.json(result);
  }catch(e){res.status(400).json({error:e.message});}
});

// Browser filesystem endpoints remain ROOT-relative. Agent tools are session-relative.
app.get('/api/fs/list',(req,res)=>{
  try{
    const abs=safe(req.query.path||'');
    const entries=fs.readdirSync(abs,{withFileTypes:true})
      .map(e=>({name:e.name,type:e.isDirectory()?'dir':'file',
        size:e.isFile()?fs.statSync(path.join(abs,e.name)).size:null}))
      .sort((a,b)=>a.type===b.type?a.name.localeCompare(b.name):a.type==='dir'?-1:1);
    res.json({path:path.relative(ROOT,abs)||'.',abs,entries});
  }catch(e){res.status(400).json({error:e.message});}
});

app.get('/api/fs/read',(req,res)=>{
  try{
    const abs=safe(req.query.path);
    if(fs.statSync(abs).size>2*1024*1024)return res.status(413).json({error:'File > 2 MB'});
    res.json({content:fs.readFileSync(abs,'utf8')});
  }catch(e){res.status(400).json({error:e.message});}
});

app.post('/api/fs/write',(req,res)=>{
  try{
    const abs=safe(req.body.path);
    if(typeof req.body.content!=='string')throw new Error('content must be a string');
    fs.writeFileSync(abs,req.body.content,'utf8');
    res.json({ok:true,path:path.relative(ROOT,abs)});
  }catch(e){res.status(400).json({error:e.message});}
});

app.get('/api/health',(_,res)=>res.json({ok:true,model:MODEL,ollama:OLLAMA,root:ROOT}));

const server=http.createServer(app);
if(require.main===module){
  server.listen(PORT,()=>console.log(`  glm-code http://localhost:${PORT}  model=${MODEL}  root=${ROOT}`));
}

module.exports={app,server,safe};
