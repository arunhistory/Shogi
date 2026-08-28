import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const host='127.0.0.1';
const previewPort=4174;
const debuggingPort=9223;
const appUrl=`http://${host}:${previewPort}/`;
const levels=['beginner','intermediate','amateur','pro','title'];
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

async function waitFor(cdp,expression,label,timeoutMs=5000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    try{if(await evaluate(cdp,`Boolean(${expression})`))return;}catch{}
    await delay(20);
  }
  throw new Error(`BROWSER_WAIT_TIMEOUT:${label}`);
}

async function navigateFresh(cdp,level){
  await cdp.send('Page.navigate',{url:`${appUrl}?cpu-latency=${level}-${Date.now()}`});
  await waitFor(cdp,`document.readyState==='complete'&&document.querySelector('.menu')`,'menu');
}

async function startCpuLevel(cdp,level){
  await evaluate(cdp,`document.querySelector('#start').click()`);
  await waitFor(cdp,`document.querySelector('[data-mode="cpu"]')`,'mode');
  await evaluate(cdp,`document.querySelector('[data-mode="cpu"]').click()`);
  await waitFor(cdp,`document.querySelector('#cpuLevel')&&document.querySelector('#order')&&document.querySelector('#senteHandicap')&&document.querySelector('#goteHandicap')&&document.querySelector('#go')`,'cpu settings');
  await evaluate(cdp,`(()=>{const select=document.querySelector('#cpuLevel');const order=document.querySelector('#order');select.value=${JSON.stringify(level)};order.value='sente';document.querySelector('#senteHandicap').value='even';document.querySelector('#goteHandicap').value='even';document.querySelector('#go').click();return select.value;})()`);
  await waitFor(cdp,`document.querySelectorAll('.board .cell').length===81`,'board');
}

async function measureReply(cdp,level){
  await navigateFresh(cdp,level);
  await startCpuLevel(cdp,level);
  await evaluate(cdp,`document.querySelectorAll('.board .cell')[54].click()`);
  await waitFor(cdp,`document.querySelectorAll('.board .cell')[45].classList.contains('legal')`,'pawn destination');
  const started=await evaluate(cdp,`(()=>{window.__cpuLatencyStart=performance.now();document.querySelectorAll('.board .cell')[45].click();return window.__cpuLatencyStart;})()`);
  await waitFor(cdp,`document.querySelector('.match-header>strong')?.textContent.includes('先手番')`,`${level} reply`,2500);
  const elapsed=await evaluate(cdp,`performance.now()-window.__cpuLatencyStart`);
  assert(Number.isFinite(started),`${level}:timer did not start`);
  assert(Number.isFinite(elapsed),`${level}:invalid elapsed time`);
  assert(elapsed<2000,`${level}:CPU reply exceeded 2000ms (${elapsed.toFixed(1)}ms)`);
  return Math.round(elapsed*10)/10;
}

const chromePath=findChrome();
const profile=await mkdtemp(join(tmpdir(),'shogi-cpu-latency-'));
let preview=null;
let chrome=null;
let cdp=null;
try{
  preview=spawn(process.platform==='win32'?'npm.cmd':'npm',['run','preview','--','--host',host,'--port',String(previewPort),'--strictPort'],{
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
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});

  const timings={};
  for(const level of levels)timings[level]=await measureReply(cdp,level);
  console.log(JSON.stringify({ok:true,limitMs:2000,timings}));
}finally{
  cdp?.close();
  await stopChild(chrome);
  await stopChild(preview);
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
