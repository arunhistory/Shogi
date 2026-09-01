import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const host='127.0.0.1';
const devPort=4194;
const debuggingPort=9244;
const appUrl=`http://${host}:${devPort}/`;
const stateB64=process.env.STATE_B64??'';
const outputPath=process.env.PRO_STEP_OUTPUT??'/tmp/pro-step-result.json';
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
    this.socket=socket;this.nextId=1;this.pending=new Map();
    socket.addEventListener('message',event=>{
      let m;try{m=JSON.parse(typeof event.data==='string'?event.data:String(event.data));}catch{return;}
      if(!m.id)return;const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.reject(new Error(`${m.error.code}:${m.error.message}`)):p.resolve(m.result??{});
    });
    socket.addEventListener('close',()=>{for(const p of this.pending.values())p.reject(new Error('CDP_CLOSED'));this.pending.clear();});
  }
  static async connect(url){
    const socket=new WebSocket(url);
    await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('CDP_CONNECT_TIMEOUT')),10000);socket.addEventListener('open',()=>{clearTimeout(t);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(t);reject(new Error('CDP_CONNECT_ERROR'));},{once:true});});
    return new CdpClient(socket);
  }
  send(method,params={}){const id=this.nextId++;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.socket.send(JSON.stringify({id,method,params}));});}
  close(){this.socket.close();}
}
async function evaluate(cdp,expression){
  const r=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});
  if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text??'BROWSER_EVALUATION_FAILED');
  return r.result?.value;
}

let decodedState=null;
if(stateB64){
  const text=Buffer.from(stateB64,'base64').toString('utf8');
  decodedState=JSON.parse(text);
  assert(decodedState&&decodedState.version===1&&decodedState.position,'STATE_INVALID');
}
const stateJson=JSON.stringify(decodedState);
const chromePath=findChrome();
const profile=await mkdtemp(join(tmpdir(),'shogi-title-pro-step-'));
const tempViteConfig=join(process.cwd(),'.tmp-title-pro-step-vite.config.mjs');
let dev=null,chrome=null,cdp=null;
try{
  await writeFile(tempViteConfig,`import {defineConfig} from 'vite';\nexport default defineConfig({base:'./',build:{target:'es2022',sourcemap:false}});\n`);
  dev=spawn(process.platform==='win32'?'npm.cmd':'npm',['run','dev','--','--config',tempViteConfig,'--host',host,'--port',String(devPort),'--strictPort'],{stdio:['ignore','ignore','inherit'],env:{...process.env}});
  await waitForHttp(appUrl);
  chrome=spawn(chromePath,['--headless=new','--disable-dev-shm-usage','--disable-background-networking','--no-first-run','--no-default-browser-check','--no-sandbox','--disable-gpu',`--remote-debugging-address=${host}`,`--remote-debugging-port=${debuggingPort}`,`--user-data-dir=${profile}`,appUrl],{stdio:['ignore','ignore','inherit']});
  await waitForHttp(`http://${host}:${debuggingPort}/json/version`);
  const targets=await(await waitForHttp(`http://${host}:${debuggingPort}/json/list`)).json();
  const page=targets.find(target=>target.type==='page'&&target.webSocketDebuggerUrl);assert(page,'CDP_PAGE_TARGET_NOT_FOUND');
  cdp=await CdpClient.connect(page.webSocketDebuggerUrl);await cdp.send('Page.enable');await cdp.send('Runtime.enable');

  const result=await evaluate(cdp,`(async()=>{
    const engine=await import('/src/game/engine.ts');
    const regularWasmUrl=new URL('/wasm/shogi_engine.wasm',location.origin).toString();
    const incoming=${stateJson};
    const POSITION_MAGIC=0x53484749,POSITION_WORDS=97;
    const pieceCodes={pawn:1,lance:2,knight:3,silver:4,gold:5,bishop:6,rook:7,king:8,tokin:9,promotedLance:10,promotedKnight:11,promotedSilver:12,horse:13,dragon:14};
    const handKinds=['pawn','lance','knight','silver','gold','bishop','rook'];
    const encodePosition=position=>{const words=new Array(POSITION_WORDS).fill(0);words[0]=POSITION_MAGIC;words[1]=position.turn==='sente'?1:-1;let index=2;for(const row of position.board)for(const piece of row)words[index++]=piece?(piece.side==='sente'?1:-1)*pieceCodes[piece.kind]:0;for(const side of ['sente','gote'])for(const kind of handKinds)words[index++]=position.hands[side][kind];if(index!==POSITION_WORDS)throw new Error('POSITION_ENCODING_SIZE:'+index);return words;};
    const request=(worker,payload,timeoutMs)=>new Promise((resolve,reject)=>{const requestId=crypto.randomUUID();const timer=setTimeout(()=>{cleanup();reject(new Error('WORKER_TIMEOUT:'+payload.type));},timeoutMs);const cleanup=()=>{clearTimeout(timer);worker.removeEventListener('message',onMessage);worker.removeEventListener('error',onError);};const onError=()=>{cleanup();reject(new Error('WORKER_ERROR:'+payload.type));};const onMessage=event=>{const data=event.data;if(data?.requestId!==requestId)return;cleanup();data.ok?resolve(data):reject(new Error(data?.error??'WORKER_FAILED'));};worker.addEventListener('message',onMessage);worker.addEventListener('error',onError);worker.postMessage({...payload,requestId});});
    let state=incoming??{version:1,position:engine.initialPosition(),titleSide:'gote',proSide:'sente',round:0,proMoves:0,titleMoves:0,proTotalMs:0,proMaxMs:0,proNodes:0,titleTotalMs:0,titleMaxMs:0,titleSpecialistNodes:0,titleConvergenceNodes:0,titleMateShortCircuits:0,firstTitleMoveCode:null,lastTitleMoveCode:null};
    let position=state.position;
    const beforeOutcome=engine.gameOutcome(position);
    if(beforeOutcome.ended)return{state,positionWords:encodePosition(position),gameEnded:true,outcome:beforeOutcome,pro:null};
    if(position.turn!==state.proSide)throw new Error('PRO_STEP_WRONG_TURN:'+position.turn);
    const worker=new Worker('/src/game/cpu-worker.ts',{type:'module'});
    try{
      worker.postMessage({type:'warmup',position,level:'pro',wasmUrl:regularWasmUrl});
      await new Promise(resolve=>setTimeout(resolve,300));
      const started=performance.now();
      const response=await request(worker,{type:'search',position,level:'pro',wasmUrl:regularWasmUrl},10000);
      const elapsedMs=performance.now()-started;
      const move=response.result?.move;if(!move)throw new Error('PRO_NO_MOVE');
      position=engine.applyMove(position,move);
      const nodes=Number(response.result?.nodesVisited??0),depth=Number(response.result?.completedDepth??0);
      state={...state,position,proMoves:Number(state.proMoves??0)+1,proTotalMs:Number(state.proTotalMs??0)+elapsedMs,proMaxMs:Math.max(Number(state.proMaxMs??0),elapsedMs),proNodes:Number(state.proNodes??0)+nodes};
      const outcome=engine.gameOutcome(position);
      return{state,positionWords:encodePosition(position),gameEnded:outcome.ended,outcome,pro:{move,elapsedMs,nodes,depth,logicalJobsCompleted:Number(response.result?.logicalJobsCompleted??0),physicalWorkers:Number(response.result?.physicalWorkers??0)}};
    }finally{worker.terminate();}
  })()`);
  const encoded=Buffer.from(JSON.stringify(result.state),'utf8').toString('base64');
  const payload={...result,stateB64:encoded};delete payload.state;
  await writeFile(outputPath,JSON.stringify(payload));
  console.log('PRO_STEP_RESULT:'+JSON.stringify(payload));
}finally{
  cdp?.close();await stopChild(chrome);await stopChild(dev);await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});await rm(tempViteConfig,{force:true});
}
