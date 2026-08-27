/// <reference lib="webworker" />
import { chooseCpuMove } from './cpu';
import { legalMoves, positionKey } from './engine';
import { loadWasmShogiEngine } from './wasm';
import type { CpuLevel, Move, Position } from './types';
import type { WasmShogiEngine } from './wasm';

interface CpuRequest {
  requestId:string;
  position:Position;
  level:CpuLevel;
  wasmUrl?:string;
}

interface CpuResult {
  move:Move|null;
  completedDepth:number;
  nodesVisited:number;
}

interface CpuResponse {
  requestId:string;
  positionKey:string;
  ok:boolean;
  wasmUsed:boolean;
  result?:CpuResult;
  error?:string;
}

const WASM_LIMITS:Record<CpuLevel,{maxDepth:number;nodeLimit:number}>={
  beginner:{maxDepth:1,nodeLimit:2_500},
  intermediate:{maxDepth:3,nodeLimit:40_000},
  amateur:{maxDepth:5,nodeLimit:300_000},
  pro:{maxDepth:8,nodeLimit:1_500_000},
  title:{maxDepth:12,nodeLimit:5_000_000},
};

let cachedWasmUrl:string|null=null;
let cachedEngine:WasmShogiEngine|null=null;
let loadPromise:Promise<WasmShogiEngine|null>|null=null;

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
    loadPromise=loadWasmShogiEngine(url);
  }
  if(!loadPromise)loadPromise=loadWasmShogiEngine(url);
  cachedEngine=await loadPromise;
  return cachedEngine;
}

function sameMove(a:Move,b:Move):boolean{
  return a.to[0]===b.to[0]
    &&a.to[1]===b.to[1]
    &&a.from?.[0]===b.from?.[0]
    &&a.from?.[1]===b.from?.[1]
    &&a.drop===b.drop
    &&!!a.promote===!!b.promote;
}

function searchWithWasm(engine:WasmShogiEngine,position:Position,level:CpuLevel):CpuResult{
  const officialLegal=legalMoves(position);
  if(officialLegal.length===0)return{move:null,completedDepth:0,nodesVisited:0};
  const limits=WASM_LIMITS[level];
  const searched=engine.searchBestMove(position,limits.maxDepth,limits.nodeLimit);
  if(!searched.move)throw new Error('WASM_SEARCH_RETURNED_NO_MOVE');
  const verified=officialLegal.find(move=>sameMove(move,searched.move!));
  if(!verified)throw new Error('WASM_SEARCH_RETURNED_ILLEGAL_MOVE');
  return{
    move:verified,
    // The C++ engine uses iterative deepening internally. Exact last completed depth
    // is not exposed by the ABI yet, so 0 deliberately means "not reported".
    completedDepth:0,
    nodesVisited:searched.nodesVisited,
  };
}

self.onmessage=async(event:MessageEvent<CpuRequest>)=>{
  const {requestId,position,level,wasmUrl}=event.data;
  const key=positionKey(position);
  try{
    const engine=await engineFor(wasmUrl);
    if(engine){
      try{
        const result=searchWithWasm(engine,position,level);
        const response:CpuResponse={requestId,positionKey:key,ok:true,wasmUsed:true,result};
        self.postMessage(response);
        return;
      }catch{
        // Never adopt an invalid WASM result. Fall back to the independently
        // validated TypeScript implementation for availability and safety.
      }
    }
    const result=chooseCpuMove(position,level);
    const response:CpuResponse={requestId,positionKey:key,ok:true,wasmUsed:false,result};
    self.postMessage(response);
  }catch(error){
    const response:CpuResponse={
      requestId,
      positionKey:key,
      ok:false,
      wasmUsed:false,
      error:error instanceof Error?error.message:'CPU_SEARCH_FAILED',
    };
    self.postMessage(response);
  }
};

export {};
