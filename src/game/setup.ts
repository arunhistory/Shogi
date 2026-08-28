import { initialPosition, positionKey } from './engine';
import { handicapRule } from './handicaps';
import type { Handicap, PieceKind, Position, Side } from './types';

export type OrderPreference='random'|'sente'|'gote';
export type HandicapSide=Side;

export interface MatchRules {
  handicap:Handicap;
  handicapSide:HandicapSide;
  order:OrderPreference;
}

export function isOrderPreference(value:unknown):value is OrderPreference{
  return value==='random'||value==='sente'||value==='gote';
}

export function isSide(value:unknown):value is Side{
  return value==='sente'||value==='gote';
}

export function oppositeSide(side:Side):Side{
  return side==='sente'?'gote':'sente';
}

export function resolveOrder(preference:OrderPreference):Side{
  if(preference!=='random')return preference;
  const value=new Uint8Array(1);
  crypto.getRandomValues(value);
  return (value[0]!&1)===0?'sente':'gote';
}

export function configuredInitialPosition(handicap:Handicap='even',handicapSide:HandicapSide='gote'):Position{
  const position=initialPosition('even');
  if(handicap!=='even'){
    const remove=(kind:PieceKind)=>{
      for(let y=0;y<9;y++)for(let x=0;x<9;x++){
        const piece=position.board[y]![x];
        if(piece?.side===handicapSide&&piece.kind===kind){
          position.board[y]![x]=null;
          return;
        }
      }
    };
    for(const kind of handicapRule(handicap).removedFromGote)remove(kind);
  }
  // 先行/後攻と駒落ち側は独立設定。先手側が常に初手を指す。
  position.turn='sente';
  position.ply=0;
  position.history=[];
  position.history.push({key:positionKey(position),mover:null,gaveCheck:false});
  return position;
}
