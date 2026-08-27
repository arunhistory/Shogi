import { applyMove, gameOutcome, initialPosition } from '../game/engine';
import type { GameOutcome, Handicap, Move, Position, Side } from '../game/types';

export type OnlinePhase='waiting'|'playing'|'ended';

export interface AuthoritativeRoomState {
  roomId: string;
  version: number;
  phase: OnlinePhase;
  position: Position;
  outcome: GameOutcome;
  processedMoveIds: string[];
}

export interface MoveRequest {
  requestId: string;
  roomId: string;
  expectedVersion: number;
  move: Move;
}

export type MoveDecision =
  | { ok:true; duplicate:false; state:AuthoritativeRoomState }
  | { ok:true; duplicate:true; state:AuthoritativeRoomState }
  | { ok:false; code:'ROOM_MISMATCH'|'NOT_PLAYING'|'NOT_YOUR_TURN'|'STALE_POSITION'|'INVALID_REQUEST_ID'|'ILLEGAL_MOVE'; state:AuthoritativeRoomState };

const requestIdPattern=/^[A-Za-z0-9_-]{16,128}$/;

export function createAuthoritativeRoom(roomId:string,handicap:Handicap='even'):AuthoritativeRoomState{
  return{
    roomId,
    version:0,
    phase:'waiting',
    position:initialPosition(handicap),
    outcome:{ended:false},
    processedMoveIds:[],
  };
}

export function startAuthoritativeRoom(state:AuthoritativeRoomState):AuthoritativeRoomState{
  if(state.phase!=='waiting')return state;
  return{...state,phase:'playing'};
}

// authenticatedSeat is supplied only after the server-side identity/reconnect layer has
// proved which seat the caller owns. Invite URL/passcode knowledge alone must never set it.
export function applyAuthoritativeMove(
  state:AuthoritativeRoomState,
  request:MoveRequest,
  authenticatedSeat:Side,
):MoveDecision{
  if(request.roomId!==state.roomId)return{ok:false,code:'ROOM_MISMATCH',state};
  if(!requestIdPattern.test(request.requestId))return{ok:false,code:'INVALID_REQUEST_ID',state};
  if(state.processedMoveIds.includes(request.requestId))return{ok:true,duplicate:true,state};
  if(state.phase!=='playing')return{ok:false,code:'NOT_PLAYING',state};
  if(state.position.turn!==authenticatedSeat)return{ok:false,code:'NOT_YOUR_TURN',state};
  if(request.expectedVersion!==state.version)return{ok:false,code:'STALE_POSITION',state};

  let nextPosition:Position;
  try{
    nextPosition=applyMove(state.position,request.move);
  }catch{
    return{ok:false,code:'ILLEGAL_MOVE',state};
  }

  const outcome=gameOutcome(nextPosition);
  const next:AuthoritativeRoomState={
    ...state,
    version:state.version+1,
    position:nextPosition,
    outcome,
    phase:outcome.ended?'ended':'playing',
    processedMoveIds:[...state.processedMoveIds,request.requestId],
  };
  return{ok:true,duplicate:false,state:next};
}
