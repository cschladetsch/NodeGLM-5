const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const launcher=fs.readFileSync(path.join(__dirname,'..','s'),'utf8');
const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
const kaiConsole=fs.readFileSync(path.join(__dirname,'..','Ext','CppKAI','Ext','CppKaiCore','Source','Library','Executor','Source','Console.cpp'),'utf8');
const kaiMain=fs.readFileSync(path.join(__dirname,'..','Ext','CppKAI','Source','App','Console','Source','Main.cpp'),'utf8');
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

test('Chat Box cwd changes render directly in the Bash panel',()=>{
  assert.match(html,/<ChatPanel[\s\S]*?onCwdChange=\{setCwd\}/);
  assert.match(html,/<span className="repl-cwd">\{cwd \|\| '~'\}<\/span>/);
  assert.doesNotMatch(html,/\[replCwd, setReplCwd\]/);
});

test('Bash input regains focus after every command settles',()=>{
  assert.match(html,/const inputRef = useRef\(null\)/);
  assert.match(html,/if \(!running\) inputRef\.current\?\.focus\(\)/);
  assert.match(html,/<input\s+ref=\{inputRef\}/);
});

test('header selects among models installed in the active endpoint',()=>{
  assert.match(html,/className="model-select"/);
  assert.match(html,/api\/models\?sid=/);
  assert.match(html,/api\/session\/model/);
  assert.match(html,/glm-selected-model/);
  assert.match(server,/app\.get\('\/api\/models'/);
  assert.match(server,/app\.post\('\/api\/session\/model'/);
  assert.match(server,/model:s\.model/);
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

test('chat chooses tools according to whether a factual answer needs a lookup',()=>{
  assert.match(server,/stable general-knowledge questions directly when you know the answer confidently/);
  assert.match(server,/Use a network-capable tool when the user asks for a lookup, the information may have changed, or verification would materially improve the answer/);
  assert.match(server,/Do not reach for a tool merely because a factual question was asked/);
});

test('Chat Box treats the Bash cwd as authoritative command context',()=>{
  assert.match(server,/\[cwd: \.\.\.\] marker on the latest message is the authoritative current directory shared with the Bash panel/);
  assert.match(server,/If the user enters a shell command such as cd, pwd, or ls, execute it with TOOL:bash/);
  assert.match(html,/const directCd=\/\^cd/);
  assert.match(html,/setPendingAction\(\{call,history:\[\],step:0,messageId:id,resume:false\}\)/);
  assert.match(html,/if\(pending\.resume===false\)/);
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
  assert.match(html,/KaiConsolePanel view=\{rtab\}/);
  assert.match(html,/\['bash','pi','rho','debugger','tree'\]/);
  assert.match(html,/WebSocket\(API\.replace\(/);
});

test('Debug and Tree explicitly select live Executors',()=>{
  assert.match(html,/function ExecutorSelect/);
  assert.match(html,/function TreeInspector/);
  assert.match(html,/function DebugInspector/);
  assert.match(html,/type:'inspect_tree'/);
  assert.match(html,/type:'debug_action',executorId,action/);
  assert.match(server,/parseKaiTreeSnapshot/);
  assert.match(server,/parsed\.type==='debug_action'/);
});

test('Executor inspection and debugging use KAI logging',()=>{
  assert.match(kaiMain,/Logger::Init\(\)/);
  assert.match(kaiConsole,/Logger::Info\("Executor tree snapshot requested"\)/);
  assert.match(kaiConsole,/Logger::Error\("Debug attach failed/);
  assert.match(kaiConsole,/Logger::Info\("Debug action '/);
});

test('Pi output omits native prompt numbering but preserves stack indices',()=>{
  assert.match(html,/line=line\.replace\(\/\\\[\\d\+\\\]\\s\*\//);
  assert.doesNotMatch(html,/line=line\.replace\(\/\\\[\\d\+\\\]:\\s\*\//);
  assert.match(html,/mode==='pi'&&visible==='π'/);
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
