import { initialPosition, positionKey } from './engine';
import { handicapRule } from './handicaps';
import type { Handicap, PieceKind, Position, Side } from './types';

export type OrderPreference='random'|'sente'|'gote';
export type HandicapSide=Side;
export type SideHandicaps=Readonly<Record<Side,Handicap>>;

export const EVEN_HANDICAPS:SideHandicaps=Object.freeze({sente:'even',gote:'even'});

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

export function handicapPairFromLegacy(handicap:Handicap='even',handicapSide:HandicapSide='gote'):SideHandicaps{
  return handicapSide==='sente'
    ?{sente:handicap,gote:'even'}
    :{sente:'even',gote:handicap};
}

export function configuredInitialPosition(
  handicapsOrLegacy:SideHandicaps|Handicap=EVEN_HANDICAPS,
  legacySide:HandicapSide='gote',
):Position{
  const handicaps:SideHandicaps=typeof handicapsOrLegacy==='string'
    ?handicapPairFromLegacy(handicapsOrLegacy,legacySide)
    :handicapsOrLegacy;
  const position=initialPosition('even');
  const remove=(side:Side,kind:PieceKind)=>{
    for(let y=0;y<9;y++)for(let x=0;x<9;x++){
      const piece=position.board[y]![x];
      if(piece?.side===side&&piece.kind===kind){
        position.board[y]![x]=null;
        return;
      }
    }
  };
  for(const side of ['sente','gote'] as const){
    for(const kind of handicapRule(handicaps[side]).removedFromGote)remove(side,kind);
  }
  // 先手・後手の駒落ちは独立設定。先手側が常に初手を指す。
  position.turn='sente';
  position.ply=0;
  position.history=[];
  position.history.push({key:positionKey(position),mover:null,gaveCheck:false});
  return position;
}
