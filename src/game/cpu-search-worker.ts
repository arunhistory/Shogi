/// <reference lib="webworker" />
import { scoreCpuRootMove, sameCpuMove } from './cpu';
import { isCheck, legalMoves, positionKey, repetitionStatus } from './engine';
import { loadWasmShogiEngine } from './wasm';
import type { Move, Position, RepetitionStatus } from './types';
import type { WasmShogiEngine } from './wasm';

interface WarmupMessage {
  type:'warmup';
  wasmUrl?:string;
}

interface InitMessage {
  type:'init';
  position:Position;
  wasmUrl?:string;
}

interface SearchMessage {
  type:'search';
  jobId:string;
  move:Move;
  depth:number;
  nodeLimit:number;
  lane:number;
}

type RootWorkerMessage=WarmupMessage|InitMessage|SearchMessage;

interface RootJobResponse {
  type:'result';
  jobId:string;
  ok:boolean;
  score?:number;
  depth?:number;
  nodesVisited?:number;
  complete?:boolean;
  wasmUsed:boolean;
  error?:string;
}

let rootPosition:Position|null=null;
let rootWasmUrl:string|undefined;
let cachedWasmUrl:string|null=null;
let cachedEngine:WasmShogiEngine|null=null;
let loadPromise:Promise<WasmShogiEngine|null>|null=null;
let parityKey:string|null=null;

function resolvedWasmUrl(explicit?:string):string{
  if(explicit)return explicit;
  return new URL('../wasm/shogi_engine.wasm',self.location.href).toString();
}

async function engineFor(explicitUrl?:string):Promise<WasmShogiEngine|null>{
  const url=resolvedWasmUrl(explicitUrl);
  if(url===cachedWasmUrl&&cachedEngine)return cachedEngine;
  if(url!==cachedWasmUrl){
    cachedWasmUrl=url;
    cachedEngine=null;
    parityKey=null;
    loadPromise=loadWasmShogiEngine(url);
  }
  if(!loadPromise)loadPromise=loadWasmShogiEngine(url);
  cachedEngine=await loadPromise;
  return cachedEngine;
}

function moveKey(move:Move):string{
  return `${move.from?.[0]??-1},${move.from?.[1]??-1}>${move.to[0]},${move.to[1]}|${move.drop??''}|${move.promote?1:0}`;
}

function sameRepetition(a:RepetitionStatus,b:RepetitionStatus):boolean{
  if(a.kind!==b.kind)return false;
  if(a.kind==='perpetual-check'&&b.kind==='perpetual-check')return a.loser===b.loser;
  return true;
}

function assertRootParity(engine:WasmShogiEngine,position:Position):void{
  const key=positionKey(position);
  if(parityKey===key)return;
  const officialLegal=legalMoves(position);
  if(engine.isCheck(position,position.turn)!==isCheck(position,position.turn))throw new Error('WASM_CHECK_MISMATCH');
  const expected=officialLegal.map(moveKey).sort();
  const observed=engine.legalMoves(position).map(moveKey).sort();
  if(expected.length!==observed.length||expected.some((value,index)=>value!==observed[index]))throw new Error('WASM_LEGAL_SET_MISMATCH');
  if(!sameRepetition(engine.repetitionStatus(position),repetitionStatus(position)))throw new Error('WASM_REPETITION_MISMATCH');
  parityKey=key;
}

self.onmessage=async(event:MessageEvent<RootWorkerMessage>)=>{
  const message=event.data;
  if(message.type==='warmup'){
    rootWasmUrl=message.wasmUrl;
    void engineFor(rootWasmUrl);
    return;
  }
  if(message.type==='init'){
    rootPosition=message.position;
    rootWasmUrl=message.wasmUrl;
    parityKey=null;
    void engineFor(rootWasmUrl);
    return;
  }

  const {jobId,move,depth,nodeLimit,lane}=message;
  try{
    const position=rootPosition;
    if(!position)throw new Error('CPU_ROOT_NOT_INITIALIZED');
    const official=legalMoves(position).find(candidate=>sameCpuMove(candidate,move));
    if(!official)throw new Error('CPU_ROOT_MOVE_ILLEGAL');
    const engine=await engineFor(rootWasmUrl);
    if(engine){
      try{
        assertRootParity(engine,position);
        const result=engine.searchRootMove(position,official,depth,nodeLimit,lane);
        const response:RootJobResponse={
          type:'result',jobId,ok:true,score:result.score,depth,
          nodesVisited:result.nodesVisited,complete:result.complete,wasmUsed:true,
        };
        self.postMessage(response);
        return;
      }catch{
        // Rule parity, ABI or search failures use the independent TypeScript path.
      }
    }
    const fallback=scoreCpuRootMove(position,official,depth,Math.min(140,Math.max(40,Math.trunc(nodeLimit/100))));
    const response:RootJobResponse={
      type:'result',jobId,ok:true,score:fallback.score,
      depth:fallback.completedDepth||depth,nodesVisited:fallback.nodesVisited,
      complete:fallback.complete,wasmUsed:false,
    };
    self.postMessage(response);
  }catch(error){
    const response:RootJobResponse={
      type:'result',jobId,ok:false,wasmUsed:false,
      error:error instanceof Error?error.message:'CPU_ROOT_SEARCH_FAILED',
    };
    self.postMessage(response);
  }
};

export {};
