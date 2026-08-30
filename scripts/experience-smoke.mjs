import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const host='127.0.0.1';
const previewPort=4175;
const debuggingPort=9225;
const appUrl=`http://${host}:${previewPort}/`;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

function findChrome(){
  for(const candidate of [process.env.CHROME_BIN,'google-chrome','google-chrome-stable','chromium','chromium-browser'].filter(Boolean)){
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
  constructor(socket){this.socket=socket;this.nextId=1;this.pending=new Map();socket.addEventListener('message',event=>{let message;try{message=JSON.parse(typeof event.data==='string'?event.data:String(event.data));}catch{return;}if(!message.id)return;const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);message.error?pending.reject(new Error(`${message.error.code}:${message.error.message}`)):pending.resolve(message.result??{});});}
  static async connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('CDP_CONNECT_TIMEOUT')),10000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP_CONNECT_ERROR'));},{once:true});});return new CdpClient(socket);}
  send(method,params={}){const id=this.nextId++;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.socket.send(JSON.stringify({id,method,params}));});}
  close(){this.socket.close();}
}
async function evaluate(cdp,expression){const response=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description??response.exceptionDetails.text??'BROWSER_EVALUATION_FAILED');return response.result?.value;}
async function waitFor(cdp,expression,label,timeoutMs=10000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){try{if(await evaluate(cdp,`Boolean(${expression})`))return;}catch{}await delay(30);}throw new Error(`BROWSER_WAIT_TIMEOUT:${label}`);}
async function fresh(cdp,label){await cdp.send('Page.navigate',{url:`${appUrl}?experience=${label}-${Date.now()}`});await waitFor(cdp,`document.readyState==='complete'&&document.querySelector('.menu')`,'menu');}
async function openGameSettings(cdp,mode){await evaluate(cdp,`document.querySelector('#start').click()`);await waitFor(cdp,`document.querySelector('[data-mode="${mode}"]')`,'mode');await evaluate(cdp,`document.querySelector('[data-mode="${mode}"]').click()`);await waitFor(cdp,`document.querySelector('#go')`,'game settings');}
function fakeBoardExpression(pieces){
  return `(()=>{const pieces=${JSON.stringify(pieces)};const cells=Array.from({length:81},(_,index)=>{const p=pieces[index];if(!p)return '<button class="cell"></button>';return '<button class="cell '+(p.side==='gote'?'gote':'')+'">'+p.label+'</button>';}).join('');return '<div class="board">'+cells+'</div>';})()`;
}

const chromePath=findChrome();
const profile=await mkdtemp(join(tmpdir(),'shogi-experience-smoke-'));
let preview=null,chrome=null,cdp=null;
try{
  preview=spawn(process.platform==='win32'?'npm.cmd':'npm',['run','preview','--','--host',host,'--port',String(previewPort),'--strictPort'],{stdio:['ignore','ignore','inherit'],env:{...process.env}});
  await waitForHttp(appUrl);
  chrome=spawn(chromePath,['--headless=new','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--no-first-run','--no-default-browser-check','--no-sandbox',`--remote-debugging-address=${host}`,`--remote-debugging-port=${debuggingPort}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','inherit']});
  await waitForHttp(`http://${host}:${debuggingPort}/json/version`);
  const targets=await (await waitForHttp(`http://${host}:${debuggingPort}/json/list`)).json();
  const page=targets.find(target=>target.type==='page'&&target.webSocketDebuggerUrl);
  assert(page,'CDP_PAGE_TARGET_NOT_FOUND');
  cdp=await CdpClient.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});

  await fresh(cdp,'bgm');
  await delay(300);
  await evaluate(cdp,`(()=>{window.__bgmPlayEvents=[];HTMLMediaElement.prototype.play=function(){window.__bgmPlayEvents.push(window.event?.type??'none');return Promise.resolve();};document.querySelector('#settings').click();})()`);
  await waitFor(cdp,`document.querySelector('#bgmEnabled')`,'audio settings');
  await evaluate(cdp,`document.querySelector('#bgmEnabled').click()`);
  await waitFor(cdp,`window.__bgmPlayEvents.length>0`,'bgm play call');
  assert(await evaluate(cdp,`window.__bgmPlayEvents.includes('change')`),'BGM play did not start inside enabling change gesture');

  await fresh(cdp,'cpu-gote');
  await openGameSettings(cdp,'cpu');
  await evaluate(cdp,`(()=>{document.querySelector('#order').value='gote';document.querySelector('#go').click();})()`);
  await waitFor(cdp,`document.querySelector('.game.cpu-view-gote')`,'cpu gote orientation',15000);
  assert(await evaluate(cdp,`document.querySelector('.board').nextElementSibling?.id==='goteHand'`),'gote hand is not on player side');
  assert(await evaluate(cdp,`getComputedStyle(document.querySelector('.board')).transform!=='none'`),'gote board was not rotated');

  await fresh(cdp,'local-layout');
  await openGameSettings(cdp,'local');
  await evaluate(cdp,`(()=>{document.querySelector('#order').value='sente';document.querySelector('#go').click();})()`);
  await waitFor(cdp,`document.querySelector('.game.local-mode')&&document.querySelector('#resign')?.parentElement?.id==='senteHand'`,'local sente controls');
  await waitFor(cdp,`document.querySelector('#moveHistory')&&document.querySelector('#opponentAction')`,'history controls');
  assert(await evaluate(cdp,`getComputedStyle(document.querySelector('#goteHand')).transform!=='none'`),'gote hand labels are not opponent-facing');
  assert(await evaluate(cdp,`getComputedStyle(document.querySelector('.elapsed-label')).position==='absolute'`),'local elapsed time was not moved to side');
  await evaluate(cdp,`document.querySelectorAll('.board .cell')[54].click()`);
  await waitFor(cdp,`document.querySelectorAll('.board .cell')[45].classList.contains('legal')`,'local pawn target');
  await evaluate(cdp,`document.querySelectorAll('.board .cell')[45].click()`);
  await waitFor(cdp,`document.querySelector('#resign')?.parentElement?.id==='goteHand'`,'local gote controls');
  await evaluate(cdp,`document.querySelector('#opponentAction').click()`);
  await waitFor(cdp,`document.querySelector('[data-opponent-action-overlay]')?.textContent.includes('9七')&&document.querySelector('[data-opponent-action-overlay]')?.textContent.includes('9六')`,'opponent action route');
  assert(await evaluate(cdp,`document.querySelector('[data-opponent-action-overlay]').textContent.includes('歩')`),'opponent action piece missing');
  await evaluate(cdp,`document.querySelector('.opponent-action-close').click()`);
  await evaluate(cdp,`document.querySelector('#moveHistory').click()`);
  await waitFor(cdp,`document.querySelector('.move-history-entry')?.textContent.includes('9七')&&document.querySelector('.move-history-entry')?.textContent.includes('9六')`,'move history row');
  await evaluate(cdp,`document.querySelector('.move-history-close').click()`);

  await fresh(cdp,'promotion');
  await evaluate(cdp,`(()=>{const cells=Array.from({length:81},(_,i)=>'<button class="cell'+(i===63?' selected':'')+(i===23?' legal':'')+'">'+(i===63?'角':'')+'</button>').join('');document.querySelector('#app').innerHTML='<main class="game"><div class="cpu-level">CPU: 初心者 / あなた: 先手</div><div class="board">'+cells+'</div></main>';document.querySelectorAll('.board .cell')[23].click();})()`);
  await waitFor(cdp,`document.querySelector('.promotion-choice-dialog')`,'custom promotion dialog');
  assert(await evaluate(cdp,`!document.querySelector('.promotion-choice-dialog').classList.contains('opponent-view')`),'CPU promotion dialog was incorrectly rotated');
  await evaluate(cdp,`[...document.querySelectorAll('.promotion-choice-dialog button')].find(b=>b.textContent==='成らない').click()`);

  await fresh(cdp,'online-cancel');
  await evaluate(cdp,`document.querySelector('#app').innerHTML='<main class="game"><header><div class="match-header"><strong>対戦相手を待っています</strong></div></header><aside class="online-info"></aside></main>'`);
  await waitFor(cdp,`document.querySelector('#cancelOnlineWaiting')`,'online waiting cancel');
  await evaluate(cdp,`document.querySelector('#cancelOnlineWaiting').click()`);
  await waitFor(cdp,`document.querySelector('.menu')`,'online cancel returned menu');

  const baseline=Array(81).fill(null);baseline[76]={side:'sente',label:'玉'};baseline[4]={side:'gote',label:'玉'};baseline[63]={side:'sente',label:'飛'};
  const checking=[...baseline];checking[63]=null;checking[13]={side:'sente',label:'飛'};
  const baselineBoard=fakeBoardExpression(baseline);
  const checkingBoard=fakeBoardExpression(checking);
  await evaluate(cdp,`document.querySelector('#app').innerHTML='<main class="game local-order"><header><div class="match-header"><strong>先手番</strong></div></header>'+${baselineBoard}+'<div class="note local-order">プレイヤー1: 先手</div></main>'`);
  await delay(80);
  await evaluate(cdp,`document.querySelector('#app').innerHTML='<main class="game"><header><div class="match-header"><strong>後手番・王手</strong></div></header>'+${checkingBoard}+'<div class="note local-order">プレイヤー1: 先手</div></main>'`);
  await waitFor(cdp,`document.querySelector('.check-effect strong')?.textContent==='王手'`,'check effect');

  console.log(JSON.stringify({ok:true,bgmGesture:true,cpuGote:true,localLayout:true,moveHistory:true,opponentAction:true,promotion:true,onlineCancel:true,checkEffect:true}));
}finally{
  cdp?.close();
  await stopChild(chrome);
  await stopChild(preview);
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
