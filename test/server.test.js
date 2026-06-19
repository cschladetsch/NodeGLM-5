const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-code-test-'));
process.env.SAFE_ROOT = root;
const {app, safe} = require('../server');

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

test('browser editor writes ROOT-relative files', async () => {
  const response=await invoke('post','/api/fs/write',
    {path:'editor.txt',content:'edited\n'});
  assert.equal(response.statusCode,200);
  assert.equal(response.body.ok,true);
  assert.equal(fs.readFileSync(path.join(root,'editor.txt'),'utf8'),'edited\n');
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
