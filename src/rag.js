const fs=require('fs'),path=require('path'),http=require('http'),https=require('https'),crypto=require('crypto');

const SOURCE_EXTENSIONS=new Set(['.h','.hh','.hpp','.hxx','.c','.cc','.cpp','.cxx','.ipp','.inl']);
const DEFAULT_KAI_DIR='Ext/CppKAI';
const DEFAULT_CORPORA=[
  {id:'CppKaiCore',path:path.join(DEFAULT_KAI_DIR,'Ext/CppKaiCore')},
  {id:'CppKaiLanguage',path:path.join(DEFAULT_KAI_DIR,'Ext/CppKaiLanguage')},
];
const DEFAULT_INDEX_FILE='.kaiworkbench-rag-index.json';
const DEFAULT_EMBED_MODEL='nomic-embed-text';
const DEFAULT_TOP_K=3;
const MAX_CHUNK_CHARS=1600;
const MIN_CHUNK_CHARS=120;

function sha256(text){
  return crypto.createHash('sha256').update(text).digest('hex');
}

function resolveIndexFile(root,indexFile=process.env.KAI_WORKBENCH_RAG_INDEX||DEFAULT_INDEX_FILE){
  return path.isAbsolute(String(indexFile))?String(indexFile):path.resolve(root,String(indexFile));
}

function isSourceFile(file){
  return SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function walk(dir){
  const files=[];
  if(!fs.existsSync(dir))return files;
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(entry.name==='.git'||entry.name==='build'||entry.name==='Bin'||entry.name==='Logs')continue;
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())files.push(...walk(full));
    else if(entry.isFile()&&isSourceFile(full))files.push(full);
  }
  return files;
}

function corpusStats(corpora){
  return corpora.map(corpus=>{
    const exists=fs.existsSync(corpus.path);
    const files=exists?walk(corpus.path).length:0;
    return {...corpus,exists,files};
  });
}

function defaultCorpora(root,kaiDir=process.env.KAI_DIR||path.join(root,DEFAULT_KAI_DIR)){
  const base=path.isAbsolute(kaiDir)?kaiDir:path.resolve(root,kaiDir);
  return [
    {id:'CppKaiCore',path:path.join(base,'Ext/CppKaiCore')},
    {id:'CppKaiLanguage',path:path.join(base,'Ext/CppKaiLanguage')},
  ];
}

function normalizeCorpora(root,corpora){
  return corpora.map(item=>({
    id:String(item.id),
    path:path.isAbsolute(String(item.path))?String(item.path):path.resolve(root,String(item.path)),
  }));
}

function loadCorpusConfig(root,configPath=process.env.KAI_WORKBENCH_RAG_CORPORA,kaiDir=process.env.KAI_DIR){
  if(configPath){
    const parsed=JSON.parse(fs.readFileSync(path.resolve(root,configPath),'utf8'));
    if(!Array.isArray(parsed.corpora))throw new Error('RAG corpus config must contain a corpora array');
    return normalizeCorpora(root,parsed.corpora);
  }
  return normalizeCorpora(root,defaultCorpora(root,kaiDir));
}

function lineDelta(line){
  let delta=0,inString=false,quote='',escaped=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i],next=line[i+1];
    if(inString){
      if(escaped)escaped=false;
      else if(ch==='\\')escaped=true;
      else if(ch===quote)inString=false;
      continue;
    }
    if(ch==='"'||ch==="'"){inString=true;quote=ch;continue;}
    if(ch==='/'&&next==='/')break;
    if(ch==='{' )delta++;
    else if(ch==='}')delta--;
  }
  return delta;
}

function startsDeclaration(line){
  const trimmed=line.trim();
  return /^(template\b|class\b|struct\b|enum\b|namespace\b|using\b|typedef\b|#\s*(define|if|ifdef|ifndef)|[A-Za-z_][\w:<>,~*&\s]+\s+[A-Za-z_~][\w:~]*\s*\([^;{}]*\)\s*(const\b|override\b|final\b|noexcept\b|->|$|\{))/.test(trimmed);
}

function isCommentLine(line){
  return /^\s*(\/\/\/?|\/\*\*?|\*|\*\/)/.test(line)||/^\s*$/.test(line);
}

function splitOversizeChunk(chunk){
  if(chunk.text.length<=MAX_CHUNK_CHARS)return [chunk];
  const parts=[];
  const lines=chunk.text.split('\n');
  let start=chunk.startLine,buf=[];
  for(let i=0;i<lines.length;i++){
    buf.push(lines[i]);
    if(buf.join('\n').length>=MAX_CHUNK_CHARS){
      parts.push({...chunk,startLine:start,endLine:chunk.startLine+i,text:buf.join('\n')});
      start=chunk.startLine+i+1;buf=[];
    }
  }
  if(buf.join('\n').trim())parts.push({...chunk,startLine:start,endLine:chunk.endLine,text:buf.join('\n')});
  return parts;
}

function chunkCppSource(content,file,corpusId){
  const lines=content.replace(/\r\n/g,'\n').split('\n');
  const chunks=[];
  let i=0,pendingComments=[];
  while(i<lines.length){
    const line=lines[i];
    if(isCommentLine(line)){
      pendingComments.push({line,index:i});
      if(pendingComments.length>30)pendingComments.shift();
      i++;continue;
    }
    const trimmed=line.trim();
    if(!trimmed){i++;continue;}
    if(!startsDeclaration(line)){
      pendingComments=[];i++;continue;
    }
    const startComment=pendingComments.length?pendingComments[0].index:i;
    let depth=0,seenBrace=false,end=i;
    for(;end<lines.length;end++){
      const d=lineDelta(lines[end]);
      if(d>0)seenBrace=true;
      depth+=d;
      const t=lines[end].trim();
      if(seenBrace&&depth<=0&&end>i)break;
      if(!seenBrace&&/[;}]$/.test(t))break;
      if(end-i>220)break;
    }
    const text=lines.slice(startComment,end+1).join('\n').trim();
    if(text.length>=MIN_CHUNK_CHARS){
      chunks.push(...splitOversizeChunk({
        id:null,corpusId,file,startLine:startComment+1,endLine:end+1,text
      }));
    }
    pendingComments=[];
    i=end+1;
  }
  if(!chunks.length&&content.trim().length>=MIN_CHUNK_CHARS){
    chunks.push({id:null,corpusId,file,startLine:1,endLine:lines.length,text:content.slice(0,MAX_CHUNK_CHARS)});
  }
  return chunks.map((chunk,index)=>({...chunk,id:sha256(`${corpusId}:${file}:${chunk.startLine}:${chunk.endLine}:${index}:${chunk.text}`).slice(0,16)}));
}

function requestJson(url,body,timeout=120000){
  return new Promise((resolve,reject)=>{
    const parsed=new URL(url);
    const data=JSON.stringify(body);
    const transport=parsed.protocol==='https:'?https:http;
    const req=transport.request({
      hostname:parsed.hostname,
      port:parsed.port||(parsed.protocol==='https:'?443:80),
      path:parsed.pathname,
      method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}
    },res=>{
      let text='';
      res.on('data',chunk=>{if(text.length<32*1024*1024)text+=chunk;});
      res.on('end',()=>{
        if((res.statusCode||500)>=400)return reject(new Error(`Embedding endpoint HTTP ${res.statusCode}: ${text.slice(0,500)}`));
        try{resolve(JSON.parse(text));}catch(error){reject(new Error(`Invalid embedding response: ${error.message}`));}
      });
    });
    req.setTimeout(timeout,()=>req.destroy(new Error(`Embedding request timed out after ${timeout} ms`)));
    req.on('error',reject);
    req.write(data);req.end();
  });
}

async function embedText(baseUrl,model,text){
  const base=String(baseUrl).replace(/\/+$/,'').replace(/\/v1$/,'');
  try{
    const result=await requestJson(`${base}/api/embeddings`,{model,prompt:text});
    if(Array.isArray(result.embedding))return result.embedding;
  }catch(error){
    if(!/404|not found/i.test(error.message))throw error;
  }
  const result=await requestJson(`${base}/api/embed`,{model,input:text});
  if(Array.isArray(result.embeddings)&&Array.isArray(result.embeddings[0]))return result.embeddings[0];
  if(Array.isArray(result.embedding))return result.embedding;
  throw new Error('Embedding response did not contain an embedding vector');
}

function emptyIndex(version=1){
  return {version,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
    embeddingModel:null,corpora:[],files:{},chunks:[]};
}

function loadIndex(indexFile){
  try{
    const parsed=JSON.parse(fs.readFileSync(indexFile,'utf8'));
    if(parsed&&Array.isArray(parsed.chunks)&&parsed.files)return parsed;
  }catch{}
  return emptyIndex();
}

function saveIndex(indexFile,index){
  fs.mkdirSync(path.dirname(indexFile),{recursive:true});
  fs.writeFileSync(indexFile,JSON.stringify(index,null,2),'utf8');
}

async function buildIndex(options){
  const root=options.root;
  const indexFile=resolveIndexFile(root,options.indexFile);
  const embeddingModel=options.embeddingModel||DEFAULT_EMBED_MODEL;
  const baseUrl=options.baseUrl;
  const embed=options.embedText||((text)=>embedText(baseUrl,embeddingModel,text));
  const corpora=options.corpora||loadCorpusConfig(root);
  const previous=loadIndex(indexFile);
  const oldChunksByFile=new Map();
  for(const chunk of previous.chunks||[]){
    if(!oldChunksByFile.has(chunk.file))oldChunksByFile.set(chunk.file,[]);
    oldChunksByFile.get(chunk.file).push(chunk);
  }
  const next={...emptyIndex(),createdAt:previous.createdAt||new Date().toISOString(),
    updatedAt:new Date().toISOString(),embeddingModel,corpora,files:{},chunks:[]};
  let scannedFiles=0,changedFiles=0,embeddedChunks=0,skippedFiles=0;
  const corpusResults=[];
  for(const corpus of corpora){
    const corpusRoot=path.isAbsolute(corpus.path)?corpus.path:path.resolve(root,corpus.path);
    const files=walk(corpusRoot);
    const corpusResult={...corpus,path:corpusRoot,exists:fs.existsSync(corpusRoot),files:files.length,changedFiles:0,skippedFiles:0,embeddedChunks:0};
    for(const abs of files){
      scannedFiles++;
      const rel=path.relative(root,abs);
      const content=fs.readFileSync(abs,'utf8');
      const fileHash=sha256(content);
      const previousFile=previous.files?.[rel];
      if(previousFile?.hash===fileHash&&previous.embeddingModel===embeddingModel){
        next.files[rel]=previousFile;
        next.chunks.push(...(oldChunksByFile.get(rel)||[]));
        skippedFiles++;corpusResult.skippedFiles++;
        continue;
      }
      changedFiles++;corpusResult.changedFiles++;
      const chunks=chunkCppSource(content,rel,corpus.id);
      for(const chunk of chunks){
        const embedding=await embed(chunk.text);
        next.chunks.push({...chunk,hash:sha256(chunk.text),embedding});
        embeddedChunks++;corpusResult.embeddedChunks++;
      }
      next.files[rel]={hash:fileHash,corpusId:corpus.id,chunkIds:chunks.map(chunk=>chunk.id),mtimeMs:fs.statSync(abs).mtimeMs};
    }
    corpusResults.push(corpusResult);
  }
  saveIndex(indexFile,next);
  return {indexFile,embeddingModel,corpora,corpusResults,scannedFiles,changedFiles,skippedFiles,embeddedChunks,totalChunks:next.chunks.length};
}

function dot(a,b){
  let value=0;
  for(let i=0;i<Math.min(a.length,b.length);i++)value+=a[i]*b[i];
  return value;
}
function norm(a){
  return Math.sqrt(a.reduce((total,value)=>total+value*value,0))||1;
}
function cosine(a,b){
  return dot(a,b)/(norm(a)*norm(b));
}

async function retrieve(options,query){
  const index=loadIndex(options.indexFile);
  if(!index.chunks.length)return [];
  const model=options.embeddingModel||index.embeddingModel||DEFAULT_EMBED_MODEL;
  const embed=options.embedText||((text)=>embedText(options.baseUrl,model,text));
  const queryEmbedding=await embed(query);
  return index.chunks
    .filter(chunk=>Array.isArray(chunk.embedding))
    .map(chunk=>({...chunk,score:cosine(queryEmbedding,chunk.embedding)}))
    .sort((a,b)=>b.score-a.score)
    .slice(0,options.topK||DEFAULT_TOP_K)
    .map(({embedding,...chunk})=>chunk);
}

function isLikelyCppQuery(text){
  return /\b(c\+\+|cpp|template|typename|sfinae|crtp|constexpr|concept|metaprogramming|std::|virtual|inheritance|polymorphism|kai|rho|tau|pi)\b/i.test(String(text||''));
}

function formatReferences(chunks){
  return chunks.map((chunk,index)=>[
    `Reference ${index+1}: ${chunk.file}:${chunk.startLine}-${chunk.endLine} (corpus ${chunk.corpusId}, score ${chunk.score.toFixed(3)})`,
    '```cpp',
    chunk.text,
    '```'
  ].join('\n')).join('\n\n');
}

function ragSystemPrompt(chunks){
  return `Use the following retrieved KAI source references as grounding material for this answer.
Ground technical C++ claims in these references and cite paths/line ranges when they support the answer.
If the references are irrelevant or do not cover the question, say that explicitly before giving any general guidance.
Do not replace CRTP with runtime virtual-function polymorphism unless the retrieved source actually uses virtual dispatch for the question.

${formatReferences(chunks)}`;
}

module.exports={
  DEFAULT_CORPORA,DEFAULT_INDEX_FILE,DEFAULT_EMBED_MODEL,DEFAULT_TOP_K,
  defaultCorpora,normalizeCorpora,corpusStats,chunkCppSource,loadCorpusConfig,resolveIndexFile,buildIndex,loadIndex,retrieve,isLikelyCppQuery,ragSystemPrompt,formatReferences,
};

if(require.main===module){
  const root=path.resolve(__dirname,'..');
  const baseUrl=process.env.KAI_WORKBENCH_BASE_URL||'http://localhost:11434';
  const indexFile=resolveIndexFile(root);
  buildIndex({
    root,
    indexFile,
    baseUrl,
    embeddingModel:process.env.KAI_WORKBENCH_RAG_EMBED_MODEL||DEFAULT_EMBED_MODEL,
    corpora:loadCorpusConfig(root),
  }).then(result=>{
    console.log(JSON.stringify({ok:true,...result},null,2));
  }).catch(error=>{
    console.error(error.message);
    process.exit(1);
  });
}
