import {readFile,writeFile} from 'node:fs/promises';

const path='src/game/cpu-worker.ts';
let source=await readFile(path,'utf8');
const replacements=[
  ['private worker:Worker;','private w:Worker;'],
  ['private position:Position|null=null;','private p:Position|null=null;'],
  ['private wasmUrl:string|undefined;','private u:string|undefined;'],
  ['this.worker','this.w'],
  ['this.position','this.p'],
  ['this.wasmUrl','this.u'],
  ['private spawn():Worker{','private s():Worker{'],
  ['this.spawn()','this.s()'],
  ['  warmup(wasmUrl?:string){','  a(wasmUrl?:string){'],
  ['slot.warmup(wasmUrl)','slot.a(wasmUrl)'],
  ['  prepare(position:Position,wasmUrl?:string){','  q(position:Position,wasmUrl?:string){'],
  ['slot.prepare(position,wasmUrl)','slot.q(position,wasmUrl)'],
  ['private replace(){','private r(){'],
  ['this.replace()','this.r()'],
  ['  async run(job:RootSearchJob,timeoutMs:number):Promise<RootJobResponse|null>{','  async x(job:RootSearchJob,timeoutMs:number):Promise<RootJobResponse|null>{'],
  ['slot.run(job,timeout)','slot.x(job,timeout)'],
  ['  terminate(){this.w.terminate();}','  t(){this.w.terminate();}'],
  ['workerPool.pop()!.terminate()','workerPool.pop()!.t()'],
];
for(const [oldText,newText] of replacements){
  if(!source.includes(oldText))throw new Error(`ANCHOR_MISSING:${oldText}`);
  source=source.replaceAll(oldText,newText);
}
await writeFile(path,source);
