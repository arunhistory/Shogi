import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const host='127.0.0.1',previewPort=4173,debuggingPort=9229,appUrl=`http://${host}:${previewPort}/`,delay=ms=>new Promise(r=>setTimeout(r,ms));
function assert(v,m){if(!v)throw new Error(m);}
function findChrome(){for(const name of ['google-chrome','google-chrome-stable','chromium','chromium-browser']){const f=spawnSync('which',[name],{encoding:'utf8'});if(f.status===0&&f.stdout.trim())return f.stdout.trim();}throw new Error('CHROME_NOT_FOUND');}
async function waitHttp(url,t=20000){const end=Date.now()+t;while(Date.now()<end){try{const r=await fetch(url,{cache:'no-store'});if(r.ok)return r;}catch{}await delay(100);}throw new Error(`HTTP_TIMEOUT:${url}`);}
async function stop(c){if(!c||c.exitCode!==null)return;const e=new Promise(r=>c.once('exit',r));c.kill('SIGTERM');await Promise.race([e,delay(2000)]);if(c.exitCode===null)c.kill('SIGKILL');}
class Cdp{constructor(s){this.socket=s;this.next=1;this.pending=new Map();s.addEventListener('message',e=>{let m;try{m=JSON.parse(e.data);}catch{return;}if(!m.id)return;const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result??{});});}static async connect(url){const s=new WebSocket(url);await new Promise((r,j)=>{s.addEventListener('open',r,{once:true});s.addEventListener('error',()=>j(new Error('CDP_CONNECT_ERROR')),{once:true});});return new Cdp(s);}send(method,params={}){const id=this.next++;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.socket.send(JSON.stringify({id,method,params}));});}close(){this.socket.close();}}
async function evaluate(c,e){const r=await c.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result?.value;}
async function waitFor(c,e,label,t=30000){const end=Date.now()+t;while(Date.now()<end){try{if(await evaluate(c,`Boolean(${e})`))return;}catch{}await delay(100);}throw new Error(`WAIT_TIMEOUT:${label}`);}

const profile=await mkdtemp(join(tmpdir(),'opponent-action-'));let preview,chrome,cdp;
try{
  preview=spawn('npm',['run','preview','--','--host',host,'--port',String(previewPort),'--strictPort'],{stdio:['ignore','pipe','pipe'],env:{...process.env}});await waitHttp(appUrl);
  chrome=spawn(findChrome(),['--headless=new','--disable-gpu','--disable-dev-shm-usage','--no-sandbox','--disable-background-networking','--no-first-run','--no-default-browser-check',`--remote-debugging-address=${host}`,`--remote-debugging-port=${debuggingPort}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','pipe','pipe']});
  await waitHttp(`http://${host}:${debuggingPort}/json/version`);const targets=await (await waitHttp(`http://${host}:${debuggingPort}/json/list`)).json();const page=targets.find(t=>t.type==='page'&&t.webSocketDebuggerUrl);assert(page,'CDP_PAGE_TARGET_NOT_FOUND');cdp=await Cdp.connect(page.webSocketDebuggerUrl);await cdp.send('Page.enable');await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate',{url:`${appUrl}?opponentAction=${Date.now()}`});
  await waitFor(cdp,`document.querySelector('#start')`,'menu');await evaluate(cdp,`document.querySelector('#start').click()`);await waitFor(cdp,`document.querySelector('[data-mode="cpu"]')`,'cpu-mode');await evaluate(cdp,`document.querySelector('[data-mode="cpu"]').click()`);await waitFor(cdp,`document.querySelector('#go')&&document.querySelector('#cpuLevel')`,'settings');
  await evaluate(cdp,`(()=>{document.querySelector('#cpuLevel').value='beginner';document.querySelector('#order').value='sente';document.querySelector('#senteHandicap').value='even';document.querySelector('#goteHandicap').value='even';document.querySelector('#go').click();})()`);
  await waitFor(cdp,`document.querySelectorAll('.board .cell').length===81`,'board');
  await evaluate(cdp,`document.querySelectorAll('.board .cell')[54].click()`);await waitFor(cdp,`document.querySelectorAll('.board .cell')[45].classList.contains('legal')`,'pawn-target');await evaluate(cdp,`document.querySelectorAll('.board .cell')[45].click()`);
  await waitFor(cdp,`document.querySelector('#opponentAction')&&document.querySelector('.match-header>strong')?.textContent.includes('先手番')`,'cpu-reply',30000);
  assert(await evaluate(cdp,`document.querySelectorAll('.opponent-move-from').length===0&&document.querySelectorAll('.opponent-move-to').length===0`),'HIGHLIGHT_VISIBLE_BEFORE_BUTTON');
  await evaluate(cdp,`document.querySelector('#opponentAction').click()`);
  await waitFor(cdp,`document.querySelectorAll('.opponent-move-from').length===1&&document.querySelectorAll('.opponent-move-to').length===1`,'visual-highlight');
  const result=await evaluate(cdp,`(()=>{const cells=[...document.querySelectorAll('.board .cell')];return{from:cells.findIndex(x=>x.classList.contains('opponent-move-from')),to:cells.findIndex(x=>x.classList.contains('opponent-move-to')),pressed:document.querySelector('#opponentAction')?.getAttribute('aria-pressed'),label:document.querySelector('#opponentAction')?.textContent};})()`);
  assert(result.from>=0&&result.to>=0&&result.from!==result.to,'MOVE_VISUAL_INVALID');assert(result.pressed==='true','BUTTON_STATE_INVALID');assert(result.label==='相手行動','BUTTON_LABEL_INVALID');
  await evaluate(cdp,`document.querySelector('#opponentAction').click()`);await waitFor(cdp,`document.querySelectorAll('.opponent-move-from').length===0&&document.querySelectorAll('.opponent-move-to').length===0`,'visual-hide');
  console.log(JSON.stringify({ok:true,button:'相手行動',fromCell:result.from,toCell:result.to,visualOnly:true}));
}finally{cdp?.close();await stop(chrome);await stop(preview);await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
