import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const gameNumber=Number(process.argv[2]??1);
if(!Number.isInteger(gameNumber)||gameNumber<1||gameNumber>5)throw new Error('GAME_NUMBER_MUST_BE_1_TO_5');

const host='127.0.0.1';
const devPort=4185;
const debuggingPort=9235;
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

const titleSide=gameNumber%2===1?'sente':'gote';
const proSide=titleSide==='sente'?'gote':'sente';
const chromePath=findChrome();
const profile=await mkdtemp(join(tmpdir(),`shogi-title-selfplay-${gameNumber}-`));
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
    '--no-first-run','--no-default-browser-check','--no-sandbox',
    '--enable-unsafe-webgpu','--use-webgpu-adapter=swiftshader','--enable-unsafe-swiftshader',
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
    const titleWorker=new Worker('/src/game/cpu-worker.ts',{type:'module'});
    const proWorker=new Worker('/src/game/cpu-worker.ts',{type:'module'});
    const titleSide=${JSON.stringify(titleSide)};
    const proSide=${JSON.stringify(proSide)};
    const maxPlies=200;
    let position=engine.initialPosition();
    let titleNodes=0;
    let proNodes=0;
    let titleJobs=0;
    let proJobs=0;
    let titleGpuUses=0;
    let titleGpuSamples=0;
    let titleGpuLayers=0;
    let titleGpuMs=0;
    let titleMaxReplyMs=0;
    let proMaxReplyMs=0;
    const search=(worker,level,pos)=>new Promise((resolve,reject)=>{
      const requestId=crypto.randomUUID();
      const started=performance.now();
      const timer=setTimeout(()=>{cleanup();reject(new Error(level+'_SEARCH_TIMEOUT'));},5000);
      const cleanup=()=>{clearTimeout(timer);worker.removeEventListener('message',onMessage);worker.removeEventListener('error',onError);};
      const onError=()=>{cleanup();reject(new Error(level+'_WORKER_ERROR'));};
      const onMessage=event=>{
        const data=event.data;
        if(data?.requestId!==requestId)return;
        cleanup();
        if(!data.ok||!data.result?.move){reject(new Error(level+'_SEARCH_FAILED:'+String(data?.error??'NO_MOVE')));return;}
        resolve({result:data.result,elapsedMs:performance.now()-started});
      };
      worker.addEventListener('message',onMessage);
      worker.addEventListener('error',onError);
      worker.postMessage({type:'search',requestId,position:pos,level,wasmUrl});
    });
    titleWorker.postMessage({type:'warmup',position,level:'title',wasmUrl});
    proWorker.postMessage({type:'warmup',position,level:'pro',wasmUrl});
    await new Promise(resolve=>setTimeout(resolve,500));
    let outcome=engine.gameOutcome(position);
    try{
      while(!outcome.ended&&position.ply<maxPlies){
        const level=position.turn===titleSide?'title':'pro';
        const worker=level==='title'?titleWorker:proWorker;
        const searched=await search(worker,level,position);
        const result=searched.result;
        if(level==='title'){
          titleNodes+=Number(result.nodesVisited??0);
          titleJobs+=Number(result.logicalJobsCompleted??0);
          titleMaxReplyMs=Math.max(titleMaxReplyMs,searched.elapsedMs);
          if(result.gpuForecastUsed){
            titleGpuUses++;
            titleGpuSamples+=Number(result.gpuForecastSamples??0);
            titleGpuLayers+=Number(result.gpuForecastLayers??0);
            titleGpuMs+=Number(result.gpuForecastMs??0);
          }
        }else{
          proNodes+=Number(result.nodesVisited??0);
          proJobs+=Number(result.logicalJobsCompleted??0);
          proMaxReplyMs=Math.max(proMaxReplyMs,searched.elapsedMs);
        }
        position=engine.applyMove(position,result.move);
        outcome=engine.gameOutcome(position);
      }
      const result=outcome.ended
        ?(outcome.winner===titleSide?'title-win':outcome.winner===proSide?'pro-win':'draw')
        :'move-limit';
      return{
        game:${gameNumber},titleSide,proSide,result,plies:position.ply,
        winner:outcome.winner??null,reason:outcome.reason??(outcome.ended?'ended':'move-limit'),
        titleNodes,proNodes,titleJobs,proJobs,
        titleGpuUses,titleGpuSamples,titleGpuLayers,titleGpuMs,
        titleMaxReplyMs,proMaxReplyMs,
        titleReplyUnder2s:titleMaxReplyMs<2000,
      };
    }finally{
      titleWorker.terminate();
      proWorker.terminate();
    }
  })()`);

  assert(result&&result.game===gameNumber,'SELFPLAY_RESULT_MISSING');
  console.log('SELFPLAY_RESULT:'+JSON.stringify(result));
}finally{
  cdp?.close();
  await stopChild(chrome);
  await stopChild(dev);
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
