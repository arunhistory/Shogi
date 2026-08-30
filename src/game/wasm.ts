import { decodePositionKey } from './position-key';
import type { BoardKind, Move, PieceKind, Position, RepetitionStatus, Side } from './types';

export type WasmMaterialEvaluator=(position:Position,perspective:Side)=>number;

export interface WasmSearchResult {
  move:Move|null;
  nodesVisited:number;
}

export interface WasmRootSearchResult {
  score:number;
  nodesVisited:number;
  complete:boolean;
}

export interface WasmShogiEngine {
  evaluate:(position:Position,perspective:Side)=>number;
  legalMoves:(position:Position)=>Move[];
  isCheck:(position:Position,side:Side)=>boolean;
  isMate:(position:Position)=>boolean;
  repetitionStatus:(position:Position)=>RepetitionStatus;
  searchBestMove:(position:Position,maxDepth:number,nodeLimit:number)=>WasmSearchResult;
  searchRootMove:(position:Position,move:Move,maxDepth:number,nodeLimit:number,lane:number,profileCode:number)=>WasmRootSearchResult;
}

interface ShogiWasmExports extends WebAssembly.Exports {
  memory:WebAssembly.Memory;
  shogi_engine_version:()=>number;
  shogi_input_buffer:()=>number;
  shogi_input_capacity:()=>number;
  shogi_history_buffer:()=>number;
  shogi_history_capacity:()=>number;
  shogi_evaluate_position:(count:number,perspective:number)=>number;
  shogi_legal_move_count:(count:number)=>number;
  shogi_legal_move_at:(index:number)=>number;
  shogi_is_check:(count:number,side:number)=>number;
  shogi_is_mate:(count:number)=>number;
  shogi_repetition_status_with_history:(positionCount:number,historyWordCount:number)=>number;
  shogi_search_best_move_with_history:(positionCount:number,historyWordCount:number,maxDepth:number,nodeLimit:number)=>number;
  shogi_search_root_move_with_history:(positionCount:number,historyWordCount:number,encodedMove:number,maxDepth:number,nodeLimit:number,lane:number,profileCode:number)=>number;
  shogi_search_future_root_move_with_history:(positionCount:number,historyWordCount:number,encodedMove:number,maxDepth:number,nodeLimit:number,lane:number)=>number;
  shogi_parallel_search_complete:()=>number;
  shogi_nodes_searched:()=>number;
}

type WasmInstantiateResult=WebAssembly.Instance|{instance:WebAssembly.Instance};

const POSITION_MAGIC=0x53484749;
const POSITION_WORDS=97;
const HISTORY_MAGIC=0x48535431;
const HISTORY_ENTRY_WORDS=5;
const FNV_PRIME=1099511628211n;
const FNV_PRIMARY_SEED=1469598103934665603n;
const FNV_SECONDARY_SEED=0x84222325cbf29ce4n;
const MASK_64=(1n<<64n)-1n;
const INVALID_PARALLEL_SCORE=2147483647;

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
const dropCodes:Record<Exclude<PieceKind,'king'>,number>={
  pawn:1,lance:2,knight:3,silver:4,gold:5,bishop:6,rook:7,
};
const handKinds:Exclude<PieceKind,'king'>[]=['pawn','lance','knight','silver','gold','bishop','rook'];
const sideCode=(side:Side)=>side==='sente'?1:-1;

function encodePosition(position:Position):Int32Array{
  if(position.turn!=='sente'&&position.turn!=='gote')throw new Error('INVALID_POSITION_TURN');
  if(!Array.isArray(position.board)||position.board.length!==9||!position.board.every(row=>Array.isArray(row)&&row.length===9))throw new Error('INVALID_POSITION_BOARD');
  const words=new Int32Array(POSITION_WORDS);
  words[0]=POSITION_MAGIC;
  words[1]=sideCode(position.turn);
  let index=2;
  for(const row of position.board){
    for(const piece of row){
      if(piece===null){words[index++]=0;continue;}
      if(!piece||typeof piece!=='object'||(piece.side!=='sente'&&piece.side!=='gote')||!(piece.kind in pieceCodes))throw new Error('INVALID_POSITION_PIECE');
      words[index++]=(piece.side==='sente'?1:-1)*pieceCodes[piece.kind];
    }
  }
  for(const side of ['sente','gote'] as const){
    const sideHands=position.hands?.[side];
    if(!sideHands||typeof sideHands!=='object')throw new Error('INVALID_POSITION_HANDS');
    for(const kind of handKinds){
      const count=sideHands[kind];
      if(!Number.isSafeInteger(count)||count<0||count>40)throw new Error('INVALID_POSITION_HAND_COUNT');
      words[index++]=count;
    }
  }
  return words;
}

function positionFromKey(key:string):Position{
  const parsed=decodePositionKey(key);
  return{...parsed,ply:0,history:[]};
}

function mixHash(hash:bigint,value:number):bigint{
  return ((hash^BigInt(value&0xff))*FNV_PRIME)&MASK_64;
}

function hashEncodedPosition(words:Int32Array,seed:bigint):bigint{
  let hash=seed;
  for(let i=2;i<83;i++)hash=mixHash(hash,words[i]!+16);
  for(let i=83;i<97;i++)hash=mixHash(hash,words[i]!);
  hash=mixHash(hash,words[1]===1?1:2);
  return hash;
}

function hashPositionKey(key:string):[bigint,bigint]{
  const words=encodePosition(positionFromKey(key));
  return[
    hashEncodedPosition(words,FNV_PRIMARY_SEED),
    hashEncodedPosition(words,FNV_SECONDARY_SEED),
  ];
}

function splitU64(value:bigint):[number,number]{
  const low=Number(value&0xffffffffn)|0;
  const high=Number((value>>32n)&0xffffffffn)|0;
  return[low,high];
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

function encodeMove(move:Move):number{
  const to=move.to[0]*9+move.to[1];
  if(!Number.isSafeInteger(to)||to<0||to>=81)throw new Error('WASM_MOVE_DESTINATION_INVALID');
  if(move.drop){
    if(move.drop==='king')throw new Error('WASM_KING_DROP_INVALID');
    const drop=dropCodes[move.drop];
    return to|(127<<7)|(drop<<14);
  }
  if(!move.from)throw new Error('WASM_MOVE_SOURCE_MISSING');
  const from=move.from[0]*9+move.from[1];
  if(!Number.isSafeInteger(from)||from<0||from>=81)throw new Error('WASM_MOVE_SOURCE_INVALID');
  return to|(from<<7)|(move.promote?1<<18:0);
}

function validExports(exports:WebAssembly.Exports):exports is ShogiWasmExports{
  const candidate=exports as Partial<ShogiWasmExports>;
  return candidate.memory instanceof WebAssembly.Memory
    &&typeof candidate.shogi_engine_version==='function'
    &&typeof candidate.shogi_input_buffer==='function'
    &&typeof candidate.shogi_input_capacity==='function'
    &&typeof candidate.shogi_history_buffer==='function'
    &&typeof candidate.shogi_history_capacity==='function'
    &&typeof candidate.shogi_evaluate_position==='function'
    &&typeof candidate.shogi_legal_move_count==='function'
    &&typeof candidate.shogi_legal_move_at==='function'
    &&typeof candidate.shogi_is_check==='function'
    &&typeof candidate.shogi_is_mate==='function'
    &&typeof candidate.shogi_repetition_status_with_history==='function'
    &&typeof candidate.shogi_search_best_move_with_history==='function'
    &&typeof candidate.shogi_search_root_move_with_history==='function'
    &&typeof candidate.shogi_search_future_root_move_with_history==='function'
    &&typeof candidate.shogi_parallel_search_complete==='function'
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
    const historyCapacity=wasm.shogi_history_capacity();
    const historyPointer=wasm.shogi_history_buffer();
    if(!Number.isSafeInteger(capacity)||capacity<POSITION_WORDS||capacity>4096)return null;
    if(!Number.isSafeInteger(pointer)||pointer<0)return null;
    if(!Number.isSafeInteger(historyCapacity)||historyCapacity<2+HISTORY_ENTRY_WORDS||historyCapacity>16_384)return null;
    if(!Number.isSafeInteger(historyPointer)||historyPointer<0)return null;

    const writePosition=(position:Position):number=>{
      const encoded=encodePosition(position);
      const requiredBytes=pointer+capacity*Int32Array.BYTES_PER_ELEMENT;
      if(requiredBytes>wasm.memory.buffer.byteLength)throw new Error('WASM_MEMORY_RANGE');
      const input=new Int32Array(wasm.memory.buffer,pointer,capacity);
      input.fill(0,0,POSITION_WORDS);
      input.set(encoded,0);
      return encoded.length;
    };

    const writeHistory=(position:Position):number=>{
      if(!Array.isArray(position.history)||position.history.length===0)throw new Error('WASM_HISTORY_MISSING');
      const requiredWords=2+position.history.length*HISTORY_ENTRY_WORDS;
      if(requiredWords>historyCapacity)throw new Error('WASM_HISTORY_CAPACITY');
      const requiredBytes=historyPointer+historyCapacity*Int32Array.BYTES_PER_ELEMENT;
      if(requiredBytes>wasm.memory.buffer.byteLength)throw new Error('WASM_HISTORY_MEMORY_RANGE');
      const history=new Int32Array(wasm.memory.buffer,historyPointer,historyCapacity);
      history.fill(0,0,requiredWords);
      history[0]=HISTORY_MAGIC;
      history[1]=position.history.length;
      let offset=2;
      for(const entry of position.history){
        if(!entry||typeof entry.key!=='string'||(entry.mover!==null&&entry.mover!=='sente'&&entry.mover!=='gote')||typeof entry.gaveCheck!=='boolean')throw new Error('WASM_HISTORY_INVALID_ENTRY');
        if(entry.mover===null&&entry.gaveCheck)throw new Error('WASM_HISTORY_INVALID_ENTRY');
        const [primary,secondary]=hashPositionKey(entry.key);
        const [primaryLow,primaryHigh]=splitU64(primary);
        const [secondaryLow,secondaryHigh]=splitU64(secondary);
        const moverCode=entry.mover==='sente'?1:entry.mover==='gote'?2:0;
        history[offset++]=primaryLow;
        history[offset++]=primaryHigh;
        history[offset++]=secondaryLow;
        history[offset++]=secondaryHigh;
        history[offset++]=moverCode|(entry.gaveCheck?4:0);
      }
      return requiredWords;
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
      repetitionStatus(position){
        const positionCount=writePosition(position);
        const historyWords=writeHistory(position);
        const value=wasm.shogi_repetition_status_with_history(positionCount,historyWords);
        if(value===0)return{kind:'none'};
        if(value===1)return{kind:'normal'};
        if(value===2)return{kind:'perpetual-check',loser:'sente'};
        if(value===3)return{kind:'perpetual-check',loser:'gote'};
        throw new Error('WASM_REPETITION_FAILURE');
      },
      searchBestMove(position,maxDepth,nodeLimit){
        const depth=Math.max(1,Math.min(12,Math.trunc(maxDepth)));
        const nodes=Math.max(100,Math.min(5_000_000,Math.trunc(nodeLimit)));
        const positionCount=writePosition(position);
        const historyWords=writeHistory(position);
        const move=decodeMove(wasm.shogi_search_best_move_with_history(positionCount,historyWords,depth,nodes));
        const nodesVisited=wasm.shogi_nodes_searched();
        return{move,nodesVisited:Number.isSafeInteger(nodesVisited)&&nodesVisited>=0?nodesVisited:0};
      },
      searchRootMove(position,move,maxDepth,nodeLimit,lane,profileCode){
        const depth=Math.max(1,Math.min(12,Math.trunc(maxDepth)));
        const nodes=Math.max(100,Math.min(250_000,Math.trunc(nodeLimit)));
        const laneValue=Math.max(0,Math.min(255,Math.trunc(lane)));
        const profileValue=Math.max(0,Math.min(4,Math.trunc(profileCode)));
        const positionCount=writePosition(position);
        const historyWords=writeHistory(position);
        const encodedMove=encodeMove(move);
        const score=profileValue===4
          ?wasm.shogi_search_future_root_move_with_history(positionCount,historyWords,encodedMove,depth,nodes,laneValue)
          :wasm.shogi_search_root_move_with_history(positionCount,historyWords,encodedMove,depth,nodes,laneValue,profileValue);
        if(score===INVALID_PARALLEL_SCORE)throw new Error('WASM_ROOT_SEARCH_INVALID');
        const completeValue=wasm.shogi_parallel_search_complete();
        if(completeValue!==0&&completeValue!==1)throw new Error('WASM_ROOT_SEARCH_COMPLETION_INVALID');
        const nodesVisited=wasm.shogi_nodes_searched();
        return{
          score,
          complete:completeValue===1,
          nodesVisited:Number.isSafeInteger(nodesVisited)&&nodesVisited>=0?nodesVisited:0,
        };
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
