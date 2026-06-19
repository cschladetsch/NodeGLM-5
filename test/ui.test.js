const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const launcher=fs.readFileSync(path.join(__dirname,'..','s'),'utf8');
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

test('./s generates the Vim-enabled, syntax-colored Ace editor',()=>{
  assert.match(launcher,/ace\/1\.36\.5\/ace\.js/);
  assert.match(launcher,/editor\.setTheme\('ace\/theme\/monokai'\)/);
  assert.match(launcher,/editor\.setKeyboardHandler\('ace\/keyboard\/vim'/);
  assert.match(launcher,/editor\.session\.setMode\(`ace\/mode\/\$\{aceMode\(fp\)\}`\)/);
  assert.match(launcher,/app\.post\('\/api\/fs\/write'/);
  assert.match(launcher,/content:aceRef\.current\.getValue\(\)/);
  assert.match(launcher,/Vim\.defineEx\('quit','q'/);
  assert.match(launcher,/dirtyRef\.current&&!params\?\.bang/);
  assert.match(launcher,/Vim\.defineEx\('write','w'/);
});

test('./s integrates native CppKAI Pi, Rho, and Debugger consoles',()=>{
  assert.match(submodules,/path = Ext\/CppKAI/);
  assert.match(submodules,/url = https:\/\/github\.com\/cschladetsch\/CppKAI/);
  assert.match(submodules,/path = Ext\/ENet/);
  assert.match(submodules,/url = https:\/\/github\.com\/lsalzman\/enet\.git/);
  assert.match(launcher,/KAI_DIR="\$SCRIPT_DIR\/Ext\/CppKAI"/);
  assert.match(launcher,/Ext\/CppKaiCore Ext\/CppKaiLanguage Ext\/imgui/);
  assert.match(launcher,/ln -s "\$ENET_DIR" "\$KAI_ENET"/);
  assert.match(launcher,/-DKAI_NETWORKING=ON/);
  assert.match(launcher,/KAI_CONSOLE="\$KAI_DIR\/Bin\/Console"/);
  assert.match(launcher,/new WebSocketServer\(\{server,path:'\/api\/kai'\}\)/);
  assert.match(launcher,/spawn\('script',\['-qefc',command,'\/dev\/null'\]/);
  assert.match(launcher,/util-linux 'script' is required/);
  assert.match(launcher,/mode==='debugger'\?\['-l','pi','-t','5','--verbose'\]/);
  assert.match(launcher,/function normalizeKaiIndices\(text,mode\)/);
  assert.match(launcher,/mode==='pi'\?line:line\.replace/);
  assert.match(launcher,/function AnsiOutput\(\{text,mode\}\)/);
  assert.match(launcher,/<AnsiOutput text=/);
  for(const mode of ['pi','rho','debugger'])
    assert.match(launcher,new RegExp(`KaiConsolePanel mode="${mode}"`));
});

test('./s Bash REPL supports the advertised server-side cwd command',()=>{
  assert.match(launcher,/if\(command==='cwd'\)return res\.json\(\{stdout:s\.cwd\+'\\n'/);
  assert.match(launcher,/function expandBangBang\(command,previous\)/);
  assert.match(launcher,/expandBangBang\(original,s\.bashHistory\.at\(-1\)\)/);
  assert.match(launcher,/if\(d\.expanded\)add\('info',`=> \$\{d\.expanded\}`\)/);
  assert.match(launcher,/if\(!running\)inputRef\.current\?\.focus\(\)/);
  assert.match(launcher,/<input ref=\{inputRef\} value=\{inp\}/);
});

test('./s serves the UI after health is ready and supports side-panel resizing',()=>{
  assert.match(launcher,/app\.use\(express\.static\(__dirname\)\)/);
  assert.match(launcher,/const API=window\.location\.origin/);
  assert.match(launcher,/curl -sf "http:\/\/localhost:\$\{NODE_PORT\}\/api\/health"/);
  assert.match(launcher,/APP_URL="http:\/\/localhost:\$\{NODE_PORT\}\/"/);
  assert.match(launcher,/className=\{`right-resizer\$\{resizing\?' dragging':''\}`\}/);
  assert.match(launcher,/onPointerDown=\{resizeRight\}/);
  assert.match(launcher,/localStorage\.setItem\('glm-right-width'/);
});

test('./s reports actionable chat transport and Ollama failures',()=>{
  assert.match(launcher,/Cannot reach GLM server at \$\{API\}\. Restart \.\/s/);
  assert.match(launcher,/Ollama HTTP \$\{r\.statusCode\}/);
  assert.match(launcher,/if\(obj\.error\)throw new Error/);
  assert.match(launcher,/Ollama request timed out/);
});
