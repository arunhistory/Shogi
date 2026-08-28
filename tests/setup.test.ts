import { describe, expect, it } from 'vitest';
import { configuredInitialPosition, handicapPairFromLegacy, oppositeSide } from '../src/game/setup';

function countSide(position:ReturnType<typeof configuredInitialPosition>,side:'sente'|'gote'){
  return position.board.flat().filter(piece=>piece?.side===side).length;
}

describe('match setup',()=>{
  it('keeps even games at twenty pieces per side and starts with sente',()=>{
    const position=configuredInitialPosition({sente:'even',gote:'even'});
    expect(countSide(position,'sente')).toBe(20);
    expect(countSide(position,'gote')).toBe(20);
    expect(position.turn).toBe('sente');
  });

  it('applies independent handicaps to sente and gote at the same time',()=>{
    const position=configuredInitialPosition({sente:'two',gote:'bishop'});
    expect(countSide(position,'sente')).toBe(18);
    expect(countSide(position,'gote')).toBe(19);
    expect(position.board.flat().some(piece=>piece?.side==='sente'&&piece.kind==='rook')).toBe(false);
    expect(position.board.flat().some(piece=>piece?.side==='sente'&&piece.kind==='bishop')).toBe(false);
    expect(position.board.flat().some(piece=>piece?.side==='gote'&&piece.kind==='rook')).toBe(true);
    expect(position.board.flat().some(piece=>piece?.side==='gote'&&piece.kind==='bishop')).toBe(false);
  });

  it('can apply six-piece handicap to both sides simultaneously',()=>{
    const position=configuredInitialPosition({sente:'six',gote:'six'});
    expect(countSide(position,'sente')).toBe(14);
    expect(countSide(position,'gote')).toBe(14);
    for(const side of ['sente','gote'] as const){
      const pieces=position.board.flat().filter(piece=>piece?.side===side);
      expect(pieces.filter(piece=>piece?.kind==='lance')).toHaveLength(0);
      expect(pieces.filter(piece=>piece?.kind==='knight')).toHaveLength(0);
      expect(pieces.filter(piece=>piece?.kind==='rook')).toHaveLength(0);
      expect(pieces.filter(piece=>piece?.kind==='bishop')).toHaveLength(0);
    }
  });

  it('keeps legacy one-side setup readable for existing clients and rooms',()=>{
    expect(handicapPairFromLegacy('rook','sente')).toEqual({sente:'rook',gote:'even'});
    const position=configuredInitialPosition('rook','sente');
    expect(countSide(position,'sente')).toBe(19);
    expect(countSide(position,'gote')).toBe(20);
  });

  it('resolves opposite sides deterministically',()=>{
    expect(oppositeSide('sente')).toBe('gote');
    expect(oppositeSide('gote')).toBe('sente');
  });
});
