import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const host='127.0.0.1';
const previewPort=4173;
const debuggingPort=9222;
const appUrl=`http://${host}:${previewPort}/`;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function assert(condition,message){
  if(!condition)throw new Error(message);
}

function findChrome(){
  const candidates=[process.env.CHROME_BIN,'google-chrome','google-chrome-stable','chromium','chromium-browser'].filter(Boolean);
  for(const candidate of candidates){
    if(candidate.includes('/'))return candidate;
    const found=spawnSync('which',[candidate],{encoding:'utf8'});
    if(found.status===0&&found.stdout.trim())return found.stdout.trim();
  }
  throw new Error('CHROME_NOT_FOUND');
}

async function waitForHttp(url,timeoutMs=20_000){
  const deadline=Date.now()+timeoutMs;
  let lastError=null;
  while(Date.now()<deadline){
    try{
      const response=await fetch(url,{cache:'no-store'});
      if(response.ok)return response;
    }catch(error){lastError=error;}
    await delay(100);
  }
  throw lastError??new Error(`HTTP_TIMEOUT:${url}`);
}

class CdpClient{
  constructor(socket){
    this.socket=socket;
    this.nextId=1;
    this.pending=new Map();
    this.listeners=new Map();
    socket.addEventListener('message',event=>{
      const text=typeof event.data==='string'?event.data:String(event.data);
      let message;
      try{message=JSON.parse(text);}catch{return;}
      if(message.id){
        const pending=this.pending.get(message.id);
        if(!pending)return;
        this.pending.delete(message.id);
        if(message.error)pending.reject(new Error(`${message.error.code}:${message.error.message}`));
        else pending.resolve(message.result??{});
        return;
      }
      if(message.method){
        for(const listener of this.listeners.get(message.method)??[])listener(message.params??{});
      }
    });
    socket.addEventListener('close',()=>{
      for(const pending of this.pending.values())pending.reject(new Error('CDP_CLOSED'));
      this.pending.clear();
    });
  }

  static async connect(url){
    const socket=new WebSocket(url);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('CDP_CONNECT_TIMEOUT')),10_000);
      socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
      socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP_CONNECT_ERROR'));},{once:true});
    });
    return new CdpClient(socket);
  }

  on(method,listener){
    const listeners=this.listeners.get(method)??[];
    listeners.push(listener);
    this.listeners.set(method,listeners);
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
  const response=await cdp.send('Runtime.evaluate',{
    expression,
    returnByValue:true,
    awaitPromise:true,
    userGesture:true,
  });
  if(response.exceptionDetails){
    const description=response.exceptionDetails.exception?.description??response.exceptionDetails.text??'BROWSER_EVALUATION_FAILED';
    throw new Error(description);
  }
  return response.result?.value;
}

async function waitFor(cdp,expression,label,timeoutMs=10_000){
  const deadline=Date.now()+timeoutMs;
  let lastError=null;
  while(Date.now()<deadline){
    try{
      if(await evaluate(cdp,`Boolean(${expression})`))return;
    }catch(error){lastError=error;}
    await delay(50);
  }
  throw lastError??new Error(`BROWSER_WAIT_TIMEOUT:${label}`);
}

async function navigate(cdp,viewport){
  await cdp.send('Emulation.setDeviceMetricsOverride',{
    width:viewport.width,
    height:viewport.height,
    deviceScaleFactor:1,
    mobile:viewport.mobile,
  });
  await cdp.send('Page.navigate',{url:`${appUrl}?smoke=${Date.now()}`});
  await waitFor(cdp,`document.readyState==='complete'&&document.querySelectorAll('.menu button').length===3`,'menu');
  assert(await evaluate(cdp,`document.documentElement.scrollWidth<=window.innerWidth+1`),`${viewport.name}:horizontal overflow on menu`);
}

async function testRulesAndSettings(cdp){
  assert(await evaluate(cdp,`[...document.querySelectorAll('.menu button')].map(x=>x.textContent).join('|')==='スタート|ルール|設定'`),'menu labels mismatch');

  await evaluate(cdp,`document.querySelector('#rules').click()`);
  await waitFor(cdp,`document.querySelector('.rules-document')`,'rules');
  assert(await evaluate(cdp,`document.querySelectorAll('.rules-document section').length>=10`),'rules sections missing');
  for(const text of ['二歩','打ち歩詰め','千日手','入玉・持将棋']){
    assert(await evaluate(cdp,`document.querySelector('.rules-document').textContent.includes(${JSON.stringify(text)})`),`rules missing: ${text}`);
  }
  await evaluate(cdp,`document.querySelector('#back').click()`);
  await waitFor(cdp,`document.querySelector('.menu')`,'menu after rules');

  await evaluate(cdp,`document.querySelector('#settings').click()`);
  await waitFor(cdp,`document.querySelector('.settings-panel')`,'settings');
  assert(await evaluate(cdp,`document.querySelectorAll('.settings-panel input[type="checkbox"]').length===2`),'BGM/SE toggles missing');
  assert(await evaluate(cdp,`document.querySelectorAll('.settings-panel input[type="range"]').length===2`),'BGM/SE volume controls missing');
  assert(await evaluate(cdp,`document.querySelectorAll('.settings-panel [data-content]').length===3`),'managed document links missing');
  await evaluate(cdp,`document.querySelector('#back').click()`);
  await waitFor(cdp,`document.querySelector('.menu')`,'menu after settings');
}

async function startMode(cdp,mode){
  await evaluate(cdp,`document.querySelector('#start').click()`);
  await waitFor(cdp,`document.querySelector('[data-mode="${mode}"]')`,'mode selection');
  await evaluate(cdp,`document.querySelector('[data-mode="${mode}"]').click()`);
  await waitFor(cdp,`document.querySelector('#go')`,'game settings');
  await evaluate(cdp,`document.querySelector('#go').click()`);
  await waitFor(cdp,`document.querySelectorAll('.board .cell').length===81`,'board');
}

async function moveFirstPawn(cdp){
  await evaluate(cdp,`document.querySelectorAll('.board .cell')[54].click()`);
  await waitFor(cdp,`document.querySelectorAll('.board .cell')[45].classList.contains('legal')`,'pawn destination');
  await evaluate(cdp,`document.querySelectorAll('.board .cell')[45].click()`);
}

async function testLocal(cdp,viewportName){
  await startMode(cdp,'local');
  assert(await evaluate(cdp,`document.querySelector('.game header strong').textContent.includes('先手番')`),`${viewportName}:initial turn mismatch`);
  await moveFirstPawn(cdp);
  await waitFor(cdp,`document.querySelector('.game header strong').textContent.includes('後手番')`,'local move committed');
  assert(await evaluate(cdp,`document.querySelectorAll('.board .cell')[54].textContent.trim()===''`),`${viewportName}:source square did not clear`);
  assert(await evaluate(cdp,`document.querySelectorAll('.board .cell')[45].textContent.trim()==='歩'`),`${viewportName}:destination square missing pawn`);
  assert(await evaluate(cdp,`document.documentElement.scrollWidth<=window.innerWidth+1`),`${viewportName}:horizontal overflow on game`);
}

async function testCpuWorker(cdp){
  await cdp.send('Page.navigate',{url:`${appUrl}?cpu-smoke=${Date.now()}`});
  await waitFor(cdp,`document.querySelectorAll('.menu button').length===3`,'CPU fresh menu');
  await startMode(cdp,'cpu');
  await evaluate(cdp,`(()=>{
    window.__shogiCpuSmoke={sawThinking:false,done:false};
    const root=document.querySelector('#app');
    const read=()=>{
      const status=document.querySelector('.game header strong')?.textContent??'';
      if(status.includes('CPU思考中'))window.__shogiCpuSmoke.sawThinking=true;
      if(window.__shogiCpuSmoke.sawThinking&&status.includes('先手番')){
        window.__shogiCpuSmoke.done=true;
        observer.disconnect();
      }
    };
    const observer=new MutationObserver(read);
    observer.observe(root,{subtree:true,childList:true,characterData:true});
    read();
    return true;
  })()`);
  await moveFirstPawn(cdp);
  await waitFor(cdp,`window.__shogiCpuSmoke?.done===true`,'CPU worker returned control',20_000);
  assert(await evaluate(cdp,`window.__shogiCpuSmoke.sawThinking===true`),'CPU thinking state was never rendered');
  assert(await evaluate(cdp,`document.querySelector('.game header strong').textContent.includes('先手番')`),'CPU did not complete its reply');
}

const chromePath=findChrome();
const profile=await mkdtemp(join(tmpdir(),'shogi-browser-smoke-'));
let preview=null;
let chrome=null;
let cdp=null;
const browserErrors=[];

try{
  preview=spawn(process.platform==='win32'?'npm.cmd':'npm',['run','preview','--','--host',host,'--port',String(previewPort),'--strictPort'],{
    stdio:['ignore','pipe','pipe'],
    env:{...process.env},
  });
  await waitForHttp(appUrl);

  chrome=spawn(chromePath,[
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    `--remote-debugging-address=${host}`,
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],{stdio:['ignore','pipe','pipe']});

  await waitForHttp(`http://${host}:${debuggingPort}/json/version`);
  const targets=await (await waitForHttp(`http://${host}:${debuggingPort}/json/list`)).json();
  const page=targets.find(target=>target.type==='page'&&target.webSocketDebuggerUrl);
  assert(page,'CDP_PAGE_TARGET_NOT_FOUND');
  cdp=await CdpClient.connect(page.webSocketDebuggerUrl);
  cdp.on('Runtime.exceptionThrown',params=>{
    const description=params.exceptionDetails?.exception?.description??params.exceptionDetails?.text??'uncaught browser exception';
    browserErrors.push(description);
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await navigate(cdp,{name:'desktop',width:1280,height:800,mobile:false});
  await testRulesAndSettings(cdp);
  await cdp.send('Page.navigate',{url:`${appUrl}?local-desktop=${Date.now()}`});
  await waitFor(cdp,`document.querySelector('.menu')`,'desktop local fresh menu');
  await testLocal(cdp,'desktop');
  await testCpuWorker(cdp);

  await navigate(cdp,{name:'mobile',width:390,height:844,mobile:true});
  await testLocal(cdp,'mobile');

  assert(browserErrors.length===0,`uncaught browser errors:\n${browserErrors.join('\n')}`);
  console.log(JSON.stringify({ok:true,desktop:true,mobile:true,localMove:true,cpuWorker:true}));
}finally{
  cdp?.close();
  chrome?.kill('SIGTERM');
  preview?.kill('SIGTERM');
  await rm(profile,{recursive:true,force:true});
}