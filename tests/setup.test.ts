import { describe, expect, it } from 'vitest';
import { configuredInitialPosition, oppositeSide } from '../src/game/setup';

function countSide(position:ReturnType<typeof configuredInitialPosition>,side:'sente'|'gote'){
  return position.board.flat().filter(piece=>piece?.side===side).length;
}

describe('match setup',()=>{
  it('keeps even games at twenty pieces per side and starts with sente',()=>{
    const position=configuredInitialPosition('even','sente');
    expect(countSide(position,'sente')).toBe(20);
    expect(countSide(position,'gote')).toBe(20);
    expect(position.turn).toBe('sente');
  });

  it('can apply the same handicap to either side',()=>{
    const sente=configuredInitialPosition('two','sente');
    const gote=configuredInitialPosition('two','gote');
    expect(countSide(sente,'sente')).toBe(18);
    expect(countSide(sente,'gote')).toBe(20);
    expect(countSide(gote,'sente')).toBe(20);
    expect(countSide(gote,'gote')).toBe(18);
    expect(sente.board.flat().some(piece=>piece?.side==='sente'&&piece.kind==='rook')).toBe(false);
    expect(sente.board.flat().some(piece=>piece?.side==='sente'&&piece.kind==='bishop')).toBe(false);
    expect(gote.board.flat().some(piece=>piece?.side==='gote'&&piece.kind==='rook')).toBe(false);
    expect(gote.board.flat().some(piece=>piece?.side==='gote'&&piece.kind==='bishop')).toBe(false);
  });

  it('removes every requested duplicate piece for six-piece handicap',()=>{
    const position=configuredInitialPosition('six','sente');
    const sente=position.board.flat().filter(piece=>piece?.side==='sente');
    expect(sente).toHaveLength(14);
    expect(sente.filter(piece=>piece?.kind==='lance')).toHaveLength(0);
    expect(sente.filter(piece=>piece?.kind==='knight')).toHaveLength(0);
  });

  it('resolves opposite sides deterministically',()=>{
    expect(oppositeSide('sente')).toBe('gote');
    expect(oppositeSide('gote')).toBe('sente');
  });
});
