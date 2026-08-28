import { describe, expect, it } from 'vitest';
import { HANDICAP_RULE_LIST, HANDICAP_RULES, handicapRule, isHandicap } from '../src/game/handicaps';
import { initialPosition } from '../src/game/engine';
import type { Handicap, PieceKind } from '../src/game/types';

function countGote(handicap:Handicap,kind:PieceKind):number{
  return initialPosition(handicap).board.flat().filter(piece=>piece?.side==='gote'&&piece.kind===kind).length;
}

describe('shared handicap registry',()=>{
  it('defines every required method once and in display order',()=>{
    expect(HANDICAP_RULE_LIST.map(rule=>rule.id)).toEqual(['even','rook','bishop','two','four','six']);
    expect(new Set(HANDICAP_RULE_LIST.map(rule=>rule.id)).size).toBe(HANDICAP_RULE_LIST.length);
    for(const rule of HANDICAP_RULE_LIST)expect(HANDICAP_RULES[rule.id]).toBe(rule);
  });

  it('is the validation boundary for supported handicap ids',()=>{
    for(const rule of HANDICAP_RULE_LIST){
      expect(isHandicap(rule.id)).toBe(true);
      expect(handicapRule(rule.id)).toBe(rule);
    }
    expect(isHandicap('eight')).toBe(false);
    expect(isHandicap('')).toBe(false);
    expect(isHandicap(null)).toBe(false);
  });

  it('preserves the six required starting positions and first turns',()=>{
    const expected:Record<Handicap,{turn:'sente'|'gote';rook:number;bishop:number;lance:number;knight:number}>={
      even:{turn:'sente',rook:1,bishop:1,lance:2,knight:2},
      rook:{turn:'gote',rook:0,bishop:1,lance:2,knight:2},
      bishop:{turn:'gote',rook:1,bishop:0,lance:2,knight:2},
      two:{turn:'gote',rook:0,bishop:0,lance:2,knight:2},
      four:{turn:'gote',rook:0,bishop:0,lance:0,knight:2},
      six:{turn:'gote',rook:0,bishop:0,lance:0,knight:0},
    };
    for(const rule of HANDICAP_RULE_LIST){
      const value=expected[rule.id];
      expect(initialPosition(rule.id).turn,rule.id).toBe(value.turn);
      expect(countGote(rule.id,'rook'),rule.id).toBe(value.rook);
      expect(countGote(rule.id,'bishop'),rule.id).toBe(value.bishop);
      expect(countGote(rule.id,'lance'),rule.id).toBe(value.lance);
      expect(countGote(rule.id,'knight'),rule.id).toBe(value.knight);
    }
  });
});
