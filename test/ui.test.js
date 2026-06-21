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
  assert.match(html,/content:aceRef\.current\.getValue\(\),sid:SID/);
});

test('RHS Bash cwd is propagated to the file browser',()=>{
  assert.match(html,/<ReplPanel cwd=\{cwd\} onCwdChange=\{setCwd\}/);
  assert.match(html,/<FileBrowser cwd=\{cwd\}/);
  assert.match(html,/api\/session\?sid=/);
});

test('main chat panel is a plain chat surface',()=>{
  assert.match(html,/chat-input-area/);
  assert.match(html,/placeholder="Message…"/);
  assert.match(html,/How can I help\?/);
  assert.doesNotMatch(html,/main-question-box/);
  assert.doesNotMatch(html,/effort-row/);
});

test('chat executes bounded tools and requires write approval',()=>{
  assert.match(html,/step>=8/);
  assert.match(html,/parseToolCall\(assistant\.content\)/);
  assert.match(html,/api\/tool\/bash/);
  assert.match(html,/api\/tool\/read_file/);
  assert.match(html,/api\/tool\/write_file\/diff/);
  assert.match(html,/Approve write/);
  assert.match(html,/Approve command/);
  assert.match(html,/resolveAction\(false\)/);
  assert.match(html,/resultMessage/);
});

test('chat supports cancellation and health checks inference readiness',()=>{
  assert.match(html,/new AbortController\(\)/);
  assert.match(html,/abortRef\.current\?\.abort\(\)/);
  assert.match(html,/Generation stopped/);
  assert.match(server,/new URL\('\/v1\/models',OLLAMA\)/);
  assert.match(server,/res\.on\('close'/);
  assert.match(server,/GLM_TIMEOUT_MS/);
  assert.match(server,/GLM_MAX_TOKENS/);
  assert.match(server,/GLM_HISTORY_MESSAGES/);
});

test('three-column workspace fills the React root without collapsing side panels',()=>{
  assert.match(html,/#root\s*\{[^}]*height:\s*100%[^}]*display:\s*flex/s);
  assert.match(html,/\.workspace\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(html,/\.sidebar\s*\{[^}]*flex-shrink:\s*0/s);
  assert.match(html,/\.right\s*\{[^}]*flex-shrink:\s*0[^}]*min-width:\s*320px/s);
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
  assert.match(html,/onOpenFile=\{setViewFile\}/);
  assert.match(html,/<FileViewerPanel filePath=\{viewFile\}/);
});

test('index.html exposes the right-side Bash and KAI buttons',()=>{
  assert.match(html,/right-tab/);
  assert.match(html,/Bash/);
  assert.match(html,/Pi/);
  assert.match(html,/Rho/);
  assert.match(html,/Debug/);
  assert.match(html,/right-resizer/);
  assert.match(html,/KaiConsolePanel mode="pi"/);
  assert.match(html,/KaiConsolePanel mode="rho"/);
  assert.match(html,/KaiConsolePanel mode="debugger"/);
  assert.match(html,/WebSocket\(API\.replace\(/);
});

test('file browser hides dotfiles by default',()=>{
  assert.match(html,/visibleEntries/);
  assert.match(html,/entries\.filter\(\(e\) => !e\.name\.startsWith\('\.'\)\)/);
  assert.match(html,/Show dotfiles/);
  assert.match(html,/Hide dotfiles/);
});

test('rho uses the Vim editor instead of a one-line prompt',()=>{
  assert.match(html,/RhoEditorPanel/);
  assert.match(html,/mirrors to Pi on change/);
  assert.match(html,/Ctrl-Enter/);
  assert.match(html,/editor\.setKeyboardHandler\('ace\/keyboard\/vim'\)/);
});

test('server.js integrates the filesystem and chat endpoints',()=>{
  assert.match(server,/app\.post\('\/api\/chat'/);
  assert.match(server,/app\.get\('\/api\/modelstore'/);
  assert.match(server,/app\.post\('\/api\/fs\/write'/);
  assert.match(server,/app\.get\('\/api\/health'/);
  assert.match(server,/HOST\s*=process\.env\.HOST\s*\|\|\s*'127\.0\.0\.1'/);
  assert.match(server,/GLM_ALLOWED_ORIGINS/);
  assert.match(server,/new Map\(\)/);
  assert.match(server,/sessions\.size>=1000/);
  assert.match(server,/req\.headers\.origin&&!allowedOrigins\.has/);
});

test('server.js exposes the current REPL and filesystem endpoints',()=>{
  assert.match(server,/app\.post\('\/api\/repl\/exec'/);
  assert.match(server,/app\.get\('\/api\/fs\/list'/);
  assert.match(server,/app\.get\('\/api\/fs\/read'/);
  assert.match(server,/app\.post\('\/api\/fs\/write'/);
  assert.match(server,/app\.get\('\/api\/health'/);
});

test('server.js exposes the KAI websocket bridge',()=>{
  assert.match(server,/api\/kai/);
  assert.match(server,/CppKAI Console is not built/);
  assert.match(server,/spawn\('script',\['-qefc',command,'\/dev\/null'\]/);
});

test('./s is no longer the implementation for CppKAI or the editor',()=>{
  assert.match(submodules,/path = Ext\/CppKAI/);
  assert.match(submodules,/url = https:\/\/github\.com\/cschladetsch\/CppKAI/);
  assert.match(submodules,/path = Ext\/ENet/);
  assert.match(submodules,/url = https:\/\/github\.com\/lsalzman\/enet\.git/);
  assert.match(launcher,/exec npm start/);
});
