import { describe, expect, it } from 'vitest';
import { chooseCpuMove } from '../src/game/cpu';
import { initialPosition, legalMoves } from '../src/game/engine';

describe('classical CPU search',()=>{
  it('returns a legal move without mutating the source position',()=>{
    const position=initialPosition();
    const before=JSON.stringify(position);
    const legal=legalMoves(position);
    const result=chooseCpuMove(position,'beginner');
    expect(result.move).not.toBeNull();
    expect(legal.some(move=>JSON.stringify(move)===JSON.stringify(result.move))).toBe(true);
    expect(result.completedDepth).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(position)).toBe(before);
  });
});
