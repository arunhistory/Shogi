import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const host='127.0.0.1';
const devPort=4191;
const debuggingPort=9241;
const appUrl=`http://${host}:${devPort}/`;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

function findChrome(){
  const candidates=[process.env.CHROME_BIN,'google-chrome','google-chrome-stable','chromium','chromium-browser'].filter(Boolean);
  for(const candidate of candidates){
    if(candidate.includes('/'))return candidate;
    const found=spawnSync('which',[candidate],{encoding:'utf8'});
    if(found.status===0&&found.stdout.trim())return found.stdout.trim();
  }
  throw new Error('CHROME_NOT_FOUND');
}

async function stopChild(child){
  if(!child||child.exitCode!==null)return;
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.kill('SIGTERM');
  await Promise.race([exited,delay(1500)]);
  if(child.exitCode===null)child.kill('SIGKILL');
}

async function waitForHttp(url,timeoutMs=20000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    try{const response=await fetch(url,{cache:'no-store'});if(response.ok)return response;}catch{}
    await delay(80);
  }
  throw new Error(`HTTP_TIMEOUT:${url}`);
}

class CdpClient{
  constructor(socket){
    this.socket=socket;
    this.nextId=1;
    this.pending=new Map();
    socket.addEventListener('message',event=>{
      let message;
      try{message=JSON.parse(typeof event.data==='string'?event.data:String(event.data));}catch{return;}
      if(!message.id)return;
      const pending=this.pending.get(message.id);
      if(!pending)return;
      this.pending.delete(message.id);
      if(message.error)pending.reject(new Error(`${message.error.code}:${message.error.message}`));
      else pending.resolve(message.result??{});
    });
    socket.addEventListener('close',()=>{
      for(const pending of this.pending.values())pending.reject(new Error('CDP_CLOSED'));
      this.pending.clear();
    });
  }
  static async connect(url){
    const socket=new WebSocket(url);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('CDP_CONNECT_TIMEOUT')),10000);
      socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
      socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP_CONNECT_ERROR'));},{once:true});
    });
    return new CdpClient(socket);
  }
  send(method,params={}){
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});
      this.socket.send(JSON.stringify({id,method,params}));
    });
  }
  close(){this.socket.close();}
}

async function evaluate(cdp,expression){
  const response=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});
  if(response.exceptionDetails){
    const description=response.exceptionDetails.exception?.description??response.exceptionDetails.text??'BROWSER_EVALUATION_FAILED';
    throw new Error(description);
  }
  return response.result?.value;
}

const chromePath=findChrome();
const profile=await mkdtemp(join(tmpdir(),'shogi-title-throughput-'));
let dev=null;
let chrome=null;
let cdp=null;

try{
  dev=spawn(process.platform==='win32'?'npm.cmd':'npm',['run','dev','--','--host',host,'--port',String(devPort),'--strictPort'],{
    stdio:['ignore','ignore','inherit'],env:{...process.env},
  });
  await waitForHttp(appUrl);

  chrome=spawn(chromePath,[
    '--headless=new','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking',
    '--no-first-run','--no-default-browser-check','--no-sandbox',
    `--remote-debugging-address=${host}`,`--remote-debugging-port=${debuggingPort}`,`--user-data-dir=${profile}`,appUrl,
  ],{stdio:['ignore','ignore','inherit']});
  await waitForHttp(`http://${host}:${debuggingPort}/json/version`);
  const targets=await (await waitForHttp(`http://${host}:${debuggingPort}/json/list`)).json();
  const page=targets.find(target=>target.type==='page'&&target.webSocketDebuggerUrl);
  assert(page,'CDP_PAGE_TARGET_NOT_FOUND');
  cdp=await CdpClient.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  const result=await evaluate(cdp,`(async()=>{
    const engine=await import('/src/game/engine.ts');
    const wasmUrl=new URL('/wasm/shogi_engine.wasm',location.origin).toString();
    const position=engine.initialPosition();
    const worker=new Worker('/src/game/cpu-worker.ts',{type:'module'});
    const search=()=>new Promise((resolve,reject)=>{
      const requestId=crypto.randomUUID();
      const timer=setTimeout(()=>{cleanup();reject(new Error('TITLE_SEARCH_TIMEOUT'));},3000);
      const cleanup=()=>{clearTimeout(timer);worker.removeEventListener('message',onMessage);worker.removeEventListener('error',onError);};
      const onError=()=>{cleanup();reject(new Error('TITLE_WORKER_ERROR'));};
      const onMessage=event=>{
        if(event.data?.requestId!==requestId)return;
        cleanup();
        if(!event.data.ok||!event.data.result?.move){reject(new Error('TITLE_SEARCH_FAILED:'+String(event.data?.error??'NO_MOVE')));return;}
        resolve(event.data.result);
      };
      worker.addEventListener('message',onMessage);
      worker.addEventListener('error',onError);
      worker.postMessage({type:'search',requestId,position,level:'title',wasmUrl});
    });
    try{
      worker.postMessage({type:'warmup',position,level:'title',wasmUrl});
      await new Promise(resolve=>setTimeout(resolve,300));
      const start=performance.now();
      const searched=await search();
      const elapsedMs=performance.now()-start;
      const nodes=Number(searched.nodesVisited??0);
      return{
        elapsedMs,
        nodesVisited:nodes,
        nodesPerSecond:elapsedMs>0?nodes/(elapsedMs/1000):0,
        logicalJobsPlanned:Number(searched.logicalJobsPlanned??0),
        logicalJobsCompleted:Number(searched.logicalJobsCompleted??0),
        physicalWorkers:Number(searched.physicalWorkers??0),
        completedDepth:Number(searched.completedDepth??0),
      };
    }finally{worker.terminate();}
  })()`);

  assert(result&&Number.isFinite(result.elapsedMs),'THROUGHPUT_RESULT_MISSING');
  assert(result.elapsedMs<2000,`TITLE_FORECAST_OVER_2S:${result.elapsedMs}`);
  console.log('TITLE_FORECAST_THROUGHPUT:'+JSON.stringify({
    ...result,
    theoreticalPositionBudget:100100000,
    actualBudgetRatio:result.nodesVisited/100100000,
  }));
}finally{
  cdp?.close();
  await stopChild(chrome);
  await stopChild(dev);
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
