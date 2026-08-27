import shogiWasmModule from '../shogi_engine.wasm';
import { initialPosition, legalMoves } from '../../../src/game/engine';
import type { BoardKind, Move, PieceKind, Position, Side } from '../../../src/game/types';

interface ShogiWasmExports extends WebAssembly.Exports {
  memory:WebAssembly.Memory;
  shogi_engine_version:()=>number;
  shogi_input_buffer:()=>number;
  shogi_input_capacity:()=>number;
  shogi_legal_move_count:(count:number)=>number;
  shogi_legal_move_at:(index:number)=>number;
  shogi_is_check:(count:number,side:number)=>number;
  shogi_is_mate:(count:number)=>number;
}

type InstantiateResult=WebAssembly.Instance|{instance:WebAssembly.Instance};

const POSITION_MAGIC=0x53484749;
const POSITION_WORDS=97;
const MAX_LEGAL_MOVES=768;

const pieceCodes:Record<BoardKind,number>={
  pawn:1,lance:2,knight:3,silver:4,gold:5,bishop:6,rook:7,king:8,
  tokin:9,promotedLance:10,promotedKnight:11,promotedSilver:12,horse:13,dragon:14,
};
const dropCodes:Record<Exclude<PieceKind,'king'>,number>={
  pawn:1,lance:2,knight:3,silver:4,gold:5,bishop:6,rook:7,
};
const handKinds:Exclude<PieceKind,'king'>[]=['pawn','lance','knight','silver','gold','bishop','rook'];
const sideCode=(side:Side)=>side==='sente'?1:-1;

function validExports(value:WebAssembly.Exports):value is ShogiWasmExports{
  const candidate=value as Partial<ShogiWasmExports>;
  return candidate.memory instanceof WebAssembly.Memory
    &&typeof candidate.shogi_engine_version==='function'
    &&typeof candidate.shogi_input_buffer==='function'
    &&typeof candidate.shogi_input_capacity==='function'
    &&typeof candidate.shogi_legal_move_count==='function'
    &&typeof candidate.shogi_legal_move_at==='function'
    &&typeof candidate.shogi_is_check==='function'
    &&typeof candidate.shogi_is_mate==='function';
}

function encodePosition(position:Position):Int32Array{
  const words=new Int32Array(POSITION_WORDS);
  words[0]=POSITION_MAGIC;
  words[1]=sideCode(position.turn);
  let index=2;
  for(const row of position.board){
    if(!Array.isArray(row)||row.length!==9)throw new Error('WASM_INVALID_BOARD');
    for(const piece of row){
      if(piece===null){words[index++]=0;continue;}
      const code=pieceCodes[piece.kind];
      if(!code)throw new Error('WASM_INVALID_PIECE');
      words[index++]=(piece.side==='sente'?1:-1)*code;
    }
  }
  for(const side of ['sente','gote'] as const){
    for(const kind of handKinds){
      const count=position.hands[side][kind];
      if(!Number.isSafeInteger(count)||count<0||count>40)throw new Error('WASM_INVALID_HAND');
      words[index++]=count;
    }
  }
  return words;
}

function squareCode(square:[number,number]):number{
  const [row,column]=square;
  if(!Number.isInteger(row)||!Number.isInteger(column)||row<0||row>8||column<0||column>8)throw new Error('WASM_INVALID_SQUARE');
  return row*9+column;
}

function encodeMove(move:Move):number{
  const to=squareCode(move.to);
  if(move.drop){
    if(move.drop==='king'||move.promote)throw new Error('WASM_INVALID_DROP');
    return (to&0x7f)|(127<<7)|(dropCodes[move.drop]<<14);
  }
  if(!move.from)throw new Error('WASM_MOVE_FROM_MISSING');
  const from=squareCode(move.from);
  return (to&0x7f)|((from&0x7f)<<7)|((move.promote?1:0)<<18);
}

const instantiated=await WebAssembly.instantiate(shogiWasmModule,{}) as InstantiateResult;
const instance=instantiated instanceof WebAssembly.Instance?instantiated:instantiated.instance;
if(!validExports(instance.exports))throw new Error('CLOUDFLARE_WASM_EXPORTS_INVALID');
const wasm=instance.exports;
const version=wasm.shogi_engine_version();
if(!Number.isSafeInteger(version)||version<3)throw new Error('CLOUDFLARE_WASM_VERSION_INVALID');
const capacity=wasm.shogi_input_capacity();
const pointer=wasm.shogi_input_buffer();
if(!Number.isSafeInteger(capacity)||capacity<POSITION_WORDS||capacity>4096||!Number.isSafeInteger(pointer)||pointer<0){
  throw new Error('CLOUDFLARE_WASM_BUFFER_INVALID');
}

function writePosition(position:Position):number{
  const words=encodePosition(position);
  const requiredBytes=pointer+capacity*Int32Array.BYTES_PER_ELEMENT;
  if(requiredBytes>wasm.memory.buffer.byteLength)throw new Error('CLOUDFLARE_WASM_MEMORY_RANGE');
  const input=new Int32Array(wasm.memory.buffer,pointer,capacity);
  input.fill(0,0,POSITION_WORDS);
  input.set(words,0);
  return POSITION_WORDS;
}

function legalMoveCodes(position:Position):number[]{
  const count=writePosition(position);
  const total=wasm.shogi_legal_move_count(count);
  if(!Number.isSafeInteger(total)||total<0||total>MAX_LEGAL_MOVES)throw new Error('CLOUDFLARE_WASM_LEGAL_FAILURE');
  const result:number[]=[];
  for(let index=0;index<total;index++){
    const code=wasm.shogi_legal_move_at(index);
    if(!Number.isSafeInteger(code)||code<0)throw new Error('CLOUDFLARE_WASM_MOVE_ENCODING');
    result.push(code);
  }
  return result;
}

function isLegalMove(position:Position,move:Move):boolean{
  const target=encodeMove(move);
  return legalMoveCodes(position).includes(target);
}

function isCheck(position:Position,side:Side):boolean{
  const value=wasm.shogi_is_check(writePosition(position),sideCode(side));
  if(value!==0&&value!==1)throw new Error('CLOUDFLARE_WASM_CHECK_FAILURE');
  return value===1;
}

function isMate(position:Position):boolean{
  const value=wasm.shogi_is_mate(writePosition(position));
  if(value!==0&&value!==1)throw new Error('CLOUDFLARE_WASM_MATE_FAILURE');
  return value===1;
}

// Fail Worker startup if the shared C++ ABI is incompatible with the TypeScript
// authority boundary. This prevents a mismatched generated module from serving rooms.
const initial=initialPosition('even');
const tsInitial=[...new Set(legalMoves(initial).map(encodeMove))].sort((a,b)=>a-b);
const wasmInitial=[...new Set(legalMoveCodes(initial))].sort((a,b)=>a-b);
if(tsInitial.length!==30||wasmInitial.length!==tsInitial.length||tsInitial.some((code,index)=>code!==wasmInitial[index])){
  throw new Error('CLOUDFLARE_WASM_STARTUP_PARITY_FAILURE');
}

export const cloudflareWasmEngine={version,isLegalMove,isCheck,isMate};
