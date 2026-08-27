import { describe, expect, it } from 'vitest';
import { SHOGI_ENGINE_WASM_BASE64 } from '../src/game/engineBinary';
import { decodePackedWasmMove, initialPosition, legalMoves, serializePositionForWasm } from '../src/game/engine';

describe('C++ WebAssembly CPU engine',()=>{
  it('loads, reports the expected version and proposes a TypeScript-verified legal move',async()=>{
    const bytes=Uint8Array.from(Buffer.from(SHOGI_ENGINE_WASM_BASE64,'base64'));
    const {instance}=await WebAssembly.instantiate(bytes,{});
    const exp=instance.exports as unknown as {memory:WebAssembly.Memory;shogi_engine_version:()=>number;shogi_position_buffer:()=>number;shogi_find_best_move:(level:number)=>number};
    expect(exp.shogi_engine_version()).toBe(2);
    const pos=initialPosition();const serialized=serializePositionForWasm(pos);new Int32Array(exp.memory.buffer,exp.shogi_position_buffer(),serialized.length).set(serialized);
    const move=decodePackedWasmMove(exp.shogi_find_best_move(0));expect(move).not.toBeNull();expect(legalMoves(pos)).toContainEqual(move);
  });
});
