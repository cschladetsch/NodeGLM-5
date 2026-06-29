const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');

const repo=path.resolve(__dirname,'..');
const kaiDir=path.join(repo,'Ext','CppKAI');
const consoleBin=process.env.KAI_CONSOLE||path.join(kaiDir,'Bin','Console');

test('CppKAI inspection uses correlated duplex control I/O',
  {skip:fs.existsSync(consoleBin)?false:'CppKAI Console is not built',timeout:5000},
  async()=>{
    const child=spawn(consoleBin,['-l','pi'],{
      cwd:kaiDir,
      env:{...process.env,KAI_CONTROL_FD:'3'},
      stdio:['pipe','pipe','pipe','pipe']
    });
    let stdout='';
    let control='';
    child.stdout.on('data',data=>stdout+=data);
    child.stdio[3].on('data',data=>control+=data);

    try{
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('control response timed out')),4000);
        const finish=()=>{
          if(!control.includes('\n'))return;
          clearTimeout(timer);
          resolve();
        };
        child.stdio[3].on('data',finish);
        child.once('error',reject);
        setTimeout(()=>child.stdio[3].write('__nodeglm_tree__ Request-A1\n'),100);
      });
      const response=JSON.parse(control.trim());
      assert.equal(response.id,'Request-A1');
      assert.equal(response.type,'tree');
      assert.equal(response.ok,true);
      assert.ok(response.executors.length>0);
      if ('dataStack' in response.executors[0] || 'contextStack' in response.executors[0]) {
        assert.ok(Array.isArray(response.executors[0].dataStack));
        assert.ok(Array.isArray(response.executors[0].contextStack));
      }
      assert.doesNotMatch(stdout,/__nodeglm_tree__|NODEGLM_TREE_BEGIN/);
    }finally{
      child.kill('SIGTERM');
      await new Promise(resolve=>child.once('close',resolve));
    }
  });
