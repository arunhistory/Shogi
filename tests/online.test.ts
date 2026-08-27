import { describe, expect, it } from 'vitest';
import { legalMoves } from '../src/game/engine';
import { applyAuthoritativeMove, createAuthoritativeRoom, startAuthoritativeRoom } from '../src/online/authoritative';

describe('authoritative online state',()=>{
  it('applies one legal request exactly once',()=>{
    const started=startAuthoritativeRoom(createAuthoritativeRoom('room-a'));
    const move=legalMoves(started.position)[0]!;
    const request={requestId:'request_00000001',roomId:'room-a',expectedRevision:0,move};
    const first=applyAuthoritativeMove(started,request,'sente');
    expect(first.ok).toBe(true);
    if(!first.ok)throw new Error('unexpected rejection');
    expect(first.duplicate).toBe(false);
    expect(first.state.revision).toBe(1);
    expect(first.state.position.ply).toBe(1);

    const retry=applyAuthoritativeMove(first.state,request,'sente');
    expect(retry.ok).toBe(true);
    if(!retry.ok)throw new Error('unexpected retry rejection');
    expect(retry.duplicate).toBe(true);
    expect(retry.state.revision).toBe(1);
    expect(retry.state.position.ply).toBe(1);
  });

  it('rejects stale state and wrong-seat operations without changing state',()=>{
    const started=startAuthoritativeRoom(createAuthoritativeRoom('room-b'));
    const move=legalMoves(started.position)[0]!;
    const before=JSON.stringify(started);
    const wrongSeat=applyAuthoritativeMove(started,{requestId:'request_00000002',roomId:'room-b',expectedRevision:0,move},'gote');
    expect(wrongSeat).toMatchObject({ok:false,code:'NOT_YOUR_TURN'});
    expect(JSON.stringify(started)).toBe(before);

    const stale=applyAuthoritativeMove(started,{requestId:'request_00000003',roomId:'room-b',expectedRevision:99,move},'sente');
    expect(stale).toMatchObject({ok:false,code:'STALE_POSITION'});
    expect(JSON.stringify(started)).toBe(before);
  });
});
