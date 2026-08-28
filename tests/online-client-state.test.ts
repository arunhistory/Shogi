import { describe, expect, it } from 'vitest';
import { applyMove, initialPosition } from '../src/game/engine';
import { parseAuthoritativeState } from '../src/online/client';

const roomId='room_test_12345678';

function playingState(){
  return{
    roomId,
    revision:7,
    position:initialPosition(),
    status:'playing' as const,
    connections:{sente:5,gote:3},
    handicap:'even' as const,
    handicapSide:'gote' as const,
    order:'random' as const,
    startedAt:1_700_000_000_000,
  };
}

function clone<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T;}

describe('authoritative client state validation',()=>{
  it('accepts a valid authoritative state up to the room connection ceiling',()=>{
    const parsed=parseAuthoritativeState(playingState(),roomId);
    expect(parsed).not.toBeNull();
    expect(parsed?.connections).toEqual({sente:5,gote:3});
    expect(parsed?.startedAt).toBe(1_700_000_000_000);
  });

  it('accepts a current-position-only history snapshot for long online games',()=>{
    const moved=applyMove(initialPosition(),{from:[6,4],to:[5,4]});
    const state={...playingState(),revision:8,position:{...moved,history:moved.history.slice(-1)}};
    const parsed=parseAuthoritativeState(state,roomId);
    expect(parsed).not.toBeNull();
    expect(parsed?.position.ply).toBe(1);
    expect(parsed?.position.history).toHaveLength(1);
  });

  it('keeps accepting the legacy full authoritative history during transition',()=>{
    const moved=applyMove(initialPosition(),{from:[6,4],to:[5,4]});
    const state={...playingState(),revision:8,position:moved};
    expect(parseAuthoritativeState(state,roomId)).not.toBeNull();
  });

  it('accepts resignation as an authoritative terminal result',()=>{
    const ended={...playingState(),status:'ended' as const,winner:'gote' as const,resultReason:'resignation',endedAt:1_700_000_010_000};
    const parsed=parseAuthoritativeState(ended,roomId);
    expect(parsed).not.toBeNull();
    expect(parsed?.winner).toBe('gote');
    expect(parsed?.resultReason).toBe('resignation');
  });

  it('rejects end timestamps before the start timestamp',()=>{
    const ended={...playingState(),status:'ended' as const,winner:'sente' as const,resultReason:'mate',endedAt:1_699_999_999_999};
    expect(parseAuthoritativeState(ended,roomId)).toBeNull();
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

    const repetition={...playingState(),status:'ended' as const,resultReason:'repetition',endedAt:1_700_000_010_000};
    expect(parseAuthoritativeState(repetition,roomId)).not.toBeNull();

    const impossibleLiveResult={...playingState(),winner:'sente' as const,resultReason:'mate'};
    expect(parseAuthoritativeState(impossibleLiveResult,roomId)).toBeNull();
  });
});
