const express=require('express'),cors=require('cors'),fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),https=require('https'),crypto=require('crypto');
const {exec,spawn}=require('child_process');
const Diff=require('diff');

const OLLAMA=process.env.GLM_BASE_URL||'http://localhost:11434';
const ROOT  =fs.realpathSync(path.resolve(process.env.SAFE_ROOT||process.env.HOME||'/tmp'));
const PORT  =process.env.PORT        ||3001;
const HOST  =process.env.HOST        ||'127.0.0.1';
const DEFAULT_MODEL=process.env.GLM_MODEL||'glm4:9b';
const GLM_TIMEOUT_MS=Math.max(1000,Number(process.env.GLM_TIMEOUT_MS)||120000);
const GLM_MAX_TOKENS=Math.max(256,Number(process.env.GLM_MAX_TOKENS)||4096);
const GLM_HISTORY_MESSAGES=Math.max(4,Number(process.env.GLM_HISTORY_MESSAGES)||40);
const MS_DIR=process.env.MS_DIR      ||path.join(os.homedir(),'local/repos/CppLmmModelStore');
const KAI_DIR=process.env.KAI_DIR    ||path.join(__dirname,'Ext/CppKAI');
const ENET_DIR=process.env.ENET_DIR  ||path.join(__dirname,'Ext/ENet');
const KAI_CONSOLE=process.env.KAI_CONSOLE||path.join(KAI_DIR,'Bin/Console');

const app=express();
const allowedOrigins=new Set((process.env.GLM_ALLOWED_ORIGINS||
  `http://localhost:${PORT},http://127.0.0.1:${PORT},null`).split(',').map(value=>value.trim()));
app.use(cors({origin(origin,callback){
  if(!origin||allowedOrigins.has(origin))return callback(null,true);
  callback(new Error('Origin not allowed'));
}}));
app.use(express.json({limit:'16mb'}));
const validSessionId=sid=>/^[A-Za-z0-9._-]{1,128}$/.test(String(sid));
app.use('/api',(req,res,next)=>{
  const sid=req.body?.sid??req.query?.sid;
  if(sid!==undefined&&!validSessionId(sid))
    return res.status(400).json({error:'invalid session id'});
  next();
});

app.get(['/', '/index.html'],(_req,res)=>res.sendFile(path.join(__dirname,'index.html')));

// Sessions: cwd tracked per SID
const sessions=new Map();
const SESSION_TTL=24*60*60*1000;
function sess(sid){
  const now=Date.now();
  if(sessions.size>=1000&&!sessions.has(sid)){
    for(const [key,value] of sessions)if(now-value.lastUsed>SESSION_TTL)sessions.delete(key);
    if(sessions.size>=1000){
      let oldestKey,oldestTime=Infinity;
      for(const [key,value] of sessions)if(value.lastUsed<oldestTime){oldestKey=key;oldestTime=value.lastUsed;}
      if(oldestKey!==undefined)sessions.delete(oldestKey);
    }
  }
  if(!sessions.has(sid))sessions.set(sid,{cwd:ROOT,model:DEFAULT_MODEL,lastUsed:now});
  const session=sessions.get(sid);
  session.lastUsed=now;
  return session;
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
  const marker=`__NODEGLM_CWD_${crypto.randomBytes(12).toString('hex')}__`;
  const wrapped=`${cmd}\n_nodeglm_status=$?\nprintf '\\n${marker}%s\\n' "$PWD"\nexit "$_nodeglm_status"`;
  return new Promise(resolve=>exec(wrapped,{cwd,timeout,maxBuffer:2*1024*1024,shell:'/bin/bash'},
    (error,stdout,stderr)=>{
      const output=stdout||'';
      const index=output.lastIndexOf(`\n${marker}`);
      const finalCwd=index>=0?output.slice(index+marker.length+1).trim():cwd;
      resolve({stdout:index>=0?output.slice(0,index):output,stderr:stderr||'',
        exitCode:error?(error.code??1):0,cwd:finalCwd});
    }));
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

Answer ordinary conversation and stable general-knowledge questions directly when you know the answer confidently. Use a network-capable tool when the user asks for a lookup, the information may have changed, or verification would materially improve the answer. Do not reach for a tool merely because a factual question was asked.

Use project tools when the user asks you to inspect, run, or change something in the current project, or when project files are required to answer. When a tool is needed, emit exactly one tool request as the entire response with no introduction or explanation:
TOOL:bash
CMD:<shell command>
END_TOOL

TOOL:read_file
PATH:<path relative to cwd>
END_TOOL

TOOL:write_file
PATH:<path relative to cwd>
CONTENT:
<complete new file content>
END_TOOL

After each request, the user will provide a TOOL_RESULT. Continue until the task is complete, then answer normally. Never claim a tool ran unless you received its TOOL_RESULT. Writes require user approval.

The [cwd: ...] marker on the latest message is the authoritative current directory shared with the Bash panel. Resolve every relative path from it. If the user enters a shell command such as cd, pwd, or ls, execute it with TOOL:bash; do not merely describe the command or ask what to do next.
`;

app.post('/api/chat',(req,res)=>{
  const {messages,sid}=req.body;
  if(!Array.isArray(messages)||messages.length===0)
    return res.status(400).json({error:'messages must be a non-empty array'});
  const s=sess(sid||'default');
  const last=messages[messages.length-1];
  if(!last||typeof last.content!=='string')
    return res.status(400).json({error:'last message must have string content'});
  const recent=messages.slice(-GLM_HISTORY_MESSAGES);
  const augmented=[...recent.slice(0,-1),
    {...last,content:last.content+`\n\n[cwd: ${s.cwd}]`}];
  const payload=JSON.stringify({
    model:s.model,
    messages:[{role:'system',content:SYSTEM},...augmented],
    temperature:0.1,
    max_tokens:GLM_MAX_TOKENS,
    stream:true,
  });
  const url=new URL('/v1/chat/completions',OLLAMA);
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  const transport=url.protocol==='https:'?https:http;
  let ended=false;
  const fail=message=>{
    if(ended||res.writableEnded)return;
    ended=true;
    res.write(`data: ${JSON.stringify({error:message})}\n\n`);res.end();
  };
  const up=transport.request({hostname:url.hostname,port:url.port||(url.protocol==='https:'?443:80),path:url.pathname,method:'POST',
    headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},
    r=>{
      if((r.statusCode||500)>=400){
        let body='';
        r.on('data',chunk=>{if(body.length<8192)body+=chunk;});
        r.on('end',()=>fail(`Model endpoint HTTP ${r.statusCode}: ${body.slice(0,500)}`));
        return;
      }
      r.on('data',chunk=>{if(!res.writableEnded)res.write(chunk);});
      r.on('end',()=>{if(!res.writableEnded){ended=true;res.end();}});
    });
  up.setTimeout(GLM_TIMEOUT_MS,()=>up.destroy(new Error(`Model request timed out after ${GLM_TIMEOUT_MS} ms`)));
  up.on('error',error=>fail(error.message));
  res.on('close',()=>{if(!res.writableEnded&&!ended)up.destroy();});
  up.write(payload);up.end();
});

// bash — handles cd, updates session cwd
app.post('/api/tool/bash',async(req,res)=>{
  const{cmd,sid}=req.body;
  if(!cmd)return res.status(400).json({error:'cmd required'});
  const s=sess(sid||'default');

  const r=await run(cmd.trim(),s.cwd);
  try{
    const finalCwd=safe(r.cwd,s.cwd);
    if(fs.statSync(finalCwd).isDirectory())s.cwd=finalCwd;
  }catch{}
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
  res.json({cwd:s.cwd,model:s.model,root:ROOT});
});

function availableModels(){
  return new Promise((resolve,reject)=>{
    const url=new URL('/v1/models',OLLAMA);
    const transport=url.protocol==='https:'?https:http;
    const request=transport.get({hostname:url.hostname,port:url.port||(url.protocol==='https:'?443:80),path:url.pathname},response=>{
      let body='';
      response.on('data',chunk=>{if(body.length<2*1024*1024)body+=chunk;});
      response.on('end',()=>{
        if((response.statusCode||500)>=400)return reject(new Error(`Model endpoint HTTP ${response.statusCode}`));
        try{
          const parsed=JSON.parse(body);
          resolve((parsed.data||[]).map(item=>item.id).filter(id=>typeof id==='string').sort());
        }catch(error){reject(new Error(`Invalid model list: ${error.message}`));}
      });
    });
    request.setTimeout(5000,()=>request.destroy(new Error('Model list timed out')));
    request.on('error',reject);
  });
}

app.get('/api/models',async(req,res)=>{
  try{
    const s=sess(req.query.sid||'default');
    res.json({models:await availableModels(),selected:s.model});
  }catch(error){res.status(502).json({error:error.message});}
});

function selectSessionModel(sid,model,models){
  if(typeof model!=='string')throw new Error('model required');
  if(!models.includes(model))throw new Error('model is not installed');
  const s=sess(sid||'default');
  s.model=model;
  return s.model;
}

app.post('/api/session/model',async(req,res)=>{
  try{
    const models=await availableModels();
    res.json({ok:true,model:selectSessionModel(req.body.sid,req.body.model,models)});
  }catch(error){
    const clientError=/^(model required|model is not installed)$/.test(error.message);
    res.status(clientError?400:502).json({error:error.message});
  }
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

app.get('/api/health',(_req,res)=>{
  const url=new URL('/v1/models',OLLAMA);
  const transport=url.protocol==='https:'?https:http;
  let settled=false;
  const finish=(ok,error)=>{
    if(settled)return;settled=true;
    const s=sess(_req.query.sid||'default');
    res.status(ok?200:503).json({ok,inference:ok,model:s.model,ollama:OLLAMA,root:ROOT,...(error?{error}:{})});
  };
  const check=transport.get({hostname:url.hostname,port:url.port||(url.protocol==='https:'?443:80),path:url.pathname},upstream=>{
    upstream.resume();
    upstream.on('end',()=>finish((upstream.statusCode||500)<400,
      (upstream.statusCode||500)>=400?`Model endpoint HTTP ${upstream.statusCode}`:null));
  });
  check.setTimeout(2000,()=>check.destroy(new Error('Model health check timed out')));
  check.on('error',error=>finish(false,error.message));
});

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
function parseKaiTreeSnapshot(text){
  const unescapeField=value=>String(value||'').replace(/\\([\\tn])/g,(_match,char)=>
    char==='t'?'\t':char==='n'?'\n':'\\');
  const executors=new Map();
  for(const line of text.replace(/\u001b\[[0-9;]*m/g,'').split(/\r?\n/)){
    const fields=line.split('\t');
    if(fields[0]==='EXEC'&&fields.length>=8){
      const executor={id:fields[1],treeId:fields[2],rootId:fields[3],scopeId:fields[4],
        dataSize:Number(fields[5])||0,contextSize:Number(fields[6])||0,
        scope:unescapeField(fields.slice(7).join('\t')),nodes:[]};
      executors.set(executor.id,executor);
    }else if(fields[0]==='NODE'&&fields.length>=8){
      const executor=executors.get(fields[1]);
      if(executor)executor.nodes.push({id:fields[2],parentId:fields[3],depth:Number(fields[4])||0,
        label:unescapeField(fields[5]),type:unescapeField(fields[6]),path:unescapeField(fields.slice(7).join('\t'))});
    }
  }
  return {executors:[...executors.values()]};
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
  if(req.headers.origin&&!allowedOrigins.has(req.headers.origin)){socket.destroy();return;}
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

  let proc=null,inspecting=false,inspectionBuffer='';
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
        proc.stdout.on('data',data=>{
          const text=data.toString();
          if(!inspecting){send('stdout',text);return;}
          inspectionBuffer+=text;
          const begin=inspectionBuffer.indexOf('NODEGLM_TREE_BEGIN');
          const end=inspectionBuffer.indexOf('NODEGLM_TREE_END');
          if(end<0)return;
          if(begin>=0)send('tree',parseKaiTreeSnapshot(inspectionBuffer.slice(begin,end)));
          else send('error','Malformed Executor tree snapshot');
          inspecting=false;inspectionBuffer='';
        });
        proc.stderr.on('data',data=>send('stderr',data.toString()));
        proc.on('error',error=>send('error',error.message));
        proc.on('close',code=>{send('exit',code);proc=null;});
        send('ready',mode);
      }else if(parsed.type==='input'&&proc){
        proc.stdin.write(String(parsed.data||'')+'\n');
      }else if(parsed.type==='inspect_tree'&&proc&&!inspecting){
        inspecting=true;inspectionBuffer='';
        proc.stdin.write('__nodeglm_tree__\n');
      }else if(parsed.type==='debug_action'&&proc){
        const id=String(parsed.executorId||'');
        const action=String(parsed.action||'');
        if(!/^\d+$/.test(id)||!['step','continue','stack','clear'].includes(action)){
          send('error','Invalid Executor debug action');continue;
        }
        proc.stdin.write(`__nodeglm_debug__ ${id} ${action}\n`);
      }else if(parsed.type==='stop'&&proc){
        proc.kill('SIGTERM');proc=null;
      }
    }
  });
  socket.on('close',()=>{if(proc)proc.kill('SIGTERM');});
});
app.use((error,_req,res,_next)=>{
  if(error.message==='Origin not allowed')return res.status(403).json({error:error.message});
  res.status(500).json({error:'internal server error'});
});
if(require.main===module){
  server.on('error',error=>{
    if(error.code==='EADDRINUSE'){
      console.error(`Port ${PORT} is already in use. Stop the existing NodeGLM server or set PORT to another value.`);
      process.exit(1);
    }
    throw error;
  });
  server.listen(PORT,HOST,()=>console.log(`  glm-code http://${HOST}:${PORT}  model=${DEFAULT_MODEL}  root=${ROOT}`));
}

module.exports={app,server,safe,validSessionId,selectSessionModel};
