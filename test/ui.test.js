const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const launcher=fs.readFileSync(path.join(__dirname,'..','s'),'utf8');
const windowLauncher=fs.readFileSync(path.join(__dirname,'..','Scripts','open-app-window.sh'),'utf8');
const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
const readme=fs.readFileSync(path.join(__dirname,'..','Readme.md'),'utf8');
const uiConfig=JSON.parse(fs.readFileSync(path.join(__dirname,'..','ui-config.json'),'utf8'));
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

test('README Mermaid diagrams avoid fragile renderer syntax',()=>{
  const diagrams=[...readme.matchAll(/```mermaid\n([\s\S]*?)\n```/g)].map(match=>match[1]);
  assert.equal(diagrams.length,4);
  for(const diagram of diagrams){
    assert.doesNotMatch(diagram,/<br\s*\/?>/i);
    assert.doesNotMatch(diagram,/\s-\.\s+[^"]+?\s+\.-?>/);
    assert.doesNotMatch(diagram,/^actor\s/im);
  }
  assert.match(diagrams[0],/flowchart LR/);
  assert.match(diagrams[2],/sequenceDiagram/);
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
  assert.match(html,/const \[modelInfo, setModelInfo\] = useState\(\[\]\)/);
  assert.match(html,/setModelInfo\(body\.modelInfo\|\|\[\]\)/);
  assert.match(html,/function modelTitle\(model\)/);
  assert.match(html,/function modelOptionLabel\(model\)/);
  assert.match(html,/ollama pull \$\{model\.id\}/);
  assert.match(html,/function ModelInstallModal/);
  assert.match(html,/api\/models\/install/);
  assert.match(html,/setInstallState\(\{model,status:'installing'/);
  assert.match(html,/Model path: \{state\.target\}/);
  assert.match(html,/className="model-install-spinner"/);
  assert.match(html,/className="model-install-track"/);
  assert.match(html,/className="model-install-bar"/);
  assert.match(html,/% downloaded/);
  assert.match(html,/width:`\$\{percent\?\?0\}%`/);
  assert.match(html,/Downloading model/);
  assert.match(html,/startedAt:Date\.now\(\)/);
  assert.match(html,/elapsed!==null&&busy/);
  assert.match(html,/onClick=\{onStop\}>Stop<\/button>/);
  assert.match(html,/const installAbortRef = useRef\(null\)/);
  assert.match(html,/signal:controller\.signal/);
  assert.match(html,/installAbortRef\.current\?\.abort\(\)/);
  assert.match(html,/status:stopped\?'stopped':'failed'/);
  assert.doesNotMatch(html,/onClose\} disabled=\{busy\}/);
  assert.match(html,/response\.body\.getReader\(\)/);
  assert.match(html,/event\.type==='progress'/);
  assert.match(html,/statusText:event\.statusText\|\|current\.statusText/);
  assert.match(html,/statusText:'Fetching model manifest'/);
  assert.match(html,/\{state\.statusText&&<div>\{state\.statusText\}\{elapsed!==null&&busy\?` \(\$\{elapsed\}s\)`:''\}<\/div>\}/);
  assert.doesNotMatch(html,/state\.output&&<pre>/);
  assert.doesNotMatch(html,/output:\(current\.output\+/);
  assert.doesNotMatch(html,/disabled=\{!model\.installed\}/);
  assert.match(html,/className="header-status model-hint"/);
  assert.match(server,/app\.get\('\/api\/models'/);
  assert.match(server,/app\.post\('\/api\/models\/install'/);
  assert.match(server,/application\/x-ndjson/);
  assert.match(server,/req\.on\('aborted'/);
  assert.match(server,/child\.kill\('SIGTERM'\)/);
  assert.match(server,/type:'progress'/);
  assert.match(server,/lastClean/);
  assert.match(server,/function installStatusText/);
  assert.match(server,/Fetching model manifest/);
  assert.match(server,/statusText:installStatusText\(clean,percent\)/);
  assert.match(server,/\\d\{1,3\}\)%/);
  assert.match(server,/RECOMMENDED_MODELS/);
  assert.match(server,/modelInfo:modelInfo\(models\)/);
  assert.match(server,/OLLAMA_MODELS/);
  assert.match(server,/app\.post\('\/api\/session\/model'/);
  assert.match(server,/model:s\.model/);
});

test('header displays app and overall VRAM usage',()=>{
  assert.match(html,/className="resource-badge vram-badge"/);
  assert.match(html,/api\/resources/);
  assert.match(html,/return `VRAM \$\{formatMiB\(total\.appUsedMiB\)\}`/);
  assert.match(html,/return `RAM \$\{formatMiB\(total\.appUsedMiB\)\}`/);
  assert.match(html,/Overall: \$\{formatMiB\(total\.usedMiB\)\} \/ \$\{formatMiB\(total\.totalMiB\)\}/);
  assert.match(html,/formatMiB/);
  assert.match(server,/app\.get\('\/api\/resources'/);
  assert.doesNotMatch(server,/app\.get\('\/api\/vram'/);
  assert.match(server,/--query-gpu=uuid,index,name,memory\.used,memory\.total/);
  assert.match(server,/--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory/);
  assert.match(server,/NodeGLM process tree plus local Ollama/);
});

test('header displays system RAM usage',()=>{
  assert.match(html,/className="resource-badge ram-badge"/);
  assert.match(html,/RAM:/);
  assert.match(html,/ramLabel/);
  assert.match(html,/ramTitle/);
  assert.match(server,/function queryRam/);
  assert.match(server,/os\.totalmem\(\)/);
  assert.match(server,/process\.memoryUsage\(\)\.rss/);
});

test('main chat panel is a plain chat surface',()=>{
  assert.match(html,/chat-input-area/);
  assert.match(html,/placeholder="Message…"/);
  assert.match(html,/How can I help\?/);
  assert.doesNotMatch(html,/main-question-box/);
  assert.doesNotMatch(html,/effort-row/);
});

test('main chat input supports arrow-key user message history',()=>{
  assert.match(html,/const \[chatHistoryIndex, setChatHistoryIndex\] = useState\(-1\)/);
  assert.match(html,/const chatDraftRef = useRef\(''\)/);
  assert.match(html,/const userInputHistory = messages/);
  assert.match(html,/message=>message\.role==='user'/);
  assert.match(html,/\.reverse\(\)/);
  assert.match(html,/function|const recallChatInput/);
  assert.match(html,/e\.key==='ArrowUp'/);
  assert.match(html,/e\.key==='ArrowDown'/);
  assert.match(html,/setInput\(nextIndex<0\?chatDraftRef\.current:userInputHistory\[nextIndex\]\)/);
  assert.match(html,/textarea\.setSelectionRange\(textarea\.value\.length,textarea\.value\.length\)/);
});

test('main chat input regains focus after each request settles',()=>{
  assert.match(html,/const wasChatBusyRef = useRef\(false\)/);
  assert.match(html,/const focusChatInput = useCallback\(\(\) => \{/);
  assert.match(html,/requestAnimationFrame\(\(\) => taRef\.current\?\.focus\(\)\)/);
  assert.match(html,/if \(wasChatBusyRef\.current && !busy\) focusChatInput\(\)/);
  assert.match(html,/wasChatBusyRef\.current = busy/);
});

test('chat persists bounded conversation memory in local storage',()=>{
  assert.match(html,/CHAT_MEMORY_KEY = 'nodeglm-chat-memory-v1'/);
  assert.match(html,/CHAT_MEMORY_LIMIT = 100/);
  assert.match(html,/useState\(loadChatMemory\)/);
  assert.match(html,/localStorage\.setItem\(CHAT_MEMORY_KEY,JSON\.stringify\(stable\)\)/);
  assert.match(html,/\.slice\(-CHAT_MEMORY_LIMIT\)/);
  assert.match(html,/if\(!streaming&&!pendingAction\)saveChatMemory\(messages\)/);
});

test('chat memory validates stored messages and excludes transient request state',()=>{
  assert.match(html,/function stableChatMessages/);
  assert.match(html,/\['user','assistant'\]\.includes\(message\.role\)/);
  assert.match(html,/typeof message\.content==='string'/);
  assert.match(html,/!message\.requestPending/);
  assert.match(html,/\{requestPending,startedAt,thinking,\.\.\.message\}/);
  assert.match(html,/const stable=stableChatMessages\(messages\)\.filter\(message => message\.content\)/);
  assert.match(html,/catch \{[\s\S]*?return INITIAL_CHAT_MESSAGES/);
});

test('chat errors replace the active placeholder instead of adding a blank message',()=>{
  assert.match(html,/error\.requestMessageId=id/);
  assert.match(html,/if\(error\.requestMessageId\)updateMessage\(error\.requestMessageId,\{content\}\)/);
});

test('CUDA allocation failures provide a usable low-memory recovery path',()=>{
  assert.match(html,/unable to allocate CUDA\|failed to load model/);
  assert.match(html,/restart Ollama through \.\/s/);
  assert.match(html,/choose a smaller model from the header/);
  assert.match(html,/your conversation is saved/);
  assert.match(launcher,/GLM_MODEL="\$\{GLM_MODEL:-qwen2\.5-coder:7b\}"/);
  assert.match(launcher,/OLLAMA_CONTEXT_LENGTH="\$\{OLLAMA_CONTEXT_LENGTH:-2048\}"/);
  assert.match(launcher,/OLLAMA_KV_CACHE_TYPE="\$\{OLLAMA_KV_CACHE_TYPE:-q8_0\}"/);
  assert.match(launcher,/OLLAMA_GPU_OVERHEAD="\$\{OLLAMA_GPU_OVERHEAD:-1073741824\}"/);
  assert.match(launcher,/OLLAMA_MAX_LOADED_MODELS="\$\{OLLAMA_MAX_LOADED_MODELS:-1\}"/);
  assert.match(launcher,/OLLAMA_NUM_PARALLEL="\$\{OLLAMA_NUM_PARALLEL:-1\}"/);
  assert.match(launcher,/Ollama already running; launcher memory settings only apply after restarting Ollama/);
});

test('Ollama connection failures explain that the backend is unavailable',()=>{
  assert.match(html,/Ollama is not accepting connections at 127\.0\.0\.1:11434/);
  assert.match(html,/your conversation is saved/);
});

test('chat exposes a guarded clear-memory control',()=>{
  assert.match(html,/Clear saved conversation memory\?/);
  assert.match(html,/localStorage\.removeItem\(CHAT_MEMORY_KEY\)/);
  assert.match(html,/api\/memory\/clear/);
  assert.match(html,/>Clear memory<\/button>/);
  assert.match(html,/disabled=\{streaming\|\|Boolean\(pendingAction\)\}/);
});

test('chat displays and refreshes learned fact memory',()=>{
  assert.match(html,/const \[memoryFacts, setMemoryFacts\] = useState\(\[\]\)/);
  assert.match(html,/const \[memoryEditorOpen, setMemoryEditorOpen\] = useState\(false\)/);
  assert.match(html,/const \[chatHistoryEditorOpen, setChatHistoryEditorOpen\] = useState\(false\)/);
  assert.match(html,/api\/memory\?sid=/);
  assert.match(html,/method:'PUT'/);
  assert.match(html,/Stored Facts/);
  assert.match(html,/Vim · one fact per line/);
  assert.match(html,/Message History/);
  assert.match(html,/Vim · JSON array/);
  assert.match(html,/ace\/mode\/json/);
  assert.match(html,/Message history must be a JSON array/);
  assert.match(html,/localStorage\.setItem\(CHAT_MEMORY_KEY,JSON\.stringify\(next\)\)/);
  assert.match(html,/className="chat-memory-link"/);
  assert.match(html,/initialFacts=\{memoryFacts\}/);
  assert.match(html,/messages=\{messages\}/);
  assert.match(html,/onSaved=\{setMessages\}/);
  assert.match(html,/setChatHistoryEditorOpen\(true\)/);
  assert.match(html,/fallbackFacts\.join\('\\n'\)/);
  assert.match(html,/function stableChatMessages/);
  assert.match(html,/loadMemoryFacts\(\)/);
  assert.match(html,/memoryFacts\.length/);
  assert.match(html,/messages\.length/);
  assert.match(html,/if\(!open\)\{[\s\S]*?aceRef\.current\?\.destroy\(\)/);
  assert.match(html,/editor&&editor\.container!==editorEl\.current/);
  assert.match(server,/extractMemoryFacts/);
  assert.match(server,/app\.put\('\/api\/memory'/);
  assert.match(server,/years\?\\s\+old/);
  assert.match(server,/Known user facts from earlier messages/);
  assert.match(server,/messages:\[\.\.\.systemMessages,\.\.\.augmented\]/);
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

test('chat understands that NodeGLM modifies its own workspace',()=>{
  assert.match(server,/NodeGLM is a self-hosted development environment/);
  assert.match(server,/application running this conversation/);
  assert.match(server,/inspect, modify, and test that workspace/);
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
  assert.match(server,/GLM_FIRST_BYTE_TIMEOUT_MS/);
  assert.match(server,/GLM_MAX_TOKENS/);
  assert.match(server,/GLM_HISTORY_MESSAGES/);
  assert.match(server,/Model did not start streaming within/);
  assert.match(server,/may still be loading or may be too large/);
  assert.match(server,/closed without streaming a response/);
});

test('slow chat requests show JSON-configured progress and elapsed time',()=>{
  assert.equal(typeof uiConfig.requestProgressDelaySeconds,'number');
  assert.ok(uiConfig.requestProgressDelaySeconds>=0);
  assert.match(server,/app\.get\('\/ui-config\.json'/);
  assert.match(html,/fetch\(`\$\{API\}\/ui-config\.json`\)/);
  assert.match(html,/function RequestProgress/);
  assert.match(html,/elapsedMs < delaySeconds \* 1000/);
  assert.match(html,/request-spinner/);
  assert.match(html,/request-progress-bar/);
  assert.match(html,/\(elapsedMs \/ 1000\)\.toFixed\(1\)/);
  assert.match(html,/requestPending:false/);
});

test('request progress timer starts with the request and always cleans up',()=>{
  assert.match(html,/const startedAt=Date\.now\(\)/);
  assert.match(html,/startedAt,requestPending:true/);
  assert.match(html,/const timer = setInterval\(tick, 100\)/);
  assert.match(html,/return \(\) => clearInterval\(timer\)/);
  assert.match(html,/finally\{[\s\S]*?requestPending:false/);
  assert.match(html,/abortRef\.current===controller/);
  assert.match(html,/sawAssistantDelta/);
  assert.match(html,/Model stream ended without assistant content/);
});

test('request progress ignores invalid remote thresholds and retains its fallback',()=>{
  assert.match(html,/useState\(3\)/);
  assert.match(html,/Number\.isFinite\(seconds\)&&seconds>=0/);
  assert.match(html,/setProgressDelaySeconds\(seconds\)/);
  assert.match(html,/\.catch\(error => console\.error\('Failed to load UI config:'/);
});

test('request progress is accessible and respects reduced motion preferences',()=>{
  assert.match(html,/className="request-progress" role="status" aria-live="polite"/);
  assert.match(html,/className="request-spinner" aria-hidden="true"/);
  assert.match(html,/@media \(prefers-reduced-motion: reduce\)/);
});

test('three-column workspace fills the React root without collapsing side panels',()=>{
  assert.match(html,/#root\s*\{[^}]*height:\s*100%[^}]*display:\s*flex/s);
  assert.match(html,/\.workspace\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(html,/\.sidebar\s*\{[^}]*flex-shrink:\s*0/s);
  assert.match(html,/\.right\s*\{[^}]*flex-shrink:\s*0[^}]*min-width:\s*320px/s);
});

test('./s starts the server and schedules its self-hosted app window',()=>{
  assert.match(launcher,/npm start &/);
  assert.match(launcher,/SAFE_ROOT="\$\{SAFE_ROOT:-\$SCRIPT_DIR\}"/);
  assert.match(launcher,/Scripts\/open-app-window\.sh/);
  assert.match(windowLauncher,/api\/health/);
  assert.match(windowLauncher,/--app=\$URL/);
  assert.match(windowLauncher,/NODEGLM_NO_WINDOW/);
  assert.match(windowLauncher,/NODEGLM_BROWSER/);
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
  assert.match(html,/type:'debug_action',id:requestId\(\),executorId,action/);
  assert.match(html,/api\/kai\?sid=/);
  assert.match(server,/KAI_CONTROL_FD:'3'/);
  assert.match(server,/runtime\.register\(requestId,socket\)/);
  assert.match(server,/parsed\.type==='debug_action'/);
});

test('Executor inspection and debugging use KAI logging',()=>{
  assert.match(kaiMain,/Logger::Init\(\)/);
  assert.match(kaiConsole,/Logger::Info\("Executor tree snapshot requested"\)/);
  assert.match(kaiConsole,/Logger::Error\(message\)/);
  assert.match(kaiConsole,/Logger::Info\("Debug action '/);
});

test('Pi output omits native prompt numbering but preserves stack indices',()=>{
  assert.match(html,/line=line\.replace\(\/\\\[\\d\+\\\]\\s\*\//);
  assert.doesNotMatch(html,/line=line\.replace\(\/\\\[\\d\+\\\]:\\s\*\//);
  assert.match(html,/mode==='pi'&&visible==='π'/);
});

test('Pi output receives semantic token colours when native ANSI is absent',()=>{
  assert.match(html,/const PI_TOKEN_STYLES=/);
  assert.match(html,/function piTokenStyle\(token\)/);
  assert.match(html,/function renderPiTokens\(text,baseStyle,keyStart\)/);
  assert.match(html,/if\(mode==='pi'&&!style\.color\)/);
  assert.match(html,/\^\\\[\\d\+\\\]:\?\$/);
  assert.match(html,/\^\[πρλ\$\]\$/);
  assert.ok(html.includes("if(/^-?\\d+(?:\\.\\d+)?$/.test(token))return PI_TOKEN_STYLES.number;"));
  assert.match(html,/\^\(true\|false\)\$/);
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
  assert.match(server,/spawn\(KAI_CONSOLE,args/);
  assert.match(server,/const kaiRuntimes=new Map\(\)/);
  assert.match(server,/socket\.on\('close',\(\)=>runtime\.detach\(socket\)\)/);
});

test('./s is no longer the implementation for CppKAI or the editor',()=>{
  assert.match(submodules,/path = Ext\/CppKAI/);
  assert.match(submodules,/url = https:\/\/github\.com\/cschladetsch\/CppKAI/);
  assert.match(submodules,/path = Ext\/ENet/);
  assert.match(submodules,/url = https:\/\/github\.com\/lsalzman\/enet\.git/);
  assert.match(launcher,/npm start &/);
});
