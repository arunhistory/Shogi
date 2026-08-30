import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const host='127.0.0.1';
const vitePort=4176;
const debuggingPort=9226;
const appUrl=`http://${host}:${vitePort}/`;
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
const profile=await mkdtemp(join(tmpdir(),'shogi-title-vs-pro-'));
let vite=null;
let chrome=null;
let cdp=null;
try{
  vite=spawn(process.platform==='win32'?'npm.cmd':'npm',['run','dev','--','--host',host,'--port',String(vitePort),'--strictPort'],{
    stdio:['ignore','ignore','inherit'],env:{...process.env},
  });
  await waitForHttp(appUrl);
  chrome=spawn(chromePath,[
    '--headless=new','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking',
    '--no-first-run','--no-default-browser-check','--no-sandbox',
    `--remote-debugging-address=${host}`,`--remote-debugging-port=${debuggingPort}`,`--user-data-dir=${profile}`,'about:blank',
  ],{stdio:['ignore','ignore','inherit']});
  await waitForHttp(`http://${host}:${debuggingPort}/json/version`);
  const targets=await (await waitForHttp(`http://${host}:${debuggingPort}/json/list`)).json();
  const page=targets.find(target=>target.type==='page'&&target.webSocketDebuggerUrl);
  assert(page,'CDP_PAGE_TARGET_NOT_FOUND');
  cdp=await CdpClient.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate',{url:`${appUrl}?title-vs-pro=${Date.now()}`});
  await delay(500);

  const result=await evaluate(cdp,`(async()=>{
    const engine=await import('/src/game/engine.ts');
    const setup=await import('/src/game/setup.ts');
    let position=setup.configuredInitialPosition();
    const wasmUrl=new URL('/wasm/shogi_engine.wasm',location.origin).toString();
    const proWorker=new Worker('/src/game/cpu-worker.ts',{type:'module'});
    const titleWorker=new Worker('/src/game/cpu-worker.ts',{type:'module'});
    const moves=[];
    const timings={pro:[],title:[]};
    const metrics={pro:[],title:[]};

    const request=(worker,level)=>new Promise((resolve,reject)=>{
      const requestId=crypto.randomUUID();
      const started=performance.now();
      const timer=setTimeout(()=>{
        worker.removeEventListener('message',onMessage);
        reject(new Error(level+':CPU_TIMEOUT'));
      },10000);
      const onMessage=event=>{
        const data=event.data;
        if(data?.requestId!==requestId)return;
        clearTimeout(timer);
        worker.removeEventListener('message',onMessage);
        if(!data.ok||!data.result?.move){reject(new Error(level+':CPU_SEARCH_FAILED:'+String(data.error??'')));return;}
        resolve({move:data.result.move,elapsed:performance.now()-started,result:data.result,wasmUsed:data.wasmUsed});
      };
      worker.addEventListener('message',onMessage);
      worker.postMessage({type:'search',requestId,position,level,wasmUrl});
    });

    proWorker.postMessage({type:'warmup',position,level:'pro',wasmUrl});
    titleWorker.postMessage({type:'warmup',position,level:'title',wasmUrl});
    await new Promise(resolve=>setTimeout(resolve,250));

    let terminal=engine.gameOutcome(position);
    while(!terminal.ended&&position.ply<200){
      const level=position.turn==='sente'?'pro':'title';
      const worker=level==='pro'?proWorker:titleWorker;
      const searched=await request(worker,level);
      timings[level].push(searched.elapsed);
      metrics[level].push({
        completedDepth:searched.result.completedDepth??0,
        nodesVisited:searched.result.nodesVisited??0,
        logicalJobsPlanned:searched.result.logicalJobsPlanned??0,
        logicalJobsCompleted:searched.result.logicalJobsCompleted??0,
        physicalWorkers:searched.result.physicalWorkers??0,
        wasmUsed:searched.wasmUsed,
      });
      moves.push({
        ply:position.ply+1,
        side:position.turn,
        level,
        move:searched.move,
        elapsedMs:Math.round(searched.elapsed*10)/10,
      });
      position=engine.applyMove(position,searched.move);
      terminal=engine.gameOutcome(position);
    }

    proWorker.terminate();
    titleWorker.terminate();
    const summarize=values=>({
      count:values.length,
      minMs:values.length?Math.round(Math.min(...values)*10)/10:0,
      avgMs:values.length?Math.round(values.reduce((a,b)=>a+b,0)/values.length*10)/10:0,
      maxMs:values.length?Math.round(Math.max(...values)*10)/10:0,
    });
    return{
      terminal,
      finalPly:position.ply,
      moves,
      timingSummary:{pro:summarize(timings.pro),title:summarize(timings.title)},
      metrics,
    };
  })()`);

  assert(result?.terminal?.ended,'SELF_PLAY_DID_NOT_END');
  console.log(JSON.stringify(result));
}finally{
  cdp?.close();
  await stopChild(chrome);
  await stopChild(vite);
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
