/// <reference lib="webworker" />
import type {BoardKind,Position} from './types';

type WarmupRequest={type:'warmup';wasmUrl:string};
type SpecialistRequest={type:'specialist';requestId:string;wasmUrl:string;position:Position;specialist:number};
type ConvergeRequest={type:'converge';requestId:string;wasmUrl:string;position:Position;candidates:number[]};
type RequestMessage=WarmupRequest|SpecialistRequest|ConvergeRequest;

interface SuperExports extends WebAssembly.Exports{
  memory:WebAssembly.Memory;
  shogi_input_buffer:()=>number;
  shogi_input_capacity:()=>number;
  shogi_super_search_specialist:(count:number,specialist:number,maxDepth:number,nodeLimit:number)=>number;
  shogi_super_converge:(positionWords:number,candidateCount:number,maxDepth:number,nodeLimit:number)=>number;
  shogi_super_best_score:()=>number;
  shogi_super_nodes_searched:()=>number;
}

type InstantiateResult=WebAssembly.Instance|{instance:WebAssembly.Instance};
const POSITION_MAGIC=0x53484749;
const POSITION_WORDS=97;
const NODE_BUDGET=5_000_000;
const pieceCodes:Record<BoardKind,number>={
  pawn:1,lance:2,knight:3,silver:4,gold:5,bishop:6,rook:7,king:8,
  tokin:9,promotedLance:10,promotedKnight:11,promotedSilver:12,horse:13,dragon:14,
};
const handKinds=['pawn','lance','knight','silver','gold','bishop','rook'] as const;

function encodePosition(position:Position):Int32Array{
  const words=new Int32Array(POSITION_WORDS);
  words[0]=POSITION_MAGIC;
  words[1]=position.turn==='sente'?1:-1;
  let index=2;
  for(const row of position.board)for(const piece of row){
    words[index++]=piece?(piece.side==='sente'?1:-1)*pieceCodes[piece.kind]:0;
  }
  for(const side of ['sente','gote'] as const){
    for(const kind of handKinds)words[index++]=position.hands[side][kind];
  }
  return words;
}

let activeUrl='';
let active:Promise<SuperExports>|null=null;
function unwrap(result:InstantiateResult):WebAssembly.Instance{return 'instance'in result?result.instance:result;}
async function load(url:string):Promise<SuperExports>{
  if(active&&url===activeUrl)return active;
  activeUrl=url;
  active=(async()=>{
    const response=await fetch(url,{cache:'no-store',credentials:'omit'});
    if(!response.ok)throw new Error(`SUPER_WASM_HTTP_${response.status}`);
    const result=await WebAssembly.instantiate(await response.arrayBuffer(),{}) as InstantiateResult;
    const wasm=unwrap(result).exports as Partial<SuperExports>;
    if(!(wasm.memory instanceof WebAssembly.Memory)
      ||typeof wasm.shogi_input_buffer!=='function'
      ||typeof wasm.shogi_input_capacity!=='function'
      ||typeof wasm.shogi_super_search_specialist!=='function'
      ||typeof wasm.shogi_super_converge!=='function'
      ||typeof wasm.shogi_super_best_score!=='function'
      ||typeof wasm.shogi_super_nodes_searched!=='function')throw new Error('SUPER_WASM_EXPORTS_INVALID');
    return wasm as SuperExports;
  })();
  return active;
}

function writePosition(wasm:SuperExports,position:Position,candidates:number[]=[]):number{
  const capacity=wasm.shogi_input_capacity();
  const pointer=wasm.shogi_input_buffer();
  if(capacity<POSITION_WORDS+candidates.length)throw new Error('SUPER_WASM_INPUT_CAPACITY');
  const input=new Int32Array(wasm.memory.buffer,pointer,capacity);
  input.fill(0,0,POSITION_WORDS+candidates.length);
  input.set(encodePosition(position),0);
  candidates.forEach((value,index)=>{input[POSITION_WORDS+index]=value|0;});
  return POSITION_WORDS;
}

self.onmessage=async(event:MessageEvent<RequestMessage>)=>{
  const message=event.data;
  try{
    const wasm=await load(message.wasmUrl);
    if(message.type==='warmup'){
      self.postMessage({type:'ready'});
      return;
    }
    const started=performance.now();
    const count=writePosition(wasm,message.position,message.type==='converge'?message.candidates:[]);
    const moveCode=message.type==='specialist'
      ?wasm.shogi_super_search_specialist(count,message.specialist,12,NODE_BUDGET)
      :wasm.shogi_super_converge(count,message.candidates.length,14,NODE_BUDGET);
    self.postMessage({
      type:'result',requestId:message.requestId,ok:moveCode>=0,moveCode,
      score:wasm.shogi_super_best_score(),nodes:wasm.shogi_super_nodes_searched(),
      elapsedMs:performance.now()-started,
      ...(message.type==='specialist'?{specialist:message.specialist}:{phase:'converge'}),
    });
  }catch(error){
    if(message.type!=='warmup')self.postMessage({type:'result',requestId:message.requestId,ok:false,error:error instanceof Error?error.message:String(error)});
  }
};

export {};
