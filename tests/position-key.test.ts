import { describe, expect, it } from 'vitest';
import { initialPosition, positionKey } from '../src/game/engine';
import { decodePositionKey, encodePositionKey } from '../src/game/position-key';

describe('position history keys',()=>{
  it('round-trips the complete rule state in a compact canonical form',()=>{
    const position=initialPosition('six');
    position.hands.sente.pawn=3;
    position.hands.gote.bishop=1;
    const key=positionKey(position);
    expect(key.startsWith('v1|')).toBe(true);
    expect(key.length).toBeLessThan(180);
    const decoded=decodePositionKey(key);
    expect(decoded.turn).toBe(position.turn);
    expect(decoded.board).toEqual(position.board);
    expect(decoded.hands).toEqual(position.hands);
    expect(encodePositionKey(decoded)).toBe(key);
  });

  it('distinguishes turn and hand state for repetition identity',()=>{
    const position=initialPosition();
    const original=positionKey(position);
    const otherTurn={...position,turn:'gote' as const};
    expect(positionKey(otherTurn)).not.toBe(original);
    const otherHands={
      ...position,
      hands:{sente:{...position.hands.sente,pawn:1},gote:{...position.hands.gote}},
    };
    expect(positionKey(otherHands)).not.toBe(original);
  });

  it('still decodes the legacy JSON history-key format',()=>{
    const position=initialPosition('bishop');
    const legacy=JSON.stringify([position.turn,position.board,position.hands]);
    const decoded=decodePositionKey(legacy);
    expect(decoded.turn).toBe(position.turn);
    expect(decoded.board).toEqual(position.board);
    expect(decoded.hands).toEqual(position.hands);
  });
});
