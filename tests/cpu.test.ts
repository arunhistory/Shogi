import { describe, expect, it } from 'vitest';
import { chooseCpuMove, CPU_BUDGETS } from '../src/game/cpu';
import { initialPosition, legalMoves } from '../src/game/engine';
import type { CpuLevel } from '../src/game/types';

const levels:CpuLevel[]=['beginner','intermediate','amateur','pro','title'];

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

  it('defines all five required levels with strictly increasing search ceilings',()=>{
    expect(Object.keys(CPU_BUDGETS).sort()).toEqual([...levels].sort());
    for(let index=1;index<levels.length;index++){
      const weaker=CPU_BUDGETS[levels[index-1]!]!;
      const stronger=CPU_BUDGETS[levels[index]!]!;
      expect(stronger.maxDepth).toBeGreaterThan(weaker.maxDepth);
      expect(stronger.timeMs).toBeGreaterThan(weaker.timeMs);
    }
  });
});
