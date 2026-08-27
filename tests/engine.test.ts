import { describe, expect, it } from 'vitest';
import { applyMove, initialPosition, legalMoves } from '../src/game/engine';

describe('shogi engine',()=>{
 it('starts with legal moves and sente to move in even game',()=>{const p=initialPosition('even');expect(p.turn).toBe('sente');expect(legalMoves(p).length).toBeGreaterThan(0);});
 it('rejects an illegal move without mutating position',()=>{const p=initialPosition();const before=JSON.stringify(p);expect(()=>applyMove(p,{from:[8,4],to:[7,4]})).toThrow('ILLEGAL_MOVE');expect(JSON.stringify(p)).toBe(before);});
 it('handicap makes gote move first',()=>{expect(initialPosition('rook').turn).toBe('gote');});
});
