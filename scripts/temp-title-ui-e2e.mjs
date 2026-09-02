import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const host='127.0.0.1';
const debuggingPort=9229;
const appUrl='https://arunhistory.github.io/Shogi/';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function assert(value,message){if(!value)throw new Error(message);}
function findChrome(){for(const name of ['google-chrome','google-chrome-stable','chromium','chromium-browser']){const found=spawnSync('which',[name],{encoding:'utf8'});if(found.status===0&&found.stdout.trim())return found.stdout.trim();}throw new Error('CHROME_NOT_FOUND');}
async function waitHttp(url,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){try{const response=await fetch(url,{cache:'no-store'});if(response.ok)return response;}catch{}await delay(100);}throw new Error(`HTTP_TIMEOUT:${url}`);}
async function stop(child){if(!child||child.exitCode!==null)return;const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await Promise.race([exited,delay(2000)]);if(child.exitCode===null)child.kill('SIGKILL');}
class Cdp{constructor(socket){this.socket=socket;this.next=1;this.pending=new Map();socket.addEventListener('message',event=>{let message;try{message=JSON.parse(event.data);}catch{return;}if(!message.id)return;const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);message.error?pending.reject(new Error(message.error.message)):pending.resolve(message.result??{});});}static async connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',()=>reject(new Error('CDP_CONNECT_ERROR')),{once:true});});return new Cdp(socket);}send(method,params={}){const id=this.next++;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.socket.send(JSON.stringify({id,method,params}));});}close(){this.socket.close();}}
async function evaluate(cdp,expression){const result=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result?.value;}
async function waitFor(cdp,expression,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await evaluate(cdp,`Boolean(${expression})`))return;}catch{}await delay(100);}throw new Error(`WAIT_TIMEOUT:${label}`);}

await waitHttp(appUrl);
const profile=await mkdtemp(join(tmpdir(),'title-ui-e2e-'));
let chrome,cdp;
try{
  chrome=spawn(findChrome(),['--headless=new','--disable-gpu','--disable-dev-shm-usage','--no-sandbox','--disable-background-networking','--no-first-run','--no-default-browser-check',`--remote-debugging-address=${host}`,`--remote-debugging-port=${debuggingPort}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','pipe','pipe']});
  await waitHttp(`http://${host}:${debuggingPort}/json/version`);
  const targets=await (await waitHttp(`http://${host}:${debuggingPort}/json/list`)).json();
  const page=targets.find(target=>target.type==='page'&&target.webSocketDebuggerUrl);
  assert(page,'CDP_PAGE_TARGET_NOT_FOUND');
  cdp=await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const nativeFetch=window.fetch.bind(window);window.__titleResponses=[];window.fetch=async(...args)=>{const response=await nativeFetch(...args);try{const url=typeof args[0]==='string'?args[0]:args[0]?.url||'';if(String(url).includes('/functions/v1/title-supercomputer')){const copy=response.clone();const json=await copy.json();window.__titleResponses.push(json);}}catch{}return response;};})();`});
  await cdp.send('Page.navigate',{url:`${appUrl}?titleE2E=${Date.now()}`});
  await waitFor(cdp,`document.querySelector('#start')`,'menu',30000);
  await evaluate(cdp,`document.querySelector('#start').click()`);
  await waitFor(cdp,`document.querySelector('[data-mode="cpu"]')`,'cpu-mode');
  await evaluate(cdp,`document.querySelector('[data-mode="cpu"]').click()`);
  await waitFor(cdp,`document.querySelector('#go')&&document.querySelector('#cpuLevel')`,'settings');
  await evaluate(cdp,`(()=>{document.querySelector('#cpuLevel').value='title';document.querySelector('#order').value='sente';document.querySelector('#senteHandicap').value='even';document.querySelector('#goteHandicap').value='even';document.querySelector('#go').click();})()`);
  await waitFor(cdp,`document.querySelectorAll('.board .cell').length===81`,'title-board',30000);
  await waitFor(cdp,`document.querySelector('.match-header>strong')?.textContent.includes('先手番')`,'title-human-turn',30000);
  const startResponse=await evaluate(cdp,`window.__titleResponses.find(x=>x?.position?.ply===0&&x?.phase==='human_turn')||null`);
  assert(startResponse?.ok===true,'TITLE_START_RESPONSE_MISSING');
  await evaluate(cdp,`document.querySelectorAll('.board .cell')[54].click()`);
  await waitFor(cdp,`document.querySelectorAll('.board .cell')[45].classList.contains('legal')`,'pawn-target');
  await evaluate(cdp,`document.querySelectorAll('.board .cell')[45].click()`);
  await waitFor(cdp,`document.querySelector('.match-header>strong')?.textContent.includes('CPU')`,'cpu-thinking',30000);
  await waitFor(cdp,`window.__titleResponses.some(x=>x?.ok===true&&x?.phase==='human_turn'&&x?.position?.ply===2)`,'authoritative-ply2',15*60*1000);
  await waitFor(cdp,`document.querySelector('.match-header>strong')?.textContent.includes('先手番')`,'ui-returned-human-turn',30000);
  const finalResponse=await evaluate(cdp,`[...window.__titleResponses].reverse().find(x=>x?.ok===true&&x?.phase==='human_turn'&&x?.position?.ply===2)||null`);
  assert(finalResponse?.position?.turn==='sente','TITLE_FINAL_TURN_MISMATCH');
  assert(Number.isInteger(finalResponse?.title?.moveCode),'TITLE_MOVE_CODE_MISSING');
  assert(await evaluate(cdp,`document.querySelectorAll('.board .cell')[45].textContent==='歩'`),'HUMAN_MOVE_NOT_RENDERED');
  console.log(JSON.stringify({ok:true,phase:finalResponse.phase,ply:finalResponse.position.ply,turn:finalResponse.position.turn,moveCode:finalResponse.title.moveCode,titleMove:finalResponse.title.move}));
}finally{
  cdp?.close();
  await stop(chrome);
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
