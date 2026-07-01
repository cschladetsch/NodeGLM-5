const express=require('express'),cors=require('cors'),fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),https=require('https'),crypto=require('crypto');
const {exec,spawn,execFile}=require('child_process');
const Diff=require('diff');
const RAG=require('./rag');

const APP_ROOT=path.resolve(__dirname,'..');
const OLLAMA=process.env.KAI_WORKBENCH_BASE_URL||'http://localhost:11434';
const ROOT  =fs.realpathSync(path.resolve(process.env.SAFE_ROOT||process.env.HOME||'/tmp'));
const PORT  =process.env.PORT        ||3001;
const HOST  =process.env.HOST        ||'127.0.0.1';
const DEFAULT_MODEL=process.env.KAI_WORKBENCH_MODEL||'qwen2.5-coder:7b';
const MODEL_CACHE_ROOT=process.env.MODEL_CACHE_ROOT||path.join(os.homedir(),'.models');
const OLLAMA_MODELS=process.env.OLLAMA_MODELS||path.join(MODEL_CACHE_ROOT,'ollama');
const KAI_WORKBENCH_TIMEOUT_MS=Math.max(1000,Number(process.env.KAI_WORKBENCH_TIMEOUT_MS)||120000);
const KAI_WORKBENCH_FIRST_BYTE_TIMEOUT_MS=Math.max(1000,Number(process.env.KAI_WORKBENCH_FIRST_BYTE_TIMEOUT_MS)||90000);
const KAI_WORKBENCH_MAX_TOKENS=Math.max(256,Number(process.env.KAI_WORKBENCH_MAX_TOKENS)||4096);
const KAI_WORKBENCH_HISTORY_MESSAGES=Math.max(4,Number(process.env.KAI_WORKBENCH_HISTORY_MESSAGES)||40);
const KAI_WORKBENCH_RAG_INDEX=RAG.resolveIndexFile(APP_ROOT);
const KAI_WORKBENCH_RAG_EMBED_MODEL=process.env.KAI_WORKBENCH_RAG_EMBED_MODEL||RAG.DEFAULT_EMBED_MODEL;
const KAI_WORKBENCH_RAG_TOP_K=Math.max(1,Math.min(8,Number(process.env.KAI_WORKBENCH_RAG_TOP_K)||RAG.DEFAULT_TOP_K));
const MS_DIR=process.env.MS_DIR      ||path.join(os.homedir(),'local/repos/CppLmmModelStore');
const KAI_DIR=process.env.KAI_DIR    ||path.join(APP_ROOT,'Ext/CppKAI');
const ENET_DIR=process.env.ENET_DIR  ||path.join(KAI_DIR,'Ext/ENet');
const KAI_CONSOLE=process.env.KAI_CONSOLE||path.join(KAI_DIR,'Bin/Console');
const MEMORY_FILE=process.env.KAI_WORKBENCH_MEMORY_FILE||path.join(ROOT,'.kaiworkbench-memory.json');
const OPEN_IMAGE_MAX_BYTES=8*1024*1024;
const RECOMMENDED_MODELS=[
  {id:'qwen2.5-coder:1.5b',label:'Qwen Coder 1.5B',vram:'~2-3 GB',ram:'~4 GB',fit:'Lowest memory coding fallback'},
  {id:'qwen2.5-coder:3b',label:'Qwen Coder 3B',vram:'~3-5 GB',ram:'~6 GB',fit:'Small coding model'},
  {id:'qwen2.5-coder:7b',label:'Qwen Coder 7B',vram:'~6-9 GB',ram:'~10 GB',fit:'Default coding model'},
  {id:'qwen2.5-coder:14b',label:'Qwen Coder 14B',vram:'~11-16 GB',ram:'~20 GB',fit:'Larger coding model'},
  {id:'deepseek-coder-v2:16b-lite',label:'DeepSeek Coder V2 Lite',vram:'~12-18 GB',ram:'~24 GB',fit:'Stronger but heavier coding model'},
  {id:'llama3.2:3b',label:'Llama 3.2 3B',vram:'~3-5 GB',ram:'~6 GB',fit:'Low-memory general chat'},
  {id:'gemma3:4b',label:'Gemma 3 4B',vram:'~4-6 GB',ram:'~8 GB',fit:'Compact general chat'}
];

function readUiConfig(configPath=path.join(APP_ROOT,'ui-config.json')){
  const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  if(typeof config.requestProgressDelaySeconds!=='number'||
      !Number.isFinite(config.requestProgressDelaySeconds)||config.requestProgressDelaySeconds<0)
    throw new Error('requestProgressDelaySeconds must be a non-negative finite number');
  return config;
}
const UI_CONFIG=readUiConfig();

const app=express();
const allowedOrigins=new Set((process.env.KAI_WORKBENCH_ALLOWED_ORIGINS||
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

app.get(['/', '/index.html'],(_req,res)=>res.sendFile(path.join(APP_ROOT,'public','index.html')));
app.get('/ui-config.json',(_req,res)=>res.json(UI_CONFIG));

function csvColumns(line){
  return String(line).split(',').map(value=>value.trim());
}
function parseMiB(value){
  const match=String(value).match(/(\d+)/);
  return match?Number(match[1]):0;
}
function parseGpuRows(text){
  return String(text).trim().split('\n').filter(Boolean).map(line=>{
    const [uuid,index,name,used,total]=csvColumns(line);
    return {uuid,index:Number(index),name,usedMiB:parseMiB(used),totalMiB:parseMiB(total)};
  });
}
function parseGpuProcessRows(text){
  return String(text).trim().split('\n').filter(Boolean).map(line=>{
    const [gpuUuid,pid,processName,used]=csvColumns(line);
    return {gpuUuid,pid:Number(pid),processName,usedMiB:parseMiB(used)};
  }).filter(row=>Number.isFinite(row.pid));
}
function processBaseName(processName){
  return String(processName||'').split(/[\\/]/).pop();
}
function isLocalModelEndpoint(){
  try{
    const host=new URL(OLLAMA).hostname;
    return ['localhost','127.0.0.1','::1'].includes(host);
  }catch{return false;}
}
function execFileText(command,args,timeout=2000){
  return new Promise((resolve,reject)=>{
    execFile(command,args,{timeout,maxBuffer:1024*1024},(error,stdout)=>error?reject(error):resolve(stdout));
  });
}
async function appGpuPids(){
  try{
    const rows=(await execFileText('ps',['-eo','pid=,ppid=,comm='])).trim().split('\n').filter(Boolean)
      .map(line=>{
        const parts=line.trim().split(/\s+/);
        return {pid:Number(parts[0]),ppid:Number(parts[1]),comm:parts.slice(2).join(' ')};
      }).filter(row=>Number.isFinite(row.pid)&&Number.isFinite(row.ppid));
    const related=new Set([process.pid]);
    let changed=true;
    while(changed){
      changed=false;
      for(const row of rows)if(related.has(row.ppid)&&!related.has(row.pid)){
        related.add(row.pid);changed=true;
      }
    }
    return related;
  }catch{return new Set([process.pid]);}
}
function summarizeVram(gpus,processes,relatedPids,includeLocalOllama){
  const gpuByUuid=new Map(gpus.map(gpu=>[gpu.uuid,{...gpu,appUsedMiB:0}]));
  for(const proc of processes){
    const gpu=gpuByUuid.get(proc.gpuUuid);
    if(!gpu)continue;
    const name=processBaseName(proc.processName);
    const belongsToApp=relatedPids.has(proc.pid)||(includeLocalOllama&&name==='ollama');
    if(belongsToApp)gpu.appUsedMiB+=proc.usedMiB;
  }
  const rows=[...gpuByUuid.values()];
  return {
    available:true,
    source:'nvidia-smi',
    appScope:includeLocalOllama?'KaiWorkbench process tree plus local Ollama':'KaiWorkbench process tree',
    gpus:rows,
    total:rows.reduce((total,gpu)=>({
      appUsedMiB:total.appUsedMiB+gpu.appUsedMiB,
      usedMiB:total.usedMiB+gpu.usedMiB,
      totalMiB:total.totalMiB+gpu.totalMiB,
    }),{appUsedMiB:0,usedMiB:0,totalMiB:0}),
  };
}
function bytesToMiB(value){
  return Math.round(Number(value||0)/1024/1024);
}
function queryRam(){
  const totalMiB=bytesToMiB(os.totalmem());
  const freeMiB=bytesToMiB(os.freemem());
  return {
    available:true,
    source:'node-os',
    total:{
      appUsedMiB:bytesToMiB(process.memoryUsage().rss),
      usedMiB:Math.max(0,totalMiB-freeMiB),
      totalMiB,
      freeMiB,
    },
  };
}
async function queryVram(){
  const gpuArgs=['--query-gpu=uuid,index,name,memory.used,memory.total','--format=csv,noheader,nounits'];
  const appArgs=['--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory','--format=csv,noheader,nounits'];
  try{
    const [gpuText,appText,relatedPids]=await Promise.all([
      execFileText('nvidia-smi',gpuArgs),
      execFileText('nvidia-smi',appArgs).catch(()=>''), appGpuPids()
    ]);
    return summarizeVram(parseGpuRows(gpuText),parseGpuProcessRows(appText),relatedPids,isLocalModelEndpoint());
  }catch(error){
    return {available:false,source:'nvidia-smi',error:error.code==='ENOENT'?'nvidia-smi not found':error.message};
  }
}

const MEMORY_FACT_LIMIT=50;
const MEMORY_FACT_MAX_LENGTH=180;

function normalizeMemoryFact(value){
  return String(value||'')
    .replace(/\s+/g,' ')
    .replace(/^[\s:,-]+|[\s.!?]+$/g,'')
    .trim()
    .slice(0,MEMORY_FACT_MAX_LENGTH);
}
function readStoredMemory(){
  try{
    const parsed=JSON.parse(fs.readFileSync(MEMORY_FILE,'utf8'));
    if(!Array.isArray(parsed))return [];
    return parsed.map(normalizeMemoryFact).filter(Boolean).slice(-MEMORY_FACT_LIMIT);
  }catch{return [];}
}
function writeStoredMemory(memory){
  const stable=(Array.isArray(memory)?memory:[]).map(normalizeMemoryFact).filter(Boolean).slice(-MEMORY_FACT_LIMIT);
  try{
    fs.mkdirSync(path.dirname(MEMORY_FILE),{recursive:true});
    fs.writeFileSync(MEMORY_FILE,JSON.stringify(stable,null,2),'utf8');
  }catch(error){
    console.error('Failed to save memory:',error.message);
  }
  return stable;
}
function extractMemoryFacts(text){
  const source=String(text||'').replace(/<file[\s\S]*?<\/file>/g,' ');
  const facts=[];
  const add=fact=>{
    const normalized=normalizeMemoryFact(fact);
    if(normalized.length>=3&&!facts.some(item=>item.toLowerCase()===normalized.toLowerCase()))
      facts.push(normalized);
  };
  const patterns=[
    /\b(?:please\s+)?remember(?:\s+that)?\s+([^.!?\n]{3,180})/gi,
    /\b(?:my name is|call me)\s+([A-Za-z][^.!?,;\n]{0,59})/g,
    /\bmy\s+([a-z][a-z0-9 _-]{1,40})'s\s+name\s+is\s+([^.!?,;\n]{1,80})/gi,
    /\bmy\s+([a-z][a-z0-9 _-]{1,40})\s+is\s+([^.!?\n]{1,120})/gi,
    /\bi\s+(?:am|'m)\s+(\d{1,3})\s+years?\s+old\b/gi,
    /\bi\s+(?:am|'m)\s+(?:based in|located in|from)\s+([^.!?\n]{2,120})/gi,
  ];
  for(const pattern of patterns){
    let match;
    while((match=pattern.exec(source))){
      if(patterns.indexOf(pattern)===1)add(`The user's name is ${match[1]}`);
      else if(patterns.indexOf(pattern)===2)add(`The user's ${match[1].trim()}'s name is ${match[2].trim()}`);
      else if(patterns.indexOf(pattern)===3)add(`The user's ${match[1].trim()} is ${match[2].trim()}`);
      else if(patterns.indexOf(pattern)===4)add(`The user is ${match[1]} years old`);
      else if(patterns.indexOf(pattern)===5)add(`The user is based in ${match[1]}`);
      else add(match[1]);
    }
  }
  return facts;
}
function setAllSessionMemory(memory){
  for(const session of sessions.values())session.memory=[...memory];
}
function addMemoryFacts(session,facts,persist=false){
  session.memory=session.memory||[];
  for(const fact of facts){
    const normalized=normalizeMemoryFact(fact);
    if(!normalized)continue;
    const existing=session.memory.findIndex(item=>item.toLowerCase()===normalized.toLowerCase());
    if(existing>=0)session.memory.splice(existing,1);
    session.memory.push(normalized);
  }
  if(session.memory.length>MEMORY_FACT_LIMIT)
    session.memory=session.memory.slice(-MEMORY_FACT_LIMIT);
  if(persist){
    session.memory=writeStoredMemory(session.memory);
    setAllSessionMemory(session.memory);
  }
  return session.memory;
}
function memoryPrompt(session){
  const memory=(session.memory||[]).filter(Boolean).slice(-MEMORY_FACT_LIMIT);
  if(!memory.length)return null;
  return `Known user facts from earlier messages:\n${memory.map(fact=>`- ${fact}`).join('\n')}\nUse these facts when relevant. Do not reveal this memory block unless asked.`;
}

// Sessions: cwd, model, and learned user facts tracked per SID
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
  if(!sessions.has(sid))sessions.set(sid,{cwd:ROOT,model:DEFAULT_MODEL,memory:readStoredMemory(),lastUsed:now});
  const session=sessions.get(sid);
  session.lastUsed=now;
  session.memory=session.memory||[];
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
  const marker=`__KAI_WORKBENCH_CWD_${crypto.randomBytes(12).toString('hex')}__`;
  const wrapped=`${cmd}\n_kaiworkbench_status=$?\nprintf '\\n${marker}%s\\n' "$PWD"\nexit "$_kaiworkbench_status"`;
  return new Promise(resolve=>exec(wrapped,{cwd,timeout,maxBuffer:2*1024*1024,shell:'/bin/bash'},
    (error,stdout,stderr)=>{
      const output=stdout||'';
      const index=output.lastIndexOf(`\n${marker}`);
      const finalCwd=index>=0?output.slice(index+marker.length+1).trim():cwd;
      resolve({stdout:index>=0?output.slice(0,index):output,stderr:stderr||'',
        exitCode:error?(error.code??1):0,cwd:finalCwd});
    }));
}

function imageExtension(mime){
  return ({
    'image/png':'png',
    'image/jpeg':'jpg',
    'image/jpg':'jpg',
    'image/gif':'gif',
    'image/webp':'webp',
    'image/svg+xml':'svg',
    'image/bmp':'bmp',
  })[String(mime||'').toLowerCase()]||'img';
}

function safeImageName(name){
  return String(name||'chat-image')
    .replace(/[^\w.-]+/g,'-')
    .replace(/^[.-]+|[.-]+$/g,'')
    .slice(0,80)||'chat-image';
}

function openNativeTarget(target){
  const commands=process.platform==='darwin'
    ? [['open',[target]]]
    : process.platform==='win32'
      ? [['cmd.exe',['/c','start','',target]]]
      : [
          ...(process.env.WSL_DISTRO_NAME?[['wslview',[target]]]:[]),
          ['xdg-open',[target]],
          ['gio',['open',target]],
        ];
  return new Promise((resolve,reject)=>{
    let index=0;
    const tryNext=()=>{
      const entry=commands[index++];
      if(!entry)return reject(new Error('No native opener is available'));
      const [command,args]=entry;
      const child=spawn(command,args,{detached:true,stdio:'ignore'});
      child.once('error',tryNext);
      child.once('spawn',()=>{
        child.unref();
        resolve({command});
      });
    };
    tryNext();
  });
}

function writeTempImage(src,name){
  const match=String(src||'').match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if(!match)throw new Error('Only base64 data image URLs can be opened as local files');
  const mime=match[1].toLowerCase();
  const data=Buffer.from(match[2],'base64');
  if(!data.length)throw new Error('Image is empty');
  if(data.length>OPEN_IMAGE_MAX_BYTES)throw new Error('Image is larger than 8 MB');
  const ext=imageExtension(mime);
  const base=safeImageName(name).replace(/\.[^.]+$/,'');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kaiworkbench-image-'));
  const file=path.join(dir,`${base}.${ext}`);
  fs.writeFileSync(file,data);
  return {file,mime,size:data.length};
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
const SYSTEM=`You are KaiWorkbench, a helpful, precise, and expert conversational software engineering assistant.
You answer questions, explain code, and provide clear guidance on software development.
When writing code, explain your design and provide complete, functional code blocks using standard markdown code fences (e.g. \`\`\`javascript).

KaiWorkbench is a self-hosted development environment: the project visible in the current workspace is the application running this conversation. Treat requests to improve "this project" or "your interface" as requests to inspect, modify, and test that workspace rather than as abstract advice.

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

async function chatReferences(lastContent,mode){
  const ragMode=['on','off','auto'].includes(mode)?mode:'auto';
  if(ragMode==='off')return [];
  if(ragMode==='auto'&&!RAG.isLikelyCppQuery(lastContent))return [];
  if(!fs.existsSync(KAI_WORKBENCH_RAG_INDEX))return [];
  try{
    return await RAG.retrieve({
      indexFile:KAI_WORKBENCH_RAG_INDEX,
      baseUrl:OLLAMA,
      topK:KAI_WORKBENCH_RAG_TOP_K,
    },lastContent);
  }catch(error){
    console.error('RAG retrieval failed:',error.message);
    return [];
  }
}

app.post('/api/chat',async(req,res)=>{
  const {messages,sid,rag}=req.body;
  if(!Array.isArray(messages)||messages.length===0)
    return res.status(400).json({error:'messages must be a non-empty array'});
  const s=sess(sid||'default');
  const last=messages[messages.length-1];
  if(!last||typeof last.content!=='string')
    return res.status(400).json({error:'last message must have string content'});
  addMemoryFacts(s,extractMemoryFacts(last.content),true);
  const recent=messages.slice(-KAI_WORKBENCH_HISTORY_MESSAGES);
  const augmented=[...recent.slice(0,-1),
    {...last,content:last.content+`\n\n[cwd: ${s.cwd}]`}];
  const systemMessages=[{role:'system',content:SYSTEM}];
  const memory=memoryPrompt(s);
  if(memory)systemMessages.push({role:'system',content:memory});
  const references=await chatReferences(last.content,rag);
  if(references.length)systemMessages.push({role:'system',content:RAG.ragSystemPrompt(references)});
  const payload=JSON.stringify({
    model:s.model,
    messages:[...systemMessages,...augmented],
    temperature:0.1,
    max_tokens:KAI_WORKBENCH_MAX_TOKENS,
    stream:true,
  });
  const url=new URL('/v1/chat/completions',OLLAMA);
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  const transport=url.protocol==='https:'?https:http;
  let ended=false,upstreamBytes=0,up;
  let firstByteTimer=setTimeout(()=>{
    fail(`Model did not start streaming within ${KAI_WORKBENCH_FIRST_BYTE_TIMEOUT_MS} ms. The selected model may still be loading or may be too large for available memory.`);
    up?.destroy();
  },KAI_WORKBENCH_FIRST_BYTE_TIMEOUT_MS);
  firstByteTimer.unref?.();
  const clearFirstByteTimer=()=>{
    if(firstByteTimer){clearTimeout(firstByteTimer);firstByteTimer=null;}
  };
  const fail=message=>{
    if(ended||res.writableEnded)return;
    clearFirstByteTimer();
    ended=true;
    res.write(`data: ${JSON.stringify({error:message})}\n\n`);res.end();
  };
  up=transport.request({hostname:url.hostname,port:url.port||(url.protocol==='https:'?443:80),path:url.pathname,method:'POST',
    headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},
    r=>{
      if((r.statusCode||500)>=400){
        clearFirstByteTimer();
        let body='';
        r.on('data',chunk=>{if(body.length<8192)body+=chunk;});
        r.on('end',()=>fail(`Model endpoint HTTP ${r.statusCode}: ${body.slice(0,500)}`));
        return;
      }
      r.on('data',chunk=>{
        upstreamBytes+=chunk.length;
        clearFirstByteTimer();
        if(!res.writableEnded)res.write(chunk);
      });
      r.on('end',()=>{
        clearFirstByteTimer();
        if(!upstreamBytes)return fail('Model endpoint closed without streaming a response');
        if(!res.writableEnded){ended=true;res.end();}
      });
    });
  up.setTimeout(KAI_WORKBENCH_TIMEOUT_MS,()=>up.destroy(new Error(`Model request timed out after ${KAI_WORKBENCH_TIMEOUT_MS} ms`)));
  up.on('error',error=>fail(error.message));
  res.on('close',()=>{if(!res.writableEnded&&!ended){clearFirstByteTimer();up.destroy();}});
  up.write(payload);up.end();
});

app.get('/api/rag/status',(_req,res)=>{
  const index=RAG.loadIndex(KAI_WORKBENCH_RAG_INDEX);
  const configuredCorpora=RAG.loadCorpusConfig(APP_ROOT,undefined,KAI_DIR);
  const corpora=index.corpora?.length?index.corpora:configuredCorpora;
  res.json({
    indexFile:KAI_WORKBENCH_RAG_INDEX,
    exists:fs.existsSync(KAI_WORKBENCH_RAG_INDEX),
    embeddingModel:index.embeddingModel||KAI_WORKBENCH_RAG_EMBED_MODEL,
    topK:KAI_WORKBENCH_RAG_TOP_K,
    corpora,
    corpusStatus:RAG.corpusStats(corpora),
    files:Object.keys(index.files||{}).length,
    chunks:index.chunks?.length||0,
    updatedAt:index.updatedAt||null,
  });
});

app.post('/api/rag/index',async(_req,res)=>{
  try{
    const result=await RAG.buildIndex({
      root:APP_ROOT,
      indexFile:KAI_WORKBENCH_RAG_INDEX,
      baseUrl:OLLAMA,
      embeddingModel:KAI_WORKBENCH_RAG_EMBED_MODEL,
      corpora:RAG.loadCorpusConfig(APP_ROOT,undefined,KAI_DIR),
    });
    res.json({ok:true,...result});
  }catch(error){
    res.status(500).json({error:error.message});
  }
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
  res.json({cwd:s.cwd,model:s.model,root:ROOT,memory:s.memory});
});

app.post('/api/session/cwd',(req,res)=>{
  try{
    const s=sess(req.body.sid||'default');
    const abs=safe(req.body.path||'',s.cwd);
    if(!fs.statSync(abs).isDirectory())throw new Error('Not a directory: '+abs);
    s.cwd=abs;
    res.json({ok:true,cwd:s.cwd});
  }catch(e){res.status(400).json({error:e.message});}
});

app.get('/api/memory',(req,res)=>{
  const s=sess(req.query.sid||'default');
  s.memory=readStoredMemory();
  setAllSessionMemory(s.memory);
  res.json({memory:s.memory});
});

app.put('/api/memory',(req,res)=>{
  const s=sess(req.body.sid||'default');
  if(!Array.isArray(req.body.memory))
    return res.status(400).json({error:'memory must be an array'});
  s.memory=writeStoredMemory(req.body.memory);
  setAllSessionMemory(s.memory);
  res.json({ok:true,memory:s.memory});
});

app.post('/api/memory/clear',(req,res)=>{
  const s=sess(req.body.sid||'default');
  s.memory=writeStoredMemory([]);
  setAllSessionMemory(s.memory);
  res.json({ok:true,memory:s.memory});
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

function modelInfo(installed){
  const installedSet=new Set(installed);
  const recommended=new Set(RECOMMENDED_MODELS.map(model=>model.id));
  const extras=installed.filter(id=>!recommended.has(id)).map(id=>({
    id,label:id,vram:'Unknown',ram:'Unknown',fit:'Installed model'
  }));
  return [...RECOMMENDED_MODELS,...extras]
    .map(model=>({...model,installed:installedSet.has(model.id)}));
}

function isInstallableModel(model){
  return typeof model==='string'&&RECOMMENDED_MODELS.some(item=>item.id===model);
}

function cleanInstallOutput(text){
  return String(text)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')
    .replace(/\[[?]?\d+[a-z]/gi,'')
    .replace(/\[[0-9]+[A-Z]/g,'')
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g,'')
    .replace(/\r/g,'\n')
    .split('\n')
    .map(line=>line.trim())
    .filter(Boolean)
    .filter((line,index,lines)=>index===0||line!==lines[index-1])
    .slice(-8)
    .join('\n');
}

function installStatusText(clean,percent){
  const lines=String(clean||'').split('\n').map(line=>line.trim()).filter(Boolean);
  if(Number.isFinite(percent))return 'Downloading model layers';
  if(lines.some(line=>/^pulling manifest\b/i.test(line)))return 'Fetching model manifest';
  if(lines.some(line=>/^pulling [0-9a-f]{8,}\b/i.test(line)))return 'Downloading model layers';
  const useful=lines.filter(line=>!/^pulling (manifest|[0-9a-f]{8,})\b/i.test(line));
  return useful[useful.length-1]||'';
}

app.get('/api/models',async(req,res)=>{
  try{
    const s=sess(req.query.sid||'default');
    const models=await availableModels();
    res.json({models,modelInfo:modelInfo(models),selected:s.model});
  }catch(error){res.status(502).json({error:error.message});}
});

app.post('/api/models/install',async(req,res)=>{
  const model=req.body?.model;
  if(!isInstallableModel(model))return res.status(400).json({error:'model is not installable'});
  if(!isLocalModelEndpoint())return res.status(400).json({error:'model install is only available for local Ollama endpoints'});
  const target=OLLAMA_MODELS;
  try{
    fs.mkdirSync(target,{recursive:true});
    res.setHeader('Content-Type','application/x-ndjson');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('X-Accel-Buffering','no');
    const send=event=>res.write(`${JSON.stringify(event)}\n`);
    send({type:'start',model,target,statusText:'Fetching model manifest'});
    const child=spawn('ollama',['pull',model],{
      env:{...process.env,OLLAMA_MODELS:target},
      stdio:['ignore','pipe','pipe']
    });
    let output='';
    let lastClean='';
    let clientClosed=false;
    req.on('aborted',()=>{
      clientClosed=true;
      if(!child.killed)child.kill('SIGTERM');
    });
    const onData=chunk=>{
      const text=String(chunk);
      const clean=cleanInstallOutput(text);
      const fresh=Boolean(clean&&clean!==lastClean);
      if(fresh){
        output=(output+clean+'\n').slice(-20000);
        lastClean=clean;
      }
      const percents=[...text.matchAll(/(\d{1,3})%/g)].map(match=>Math.min(100,Number(match[1])));
      const percent=percents.length?percents[percents.length-1]:undefined;
      send({type:'progress',statusText:installStatusText(clean,percent),text:fresh?`${clean}\n`:'',...(percent!==undefined?{percent}:{})});
    };
    child.stdout.on('data',onData);
    child.stderr.on('data',onData);
    child.on('error',error=>{
      if(clientClosed)return;
      send({type:'error',error:error.message,target,model,output});
      res.end();
    });
    child.on('close',async code=>{
      if(clientClosed)return;
      if(code!==0){
        send({type:'error',error:(output||`ollama pull exited ${code}`).trim(),target,model,output});
        res.end();
        return;
      }
      try{
        const models=await availableModels();
        send({type:'done',ok:true,model,target,models,modelInfo:modelInfo(models),output,percent:100});
      }catch(error){
        send({type:'error',error:error.message,target,model,output});
      }
      res.end();
    });
  }catch(error){
    res.status(500).json({error:error.message,target,model});
  }
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

app.post('/api/open/image',async(req,res)=>{
  try{
    const {src,name}=req.body||{};
    if(typeof src!=='string'||!src)return res.status(400).json({error:'src required'});
    if(/^https?:\/\//i.test(src)){
      const opened=await openNativeTarget(src);
      return res.json({ok:true,target:src,opened});
    }
    const image=writeTempImage(src,name);
    const opened=await openNativeTarget(image.file);
    res.json({ok:true,path:image.file,mime:image.mime,size:image.size,opened});
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

app.get('/api/resources',async(_req,res)=>{
  res.json({vram:await queryVram(),ram:queryRam()});
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
function ensureKaiENet(){
  const kaiEnet=path.join(KAI_DIR,'Ext/ENet');
  try{
    if(!fs.existsSync(kaiEnet)&&path.resolve(ENET_DIR)!==path.resolve(kaiEnet)&&fs.existsSync(ENET_DIR)){
      fs.mkdirSync(path.dirname(kaiEnet),{recursive:true});
      fs.symlinkSync(ENET_DIR,kaiEnet,'dir');
    }
  }catch{}
}
const kaiRuntimes=new Map();
const validRequestId=id=>/^[A-Za-z0-9._-]{1,128}$/.test(String(id));
const sendSocket=(socket,type,data)=>{
  if(socket.writable)socket.write(wsFrame(JSON.stringify({type,data})));
};
function createKaiRuntime(sid){
  const runtime={sid,proc:null,mode:'pi',clients:new Set(),pending:new Map(),
    controlBuffer:'',lastUsed:Date.now(),idleTimer:null};
  runtime.broadcast=(type,data)=>{
    for(const client of runtime.clients)sendSocket(client,type,data);
  };
  runtime.touch=()=>{
    runtime.lastUsed=Date.now();
    if(runtime.idleTimer){clearTimeout(runtime.idleTimer);runtime.idleTimer=null;}
  };
  runtime.stop=()=>{
    if(runtime.proc)runtime.proc.kill('SIGTERM');
    runtime.proc=null;
    for(const pending of runtime.pending.values())clearTimeout(pending.timer);
    runtime.pending.clear();
    runtime.controlBuffer='';
  };
  runtime.detach=socket=>{
    runtime.clients.delete(socket);
    for(const [id,pending] of runtime.pending)if(pending.socket===socket){
      clearTimeout(pending.timer);runtime.pending.delete(id);
    }
    if(!runtime.clients.size&&!runtime.idleTimer){
      runtime.idleTimer=setTimeout(()=>{
        runtime.stop();
        kaiRuntimes.delete(sid);
      },SESSION_TTL);
      runtime.idleTimer.unref();
    }
  };
  runtime.register=(id,socket)=>{
    if(runtime.pending.has(id))return false;
    const timer=setTimeout(()=>{
      const pending=runtime.pending.get(id);
      if(!pending)return;
      runtime.pending.delete(id);
      sendSocket(pending.socket,'error',`CppKAI request ${id} timed out`);
    },30000);
    timer.unref();
    runtime.pending.set(id,{socket,timer});
    return true;
  };
  runtime.start=mode=>{
    runtime.touch();
    if(runtime.proc)return true;
    if(!fs.existsSync(KAI_CONSOLE))return false;
    ensureKaiENet();
    runtime.mode=['pi','rho','debugger'].includes(mode)?mode:'pi';
    const args=runtime.mode==='debugger'?['-l','pi','-t','5','--verbose']:['-l',runtime.mode];
    const child=spawn(KAI_CONSOLE,args,{
      cwd:KAI_DIR,
      env:{...process.env,TERM:'xterm-256color',KAI_CONTROL_FD:'3'},
      stdio:['pipe','pipe','pipe','pipe']
    });
    runtime.proc=child;
    child.stdout.on('data',data=>runtime.broadcast('stdout',data.toString()));
    child.stderr.on('data',data=>runtime.broadcast('stderr',data.toString()));
    child.stdin.on('error',error=>runtime.broadcast('error',error.message));
    child.stdio[3].on('error',error=>runtime.broadcast('error',error.message));
    child.stdio[3].on('data',data=>{
      runtime.controlBuffer+=data.toString();
      if(runtime.controlBuffer.length>4*1024*1024){
        runtime.broadcast('error','CppKAI control response exceeded 4 MiB');
        runtime.stop();
        return;
      }
      let newline;
      while((newline=runtime.controlBuffer.indexOf('\n'))>=0){
        const line=runtime.controlBuffer.slice(0,newline);
        runtime.controlBuffer=runtime.controlBuffer.slice(newline+1);
        if(!line)continue;
        let response;
        try{response=JSON.parse(line);}catch{
          runtime.broadcast('error','Malformed CppKAI control response');
          continue;
        }
        const pending=runtime.pending.get(String(response.id));
        runtime.pending.delete(String(response.id));
        if(pending){clearTimeout(pending.timer);sendSocket(pending.socket,response.type,response);}
      }
    });
    child.on('error',error=>runtime.broadcast('error',error.message));
    child.on('close',code=>{
      if(runtime.proc!==child)return;
      runtime.proc=null;
      for(const pending of runtime.pending.values())clearTimeout(pending.timer);
      runtime.pending.clear();
      runtime.broadcast('exit',code);
    });
    return true;
  };
  return runtime;
}
function getKaiRuntime(sid){
  let runtime=kaiRuntimes.get(sid);
  if(!runtime){runtime=createKaiRuntime(sid);kaiRuntimes.set(sid,runtime);}
  runtime.touch();
  return runtime;
}
server.on('upgrade',(req,socket,head)=>{
  const wsUrl=new URL(req.url,'http://localhost');
  const sid=wsUrl.searchParams.get('sid');
  if(wsUrl.pathname!=='/api/kai'||!validSessionId(sid)){socket.destroy();return;}
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

  const runtime=getKaiRuntime(sid);
  runtime.clients.add(socket);
  let recv=head&&head.length?Buffer.from(head):Buffer.alloc(0);
  const send=(type,data)=>sendSocket(socket,type,data);
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
      runtime.touch();
      if(parsed.type==='start'){
        const mode=['pi','rho','debugger'].includes(parsed.mode)?parsed.mode:'pi';
        if(!runtime.start(mode))return send('error','CppKAI Console is not built');
        send('ready',runtime.mode);
      }else if(parsed.type==='input'&&runtime.proc){
        runtime.proc.stdin.write(String(parsed.data||'')+'\n');
      }else if(parsed.type==='inspect_tree'&&runtime.proc){
        const id=String(parsed.id||'');
        if(!validRequestId(id))return send('error','Invalid request id');
        if(!runtime.register(id,socket))return send('error','Duplicate request id');
        runtime.proc.stdio[3].write(`__kai_inspect_tree__ ${id}\n`);
      }else if(parsed.type==='debug_action'&&runtime.proc){
        const requestId=String(parsed.id||'');
        const id=String(parsed.executorId||'');
        const action=String(parsed.action||'');
        if(!validRequestId(requestId)||!/^\d+$/.test(id)||!['step','continue','stack','clear'].includes(action)){
          send('error','Invalid Executor debug action');continue;
        }
        if(!runtime.register(requestId,socket))return send('error','Duplicate request id');
        runtime.proc.stdio[3].write(`__kai_debug_action__ ${requestId} ${id} ${action}\n`);
      }else if(parsed.type==='stop'&&runtime.proc){
        runtime.stop();
      }
    }
  });
  socket.on('close',()=>runtime.detach(socket));
});
server.on('close',()=>{
  for(const runtime of kaiRuntimes.values())runtime.stop();
  kaiRuntimes.clear();
});
app.use((error,_req,res,_next)=>{
  if(error.message==='Origin not allowed')return res.status(403).json({error:error.message});
  res.status(500).json({error:'internal server error'});
});
if(require.main===module){
  server.on('error',error=>{
    if(error.code==='EADDRINUSE'){
      console.error(`Port ${PORT} is already in use. Stop the existing KaiWorkbench server or set PORT to another value.`);
      process.exit(1);
    }
    throw error;
  });
  server.listen(PORT,HOST,()=>console.log(`  kai-workbench http://${HOST}:${PORT}  model=${DEFAULT_MODEL}  root=${ROOT}`));
}

module.exports={app,server,safe,validSessionId,selectSessionModel,readUiConfig,
  parseGpuRows,parseGpuProcessRows,summarizeVram,queryRam,extractMemoryFacts,addMemoryFacts,memoryPrompt,
  modelInfo,RECOMMENDED_MODELS,isInstallableModel,cleanInstallOutput,installStatusText,
  imageExtension,safeImageName,writeTempImage,chatReferences};
