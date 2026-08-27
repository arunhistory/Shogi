/// <reference lib="webworker" />
import { chooseCpuMove } from './cpu';
import { positionKey } from './engine';
import type { CpuLevel, Position } from './types';

interface CpuRequest {
  requestId: string;
  position: Position;
  level: CpuLevel;
}

interface CpuResponse {
  requestId: string;
  positionKey: string;
  ok: boolean;
  result?: ReturnType<typeof chooseCpuMove>;
  error?: string;
}

self.onmessage=(event:MessageEvent<CpuRequest>)=>{
  const {requestId,position,level}=event.data;
  const key=positionKey(position);
  try{
    const result=chooseCpuMove(position,level);
    const response:CpuResponse={requestId,positionKey:key,ok:true,result};
    self.postMessage(response);
  }catch(error){
    const response:CpuResponse={
      requestId,
      positionKey:key,
      ok:false,
      error:error instanceof Error?error.message:'CPU_SEARCH_FAILED',
    };
    self.postMessage(response);
  }
};

export {};
