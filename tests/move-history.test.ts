import {describe,expect,it} from 'vitest';
import {inferMove,squareLabel} from '../src/ui/move-history-core';
import type {BoardSnapshot,HistoryPiece} from '../src/ui/move-history-core';

const empty=():BoardSnapshot=>Array.from({length:81},()=>null);
const piece=(label:string,side:HistoryPiece['side']):HistoryPiece=>({label,side});

describe('move history inference',()=>{
  it('uses standard shogi square labels',()=>{
    expect(squareLabel(54)).toBe('9七');
    expect(squareLabel(45)).toBe('9六');
    expect(squareLabel(40)).toBe('5五');
  });

  it('records an ordinary move',()=>{
    const before=empty();
    before[54]=piece('歩','sente');
    const after=empty();
    after[45]=piece('歩','sente');
    expect(inferMove(before,after)).toEqual({side:'sente',piece:'歩',from:'9七',to:'9六',captured:null,promotedTo:null,drop:false});
  });

  it('records captures and promotion',()=>{
    const before=empty();
    before[20]=piece('歩','sente');
    before[11]=piece('銀','gote');
    const after=empty();
    after[11]=piece('と','sente');
    expect(inferMove(before,after)).toEqual({side:'sente',piece:'歩',from:'7三',to:'7二',captured:'銀',promotedTo:'と',drop:false});
  });

  it('records a piece drop from hand',()=>{
    const before=empty();
    const after=empty();
    after[40]=piece('銀','gote');
    expect(inferMove(before,after)).toEqual({side:'gote',piece:'銀',from:null,to:'5五',captured:null,promotedTo:null,drop:true});
  });

  it('does not treat a board reset as one move',()=>{
    const before=empty();
    const after=empty();
    before[54]=piece('歩','sente');
    after[45]=piece('歩','sente');
    after[0]=piece('香','gote');
    expect(inferMove(before,after)).toBeNull();
  });
});
