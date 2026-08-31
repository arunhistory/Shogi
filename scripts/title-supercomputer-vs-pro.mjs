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
  constructor(socket){this.socket=socket;this.nextId=1;this.pending=new Map();socket.addEventListener('message',event=>{let m;try{m=JSON.parse(typeof event.data==='string'?event.data:String(event.data));}catch{return;}if(!m.id)return;const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.reject(new Error(`${m.error.code}:${m.error.message}`)):p.resolve(m.result??{});});socket.addEventListener('close',()=>{for(const p of this.pending.values())p.reject(new Error('CDP_CLOSED'));this.pending.clear();});}
  static async connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('CDP_CONNECT_TIMEOUT')),10000);socket.addEventListener('open',()=>{clearTimeout(t);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(t);reject(new Error('CDP_CONNECT_ERROR'));},{once:true});});return new CdpClient(socket);}
  send(method,params={}){const id=this.nextId++;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.socket.send(JSON.stringify({id,method,params}));});}
  close(){this.socket.close();}
}
async function evaluate(cdp,expression){const r=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text??'BROWSER_EVALUATION_FAILED');return r.result?.value;}

const chromePath=findChrome();
const profile=await mkdtemp(join(tmpdir(),'shogi-title-super-match-'));
let dev=null,chrome=null,cdp=null;
try{
  dev=spawn(process.platform==='win32'?'npm.cmd':'npm',['run','dev','--','--host',host,'--port',String(devPort),'--strictPort'],{stdio:['ignore','ignore','inherit'],env:{...process.env}});
  await waitForHttp(appUrl);
  chrome=spawn(chromePath,['--headless=new','--disable-dev-shm-usage','--disable-background-networking','--no-first-run','--no-default-browser-check','--no-sandbox','--disable-gpu',`--remote-debugging-address=${host}`,`--remote-debugging-port=${debuggingPort}`,`--user-data-dir=${profile}`,appUrl],{stdio:['ignore','ignore','inherit']});
  await waitForHttp(`http://${host}:${debuggingPort}/json/version`);
  const targets=await (await waitForHttp(`http://${host}:${debuggingPort}/json/list`)).json();
  const page=targets.find(target=>target.type==='page'&&target.webSocketDebuggerUrl);assert(page,'CDP_PAGE_TARGET_NOT_FOUND');
  cdp=await CdpClient.connect(page.webSocketDebuggerUrl);await cdp.send('Page.enable');await cdp.send('Runtime.enable');

  const result=await evaluate(cdp,`(async()=>{
    const engine=await import('/src/game/engine.ts');
    const regularWasmUrl=new URL('/wasm/shogi_engine.wasm',location.origin).toString();
    const superWasmUrl=new URL('/wasm/title_supercomputer.wasm',location.origin).toString();
    const proWorker=new Worker('/src/game/cpu-worker.ts',{type:'module'});
    const specialists=Array.from({length:20},()=>new Worker('/src/game/title-super-worker.ts',{type:'module'}));
    const convergenceWorker=new Worker('/src/game/title-super-worker.ts',{type:'module'});
    const titleSide='gote',proSide='sente',maxPlies=82;
    const moveKey=m=>String(m?.from??'drop')+'>'+String(m?.to)+'|'+String(m?.drop??'')+'|'+(m?.promote?1:0);
    const decodeMove=code=>{if(!Number.isInteger(code)||code<0)return null;const to=code&0x7f,from=(code>>7)&0x7f,drop=(code>>14)&0xf,promote=((code>>18)&1)===1;if(to<0||to>=81)return null;const dst=[Math.floor(to/9),to%9];if(drop){const kinds={1:'pawn',2:'lance',3:'knight',4:'silver',5:'gold',6:'bishop',7:'rook'};if(!kinds[drop]||from!==127||promote)return null;return{drop:kinds[drop],to:dst};}if(from<0||from>=81)return null;return{from:[Math.floor(from/9),from%9],to:dst,...(promote?{promote:true}:{})};};
    const request=(worker,payload,timeoutMs)=>new Promise((resolve,reject)=>{const requestId=crypto.randomUUID();const timer=setTimeout(()=>{cleanup();reject(new Error('WORKER_TIMEOUT:'+payload.type));},timeoutMs);const cleanup=()=>{clearTimeout(timer);worker.removeEventListener('message',onMessage);worker.removeEventListener('error',onError);};const onError=()=>{cleanup();reject(new Error('WORKER_ERROR:'+payload.type));};const onMessage=event=>{const data=event.data;if(data?.requestId!==requestId)return;cleanup();data.ok?resolve(data):reject(new Error(data?.error??'WORKER_FAILED'));};worker.addEventListener('message',onMessage);worker.addEventListener('error',onError);worker.postMessage({...payload,requestId});});
    const warm=worker=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(new Error('SUPER_WARMUP_TIMEOUT'));},10000);const cleanup=()=>{clearTimeout(timer);worker.removeEventListener('message',onMessage);worker.removeEventListener('error',onError);};const onError=()=>{cleanup();reject(new Error('SUPER_WARMUP_ERROR'));};const onMessage=event=>{if(event.data?.type!=='ready')return;cleanup();resolve();};worker.addEventListener('message',onMessage);worker.addEventListener('error',onError);worker.postMessage({type:'warmup',wasmUrl:superWasmUrl});});
    await Promise.all([...specialists,convergenceWorker].map(warm));
    let position=engine.initialPosition();
    proWorker.postMessage({type:'warmup',position,level:'pro',wasmUrl:regularWasmUrl});
    await new Promise(resolve=>setTimeout(resolve,400));
    const trace=[];let outcome=engine.gameOutcome(position);
    let titleTotalNodes=0,titleSpecialistNodes=0,titleConvergenceNodes=0,proNodes=0;
    let titleMaxMs=0,proMaxMs=0;const titleTimes=[],proTimes=[];
    const searchPro=async pos=>{const started=performance.now();const r=await request(proWorker,{type:'search',position:pos,level:'pro',wasmUrl:regularWasmUrl},10000);return{move:r.result.move,nodes:Number(r.result.nodesVisited??0),elapsedMs:performance.now()-started,depth:Number(r.result.completedDepth??0)};};
    const searchTitle=async pos=>{
      const started=performance.now();
      const specialistStarted=performance.now();
      const rows=await Promise.all(specialists.map((worker,index)=>request(worker,{type:'specialist',position:pos,specialist:index+1,wasmUrl:superWasmUrl},180000)));
      const specialistWallMs=performance.now()-specialistStarted;
      const candidates=rows.map(r=>r.moveCode);
      const convergenceStarted=performance.now();
      const final=await request(convergenceWorker,{type:'converge',position:pos,candidates,wasmUrl:superWasmUrl},180000);
      const convergenceWallMs=performance.now()-convergenceStarted;
      const move=decodeMove(final.moveCode);if(!move)throw new Error('SUPER_MOVE_DECODE_FAILED');
      const legal=engine.legalMoves(pos);if(!legal.some(candidate=>moveKey(candidate)===moveKey(move)))throw new Error('SUPER_ILLEGAL_MOVE:'+JSON.stringify(move));
      const specialistNodes=rows.reduce((sum,r)=>sum+Number(r.nodes??0),0),convergenceNodes=Number(final.nodes??0);
      return{move,elapsedMs:performance.now()-started,specialistWallMs,convergenceWallMs,specialistNodes,convergenceNodes,totalNodes:specialistNodes+convergenceNodes,specialistMaxInternalMs:Math.max(...rows.map(r=>Number(r.elapsedMs??0))),specialistMoves:candidates,score:Number(final.score??0)};
    };
    try{
      while(!outcome.ended&&position.ply<maxPlies){
        if(position.turn===proSide){
          const r=await searchPro(position);proNodes+=r.nodes;proTimes.push(r.elapsedMs);proMaxMs=Math.max(proMaxMs,r.elapsedMs);trace.push({ply:position.ply+1,side:position.turn,level:'pro',move:r.move,elapsedMs:r.elapsedMs,nodes:r.nodes,depth:r.depth});position=engine.applyMove(position,r.move);
        }else{
          const r=await searchTitle(position);titleSpecialistNodes+=r.specialistNodes;titleConvergenceNodes+=r.convergenceNodes;titleTotalNodes+=r.totalNodes;titleTimes.push(r.elapsedMs);titleMaxMs=Math.max(titleMaxMs,r.elapsedMs);trace.push({ply:position.ply+1,side:position.turn,level:'title-supercomputer',move:r.move,elapsedMs:r.elapsedMs,specialistWallMs:r.specialistWallMs,convergenceWallMs:r.convergenceWallMs,specialistNodes:r.specialistNodes,convergenceNodes:r.convergenceNodes,totalNodes:r.totalNodes,specialistMaxInternalMs:r.specialistMaxInternalMs,score:r.score});position=engine.applyMove(position,r.move);
        }
        outcome=engine.gameOutcome(position);
      }
      const gameResult=outcome.ended?(outcome.winner===titleSide?'title-win':outcome.winner===proSide?'pro-win':'draw'):'over-82';
      const avg=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
      return{result:gameResult,plies:position.ply,winner:outcome.winner??null,reason:outcome.reason??(outcome.ended?'ended':'move-limit'),titleSide,proSide,titleMoves:titleTimes.length,titleAvgMs:avg(titleTimes),titleMaxMs,titleUnder3s:titleTimes.every(v=>v<=3000),titleSpecialistNodes,titleConvergenceNodes,titleTotalNodes,proAvgMs:avg(proTimes),proMaxMs,proNodes,trace};
    }finally{proWorker.terminate();for(const w of specialists)w.terminate();convergenceWorker.terminate();}
  })()`);
  console.log('SUPER_MATCH_RESULT:'+JSON.stringify(result));
}finally{cdp?.close();await stopChild(chrome);await stopChild(dev);await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
