/// <reference lib="webworker" />
import { chooseCpuMove } from './cpu';
import { positionKey } from './engine';
import { loadWasmMaterialEvaluator } from './wasm';
import type { CpuLevel, Position } from './types';
import type { WasmMaterialEvaluator } from './wasm';

interface CpuRequest {
  requestId: string;
  position: Position;
  level: CpuLevel;
  wasmUrl?: string;
}

interface CpuResponse {
  requestId: string;
  positionKey: string;
  ok: boolean;
  wasmUsed: boolean;
  result?: ReturnType<typeof chooseCpuMove>;
  error?: string;
}

let cachedWasmUrl:string|null=null;
let cachedEvaluator:WasmMaterialEvaluator|null=null;
let loadPromise:Promise<WasmMaterialEvaluator|null>|null=null;

async function evaluatorFor(url?:string):Promise<WasmMaterialEvaluator|null>{
  if(!url)return null;
  if(url===cachedWasmUrl&&cachedEvaluator)return cachedEvaluator;
  if(url!==cachedWasmUrl){
    cachedWasmUrl=url;
    cachedEvaluator=null;
    loadPromise=loadWasmMaterialEvaluator(url);
  }
  if(!loadPromise)loadPromise=loadWasmMaterialEvaluator(url);
  cachedEvaluator=await loadPromise;
  return cachedEvaluator;
}

self.onmessage=async(event:MessageEvent<CpuRequest>)=>{
  const {requestId,position,level,wasmUrl}=event.data;
  const key=positionKey(position);
  try{
    const evaluator=await evaluatorFor(wasmUrl);
    const result=chooseCpuMove(position,level,evaluator??undefined);
    const response:CpuResponse={requestId,positionKey:key,ok:true,wasmUsed:!!evaluator,result};
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
