import type { CpuLevel, Move, Position } from './types';

type WorkerReply = { id:string; move:Move|null; nodes:number; engine:'wasm'|'fallback'; error?:string };
export type CpuMoveResult = Omit<WorkerReply,'id'>;

export class CpuController {
  private worker: Worker | null = null;
  private pending = new Map<string,{resolve:(value:CpuMoveResult)=>void;reject:(reason:unknown)=>void}>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('../workers/cpu.worker.ts', import.meta.url), {type:'module'});
    worker.addEventListener('message',(event:MessageEvent<WorkerReply>)=>{
      const item=this.pending.get(event.data.id); if(!item)return;
      this.pending.delete(event.data.id); const {id:_,...result}=event.data; item.resolve(result);
    });
    worker.addEventListener('error',(event)=>{
      for(const item of this.pending.values()) item.reject(event.error ?? new Error(event.message));
      this.pending.clear(); this.worker?.terminate(); this.worker=null;
    });
    this.worker=worker; return worker;
  }

  think(position:Position, level:CpuLevel): Promise<CpuMoveResult> {
    const id=crypto.randomUUID(); const worker=this.ensureWorker();
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});worker.postMessage({id,position,level});});
  }

  cancelAll(): void {
    this.worker?.terminate(); this.worker=null;
    for(const item of this.pending.values()) item.reject(new DOMException('CPU search cancelled','AbortError'));
    this.pending.clear();
  }
}
