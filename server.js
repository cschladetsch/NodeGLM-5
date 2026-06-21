const express=require('express'),cors=require('cors'),fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),https=require('https'),crypto=require('crypto');
const {exec,spawn}=require('child_process');
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
const KAI_DIR=process.env.KAI_DIR    ||path.join(__dirname,'Ext/CppKAI');
const ENET_DIR=process.env.ENET_DIR  ||path.join(__dirname,'Ext/ENet');
const KAI_CONSOLE=process.env.KAI_CONSOLE||path.join(KAI_DIR,'Bin/Console');

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

// System prompt — helpful conversational assistant
const SYSTEM=`You are GLM-Code, a helpful, precise, and expert conversational software engineering assistant.
You answer questions, explain code, and provide clear guidance on software development.
When writing code, explain your design and provide complete, functional code blocks using standard markdown code fences (e.g. \`\`\`javascript).
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

app.get('/api/session',(req,res)=>{
  const s=sess(req.query.sid||'default');
  res.json({cwd:s.cwd,root:ROOT});
});

// Browser and agent filesystem operations share the session working directory.
app.get('/api/fs/list',(req,res)=>{
  try{
    const s=sess(req.query.sid||'default');
    const abs=safe(req.query.path||'',s.cwd);
    const entries=fs.readdirSync(abs,{withFileTypes:true})
      .map(e=>({name:e.name,type:e.isDirectory()?'dir':'file',
        size:e.isFile()?fs.statSync(path.join(abs,e.name)).size:null}))
      .sort((a,b)=>a.type===b.type?a.name.localeCompare(b.name):a.type==='dir'?-1:1);
    res.json({path:path.relative(s.cwd,abs)||'.',abs,cwd:s.cwd,entries});
  }catch(e){res.status(400).json({error:e.message});}
});

app.get('/api/fs/read',(req,res)=>{
  try{
    const s=sess(req.query.sid||'default');
    const abs=safe(req.query.path,s.cwd);
    if(fs.statSync(abs).size>2*1024*1024)return res.status(413).json({error:'File > 2 MB'});
    res.json({content:fs.readFileSync(abs,'utf8')});
  }catch(e){res.status(400).json({error:e.message});}
});

app.post('/api/fs/write',(req,res)=>{
  try{
    const s=sess(req.body.sid||'default');
    const abs=safe(req.body.path,s.cwd);
    if(typeof req.body.content!=='string')throw new Error('content must be a string');
    fs.writeFileSync(abs,req.body.content,'utf8');
    res.json({ok:true,path:path.relative(s.cwd,abs)});
  }catch(e){res.status(400).json({error:e.message});}
});

app.get('/api/health',(_,res)=>res.json({ok:true,model:MODEL,ollama:OLLAMA,root:ROOT}));

const server=http.createServer(app);
function wsFrame(text){
  const payload=Buffer.from(String(text));
  const len=payload.length;
  let header;
  if(len<126){
    header=Buffer.alloc(2);
    header[1]=len;
  }else if(len<0x10000){
    header=Buffer.alloc(4);
    header[1]=126;
    header.writeUInt16BE(len,2);
  }else{
    header=Buffer.alloc(10);
    header[1]=127;
    header.writeBigUInt64BE(BigInt(len),2);
  }
  header[0]=0x81;
  return Buffer.concat([header,payload]);
}
function wsDecode(buffer){
  if(buffer.length<2)return null;
  const b1=buffer[0],b2=buffer[1];
  const opcode=b1&0x0f;
  let len=b2&0x7f;
  let offset=2;
  if(len===126){
    if(buffer.length<4)return null;
    len=buffer.readUInt16BE(2);
    offset=4;
  }else if(len===127){
    if(buffer.length<10)return null;
    len=Number(buffer.readBigUInt64BE(2));
    offset=10;
  }
  const masked=!!(b2&0x80);
  const maskBytes=masked?4:0;
  if(buffer.length<offset+maskBytes+len)return null;
  let payload=buffer.slice(offset+maskBytes,offset+maskBytes+len);
  if(masked){
    const mask=buffer.slice(offset,offset+4);
    payload=Buffer.from(payload.map((byte,i)=>byte^mask[i%4]));
  }
  return {opcode,text:payload.toString('utf8'),rest:buffer.slice(offset+maskBytes+len)};
}
function ensureKaiENet(){
  const kaiEnet=path.join(KAI_DIR,'Ext/ENet');
  try{
    if(!fs.existsSync(kaiEnet)){
      fs.mkdirSync(path.dirname(kaiEnet),{recursive:true});
      fs.symlinkSync(ENET_DIR,kaiEnet,'dir');
    }
  }catch{}
}
server.on('upgrade',(req,socket,head)=>{
  if(req.url!=='/api/kai'){socket.destroy();return;}
  const key=req.headers['sec-websocket-key'];
  if(!key){socket.destroy();return;}
  const accept=crypto.createHash('sha1')
    .update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    ''
  ].join('\r\n'));

  let proc=null;
  let recv=head&&head.length?Buffer.from(head):Buffer.alloc(0);
  const send=(type,data)=>{
    if(!socket.writable)return;
    socket.write(wsFrame(JSON.stringify({type,data})));
  };
  socket.on('data',chunk=>{
    recv=Buffer.concat([recv,chunk]);
    while(true){
      const msg=wsDecode(recv);
      if(!msg)break;
      recv=msg.rest;
      if(msg.opcode===0x8){socket.end();return;}
      if(msg.opcode!==0x1)continue;
      let parsed;
      try{parsed=JSON.parse(msg.text);}catch{send('error','Invalid request');continue;}
      if(parsed.type==='start'&&!proc){
        const mode=['pi','rho','debugger'].includes(parsed.mode)?parsed.mode:'pi';
        if(!fs.existsSync(KAI_CONSOLE))return send('error','CppKAI Console is not built');
        ensureKaiENet();
        const args=mode==='debugger'?['-l','pi','-t','5','--verbose']:['-l',mode];
        const quote=value=>`'${String(value).replace(/'/g,"'\\''")}'`;
        const command=[KAI_CONSOLE,...args].map(quote).join(' ');
        proc=spawn('script',['-qefc',command,'/dev/null'],{
          cwd:KAI_DIR,
          env:{...process.env,TERM:'xterm-256color'},
          stdio:['pipe','pipe','pipe']
        });
        proc.stdout.on('data',data=>send('stdout',data.toString()));
        proc.stderr.on('data',data=>send('stderr',data.toString()));
        proc.on('error',error=>send('error',error.message));
        proc.on('close',code=>{send('exit',code);proc=null;});
        send('ready',mode);
      }else if(parsed.type==='input'&&proc){
        proc.stdin.write(String(parsed.data||'')+'\n');
      }else if(parsed.type==='stop'&&proc){
        proc.kill('SIGTERM');proc=null;
      }
    }
  });
  socket.on('close',()=>{if(proc)proc.kill('SIGTERM');});
});
if(require.main===module){
  server.on('error',error=>{
    if(error.code==='EADDRINUSE'){
      console.error(`Port ${PORT} is already in use. Stop the existing NodeGLM server or set PORT to another value.`);
      process.exit(1);
    }
    throw error;
  });
  server.listen(PORT,()=>console.log(`  glm-code http://localhost:${PORT}  model=${MODEL}  root=${ROOT}`));
}

module.exports={app,server,safe};
