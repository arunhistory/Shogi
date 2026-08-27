import type { BoardKind, Move, PieceKind, Position, Side } from './types';

export type WasmMaterialEvaluator=(position:Position,perspective:Side)=>number;

export interface WasmSearchResult {
  move:Move|null;
  nodesVisited:number;
}

export interface WasmShogiEngine {
  evaluate:(position:Position,perspective:Side)=>number;
  legalMoves:(position:Position)=>Move[];
  isCheck:(position:Position,side:Side)=>boolean;
  isMate:(position:Position)=>boolean;
  searchBestMove:(position:Position,maxDepth:number,nodeLimit:number)=>WasmSearchResult;
}

interface ShogiWasmExports extends WebAssembly.Exports {
  memory:WebAssembly.Memory;
  shogi_engine_version:()=>number;
  shogi_input_buffer:()=>number;
  shogi_input_capacity:()=>number;
  shogi_evaluate_position:(count:number,perspective:number)=>number;
  shogi_legal_move_count:(count:number)=>number;
  shogi_legal_move_at:(index:number)=>number;
  shogi_is_check:(count:number,side:number)=>number;
  shogi_is_mate:(count:number)=>number;
  shogi_search_best_move:(count:number,maxDepth:number,nodeLimit:number)=>number;
  shogi_nodes_searched:()=>number;
}

type WasmInstantiateResult=WebAssembly.Instance|{instance:WebAssembly.Instance};

const POSITION_MAGIC=0x53484749;
const POSITION_WORDS=97;

const pieceCodes:Record<BoardKind,number>={
  pawn:1,
  lance:2,
  knight:3,
  silver:4,
  gold:5,
  bishop:6,
  rook:7,
  king:8,
  tokin:9,
  promotedLance:10,
  promotedKnight:11,
  promotedSilver:12,
  horse:13,
  dragon:14,
};

const dropKinds:Record<number,Exclude<PieceKind,'king'>>={
  1:'pawn',2:'lance',3:'knight',4:'silver',5:'gold',6:'bishop',7:'rook',
};
const handKinds:Exclude<PieceKind,'king'>[]=['pawn','lance','knight','silver','gold','bishop','rook'];
const sideCode=(side:Side)=>side==='sente'?1:-1;

function encodePosition(position:Position):Int32Array{
  const words=new Int32Array(POSITION_WORDS);
  words[0]=POSITION_MAGIC;
  words[1]=sideCode(position.turn);
  let index=2;
  for(const row of position.board){
    for(const piece of row){
      words[index++]=piece?(piece.side==='sente'?1:-1)*pieceCodes[piece.kind]:0;
    }
  }
  for(const side of ['sente','gote'] as const){
    for(const kind of handKinds)words[index++]=position.hands[side][kind];
  }
  return words;
}

function decodeMove(code:number):Move|null{
  if(!Number.isSafeInteger(code)||code<0)return null;
  const to=code&0x7f;
  const from=(code>>7)&0x7f;
  const drop=(code>>14)&0x0f;
  const promote=((code>>18)&1)===1;
  if(to<0||to>=81)return null;
  const destination:[number,number]=[Math.floor(to/9),to%9];
  if(drop!==0){
    const kind=dropKinds[drop];
    if(!kind||from!==127||promote)return null;
    return{drop:kind,to:destination};
  }
  if(from<0||from>=81)return null;
  return{
    from:[Math.floor(from/9),from%9],
    to:destination,
    ...(promote?{promote:true}:{}),
  };
}

function validExports(exports:WebAssembly.Exports):exports is ShogiWasmExports{
  const candidate=exports as Partial<ShogiWasmExports>;
  return candidate.memory instanceof WebAssembly.Memory
    &&typeof candidate.shogi_engine_version==='function'
    &&typeof candidate.shogi_input_buffer==='function'
    &&typeof candidate.shogi_input_capacity==='function'
    &&typeof candidate.shogi_evaluate_position==='function'
    &&typeof candidate.shogi_legal_move_count==='function'
    &&typeof candidate.shogi_legal_move_at==='function'
    &&typeof candidate.shogi_is_check==='function'
    &&typeof candidate.shogi_is_mate==='function'
    &&typeof candidate.shogi_search_best_move==='function'
    &&typeof candidate.shogi_nodes_searched==='function';
}

function unwrapInstance(result:WasmInstantiateResult):WebAssembly.Instance{
  return 'instance' in result?result.instance:result;
}

async function instantiate(url:string):Promise<WebAssembly.Instance>{
  const response=await fetch(url,{cache:'no-store',credentials:'omit'});
  if(!response.ok)throw new Error(`WASM_HTTP_${response.status}`);
  if(typeof WebAssembly.instantiateStreaming==='function'){
    try{
      const result=await WebAssembly.instantiateStreaming(response.clone(),{}) as WasmInstantiateResult;
      return unwrapInstance(result);
    }catch{
      // Static hosts may omit application/wasm. ArrayBuffer fallback keeps the game usable.
    }
  }
  const bytes=await response.arrayBuffer();
  const result=await WebAssembly.instantiate(bytes,{}) as WasmInstantiateResult;
  return unwrapInstance(result);
}

export async function loadWasmShogiEngine(url:string):Promise<WasmShogiEngine|null>{
  try{
    const instance=await instantiate(url);
    if(!validExports(instance.exports))return null;
    const wasm=instance.exports;
    if(wasm.shogi_engine_version()<3)return null;
    const capacity=wasm.shogi_input_capacity();
    const pointer=wasm.shogi_input_buffer();
    if(!Number.isSafeInteger(capacity)||capacity<POSITION_WORDS||capacity>4096)return null;
    if(!Number.isSafeInteger(pointer)||pointer<0)return null;

    const writePosition=(position:Position):number=>{
      const encoded=encodePosition(position);
      const requiredBytes=pointer+capacity*Int32Array.BYTES_PER_ELEMENT;
      if(requiredBytes>wasm.memory.buffer.byteLength)throw new Error('WASM_MEMORY_RANGE');
      const input=new Int32Array(wasm.memory.buffer,pointer,capacity);
      input.fill(0,0,POSITION_WORDS);
      input.set(encoded,0);
      return encoded.length;
    };

    return{
      evaluate(position,perspective){
        const count=writePosition(position);
        return wasm.shogi_evaluate_position(count,sideCode(perspective));
      },
      legalMoves(position){
        const count=writePosition(position);
        const total=wasm.shogi_legal_move_count(count);
        if(total<0||total>768)throw new Error('WASM_LEGAL_MOVE_FAILURE');
        const moves:Move[]=[];
        for(let i=0;i<total;i++){
          const move=decodeMove(wasm.shogi_legal_move_at(i));
          if(!move)throw new Error('WASM_INVALID_MOVE_ENCODING');
          moves.push(move);
        }
        return moves;
      },
      isCheck(position,side){
        const count=writePosition(position);
        const value=wasm.shogi_is_check(count,sideCode(side));
        if(value!==0&&value!==1)throw new Error('WASM_CHECK_FAILURE');
        return value===1;
      },
      isMate(position){
        const count=writePosition(position);
        const value=wasm.shogi_is_mate(count);
        if(value!==0&&value!==1)throw new Error('WASM_MATE_FAILURE');
        return value===1;
      },
      searchBestMove(position,maxDepth,nodeLimit){
        const depth=Math.max(1,Math.min(12,Math.trunc(maxDepth)));
        const nodes=Math.max(100,Math.min(5_000_000,Math.trunc(nodeLimit)));
        const count=writePosition(position);
        const move=decodeMove(wasm.shogi_search_best_move(count,depth,nodes));
        const nodesVisited=wasm.shogi_nodes_searched();
        return{move,nodesVisited:Number.isSafeInteger(nodesVisited)&&nodesVisited>=0?nodesVisited:0};
      },
    };
  }catch{
    return null;
  }
}

export async function loadWasmMaterialEvaluator(url:string):Promise<WasmMaterialEvaluator|null>{
  const engine=await loadWasmShogiEngine(url);
  return engine?((position,perspective)=>engine.evaluate(position,perspective)):null;
}
