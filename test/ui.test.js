const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const launcher=fs.readFileSync(path.join(__dirname,'..','s'),'utf8');
const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
const submodules=fs.readFileSync(path.join(__dirname,'..','.gitmodules'),'utf8');

test('Ace loads from the pinned CDN and configures its module base',()=>{
  assert.match(html,/ace\/1\.36\.5\/ace\.js/);
  assert.match(html,/ace\.config\.set\('basePath','https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/ace\/1\.36\.5\/'\)/);
});

test('Ace editor enables Monokai, Vim, and a save command',()=>{
  assert.match(html,/editor\.setTheme\('ace\/theme\/monokai'\)/);
  assert.match(html,/editor\.setKeyboardHandler\('ace\/keyboard\/vim'\)/);
  assert.match(html,/name:'saveFile'/);
  assert.match(html,/win:'Ctrl-S',mac:'Command-S'/);
});

test('C and C++ extensions map to the Ace C++ mode',()=>{
  for(const extension of ['c','cc','cpp','cxx','h','hh','hpp'])
    assert.match(html,new RegExp(`${extension}:'c_cpp'`));
});

test('editor save posts current Ace content to the filesystem endpoint',()=>{
  assert.match(html,/fetch\(`\$\{API\}\/api\/fs\/write`/);
  assert.match(html,/content:aceRef\.current\.getValue\(\)/);
});

test('./s is a thin launcher',()=>{
  assert.match(launcher,/exec npm start/);
  assert.doesNotMatch(launcher,/cat >|TOOL:|new WebSocketServer|editor\.setTheme/);
});

test('index.html provides the Vim-enabled, syntax-colored Ace editor',()=>{
  assert.match(html,/ace\/1\.36\.5\/ace\.js/);
  assert.match(html,/editor\.setTheme\('ace\/theme\/monokai'\)/);
  assert.match(html,/editor\.setKeyboardHandler\('ace\/keyboard\/vim'/);
  assert.match(html,/editor\.session\.setMode\(`ace\/mode\/\$\{aceMode\(filePath\)\}`\)/);
  assert.match(html,/editor\.commands\.addCommand\(\{name:'saveFile'/);
  assert.match(html,/win:'Ctrl-S',mac:'Command-S'/);
});

test('server.js integrates the filesystem and chat endpoints',()=>{
  assert.match(server,/app\.post\('\/api\/chat'/);
  assert.match(server,/app\.get\('\/api\/modelstore'/);
  assert.match(server,/app\.post\('\/api\/fs\/write'/);
  assert.match(server,/app\.get\('\/api\/health'/);
});

test('server.js exposes the current REPL and filesystem endpoints',()=>{
  assert.match(server,/app\.post\('\/api\/repl\/exec'/);
  assert.match(server,/app\.get\('\/api\/fs\/list'/);
  assert.match(server,/app\.get\('\/api\/fs\/read'/);
  assert.match(server,/app\.post\('\/api\/fs\/write'/);
  assert.match(server,/app\.get\('\/api\/health'/);
});

test('./s is no longer the implementation for CppKAI or the editor',()=>{
  assert.match(submodules,/path = Ext\/CppKAI/);
  assert.match(submodules,/url = https:\/\/github\.com\/cschladetsch\/CppKAI/);
  assert.match(submodules,/path = Ext\/ENet/);
  assert.match(submodules,/url = https:\/\/github\.com\/lsalzman\/enet\.git/);
  assert.match(launcher,/exec npm start/);
});
