const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

const opener=path.join(__dirname,'..','Scripts','open-app-window.sh');

function executable(file,content){
  fs.writeFileSync(file,content,{mode:0o755});
}

test('window opener waits for health and launches the configured browser in app mode',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nodeglm-window-test-'));
  const calls=path.join(dir,'calls');
  const browser=path.join(dir,'test-browser');
  executable(path.join(dir,'curl'),`#!/usr/bin/env bash\necho health >> "${calls}"\nexit 0\n`);
  executable(browser,`#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${calls}"\n`);

  const result=spawnSync('bash',[opener,'http://127.0.0.1:4321/'],{
    encoding:'utf8',
    env:{...process.env,PATH:`${dir}:${process.env.PATH}`,NODEGLM_BROWSER:browser}
  });
  assert.equal(result.status,0,result.stderr);
  const output=fs.readFileSync(calls,'utf8');
  assert.match(output,/health/);
  assert.match(output,/--app=http:\/\/127\.0\.0\.1:4321\//);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('window opener opt-out performs no health check or browser launch',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nodeglm-window-disabled-'));
  const marker=path.join(dir,'called');
  const command=`#!/usr/bin/env bash\ntouch "${marker}"\n`;
  executable(path.join(dir,'curl'),command);
  const browser=path.join(dir,'test-browser');
  executable(browser,command);

  const result=spawnSync('bash',[opener,'http://127.0.0.1:4321/'],{
    encoding:'utf8',
    env:{...process.env,PATH:`${dir}:${process.env.PATH}`,NODEGLM_BROWSER:browser,NODEGLM_NO_WINDOW:'1'}
  });
  assert.equal(result.status,0,result.stderr);
  assert.equal(fs.existsSync(marker),false);
  fs.rmSync(dir,{recursive:true,force:true});
});
