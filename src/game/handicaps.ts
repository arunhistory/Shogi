import type { Handicap, PieceKind, Side } from './types';

export interface HandicapRule {
  id:Handicap;
  label:string;
  firstTurn:Side;
  removedFromGote:readonly PieceKind[];
}

export const HANDICAP_RULES:Readonly<Record<Handicap,HandicapRule>>={
  even:{id:'even',label:'平手',firstTurn:'sente',removedFromGote:[]},
  rook:{id:'rook',label:'飛車落ち',firstTurn:'gote',removedFromGote:['rook']},
  bishop:{id:'bishop',label:'角落ち',firstTurn:'gote',removedFromGote:['bishop']},
  two:{id:'two',label:'2枚落ち',firstTurn:'gote',removedFromGote:['rook','bishop']},
  four:{id:'four',label:'4枚落ち',firstTurn:'gote',removedFromGote:['rook','bishop','lance','lance']},
  six:{id:'six',label:'6枚落ち',firstTurn:'gote',removedFromGote:['rook','bishop','lance','lance','knight','knight']},
};

export const HANDICAP_RULE_LIST=Object.freeze([
  HANDICAP_RULES.even,
  HANDICAP_RULES.rook,
  HANDICAP_RULES.bishop,
  HANDICAP_RULES.two,
  HANDICAP_RULES.four,
  HANDICAP_RULES.six,
] as const);

export function isHandicap(value:unknown):value is Handicap{
  return typeof value==='string'&&Object.prototype.hasOwnProperty.call(HANDICAP_RULES,value);
}

export function handicapRule(handicap:Handicap):HandicapRule{
  return HANDICAP_RULES[handicap];
}
