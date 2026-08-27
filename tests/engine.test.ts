import { describe, expect, it } from 'vitest';
import { applyMove, emptyHands, gameResult, initialPosition, legalMoves, positionKey, repetitionCount } from '../src/game/engine';
import type { Board, HistoryEntry, Position } from '../src/game/types';

function emptyBoard():Board{return Array.from({length:9},()=>Array(9).fill(null));}
function custom(board:Board,turn:'sente'|'gote'='sente'):Position{const p:Position={board,hands:emptyHands(),turn,ply:0,history:[]};p.history=[{key:positionKey(p),turn,lastMoveBy:null,gaveCheck:false}];return p;}

describe('shogi rules engine',()=>{
  it('starts a normal game with sente and records the initial position',()=>{const p=initialPosition();expect(p.turn).toBe('sente');expect(p.history).toHaveLength(1);expect(repetitionCount(p)).toBe(1);expect(legalMoves(p).length).toBeGreaterThan(0);});
  it('starts handicap games with the upper side (internal gote) to move',()=>{expect(initialPosition('rook').turn).toBe('gote');expect(initialPosition('six').turn).toBe('gote');});
  it('rejects illegal moves without mutating the source position',()=>{const p=initialPosition();const before=JSON.stringify(p);expect(()=>applyMove(p,{from:[8,4],to:[6,4]})).toThrow('ILLEGAL_MOVE');expect(JSON.stringify(p)).toBe(before);});
  it('never generates a move that captures the opposing king',()=>{const b=emptyBoard();b[8]![4]={side:'sente',kind:'king'};b[0]![4]={side:'gote',kind:'king'};b[1]![4]={side:'sente',kind:'rook'};const p=custom(b);expect(legalMoves(p).some(m=>m.to[0]===0&&m.to[1]===4)).toBe(false);});
  it('enforces nifu for pawn drops',()=>{const b=emptyBoard();b[8]![4]={side:'sente',kind:'king'};b[0]![4]={side:'gote',kind:'king'};b[6]![3]={side:'sente',kind:'pawn'};const p=custom(b);p.hands.sente.pawn=1;const drops=legalMoves(p).filter(m=>m.drop==='pawn');expect(drops.some(m=>m.to[1]===3)).toBe(false);expect(drops.some(m=>m.to[1]===2)).toBe(true);});
  it('forces promotion when a pawn reaches the last rank',()=>{const b=emptyBoard();b[8]![4]={side:'sente',kind:'king'};b[0]![8]={side:'gote',kind:'king'};b[1]![0]={side:'sente',kind:'pawn'};const p=custom(b);const candidates=legalMoves(p).filter(m=>m.from?.[0]===1&&m.from[1]===0&&m.to[0]===0);expect(candidates).toHaveLength(1);expect(candidates[0]!.promote).toBe(true);});
  it('declares normal fourfold repetition as no-result',()=>{const p=initialPosition();const key=positionKey(p);const h:HistoryEntry[]=[];for(let i=0;i<4;i++){h.push({key,turn:p.turn,lastMoveBy:i===0?null:'gote',gaveCheck:false});if(i<3)h.push({key:`other-${i}`,turn:'gote',lastMoveBy:'sente',gaveCheck:false});}p.history=h;expect(repetitionCount(p)).toBe(4);expect(gameResult(p)).toEqual({status:'finished',reason:'repetition',winner:null,loser:null});});
  it('separates perpetual-check repetition and makes the checking side lose',()=>{const p=initialPosition();const key=positionKey(p);const h:HistoryEntry[]=[{key,turn:'sente',lastMoveBy:null,gaveCheck:false}];for(let i=0;i<3;i++){h.push({key:`checked-${i}`,turn:'gote',lastMoveBy:'sente',gaveCheck:true});h.push({key,turn:'sente',lastMoveBy:'gote',gaveCheck:false});}p.history=h;expect(gameResult(p)).toEqual({status:'finished',reason:'perpetual_check',winner:'gote',loser:'sente'});});
});
