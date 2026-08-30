import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const host='127.0.0.1';
const devPort=4193;
const debuggingPort=9243;
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
const profile=await mkdtemp(join(tmpdir(),'shogi-title-gpu-fabric-'));
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
  await cdp.send('Runtime.enable');

  const result=await evaluate(cdp,`(async()=>{
    const engine=await import('/src/game/engine.ts');
    const gpuForecast=await import('/src/game/title-gpu-forecast.ts');
    const position=engine.initialPosition();
    const moves=engine.legalMoves(position);
    const warmed=await gpuForecast.warmupTitleGpuForecastFabric();
    if(!warmed)return{supported:false,reason:'WEBGPU_UNAVAILABLE'};
    await gpuForecast.runTitleGpuForecastFabric(position,moves);
    return await gpuForecast.runTitleGpuForecastFabric(position,moves);
  })()`);

  assert(result&&result.supported===true,`GPU_FABRIC_UNAVAILABLE:${result?.reason??'UNKNOWN'}`);
  assert(result.layers===500,`GPU_FABRIC_LAYER_COUNT:${result.layers}`);
  assert(result.lanesPerLayer===64,`GPU_FABRIC_LANE_COUNT:${result.lanesPerLayer}`);
  assert(result.totalSamples===100000000,`GPU_FABRIC_SAMPLE_COUNT:${result.totalSamples}`);
  assert(result.signaturesChecked===500,`GPU_FABRIC_INCOMPLETE:${result.signaturesChecked}`);
  assert(Number.isFinite(result.elapsedMs)&&result.elapsedMs>0,'GPU_FABRIC_TIME_INVALID');
  console.log('TITLE_GPU_FABRIC:'+JSON.stringify(result));
}finally{
  cdp?.close();
  await stopChild(chrome);
  await stopChild(dev);
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
