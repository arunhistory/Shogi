import { describe, expect, it } from 'vitest';
import {
  chooseCpuFallbackMove,
  chooseCpuMove,
  chooseCpuMoveFromRanked,
  CPU_BUDGETS,
  CPU_PARALLEL_PROFILES,
  rankCpuMovesFast,
} from '../src/game/cpu';
import { applyLegalMoveUnchecked, initialPosition, isCheck, legalMoves } from '../src/game/engine';
import type { CpuLevel, Move, Position } from '../src/game/types';

const levels:CpuLevel[]=['beginner','intermediate','amateur','pro','title'];

function emptyHands(){
  return{
    sente:{king:0,rook:0,bishop:0,gold:0,silver:0,knight:0,lance:0,pawn:0},
    gote:{king:0,rook:0,bishop:0,gold:0,silver:0,knight:0,lance:0,pawn:0},
  };
}

function mateInOnePosition():Position{
  const board=Array.from({length:9},()=>Array(9).fill(null)) as Position['board'];
  board[0]![0]={side:'gote',kind:'king'};
  board[2]![0]={side:'sente',kind:'gold'};
  board[2]![2]={side:'sente',kind:'knight'};
  board[8]![8]={side:'sente',kind:'king'};
  const hands=emptyHands();
  hands.sente.rook=1;
  return{board,hands,turn:'sente',ply:20,history:[]};
}

describe('parallel classical CPU search',()=>{
  it('returns legal fallback and serial moves without mutating the source position',()=>{
    const position=initialPosition();
    const before=JSON.stringify(position);
    const legal=legalMoves(position);
    const fallback=chooseCpuFallbackMove(position,'title');
    const serial=chooseCpuMove(position,'beginner');
    expect(fallback).not.toBeNull();
    expect(serial.move).not.toBeNull();
    expect(legal.some(move=>JSON.stringify(move)===JSON.stringify(fallback))).toBe(true);
    expect(legal.some(move=>JSON.stringify(move)===JSON.stringify(serial.move))).toBe(true);
    expect(JSON.stringify(position)).toBe(before);
  });

  it('ranks every legal root move once in the fast fallback pass',()=>{
    const position=initialPosition();
    const ranked=rankCpuMovesFast(position,'title');
    expect(ranked).toHaveLength(legalMoves(position).length);
    expect(new Set(ranked.map(item=>JSON.stringify(item.move))).size).toBe(ranked.length);
  });

  it('keeps every serial safety budget far below the two-second reply requirement',()=>{
    expect(Object.keys(CPU_BUDGETS).sort()).toEqual([...levels].sort());
    for(const level of levels)expect(CPU_BUDGETS[level].timeMs).toBeLessThan(1000);
  });

  it('defines all five reply profiles below two seconds with increasing parallel density',()=>{
    expect(Object.keys(CPU_PARALLEL_PROFILES).sort()).toEqual([...levels].sort());
    for(const level of levels)expect(CPU_PARALLEL_PROFILES[level].replyDeadlineMs).toBeLessThan(1900);
    for(let index=1;index<levels.length;index++){
      const weaker=CPU_PARALLEL_PROFILES[levels[index-1]!]!;
      const stronger=CPU_PARALLEL_PROFILES[levels[index]!]!;
      expect(stronger.workerCap).toBeGreaterThanOrEqual(weaker.workerCap);
      expect(stronger.logicalJobTarget).toBeGreaterThan(weaker.logicalJobTarget);
      expect(stronger.maxDepth).toBeGreaterThan(weaker.maxDepth);
      expect(stronger.lanes).toBeGreaterThanOrEqual(weaker.lanes);
      expect(stronger.profileCode).toBeGreaterThan(weaker.profileCode);
    }
  });

  it('separates pro and title search strategy instead of only adding workers',()=>{
    const pro=CPU_PARALLEL_PROFILES.pro;
    const title=CPU_PARALLEL_PROFILES.title;
    expect(title.profileCode).not.toBe(pro.profileCode);
    expect(title.baseDepth).toBeGreaterThan(pro.baseDepth);
    expect(title.depthStep).toBeGreaterThan(pro.depthStep);
    expect(title.nodeBase).toBeGreaterThan(pro.nodeBase);
    expect(title.retention).toBeLessThan(pro.retention);
    expect(title.maxDepth).toBe(12);
  });

  it('does not randomize pro or title decisions',()=>{
    const first:Move={from:[6,0],to:[5,0]};
    const second:Move={from:[6,1],to:[5,1]};
    const ranked=[{move:first,score:100},{move:second,score:99}];
    expect(CPU_PARALLEL_PROFILES.pro.variationPool).toBe(1);
    expect(CPU_PARALLEL_PROFILES.title.variationPool).toBe(1);
    expect(chooseCpuMoveFromRanked('pro',2,ranked,()=>0.999)).toEqual(first);
    expect(chooseCpuMoveFromRanked('title',20,ranked,()=>0.999)).toEqual(first);
  });

  it('puts an available immediate mate above positional alternatives for upper CPU levels',()=>{
    const position=mateInOnePosition();
    for(const level of ['pro','title'] as const){
      const ranked=rankCpuMovesFast(position,level);
      expect(ranked.length).toBeGreaterThan(0);
      expect(ranked[0]!.score).toBeGreaterThan(800000);
      const next=applyLegalMoveUnchecked(position,ranked[0]!.move);
      expect(isCheck(next,'gote')).toBe(true);
      expect(legalMoves(next)).toHaveLength(0);
    }
  });

  it('allocates high-density search specifically to pro and title class',()=>{
    expect(CPU_PARALLEL_PROFILES.pro.logicalJobTarget).toBeGreaterThanOrEqual(96);
    expect(CPU_PARALLEL_PROFILES.title.logicalJobTarget).toBeGreaterThanOrEqual(256);
    expect(CPU_PARALLEL_PROFILES.pro.workerCap).toBeGreaterThanOrEqual(4);
    expect(CPU_PARALLEL_PROFILES.title.workerCap).toBeGreaterThan(CPU_PARALLEL_PROFILES.pro.workerCap);
    expect(CPU_PARALLEL_PROFILES.title.replyDeadlineMs).toBeLessThanOrEqual(1650);
  });
});
