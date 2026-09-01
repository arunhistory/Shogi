import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {performance} from 'node:perf_hooks';

const host=process.env.PRACTICAL_PROXY_HOST??'127.0.0.1';
const port=Number(process.env.PRACTICAL_PROXY_PORT??9000);
const localKey=process.env.TITLE_KEY??'bench';
const remoteUrl=process.env.REMOTE_TITLE_URL??'https://mpuhgfbdkxmhynytwhzu.supabase.co/functions/v1/title-supercomputer';
const remoteKey=process.env.REMOTE_TITLE_KEY??'';
const jsPath=process.env.TITLE_PRACTICAL_JS??'/tmp/title-practical.js';
const wasmPath=process.env.TITLE_PRACTICAL_WASM??'/tmp/title-practical.wasm';
const POSITION_WORDS=97;
const BUDGET=5_000_000;
const labels=['','self_king_survival','enemy_king_mate','own_attack','enemy_attack_forecast','defense','attack_disruption','last_move_response','own_drop','enemy_drop','hand_cycle','exchange','attack_map_change','piece_reposition','promotion','initiative_forcing','escape_blockade','collapse_detection','worst_response','long_term','anomaly'];

if(!remoteKey)throw new Error('REMOTE_TITLE_KEY_REQUIRED');
const require=createRequire(import.meta.url);
const createTitle=require(jsPath);
const wasmBinary=await readFile(wasmPath);
const runtimeDir=dirname(jsPath);
const mod=await createTitle({wasmBinary,locateFile:path=>join(runtimeDir,path),mainScriptUrlOrBlob:jsPath});
const ptr=mod._shogi_input_buffer();
const capacity=Number(mod._shogi_input_capacity());
if(capacity<117)throw new Error('PRACTICAL_WASM_INPUT_CAPACITY:'+capacity);

function normalizePosition(raw){
  if(!Array.isArray(raw)||raw.length!==POSITION_WORDS)throw new Error('POSITION_WORDS_MUST_BE_97');
  return raw.map(value=>{const n=Number(value);if(!Number.isInteger(n)||n<-2147483648||n>2147483647)throw new Error('POSITION_WORD_INVALID');return n|0;});
}
function normalizeCandidates(raw){
  if(!Array.isArray(raw)||raw.length<1||raw.length>20)throw new Error('CANDIDATES_MUST_BE_1_TO_20');
  return raw.map(value=>{const n=Number(value);if(!Number.isInteger(n))throw new Error('CANDIDATE_INVALID');return n|0;});
}
function writeInput(position,candidates=[]){
  const words=[...position,...candidates];
  mod.HEAP32.fill(0,ptr>>2,(ptr>>2)+words.length);
  mod.HEAP32.set(Int32Array.from(words),ptr>>2);
}
function runLocal12(rawPosition){
  const position=normalizePosition(rawPosition);writeInput(position);
  const started=performance.now();
  const moveCode=Number(mod._shogi_super_search_specialist(POSITION_WORDS,12,12,BUDGET));
  if(moveCode<0)throw new Error('NO_LEGAL_MOVE');
  return{id:12,label:labels[12],moveCode,score:Number(mod._shogi_super_best_score()),nodes:Number(mod._shogi_super_nodes_searched()),elapsedMs:performance.now()-started,execution:'local-dual12'};
}
function runLocalConvergence(rawPosition,rawCandidates){
  const position=normalizePosition(rawPosition),candidates=normalizeCandidates(rawCandidates);writeInput(position,candidates);
  const started=performance.now();
  const moveCode=Number(mod._shogi_super_converge(POSITION_WORDS,candidates.length,14,BUDGET));
  if(moveCode<0)throw new Error('NO_LEGAL_MOVE');
  return{phase:'future_convergence',moveCode,score:Number(mod._shogi_super_best_score()),nodes:Number(mod._shogi_super_nodes_searched()),elapsedMs:performance.now()-started,inputSpecialists:candidates.length,execution:'local-multicore-convergence'};
}
async function remoteSpecialist(id,positionWords){
  const response=await fetch(remoteUrl,{method:'POST',headers:{'content-type':'application/json','apikey':remoteKey},body:JSON.stringify({action:'specialist',specialist:id,positionWords})});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{throw new Error(`REMOTE_NON_JSON_${response.status}`);}
  if(!response.ok||!data?.ok)throw new Error(`REMOTE_SPECIALIST_${id}_${response.status}:${String(data?.error??'UNKNOWN')}`);
  return{...data.result,execution:'remote-current-supabase'};
}
async function runTurn(positionWords){
  const started=performance.now();
  const specialistStarted=performance.now();
  const promises=new Array(20);
  for(let id=1;id<=20;id++){
    if(id===12)continue;
    promises[id-1]=remoteSpecialist(id,positionWords);
  }
  promises[11]=new Promise((resolve,reject)=>setImmediate(()=>{try{resolve(runLocal12(positionWords));}catch(error){reject(error);}}));
  const specialists=await Promise.all(promises);
  const specialistPhaseMs=performance.now()-specialistStarted;
  const candidates=specialists.map(x=>Number(x.moveCode)|0);
  const convergeStarted=performance.now();
  const convergence=runLocalConvergence(positionWords,candidates);
  const convergePhaseMs=performance.now()-convergeStarted;
  return{phase:'practical_hybrid_20_future_prediction',specialists,candidates,convergence,specialistPhaseMs,convergePhaseMs,totalMs:performance.now()-started};
}
function send(res,status,payload){
  const body=JSON.stringify(payload);
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':'http://127.0.0.1:4193','access-control-allow-methods':'POST,OPTIONS','access-control-allow-headers':'content-type,apikey'});res.end(body);
}
const server=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/health')return send(res,200,{ok:true});
  if(req.method==='OPTIONS')return send(res,204,{});
  if(req.method!=='POST'||req.url!=='/title-supercomputer')return send(res,404,{ok:false,error:'NOT_FOUND'});
  if((req.headers.apikey??'')!==localKey)return send(res,401,{ok:false,error:'UNAUTHORIZED'});
  try{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw||'{}');const action=String(body.action??'');
    if(action==='specialist'){
      const id=Number(body.specialist);if(!Number.isInteger(id)||id<1||id>20)throw new Error('INVALID_SPECIALIST');
      const result=id===12?runLocal12(body.positionWords):await remoteSpecialist(id,body.positionWords);return send(res,200,{ok:true,result});
    }
    if(action==='converge')return send(res,200,{ok:true,result:runLocalConvergence(body.positionWords,body.candidates)});
    if(action==='turn')return send(res,200,{ok:true,result:await runTurn(body.positionWords)});
    throw new Error('ACTION_INVALID');
  }catch(error){return send(res,400,{ok:false,error:error instanceof Error?error.message:String(error)});}
});
server.listen(port,host,()=>console.log(`PRACTICAL_PROXY_READY:http://${host}:${port}`));
function shutdown(){server.close(()=>{try{mod.PThread.terminateAllThreads();}finally{process.exit(0);}});setTimeout(()=>process.exit(1),2000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
