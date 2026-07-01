const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');

function executable(names){
  for(const name of names){
    if(path.isAbsolute(name)&&fs.existsSync(name))return name;
    for(const dir of (process.env.PATH||'').split(path.delimiter)){
      const candidate=path.join(dir,name);
      if(fs.existsSync(candidate))return candidate;
    }
  }
  return null;
}

const edge=process.env.EDGE_BIN||executable([
  'microsoft-edge','microsoft-edge-stable','msedge',
  '/opt/microsoft/msedge/msedge'
]);
const driver=process.env.MSEDGEDRIVER||executable(['msedgedriver']);
const skip=!edge?'Microsoft Edge is not installed':!driver?'msedgedriver is not installed':false;

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('Edge edits and saves a C++ file through Ace', {skip}, async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kai-workbench-edge-e2e-'));
  fs.writeFileSync(path.join(root,'sample.cpp'),'int main() { return 0; }\n');
  process.env.SAFE_ROOT=root;
  const {server}=require('../src/server');
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));

  const driverPort=9515+Math.floor(Math.random()*1000);
  const child=spawn(driver,[`--port=${driverPort}`],{stdio:'ignore'});
  const webdriver=`http://127.0.0.1:${driverPort}`;
  let sessionId;
  const request=async(method,url,body)=>{
    const response=await fetch(webdriver+url,{
      method,headers:{'content-type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body)
    });
    const result=await response.json();
    if(!response.ok||result.value?.error)throw new Error(JSON.stringify(result.value));
    return result.value;
  };

  try{
    for(let i=0;i<50;i++){
      try{await fetch(`${webdriver}/status`);break;}catch{await sleep(100);}
    }
    const session=await request('POST','/session',{
      capabilities:{alwaysMatch:{browserName:'MicrosoftEdge','ms:edgeOptions':{
        binary:edge,args:['--headless=new','--disable-gpu','--no-sandbox']
      }}}
    });
    sessionId=session.sessionId;
    const execute=script=>request('POST',`/session/${sessionId}/execute/sync`,{script,args:[]});
    await request('POST',`/session/${sessionId}/url`,{
      url:`http://127.0.0.1:${server.address().port}/`
    });

    for(let i=0;i<100;i++){
      const layout=await execute(`
        const sidebar=document.querySelector('.sidebar')?.getBoundingClientRect();
        const main=document.querySelector('.workspace > .main')?.getBoundingClientRect();
        const right=document.querySelector('.right')?.getBoundingClientRect();
        return sidebar&&main&&right?{sidebar:sidebar.width,main:main.width,right:right.width}:null;
      `);
      if(layout){
        assert.ok(layout.sidebar>=200,`sidebar width ${layout.sidebar}`);
        assert.ok(layout.main>0,`main width ${layout.main}`);
        assert.ok(layout.right>=320,`right width ${layout.right}`);
        break;
      }
      await sleep(100);
    }
    for(let i=0;i<100;i++){
      const ready=await execute(`
        const entry=[...document.querySelectorAll('.sidebar-entry')]
          .find(node=>node.textContent.includes('sample.cpp'));
        if(entry)entry.click();
        return Boolean(document.querySelector('.file-viewer-content')?.env?.editor);
      `);
      if(ready)break;
      await sleep(100);
    }
    const config=await execute(`
      const editor=document.querySelector('.file-viewer-content').env.editor;
      return {
        theme:editor.getTheme(),
        mode:editor.session.getMode().$id,
        keyboard:editor.getKeyboardHandler().$id
      };
    `);
    assert.equal(config.theme,'ace/theme/monokai');
    assert.equal(config.mode,'ace/mode/c_cpp');
    assert.equal(config.keyboard,'ace/keyboard/vim');

    await execute(`
      const editor=document.querySelector('.file-viewer-content').env.editor;
      editor.setValue('int answer() { return 42; }\\n',-1);
      document.querySelector('.file-viewer-header button').click();
    `);
    for(let i=0;i<50&&fs.readFileSync(path.join(root,'sample.cpp'),'utf8').includes('main');i++)
      await sleep(100);
    assert.equal(fs.readFileSync(path.join(root,'sample.cpp'),'utf8'),'int answer() { return 42; }\n');

    const treeReady=async tab=>{
      await execute(`
        [...document.querySelectorAll('.right-tab')]
          .find(node=>node.textContent.trim()==='${tab}')?.click();
      `);
      for(let i=0;i<100;i++){
        const state=await execute(`return {
          options:document.querySelectorAll('.executor-toolbar select option').length,
          nodes:document.querySelectorAll('.tree-node').length
        };`);
        if(state.options>0)return state;
        await sleep(100);
      }
      return {options:0,nodes:0};
    };
    const tree=await treeReady('TREE');
    assert.ok(tree.options>0,'Tree panel lists live Executors');
    assert.ok(tree.nodes>0,'Tree panel renders the selected Executor tree');
    const debug=await treeReady('DEBUG');
    assert.ok(debug.options>0,'Debug panel lists live Executors');
  }finally{
    if(sessionId)await request('DELETE',`/session/${sessionId}`).catch(()=>{});
    child.kill();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
