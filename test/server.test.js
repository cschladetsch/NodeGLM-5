const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-workbench-test-'));
process.env.SAFE_ROOT = root;
const {app, safe, validSessionId, selectSessionModel, readUiConfig,
  parseGpuRows,parseGpuProcessRows,summarizeVram,queryRam,
  extractMemoryFacts,addMemoryFacts,memoryPrompt,modelInfo,RECOMMENDED_MODELS,isInstallableModel,cleanInstallOutput,installStatusText,
  imageExtension,safeImageName,writeTempImage} = require('../src/server');
const RAG = require('../src/rag');

test.after(() => {
  fs.rmSync(root, {recursive:true, force:true});
});

async function invoke(method, routePath, body = {}, query = {}) {
  const layer = app._router.stack.find(entry =>
    entry.route && entry.route.path === routePath && entry.route.methods[method]);
  assert.ok(layer, `route ${method.toUpperCase()} ${routePath} exists`);
  const result = {statusCode:200, body:undefined, headers:{}};
  const res = {
    status(code) { result.statusCode=code; return this; },
    json(value) { result.body=value; return this; },
    setHeader(name,value) { result.headers[name]=value; },
  };
  await layer.route.stack[0].handle({body,query},res);
  return result;
}

test('safe rejects sibling-prefix and parent traversal paths', () => {
  assert.equal(safe('.'), root);
  assert.throws(() => safe('../escape'), /Outside sandbox/);
  assert.throws(() => safe(`${root}-sibling/file`), /Outside sandbox/);
});

test('safe rejects symlinks that leave the sandbox', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-workbench-outside-'));
  fs.symlinkSync(outside, path.join(root, 'escape-link'));
  assert.throws(() => safe('escape-link/new.txt'), /Outside sandbox/);
  fs.rmSync(outside, {recursive:true, force:true});
});

test('session cwd is shared by bash and relative file tools', async () => {
  fs.mkdirSync(path.join(root, 'project'));
  const cd = (await invoke('post','/api/tool/bash',{sid:'one',cmd:'cd project'})).body;
  assert.equal(cd.cwd, path.join(root, 'project'));

  const write = (await invoke('post','/api/tool/write_file/confirm',
    {sid:'one',path:'hello.txt',content:'hello\n'})).body;
  assert.equal(write.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'project', 'hello.txt'), 'utf8'), 'hello\n');

  const read = (await invoke('post','/api/tool/read_file',{sid:'one',path:'hello.txt'})).body;
  assert.equal(read.content, 'hello\n');
});

test('chat rejects malformed messages before proxying', async () => {
  const response = await invoke('post','/api/chat',{messages:[]});
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /non-empty/);
});

test('RAG chunking keeps template declarations with leading comments', () => {
  const source=[
    '/// CRTP base used by tests.',
    'template <class Derived>',
    'class Base {',
    'public:',
    '  void call() { static_cast<Derived *>(this)->impl(); }',
    '};',
    '',
    'class RuntimeBase {',
    'public:',
    '  virtual void call();',
    '};',
  ].join('\n');
  const chunks=RAG.chunkCppSource(source,'example.hpp','test');
  assert.ok(chunks.some(chunk=>
    chunk.text.includes('/// CRTP base')&&
    chunk.text.includes('template <class Derived>')&&
    chunk.text.includes('static_cast<Derived *>')
  ));
});

test('RAG status endpoint is available without an index', async () => {
  const response=await invoke('get','/api/rag/status');
  assert.equal(response.statusCode,200);
  assert.equal(typeof response.body.indexFile,'string');
  assert.equal(typeof response.body.chunks,'number');
  assert.ok(Array.isArray(response.body.corpora));
  assert.ok(Array.isArray(response.body.corpusStatus));
  assert.equal(typeof response.body.corpusStatus[0]?.exists,'boolean');
});

test('RAG corpus defaults follow the configured KAI checkout', () => {
  const kaiDir=path.join(root,'external-kai');
  const corpora=RAG.loadCorpusConfig(__dirname,undefined,kaiDir);
  assert.deepEqual(corpora,[
    {id:'CppKaiCore',path:path.join(kaiDir,'Ext/CppKaiCore')},
    {id:'CppKaiLanguage',path:path.join(kaiDir,'Ext/CppKaiLanguage')},
  ]);
});

test('RAG default index path is repo-relative, not SAFE_ROOT-relative', () => {
  assert.equal(RAG.resolveIndexFile(__dirname),path.join(__dirname,RAG.DEFAULT_INDEX_FILE));
  assert.equal(RAG.resolveIndexFile(__dirname,'rag/index.json'),path.join(__dirname,'rag/index.json'));
});

test('RAG indexing is incremental and keeps CRTP chunks retrievable', async () => {
  const project=fs.mkdtempSync(path.join(os.tmpdir(),'kai-rag-index-'));
  const corpus=path.join(project,'Ext','CppKAI','Ext','CppKaiCore');
  fs.mkdirSync(corpus,{recursive:true});
  const source=[
    '/// CRTP base used by the regression test.',
    'template <class Derived>',
    'class Base {',
    'public:',
    '  void call() { static_cast<Derived *>(this)->impl(); }',
    '  void explain() { static_cast<Derived *>(this)->impl(); }',
    '};',
    '',
    'class Widget : public Base<Widget> {',
    'public:',
    '  void impl();',
    '};',
  ].join('\n');
  fs.writeFileSync(path.join(corpus,'Base.hpp'),source);
  const indexFile=path.join(project,'.kaiworkbench-rag-index.json');
  let embeds=0;
  const fakeEmbed=async text=>{
    embeds++;
    return [
      /crtp|Derived|static_cast|Base<Widget>/i.test(text)?1:0,
      /virtual/i.test(text)?1:0,
      String(text).length/1000,
    ];
  };
  const options={
    root:project,
    indexFile,
    embeddingModel:'test-embed',
    corpora:[{id:'CppKaiCore',path:corpus}],
    embedText:fakeEmbed,
  };
  const first=await RAG.buildIndex(options);
  assert.equal(first.changedFiles,1);
  assert.ok(first.embeddedChunks>=1);
  const firstEmbeds=embeds;
  const second=await RAG.buildIndex(options);
  assert.equal(second.changedFiles,0);
  assert.equal(second.skippedFiles,1);
  assert.equal(embeds,firstEmbeds);

  const refs=await RAG.retrieve({...options,topK:1},'Explain CRTP template Derived static_cast');
  assert.equal(refs.length,1);
  assert.match(refs[0].text,/template <class Derived>/);
  assert.match(refs[0].text,/static_cast<Derived \*>/);
  const prompt=RAG.ragSystemPrompt(refs);
  assert.match(prompt,/Do not replace CRTP with runtime virtual-function polymorphism/);
  assert.match(prompt,/Base\.hpp:\d+-\d+/);
  fs.rmSync(project,{recursive:true,force:true});
});

test('UI config endpoint returns the validated request progress threshold', async () => {
  const response=await invoke('get','/ui-config.json');
  assert.equal(response.statusCode,200);
  assert.deepEqual(response.body,readUiConfig());
  assert.equal(typeof response.body.requestProgressDelaySeconds,'number');
});

test('image open endpoint can materialize chat images as local temp files', () => {
  const layer = app._router.stack.find(entry =>
    entry.route && entry.route.path === '/api/open/image' && entry.route.methods.post);
  assert.ok(layer, 'POST /api/open/image exists');
  assert.equal(imageExtension('image/png'),'png');
  assert.equal(safeImageName('../bad name.png'),'bad-name.png');
  const image=writeTempImage('data:image/png;base64,aGVsbG8=','hello.png');
  assert.equal(image.mime,'image/png');
  assert.equal(image.size,5);
  assert.equal(path.extname(image.file),'.png');
  assert.equal(fs.readFileSync(image.file,'utf8'),'hello');
  fs.rmSync(path.dirname(image.file),{recursive:true,force:true});
});

test('VRAM parser summarizes app and overall GPU memory', () => {
  const gpus=parseGpuRows('GPU-abc, 0, NVIDIA RTX 2070, 6144, 8192\n');
  const processes=parseGpuProcessRows([
    'GPU-abc, 111, /usr/bin/ollama, 5120',
    'GPU-abc, 222, /usr/bin/kwin, 256',
  ].join('\n'));
  const summary=summarizeVram(gpus,processes,new Set([333]),true);
  assert.equal(summary.available,true);
  assert.equal(summary.total.usedMiB,6144);
  assert.equal(summary.total.totalMiB,8192);
  assert.equal(summary.total.appUsedMiB,5120);
  assert.equal(summary.gpus[0].appUsedMiB,5120);
});

test('RAM summary reports system and app memory in MiB', () => {
  const summary=queryRam();
  assert.equal(summary.available,true);
  assert.equal(summary.source,'node-os');
  assert.ok(summary.total.totalMiB>0);
  assert.ok(summary.total.usedMiB>=0);
  assert.ok(summary.total.appUsedMiB>0);
});

test('memory extraction captures explicit user facts', () => {
  const facts=extractMemoryFacts("My name is Christian. I am 54 years old. My cat's name is Raffy. My favorite editor is Vim. Remember that I prefer direct answers.");
  assert.deepEqual(facts,[
    'I prefer direct answers',
    "The user's cat's name is Raffy",
    "The user's name is Christian",
    "The user's favorite editor is Vim",
    'The user is 54 years old',
  ]);
});

test('session memory deduplicates facts and builds a prompt block', () => {
  const session={memory:[]};
  addMemoryFacts(session,['The user likes Vim','the user likes Vim','The user works in KaiWorkbench']);
  assert.deepEqual(session.memory,['the user likes Vim','The user works in KaiWorkbench']);
  assert.match(memoryPrompt(session),/Known user facts/);
  assert.match(memoryPrompt(session),/- the user likes Vim/);
});

test('memory endpoint reports and clears session facts', async () => {
  const before=await invoke('get','/api/memory',{}, {sid:'memory'});
  assert.deepEqual(before.body.memory,[]);
  const updated=await invoke('put','/api/memory',{sid:'memory',memory:[' Christian ', '', 'The user likes Vim.']});
  assert.equal(updated.body.ok,true);
  assert.deepEqual(updated.body.memory,['Christian','The user likes Vim']);
  const cleared=await invoke('post','/api/memory/clear',{sid:'memory'});
  assert.equal(cleared.body.ok,true);
  assert.deepEqual(cleared.body.memory,[]);
});

test('UI config accepts zero and fractional progress delays', () => {
  for(const delay of [0,0.25,30]){
    const configPath=path.join(root,`ui-config-${delay}.json`);
    fs.writeFileSync(configPath,JSON.stringify({requestProgressDelaySeconds:delay}));
    assert.equal(readUiConfig(configPath).requestProgressDelaySeconds,delay);
  }
});

test('UI config rejects missing, non-numeric, negative, and non-finite delays', () => {
  const invalid=[{}, {requestProgressDelaySeconds:'3'}, {requestProgressDelaySeconds:-1},
    {requestProgressDelaySeconds:null}];
  invalid.forEach((config,index)=>{
    const configPath=path.join(root,`invalid-ui-config-${index}.json`);
    fs.writeFileSync(configPath,JSON.stringify(config));
    assert.throws(()=>readUiConfig(configPath),/non-negative finite number/);
  });
  const nonFinitePath=path.join(root,'non-finite-ui-config.json');
  fs.writeFileSync(nonFinitePath,'{"requestProgressDelaySeconds":1e999}');
  assert.throws(()=>readUiConfig(nonFinitePath),/non-negative finite number/);
});

test('UI config reports malformed JSON', () => {
  const configPath=path.join(root,'malformed-ui-config.json');
  fs.writeFileSync(configPath,'{"requestProgressDelaySeconds":');
  assert.throws(()=>readUiConfig(configPath),SyntaxError);
});

test('API rejects malformed session identifiers', async () => {
  assert.equal(validSessionId('session-123.example'),true);
  assert.equal(validSessionId('../escape'),false);
  assert.equal(validSessionId('__proto__'),true);
  assert.equal(validSessionId('x'.repeat(129)),false);
});

test('model selection is session-scoped and limited to installed models', async () => {
  assert.equal(selectSessionModel('model-a','qwen:7b',['qwen:7b','llama:9b']),'qwen:7b');
  assert.equal(selectSessionModel('model-b','llama:9b',['qwen:7b','llama:9b']),'llama:9b');
  assert.throws(()=>selectSessionModel('model-a','missing:1b',['qwen:7b']),/not installed/);
  assert.throws(()=>selectSessionModel('model-a',null,['qwen:7b']),/required/);
});

test('model metadata includes installed and potential smaller models', async () => {
  const info=modelInfo(['qwen2.5-coder:7b','custom:latest']);
  assert.ok(RECOMMENDED_MODELS.some(model=>model.id==='qwen2.5-coder:1.5b'));
  assert.equal(info.find(model=>model.id==='qwen2.5-coder:7b').installed,true);
  assert.equal(info.find(model=>model.id==='qwen2.5-coder:1.5b').installed,false);
  assert.equal(info.find(model=>model.id==='custom:latest').installed,true);
  assert.match(info.find(model=>model.id==='qwen2.5-coder:1.5b').vram,/GB/);
  assert.equal(isInstallableModel('qwen2.5-coder:1.5b'),true);
  assert.equal(isInstallableModel('custom:latest'),false);
});

test('model install output strips terminal control sequences', async () => {
  const clean=cleanInstallOutput('\u001b[?25l\u001b[1Gpulling manifest ⠼ \u001b[K\u001b[?25h\u001b[?2026l');
  assert.equal(clean,'pulling manifest');
  assert.doesNotMatch(clean,/\[?\d+[A-Za-z]/);
  assert.doesNotMatch(clean,/⠼/);
  assert.equal(cleanInstallOutput('pulling manifest\npulling manifest\n'),'pulling manifest');
  assert.equal(installStatusText('pulling manifest',undefined),'Fetching model manifest');
  const layerDigest='a'.repeat(12);
  assert.equal(installStatusText(`pulling ${layerDigest}`,undefined),'Downloading model layers');
  assert.equal(installStatusText(`pulling ${layerDigest}: 18%`,18),'Downloading model layers');
  assert.equal(installStatusText('verifying sha256 digest',undefined),'verifying sha256 digest');
});

test('browser editor writes ROOT-relative files', async () => {
  const response=await invoke('post','/api/fs/write',
    {path:'editor.txt',content:'edited\n'});
  assert.equal(response.statusCode,200);
  assert.equal(response.body.ok,true);
  assert.equal(fs.readFileSync(path.join(root,'editor.txt'),'utf8'),'edited\n');
});

test('browser filesystem follows the Bash session cwd', async () => {
  fs.mkdirSync(path.join(root,'browser-project'));
  await invoke('post','/api/tool/bash',{sid:'browser',cmd:'cd browser-project'});

  const write=await invoke('post','/api/fs/write',
    {sid:'browser',path:'session.txt',content:'session cwd\n'});
  assert.equal(write.body.ok,true);
  assert.equal(fs.readFileSync(path.join(root,'browser-project','session.txt'),'utf8'),'session cwd\n');

  const list=await invoke('get','/api/fs/list',{}, {sid:'browser',path:''});
  assert.equal(list.body.cwd,path.join(root,'browser-project'));
  assert.ok(list.body.entries.some(entry=>entry.name==='session.txt'));
});

test('browser cwd navigation updates the shared session cwd', async () => {
  fs.mkdirSync(path.join(root,'browser-nav'));
  const down=await invoke('post','/api/session/cwd',{sid:'browser-nav',path:'browser-nav'});
  assert.equal(down.body.cwd,path.join(root,'browser-nav'));

  const up=await invoke('post','/api/session/cwd',{sid:'browser-nav',path:'..'});
  assert.equal(up.body.cwd,root);

  const list=await invoke('get','/api/fs/list',{}, {sid:'browser-nav',path:''});
  assert.equal(list.body.cwd,root);
});

test('write diff previews existing and new files without changing them', async () => {
  fs.writeFileSync(path.join(root,'existing.txt'),'old\n');
  const existing=(await invoke('post','/api/tool/write_file/diff',
    {path:'existing.txt',content:'new\n',sid:'diff'})).body;
  assert.match(existing.patch,/-old/);
  assert.match(existing.patch,/\+new/);
  assert.equal(existing.isNew,false);
  assert.equal(fs.readFileSync(path.join(root,'existing.txt'),'utf8'),'old\n');

  const fresh=(await invoke('post','/api/tool/write_file/diff',
    {path:'fresh.txt',content:'fresh\n',sid:'diff'})).body;
  assert.equal(fresh.isNew,true);
  assert.equal(fs.existsSync(path.join(root,'fresh.txt')),false);
});

test('browser filesystem endpoints reject traversal', async () => {
  const read=await invoke('get','/api/fs/read',{}, {path:'../outside.txt'});
  assert.equal(read.statusCode,400);
  assert.match(read.body.error,/Outside sandbox/);

  const write=await invoke('post','/api/fs/write',{path:'../outside.txt',content:'no'});
  assert.equal(write.statusCode,400);
  assert.match(write.body.error,/Outside sandbox/);
});

test('bash sessions are isolated and report command failures', async () => {
  fs.mkdirSync(path.join(root,'isolated'));
  const moved=(await invoke('post','/api/tool/bash',{sid:'session-a',cmd:'cd isolated'})).body;
  assert.equal(moved.exitCode,0);

  const other=(await invoke('post','/api/tool/bash',{sid:'session-b',cmd:'pwd'})).body;
  assert.equal(other.stdout.trim(),root);

  const failed=(await invoke('post','/api/tool/bash',{sid:'session-b',cmd:'exit 7'})).body;
  assert.equal(failed.exitCode,7);
});

test('compound and multiline Bash commands persist their final cwd', async () => {
  fs.mkdirSync(path.join(root,'compound'));
  const compound=(await invoke('post','/api/tool/bash',
    {sid:'compound-cwd',cmd:'cd compound && pwd'})).body;
  assert.equal(compound.exitCode,0);
  assert.equal(compound.cwd,path.join(root,'compound'));

  const parent=(await invoke('post','/api/tool/bash',
    {sid:'compound-cwd',cmd:'printf first\\n\ncd ..\nprintf second\\n'})).body;
  assert.equal(parent.exitCode,0);
  assert.equal(parent.cwd,root);
  assert.match(parent.stdout,/first/);
  assert.match(parent.stdout,/second/);
});
