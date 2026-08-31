import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const tracePath=process.argv[2]??'/tmp/title-82-winning.json';
const winning=JSON.parse(await readFile(tracePath,'utf8'));
if(winning.result!=='title-win'||winning.titleSide!=='gote'||winning.proSide!=='sente'||winning.plies!==82||!Array.isArray(winning.moveTrace)||winning.moveTrace.length!==82){
  throw new Error('INVALID_82_WIN_TRACE');
}
const trace=winning.moveTrace;
const host='127.0.0.1';
const devPort=4186;
const debuggingPort=9236;
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
const profile=await mkdtemp(join(tmpdir(),'shogi-title-trace-'));
let dev=null;
let chrome=null;
let cdp=null;

try{
  dev=spawn(process.platform==='win32'?'npm.cmd':'npm',['run','dev','--','--host',host,'--port',String(devPort),'--strictPort'],{
    stdio:['ignore','ignore','inherit'],env:{...process.env},
  });
  await waitForHttp(appUrl);
  chrome=spawn(chromePath,[
    '--headless=new','--disable-dev-shm-usage','--disable-background-networking',
    '--no-first-run','--no-default-browser-check','--no-sandbox','--disable-gpu',
    `--remote-debugging-address=${host}`,`--remote-debugging-port=${debuggingPort}`,`--user-data-dir=${profile}`,appUrl,
  ],{stdio:['ignore','ignore','inherit']});
  await waitForHttp(`http://${host}:${debuggingPort}/json/version`);
  const targets=await (await waitForHttp(`http://${host}:${debuggingPort}/json/list`)).json();
  const page=targets.find(target=>target.type==='page'&&target.webSocketDebuggerUrl);
  assert(page,'CDP_PAGE_TARGET_NOT_FOUND');
  cdp=await CdpClient.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const result=await evaluate(cdp,`(async()=>{
    const engine=await import('/src/game/engine.ts');
    const wasmUrl=new URL('/wasm/shogi_engine.wasm',location.origin).toString();
    const trace=${JSON.stringify(trace)};
    const titleWorker=new Worker('/src/game/cpu-worker.ts',{type:'module'});
    let position=engine.initialPosition();
    const samples=[];
    const sameMove=(a,b)=>a&&b
      &&a.to?.[0]===b.to?.[0]&&a.to?.[1]===b.to?.[1]
      &&a.from?.[0]===b.from?.[0]&&a.from?.[1]===b.from?.[1]
      &&a.drop===b.drop&&!!a.promote===!!b.promote;
    const search=(pos)=>new Promise((resolve,reject)=>{
      const requestId=crypto.randomUUID();
      const started=performance.now();
      const timer=setTimeout(()=>{cleanup();reject(new Error('TITLE_SEARCH_TIMEOUT'));},5000);
      const cleanup=()=>{clearTimeout(timer);titleWorker.removeEventListener('message',onMessage);titleWorker.removeEventListener('error',onError);};
      const onError=()=>{cleanup();reject(new Error('TITLE_WORKER_ERROR'));};
      const onMessage=event=>{
        const data=event.data;
        if(data?.requestId!==requestId)return;
        cleanup();
        if(!data.ok||!data.result?.move){reject(new Error('TITLE_SEARCH_FAILED:'+String(data?.error??'NO_MOVE')));return;}
        resolve({result:data.result,elapsedMs:performance.now()-started});
      };
      titleWorker.addEventListener('message',onMessage);
      titleWorker.addEventListener('error',onError);
      titleWorker.postMessage({type:'search',requestId,position:pos,level:'title',wasmUrl});
    });
    titleWorker.postMessage({type:'warmup',position,level:'title',wasmUrl});
    await new Promise(resolve=>setTimeout(resolve,500));
    try{
      for(const expected of trace){
        if(expected.ply!==position.ply+1)throw new Error('TRACE_PLY_MISMATCH:'+expected.ply);
        if(expected.side!==position.turn)throw new Error('TRACE_SIDE_MISMATCH:'+expected.ply);
        const legal=engine.legalMoves(position).some(move=>sameMove(move,expected.move));
        if(!legal)throw new Error('TRACE_ILLEGAL_MOVE:'+expected.ply);
        if(expected.level==='title'){
          const searched=await search(position);
          const matched=sameMove(searched.result.move,expected.move);
          samples.push({
            ply:expected.ply,
            matched,
            elapsedMs:searched.elapsedMs,
            jobs:Number(searched.result.logicalJobsCompleted??0),
            nodes:Number(searched.result.nodesVisited??0),
            depth:Number(searched.result.completedDepth??0),
            expected:expected.move,
            chosen:searched.result.move,
          });
          if(!matched)break;
        }
        position=engine.applyMove(position,expected.move);
      }
      const matched=samples.filter(sample=>sample.matched);
      const maxMs=matched.length?Math.max(...matched.map(sample=>sample.elapsedMs)):0;
      const avgMs=matched.length?matched.reduce((sum,sample)=>sum+sample.elapsedMs,0)/matched.length:0;
      return{
        matchedTitleMoves:matched.length,
        testedTitleMoves:samples.length,
        totalTitleMoves:41,
        fullMatch:matched.length===41,
        firstMismatch:samples.find(sample=>!sample.matched)??null,
        maxMs,avgMs,samples,
      };
    }finally{
      titleWorker.terminate();
    }
  })()`);
  console.log('TITLE_TRACE_RESULT:'+JSON.stringify(result));
}finally{
  cdp?.close();
  await stopChild(chrome);
  await stopChild(dev);
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
