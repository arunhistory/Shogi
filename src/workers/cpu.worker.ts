/// <reference lib="webworker" />
import { decodePackedWasmMove, legalMoves, serializePositionForWasm } from '../game/engine';
import { SHOGI_ENGINE_WASM_BASE64 } from '../game/engineBinary';
import type { CpuLevel, Move, Position } from '../game/types';

type CpuRequest = { id:string; position:Position; level:CpuLevel };
type CpuResponse = { id:string; move:Move|null; nodes:number; engine:'wasm'|'fallback'; error?:string };

type WasmExports = {
  memory: WebAssembly.Memory;
  shogi_engine_version: () => number;
  shogi_position_buffer: () => number;
  shogi_find_best_move: (level:number) => number;
  shogi_last_nodes: () => number;
};

let enginePromise: Promise<WasmExports> | null = null;
const levelIndex: Record<CpuLevel,number> = {beginner:0,intermediate:1,amateur:2,pro:3,title:4};
const moveKey = (m:Move) => `${m.from?.join(',') ?? `d:${m.drop}`}>${m.to.join(',')}:${m.promote?1:0}`;

function loadEngine(): Promise<WasmExports> {
  if (!enginePromise) enginePromise = (async () => {
    const raw = atob(SHOGI_ENGINE_WASM_BASE64);
    const bytes = new Uint8Array(raw.length);
    for (let i=0;i<raw.length;i++) bytes[i] = raw.charCodeAt(i);
    const result = await WebAssembly.instantiate(bytes, {});
    const exp = result.instance.exports as unknown as WasmExports;
    if (exp.shogi_engine_version() !== 2) throw new Error('WASM_ENGINE_VERSION_MISMATCH');
    return exp;
  })();
  return enginePromise;
}

function fallback(position:Position): Move|null {
  const moves = legalMoves(position);
  if (!moves.length) return null;
  const scored = moves.map(move => {
    const target = position.board[move.to[0]]![move.to[1]];
    const capture = target ? 100 : 0;
    const promote = move.promote ? 30 : 0;
    return {move,score:capture+promote};
  }).sort((a,b)=>b.score-a.score || moveKey(a.move).localeCompare(moveKey(b.move)));
  return scored[0]!.move;
}

self.addEventListener('message', async (event:MessageEvent<CpuRequest>) => {
  const {id,position,level} = event.data;
  const response: CpuResponse = {id,move:null,nodes:0,engine:'fallback'};
  try {
    const legal = legalMoves(position);
    if (!legal.length) { self.postMessage(response); return; }
    const legalByKey = new Map(legal.map(m => [moveKey(m),m]));
    const wasm = await loadEngine();
    const serialized = serializePositionForWasm(position);
    const ptr = wasm.shogi_position_buffer();
    new Int32Array(wasm.memory.buffer,ptr,serialized.length).set(serialized);
    const packed = wasm.shogi_find_best_move(levelIndex[level]);
    const proposed = decodePackedWasmMove(packed);
    const verified = proposed ? legalByKey.get(moveKey(proposed)) : undefined;
    if (verified) {
      response.move = verified;
      response.nodes = wasm.shogi_last_nodes();
      response.engine = 'wasm';
    } else {
      response.move = fallback(position);
      response.error = 'WASM_MOVE_REJECTED_BY_RULE_ENGINE';
    }
  } catch (error) {
    response.move = fallback(position);
    response.error = error instanceof Error ? error.message : 'CPU_ENGINE_ERROR';
  }
  self.postMessage(response);
});
