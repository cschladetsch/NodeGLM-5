const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
const launcher=fs.readFileSync(path.join(__dirname,'..','s.ps1'),'utf8');
const windowLauncher=fs.readFileSync(path.join(__dirname,'..','Scripts','open-app-window.ps1'),'utf8');
const server=fs.readFileSync(path.join(__dirname,'..','src','server.js'),'utf8');
const readme=fs.readFileSync(path.join(__dirname,'..','Readme.md'),'utf8');
const uiConfig=JSON.parse(fs.readFileSync(path.join(__dirname,'..','ui-config.json'),'utf8'));
const readOptional=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
const kaiConsole=readOptional(path.join(__dirname,'..','Ext','CppKAI','Ext','CppKaiCore','Source','Library','Executor','Source','Console.cpp'));
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

test('Ace Vim ex commands support q, wq, and substitute',()=>{
  assert.match(html,/function installAceVimExCommands\(\)/);
  assert.match(html,/function bindAceVimExActions\(editor, actions\)/);
  assert.match(html,/Vim\.defineEx\(name, name, handler\)/);
  assert.match(html,/define\('q', \(cm, input\) => run\(cm, 'quit', input\)\)/);
  assert.match(html,/define\('q!', \(cm, input\) => run\(cm, 'q!', input\)\)/);
  assert.match(html,/define\('w', \(cm, input\) => run\(cm, 'write', input\)\)/);
  assert.match(html,/define\('wq', \(cm, input\) => run\(cm, 'wq', input\)\)/);
  assert.match(html,/define\('s', \(cm, input\) => run\(cm, 'substitute', input\)\)/);
  assert.match(html,/bindAceVimExActions\(editor,\{/);
  assert.match(html,/close:\(\)=>onClose\(\)/);
});

test('tree inspector renders explorer branches and continuation paste support',()=>{
  assert.match(html,/function buildTreeExplorer\(nodes\)/);
  assert.match(html,/function treeNodeSummary\(node, exec\)/);
  assert.match(html,/function getContinuationPasteText\(node\)/);
  assert.match(html,/function isContinuationNode\(node\)/);
  assert.match(html,/function getNodeSourceText\(node\)/);
  assert.match(html,/function collectContinuationTokens\(node\)/);
  assert.match(html,/function getContinuationRhoText\(node\)/);
  assert.match(html,/function getTreeObjectRhoText\(node,exec\)/);
  assert.match(html,/className=\{branchClass\}/);
  assert.match(html,/title=\{treeNodeSummary\(node,exec\)\}/);
  assert.match(html,/className="tree-toggle"/);
  assert.match(html,/className="tree-count"/);
  assert.match(html,/if\(level>0&&item\.children\?\.length\)next\.add\(String\(item\.id\)\)/);
  assert.match(html,/onOpenObject\?\.\(getTreeObjectRhoText\(node,exec\)\)/);
  assert.match(html,/Double-click to paste to Pi/);
  assert.match(html,/const \[piDraft, setPiDraft\] = useState\(''\)/);
  assert.match(html,/setPiDraft\(value\);/);
  assert.match(html,/setRtab\('pi'\)/);
  assert.match(html,/setInp\(piDraft\)/);
  assert.match(html,/onPasteContinuation=\{pasteContinuationToPi\}/);
});

test('tree object double-click opens the object in the Rho editor',()=>{
  assert.match(html,/const \[rhoDraft, setRhoDraft\] = useState\(''\)/);
  assert.match(html,/const openTreeObjectInRho = value => \{/);
  assert.match(html,/setRhoDraft\(value\);/);
  assert.match(html,/setRhoMirror\(value\);/);
  assert.match(html,/setRtab\('rho'\);/);
  assert.match(html,/rhoDraft=\{rhoDraft\}/);
  assert.match(html,/onConsumeRhoDraft=\{\(\)=>setRhoDraft\(''\)\}/);
  assert.match(html,/onOpenTreeObject=\{openTreeObjectInRho\}/);
  assert.match(html,/onOpenObject=\{onOpenTreeObject\}/);
  assert.match(html,/if\(view!=='rho'\|\|!rhoDraft\)return/);
});

test('tree continuation opens its body in Rho instead of its binding label',()=>{
  assert.match(html,/if\(isContinuationNode\(node\)&&continuation\)return continuation/);
  assert.match(html,/const direct=getNodeSourceText\(node\)/);
  assert.match(html,/return tokens\.length\?`\{\$\{tokens\.join\(' '\)\} \}`:''/);
  assert.match(html,/getNodeSourceText\(node\)/);
  assert.doesNotMatch(html,/node\?\.source\?\?node\?\.code\?\?node\?\.text\?\?node\?\.value\?\?node\?\.label/);
});

test('Pi panel stack buttons execute immediately and do not use a Run button',()=>{
  assert.match(html,/const PI_STACK_OPS = \[/);
  assert.match(html,/word:'dup'/);
  assert.match(html,/word:'swap'/);
  assert.match(html,/word:'drop'/);
  assert.match(html,/word:'rot'/);
  assert.match(html,/word:'roll'/);
  assert.match(html,/word:'over'/);
  assert.match(html,/word:'depth'/);
  assert.match(html,/className="pi-op-bar"/);
  assert.match(html,/onClick=\{\(\)=>run\(op\.word\)\}/);
  assert.doesNotMatch(html,/onClick=\{\(\)=>run\(inp\)\} disabled=\{status!=='connected'\|\|!inp\.trim\(\)\}>Run<\/button>/);
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
  assert.match(html,/<FileBrowser cwd=\{cwd\} root=\{root\}/);
  assert.match(html,/api\/session\?sid=/);
});

test('file browser parent navigation updates the shared cwd',()=>{
  assert.match(html,/function FileBrowser\(\{ cwd, root, onInject, onOpenFile, onCwdChange \}\)/);
  assert.match(html,/api\/session\/cwd/);
  assert.match(html,/body: JSON\.stringify\(\{ path: p, sid: SID \}\)/);
  assert.match(html,/onCwdChange\?\.\(d\.cwd\)/);
  assert.match(html,/\{cwd && root && cwd !== root && \(/);
  assert.match(html,/const goUp = \(\) => \{\s*changeCwd\('\.\.'\);/);
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
  assert.match(html,/kai-workbench-selected-model/);
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
  assert.match(html,/function modelVramLabel\(model,vram\)/);
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
  assert.match(html,/Loaded models:/);
  assert.match(html,/formatMiB/);
  assert.match(server,/app\.get\('\/api\/resources'/);
  assert.doesNotMatch(server,/app\.get\('\/api\/vram'/);
  assert.match(server,/--query-gpu=uuid,index,name,memory\.used,memory\.total/);
  assert.match(server,/--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory/);
  assert.match(server,/\/api\/ps/);
  assert.match(server,/nvidia-smi\+ollama-api/);
  assert.match(server,/KaiWorkbench process tree plus local Ollama/);
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

test('main chat panel supports dragging images in and out',()=>{
  assert.match(html,/const CHAT_IMAGE_MAX_BYTES = 4 \* 1024 \* 1024/);
  assert.match(html,/function fileToChatImage\(file\)/);
  assert.match(html,/function imageUrlToChatImage\(src\)/);
  assert.match(html,/function dragImageTransfer\(event,image\)/);
  assert.match(html,/async function openChatImage\(image\)/);
  assert.match(html,/api\/open\/image/);
  assert.match(html,/dt\.setData\('DownloadURL'/);
  assert.match(html,/const \[attachedImages, setAttachedImages\] = useState\(\[\]\)/);
  assert.match(html,/const \[dragActive, setDragActive\] = useState\(false\)/);
  assert.match(html,/const addDroppedImages = useCallback\(async dataTransfer =>/);
  assert.match(html,/dataTransfer\.files\]\.filter\(file=>file\.type\.startsWith\('image\/'\)\)/);
  assert.match(html,/imageUrlToChatImage\(htmlSrc \|\| urlText\.split\('\\n'\)\.find/);
  assert.match(html,/onDragOver=\{onChatDragOver\}/);
  assert.match(html,/onDrop=\{onChatDrop\}/);
  assert.match(html,/className="chat-drop-hint"/);
  assert.match(html,/Drop images to attach them to this chat\./);
  assert.match(html,/onDragStart=\{event=>dragImageTransfer\(event,image\)\}/);
  assert.match(html,/onDoubleClick=\{\(\)=>openChatImage\(image\)\.catch/);
  assert.match(html,/attachedImages\.map\(image=>`\\n\\n\$\{imageContext\(image\)\}`\)\.join\(''\)/);
  assert.match(html,/images: \[\.\.\.attachedImages\]/);
  assert.match(html,/setAttachedImages\(\[\]\)/);
  assert.match(html,/attachedImages\.length===0/);
});

test('main chat input regains focus after each request settles',()=>{
  assert.match(html,/const wasChatBusyRef = useRef\(false\)/);
  assert.match(html,/const focusChatInput = useCallback\(\(\) => \{/);
  assert.match(html,/requestAnimationFrame\(\(\) => taRef\.current\?\.focus\(\)\)/);
  assert.match(html,/if \(wasChatBusyRef\.current && !busy\) focusChatInput\(\)/);
  assert.match(html,/wasChatBusyRef\.current = busy/);
});

test('chat persists bounded conversation memory in local storage',()=>{
  assert.match(html,/CHAT_MEMORY_KEY = 'kai-workbench-chat-memory-v1'/);
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
  assert.match(html,/\{requestPending,startedAt,thinking,images,fullContent,\.\.\.message\}/);
  assert.match(html,/const stable=stableChatMessages\(messages\)\.filter\(message => message\.content\)/);
  assert.match(html,/catch \{[\s\S]*?return INITIAL_CHAT_MESSAGES/);
});

test('chat errors replace the active placeholder instead of adding a blank message',()=>{
  assert.match(html,/error\.requestMessageId=id/);
  assert.match(html,/if\(error\.requestMessageId\)updateMessage\(error\.requestMessageId,\{content\}\)/);
});

test('CUDA allocation failures provide a usable low-memory recovery path',()=>{
  assert.match(html,/unable to allocate CUDA\|failed to load model/);
  assert.match(html,/restart Ollama through \.\/s\.ps1/);
  assert.match(html,/choose a smaller model from the header/);
  assert.match(html,/your conversation is saved/);
  assert.match(launcher,/KAI_WORKBENCH_MODEL="\$\{KAI_WORKBENCH_MODEL:-qwen2\.5-coder:7b\}"/);
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

test('chat understands that KaiWorkbench modifies its own workspace',()=>{
  assert.match(server,/KaiWorkbench is a self-hosted development environment/);
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

test('Pi input sends trailing backslashes to CppKAI instead of buffering them',()=>{
  assert.match(html,/wsRef\.current\.send\(JSON\.stringify\(\{type:'input',data:command\}\)\)/);
  assert.doesNotMatch(html,/pendingLines/);
  assert.doesNotMatch(html,/endsWith\('\\\\'\)/);
});

test('chat supports cancellation and health checks inference readiness',()=>{
  assert.match(html,/new AbortController\(\)/);
  assert.match(html,/abortRef\.current\?\.abort\(\)/);
  assert.match(html,/Generation stopped/);
  assert.match(server,/new URL\('\/v1\/models',OLLAMA\)/);
  assert.match(server,/res\.on\('close'/);
  assert.match(server,/KAI_WORKBENCH_TIMEOUT_MS/);
  assert.match(server,/KAI_WORKBENCH_FIRST_BYTE_TIMEOUT_MS/);
  assert.match(server,/KAI_WORKBENCH_MAX_TOKENS/);
  assert.match(server,/KAI_WORKBENCH_HISTORY_MESSAGES/);
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

test('./s.ps1 starts the server and schedules its self-hosted app window',()=>{
  assert.match(launcher,/npm start &/);
  assert.match(launcher,/SAFE_ROOT="\$\{SAFE_ROOT:-\$SCRIPT_DIR\}"/);
  assert.match(launcher,/Scripts\/open-app-window\.ps1/);
  assert.match(windowLauncher,/api\/health/);
  assert.match(windowLauncher,/--app=\$URL/);
  assert.match(windowLauncher,/KAI_WORKBENCH_NO_WINDOW/);
  assert.match(windowLauncher,/KAI_WORKBENCH_BROWSER/);
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
  assert.match(html,/KaiConsolePanel[\s\S]*?view=\{rtab\}/);
  assert.match(html,/\['bash','pi','rho','debugger','tree'\]/);
  assert.match(html,/WebSocket\(API\.replace\(/);
});

test('Debug and Tree explicitly select live Executors',()=>{
  assert.match(html,/function ExecutorSelect/);
  assert.match(html,/function TreeInspector/);
  assert.match(html,/function DebugInspector/);
  assert.match(html,/function DebugStackList/);
  assert.match(html,/type:'inspect_tree'/);
  assert.match(html,/type:'debug_action',id:requestId\(\),executorId,action/);
  assert.match(html,/api\/kai\?sid=/);
  assert.match(server,/KAI_CONTROL_FD:'3'/);
  assert.match(server,/runtime\.register\(requestId,socket\)/);
  assert.match(server,/parsed\.type==='debug_action'/);
});

test('Debug panel renders current state, context, and console at once',()=>{
  assert.match(html,/className="debug-workspace"/);
  assert.match(html,/className="debug-top"/);
  assert.match(html,/<strong>Current State<\/strong>/);
  assert.match(html,/<strong>Context<\/strong>/);
  assert.match(html,/<strong>Console<\/strong>/);
  assert.match(html,/exec\.dataStack/);
  assert.match(html,/exec\.contextStack/);
  assert.match(html,/onClearConsole=\{\(\)=>setOutput\(''\)\}/);
  assert.match(html,/onPasteContinuation=\{onPasteContinuation\}/);
  assert.match(html,/Context stack is empty/);
});

test('Executor inspection and debugging use KAI logging',()=>{
  if(!/Logger::Init\(\)/.test(kaiMain))return;
  assert.match(kaiMain,/Logger::Init\(\)/);
  if(!kaiConsole)return;
  assert.match(kaiConsole,/Logger::Info\("Executor tree snapshot requested"\)/);
  assert.match(kaiConsole,/Logger::Error\(message\)/);
  assert.match(kaiConsole,/Logger::Info\("Debug action '/);
});

test('Pi output omits native prompt numbering but preserves stack indices',()=>{
  assert.match(html,/line=line\.replace\(\/\\\[\\d\+\\\]\\s\*\//);
  assert.doesNotMatch(html,/line=line\.replace\(\/\\\[\\d\+\\\]:\\s\*\//);
  assert.match(html,/function normalizeKaiIndices\(text,mode\)/);
  assert.match(html,/if\(mode!=='pi'\)\{/);
  assert.match(html,/stackVisiblePattern=\/\^\\\[\\d\+\\\]:\?/);
  assert.match(html,/const rewriteStackLine=\(line,index\)=>/);
  assert.match(html,/stackBlock\.slice\(\)\.reverse\(\)\.forEach/);
  assert.match(html,/stackBlock\.length-1-i/);
  assert.match(html,/if\(stackVisiblePattern\.test\(visible\)\)\{/);
  assert.match(html,/if\(\/\^\\\[\\d\+\\\]:\?\/\.test\(token\)\)return PI_TOKEN_STYLES\.stack;/);
});

test('Pi output receives semantic token colours when native ANSI is absent',()=>{
  assert.match(html,/const PI_TOKEN_STYLES=/);
  assert.match(html,/function piTokenStyle\(token\)/);
  assert.match(html,/function renderPiTokens\(text,baseStyle,keyStart\)/);
  assert.match(html,/if\(mode==='pi'&&!style\.color\)/);
  assert.match(html,/if\(\/\^\\\[\\d\+\\\]:\?\/\.test\(token\)\)return PI_TOKEN_STYLES\.stack;/);
  assert.match(html,/\\\[\\d\+\\\]:\?/);
  assert.ok(html.includes("if(/^-?\\d+(?:\\.\\d+)?$/.test(token))return PI_TOKEN_STYLES.number;"));
  assert.match(html,/true\|false\|nil\|null/);
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
  assert.match(server,/app\.post\('\/api\/rag\/index'/);
  assert.match(server,/app\.get\('\/api\/rag\/status'/);
  assert.match(server,/app\.get\('\/api\/modelstore'/);
  assert.match(server,/app\.post\('\/api\/fs\/write'/);
  assert.match(server,/app\.get\('\/api\/health'/);
  assert.match(server,/HOST\s*=process\.env\.HOST\s*\|\|\s*'127\.0\.0\.1'/);
  assert.match(server,/KAI_WORKBENCH_ALLOWED_ORIGINS/);
  assert.match(server,/new Map\(\)/);
  assert.match(server,/sessions\.size>=1000/);
  assert.match(server,/req\.headers\.origin&&!allowedOrigins\.has/);
});

test('chat exposes a RAG grounding toggle',()=>{
  assert.match(html,/kai-workbench-rag-mode/);
  assert.match(html,/className="rag-select"/);
  assert.match(html,/body:JSON\.stringify\(\{messages:history,sid:SID,rag:ragMode\}\)/);
  assert.match(html,/<option value="auto">auto<\/option>/);
  assert.match(html,/<option value="off">off<\/option>/);
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

test('./s.ps1 is no longer the implementation for CppKAI or the editor',()=>{
  assert.match(submodules,/path = Ext\/CppKAI/);
  assert.match(submodules,/url = https:\/\/github\.com\/cschladetsch\/CppKAI/);
  assert.doesNotMatch(submodules,/path = Ext\/ENet/);
  assert.match(server,/const ENET_DIR=process\.env\.ENET_DIR\s*\|\|\s*path\.join\(KAI_DIR,'Ext\/ENet'\)/);
  assert.match(launcher,/npm start &/);
});
