import { describe, expect, it } from 'vitest';
import {
  applyMove,
  emptyHands,
  gameOutcome,
  initialPosition,
  isCheck,
  legalMoves,
  positionKey,
  repetitionCount,
  repetitionStatus,
} from '../src/game/engine';
import type { Board, Position } from '../src/game/types';

function blankPosition(turn:'sente'|'gote'='sente'):Position{
  const board:Board=Array.from({length:9},()=>Array(9).fill(null));
  board[8]![4]={side:'sente',kind:'king'};
  board[0]![4]={side:'gote',kind:'king'};
  const pos:Position={board,hands:emptyHands(),turn,ply:0,history:[]};
  pos.history.push({key:positionKey(pos),mover:null,gaveCheck:false});
  return pos;
}

describe('shogi engine',()=>{
  it('starts with legal moves, sente to move, and the initial position in history',()=>{
    const p=initialPosition('even');
    expect(p.turn).toBe('sente');
    expect(legalMoves(p).length).toBeGreaterThan(0);
    expect(repetitionCount(p)).toBe(1);
  });

  it('rejects an illegal move without mutating position',()=>{
    const p=initialPosition();
    const before=JSON.stringify(p);
    expect(()=>applyMove(p,{from:[8,4],to:[7,4]})).toThrow('ILLEGAL_MOVE');
    expect(JSON.stringify(p)).toBe(before);
  });

  it('handicap removes upper-side pieces and makes gote move first',()=>{
    const p=initialPosition('rook');
    expect(p.turn).toBe('gote');
    expect(p.board.flat().some(piece=>piece?.side==='gote'&&piece.kind==='rook')).toBe(false);
  });

  it('detects check but never generates a move that captures the king',()=>{
    const p=blankPosition('sente');
    p.board[1]![4]={side:'sente',kind:'rook'};
    expect(isCheck(p,'gote')).toBe(true);
    expect(legalMoves(p).some(move=>move.to[0]===0&&move.to[1]===4)).toBe(false);
  });

  it('classifies fourfold repetition separately from perpetual check',()=>{
    const p=blankPosition('sente');
    const key=positionKey(p);
    p.history=[
      {key,mover:null,gaveCheck:false},
      {key:'a',mover:'sente',gaveCheck:false},
      {key,mover:'gote',gaveCheck:false},
      {key:'b',mover:'sente',gaveCheck:false},
      {key,mover:'gote',gaveCheck:false},
      {key:'c',mover:'sente',gaveCheck:false},
      {key,mover:'gote',gaveCheck:false},
    ];
    expect(repetitionStatus(p)).toEqual({kind:'normal'});
    expect(gameOutcome(p)).toEqual({ended:true,reason:'repetition',draw:true});
  });

  it('makes the continuously checking side lose on perpetual-check repetition',()=>{
    const p=blankPosition('sente');
    const key=positionKey(p);
    p.history=[
      {key,mover:null,gaveCheck:false},
      {key:'a',mover:'sente',gaveCheck:true},
      {key,mover:'gote',gaveCheck:false},
      {key:'b',mover:'sente',gaveCheck:true},
      {key,mover:'gote',gaveCheck:false},
      {key:'c',mover:'sente',gaveCheck:true},
      {key,mover:'gote',gaveCheck:false},
    ];
    expect(repetitionStatus(p)).toEqual({kind:'perpetual-check',loser:'sente'});
    expect(gameOutcome(p)).toEqual({ended:true,reason:'perpetual-check',winner:'gote',loser:'sente'});
  });
});
