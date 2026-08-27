import { describe, expect, it } from 'vitest';
import { initialPosition } from '../src/game/engine';
import { parseAuthoritativeState } from '../src/online/client';

const roomId='room_test_12345678';

function playingState(){
  return{
    roomId,
    revision:7,
    position:initialPosition(),
    status:'playing' as const,
    connections:{sente:5,gote:3},
  };
}

function clone<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T;}

describe('authoritative client state validation',()=>{
  it('accepts a valid authoritative state up to the room connection ceiling',()=>{
    const parsed=parseAuthoritativeState(playingState(),roomId);
    expect(parsed).not.toBeNull();
    expect(parsed?.connections).toEqual({sente:5,gote:3});
  });

  it('rejects connection counts beyond the authoritative room ceiling',()=>{
    const state=playingState();
    state.connections={sente:5,gote:4};
    expect(parseAuthoritativeState(state,roomId)).toBeNull();
  });

  it('rejects malformed pieces, hands, and history before adopting a position',()=>{
    const badPiece=clone(playingState());
    badPiece.position.board[6]![0]={side:'sente',kind:'unknown'} as never;
    expect(parseAuthoritativeState(badPiece,roomId)).toBeNull();

    const badHands=clone(playingState());
    badHands.position.hands.sente.king=1;
    expect(parseAuthoritativeState(badHands,roomId)).toBeNull();

    const badHistory=clone(playingState());
    badHistory.position.history[0]!.key='tampered';
    expect(parseAuthoritativeState(badHistory,roomId)).toBeNull();
  });

  it('requires terminal result metadata to agree with the room status',()=>{
    const missingWinner={...playingState(),status:'ended' as const,resultReason:'mate'};
    expect(parseAuthoritativeState(missingWinner,roomId)).toBeNull();

    const repetition={...playingState(),status:'ended' as const,resultReason:'repetition'};
    expect(parseAuthoritativeState(repetition,roomId)).not.toBeNull();

    const impossibleLiveResult={...playingState(),winner:'sente' as const,resultReason:'mate'};
    expect(parseAuthoritativeState(impossibleLiveResult,roomId)).toBeNull();
  });
});
