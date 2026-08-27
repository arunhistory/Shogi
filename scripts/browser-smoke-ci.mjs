import {spawn} from 'node:child_process';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sourceUrl=new URL('./browser-smoke.mjs',import.meta.url);
const sourcePath=fileURLToPath(sourceUrl);
const MAX_CAPTURE=32_768;

async function freePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  const address=server.address();
  const port=typeof address==='object'&&address?address.port:0;
  await new Promise(resolve=>server.close(resolve));
  if(!Number.isInteger(port)||port<=0)throw new Error('FREE_PORT_UNAVAILABLE');
  return port;
}

function appendBounded(current,chunk){
  const next=current+chunk.toString();
  return next.length<=MAX_CAPTURE?next:next.slice(next.length-MAX_CAPTURE);
}

async function runAttempt(attempt){
  const port=await freePort();
  const tempUrl=new URL(`./.browser-smoke-attempt-${process.pid}-${attempt}-${port}.mjs`,import.meta.url);
  const tempPath=fileURLToPath(tempUrl);
  let source=await readFile(sourcePath,'utf8');
  if(!source.includes('const debuggingPort=9222;'))throw new Error('SMOKE_DEBUG_PORT_MARKER_MISSING');
  source=source.replace('const debuggingPort=9222;',`const debuggingPort=${port};`);
  // Surface Chrome startup diagnostics through this runner instead of leaving its
  // stderr on an unread pipe. The preview server remains quiet.
  source=source.replace(
    "  ],{stdio:['ignore','pipe','pipe']});",
    "  ],{stdio:['ignore','ignore','inherit']});",
  );
  source+='\nprocess.exit(0);\n';
  await writeFile(tempPath,source,'utf8');

  let child=null;
  let stdout='';
  let stderr='';
  try{
    child=spawn(process.execPath,[tempPath],{stdio:['ignore','pipe','pipe'],env:{...process.env}});
    child.stdout.on('data',chunk=>{stdout=appendBounded(stdout,chunk);});
    child.stderr.on('data',chunk=>{stderr=appendBounded(stderr,chunk);});

    const exit=await Promise.race([
      new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal,timeout:false}))),
      delay(60_000).then(()=>({code:null,signal:null,timeout:true})),
    ]);
    if(exit.timeout){
      child.kill('SIGKILL');
      await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(2_000)]);
      throw new Error(`BROWSER_SMOKE_TIMEOUT attempt=${attempt} cdpPort=${port}`);
    }
    if(exit.code!==0){
      throw new Error(
        `BROWSER_SMOKE_FAILED attempt=${attempt} cdpPort=${port} exit=${String(exit.code)} signal=${String(exit.signal)}\n${stderr.slice(-8000)}`,
      );
    }
    if(stdout)process.stdout.write(stdout);
    return;
  }finally{
    if(child?.exitCode===null)child.kill('SIGKILL');
    await unlink(tempPath).catch(()=>{});
  }
}

let lastError=null;
for(let attempt=1;attempt<=2;attempt++){
  try{
    await runAttempt(attempt);
    process.exit(0);
  }catch(error){
    lastError=error;
    console.error(error);
    if(attempt<2){
      console.error('Retrying browser smoke once with a fresh CDP port/profile.');
      await delay(300);
    }
  }
}
throw lastError??new Error('BROWSER_SMOKE_FAILED');
