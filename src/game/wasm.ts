import type { BoardKind, PieceKind, Position, Side } from './types';

export type WasmMaterialEvaluator=(position:Position,perspective:Side)=>number;

interface ShogiWasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  shogi_engine_version:()=>number;
  shogi_input_buffer:()=>number;
  shogi_input_capacity:()=>number;
  shogi_evaluate_material_codes:(count:number)=>number;
}

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

const handKinds:PieceKind[]=['pawn','lance','knight','silver','gold','bishop','rook','king'];

function encodeMaterial(position:Position,perspective:Side):number[]{
  const encoded:number[]=[];
  for(const row of position.board){
    for(const piece of row){
      if(!piece)continue;
      const sign=piece.side===perspective?1:-1;
      encoded.push(sign*pieceCodes[piece.kind]);
    }
  }
  for(const side of ['sente','gote'] as const){
    const sign=side===perspective?1:-1;
    for(const kind of handKinds){
      const count=position.hands[side][kind];
      for(let i=0;i<count;i++)encoded.push(sign*pieceCodes[kind]);
    }
  }
  return encoded;
}

function validExports(exports:WebAssembly.Exports):exports is ShogiWasmExports{
  const candidate=exports as Partial<ShogiWasmExports>;
  return candidate.memory instanceof WebAssembly.Memory
    &&typeof candidate.shogi_engine_version==='function'
    &&typeof candidate.shogi_input_buffer==='function'
    &&typeof candidate.shogi_input_capacity==='function'
    &&typeof candidate.shogi_evaluate_material_codes==='function';
}

async function instantiate(url:string):Promise<WebAssembly.Instance>{
  const response=await fetch(url,{cache:'no-store',credentials:'omit'});
  if(!response.ok)throw new Error(`WASM_HTTP_${response.status}`);
  if(typeof WebAssembly.instantiateStreaming==='function'){
    try{
      const result=await WebAssembly.instantiateStreaming(response.clone(),{});
      return result.instance;
    }catch{
      // Some static hosts may not send application/wasm. Fall back to ArrayBuffer.
    }
  }
  const bytes=await response.arrayBuffer();
  const result=await WebAssembly.instantiate(bytes,{});
  return result.instance;
}

export async function loadWasmMaterialEvaluator(url:string):Promise<WasmMaterialEvaluator|null>{
  try{
    const instance=await instantiate(url);
    if(!validExports(instance.exports))return null;
    const wasm=instance.exports;
    if(wasm.shogi_engine_version()<2)return null;
    const capacity=wasm.shogi_input_capacity();
    const pointer=wasm.shogi_input_buffer();
    if(!Number.isSafeInteger(capacity)||capacity<=0||capacity>4096)return null;
    if(!Number.isSafeInteger(pointer)||pointer<0)return null;

    return(position,perspective)=>{
      const encoded=encodeMaterial(position,perspective);
      if(encoded.length>capacity)throw new Error('WASM_INPUT_CAPACITY');
      const requiredBytes=pointer+capacity*Int32Array.BYTES_PER_ELEMENT;
      if(requiredBytes>wasm.memory.buffer.byteLength)throw new Error('WASM_MEMORY_RANGE');
      const input=new Int32Array(wasm.memory.buffer,pointer,capacity);
      input.fill(0,0,encoded.length);
      input.set(encoded,0);
      return wasm.shogi_evaluate_material_codes(encoded.length);
    };
  }catch{
    return null;
  }
}
