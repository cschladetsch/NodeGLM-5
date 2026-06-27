const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-code-test-'));
process.env.SAFE_ROOT = root;
const {app, safe, validSessionId, selectSessionModel, readUiConfig,
  parseGpuRows,parseGpuProcessRows,summarizeVram,queryRam,
  extractMemoryFacts,addMemoryFacts,memoryPrompt} = require('../server');

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
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-code-outside-'));
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

test('UI config endpoint returns the validated request progress threshold', async () => {
  const response=await invoke('get','/ui-config.json');
  assert.equal(response.statusCode,200);
  assert.deepEqual(response.body,readUiConfig());
  assert.equal(typeof response.body.requestProgressDelaySeconds,'number');
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
  const facts=extractMemoryFacts('My name is Christian. My favorite editor is Vim. Remember that I prefer direct answers.');
  assert.deepEqual(facts,[
    'I prefer direct answers',
    "The user's name is Christian",
    "The user's favorite editor is Vim",
  ]);
});

test('session memory deduplicates facts and builds a prompt block', () => {
  const session={memory:[]};
  addMemoryFacts(session,['The user likes Vim','the user likes Vim','The user works in NodeGLM']);
  assert.deepEqual(session.memory,['the user likes Vim','The user works in NodeGLM']);
  assert.match(memoryPrompt(session),/Known user facts/);
  assert.match(memoryPrompt(session),/- the user likes Vim/);
});

test('memory endpoint reports and clears session facts', async () => {
  const before=await invoke('get','/api/memory',{}, {sid:'memory'});
  assert.deepEqual(before.body.memory,[]);
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
  assert.equal(selectSessionModel('model-a','qwen:7b',['qwen:7b','glm:9b']),'qwen:7b');
  assert.equal(selectSessionModel('model-b','glm:9b',['qwen:7b','glm:9b']),'glm:9b');
  assert.throws(()=>selectSessionModel('model-a','missing:1b',['qwen:7b']),/not installed/);
  assert.throws(()=>selectSessionModel('model-a',null,['qwen:7b']),/required/);
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
