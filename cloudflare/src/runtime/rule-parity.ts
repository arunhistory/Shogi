import { applyMove, gameOutcome, isCheck } from '../../../src/game/engine';
import type { GameOutcome, Move, Position } from '../../../src/game/types';
import { cloudflareWasmEngine } from './wasm-engine';

export type RuleParityResult=
  |{ok:true;position:Position;outcome:GameOutcome}
  |{ok:false;code:'ILLEGAL_MOVE'|'GAME_NOT_PLAYING'|'ENGINE_PARITY_FAILURE'|'ENGINE_UNAVAILABLE'};

export function validateMoveWithWasm(position:Position,move:Move):RuleParityResult{
  let wasmLegal:boolean;
  try{
    wasmLegal=cloudflareWasmEngine.isLegalMove(position,move);
  }catch{
    return{ok:false,code:'ENGINE_UNAVAILABLE'};
  }

  let next:Position;
  try{
    next=applyMove(position,move);
  }catch(error){
    if(wasmLegal)return{ok:false,code:'ENGINE_PARITY_FAILURE'};
    return{
      ok:false,
      code:error instanceof Error&&error.message==='GAME_ENDED'?'GAME_NOT_PLAYING':'ILLEGAL_MOVE',
    };
  }
  if(!wasmLegal)return{ok:false,code:'ENGINE_PARITY_FAILURE'};

  const outcome=gameOutcome(next);
  try{
    const tsCheck=isCheck(next,next.turn);
    const wasmCheck=cloudflareWasmEngine.isCheck(next,next.turn);
    const tsMate=outcome.ended&&outcome.reason==='mate';
    const wasmMate=cloudflareWasmEngine.isMate(next);
    if(tsCheck!==wasmCheck||tsMate!==wasmMate)return{ok:false,code:'ENGINE_PARITY_FAILURE'};
  }catch{
    return{ok:false,code:'ENGINE_UNAVAILABLE'};
  }
  return{ok:true,position:next,outcome};
}
