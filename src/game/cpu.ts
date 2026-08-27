import { applyLegalMoveUnchecked, isCheck, legalMoves, positionKey, repetitionStatus } from './engine';
import type { BoardKind, CpuLevel, Move, Position, Side } from './types';

interface CpuBudget {
  maxDepth: number;
  timeMs: number;
  beginnerPool?: number;
}

// These are computation ceilings, not shogi clock settings. Clock/seconds remain undecided.
export const CPU_BUDGETS:Record<CpuLevel,CpuBudget>={
  beginner:{maxDepth:1,timeMs:120,beginnerPool:6},
  intermediate:{maxDepth:2,timeMs:400},
  amateur:{maxDepth:3,timeMs:1200},
  pro:{maxDepth:5,timeMs:3500},
  title:{maxDepth:7,timeMs:8000},
};

const values:Record<BoardKind,number>={
  king:100000,rook:1000,bishop:900,gold:600,silver:520,knight:360,lance:320,pawn:100,
  dragon:1350,horse:1250,promotedSilver:600,promotedKnight:600,promotedLance:600,tokin:600,
};
const handValues:Record<string,number>={king:100000,rook:1000,bishop:900,gold:600,silver:520,knight:360,lance:320,pawn:100};
const other=(side:Side):Side=>side==='sente'?'gote':'sente';
const TIMEOUT=Symbol('CPU_SEARCH_TIMEOUT');

interface SearchState { deadline:number; nodes:number }
export type CpuMaterialEvaluator=(position:Position,perspective:Side)=>number;

function tsMaterialEvaluation(pos:Position,perspective:Side):number{
  let score=0;
  for(const row of pos.board)for(const piece of row){
    if(!piece)continue;
    score+=(piece.side===perspective?1:-1)*values[piece.kind];
  }
  for(const side of ['sente','gote'] as const){
    const sign=side===perspective?1:-1;
    for(const [kind,count] of Object.entries(pos.hands[side]))score+=sign*(handValues[kind]??0)*count;
  }
  return score;
}

function staticEvaluation(pos:Position,perspective:Side,materialEvaluator?:CpuMaterialEvaluator):number{
  let score:number;
  if(materialEvaluator){
    try{score=materialEvaluator(pos,perspective);}catch{score=tsMaterialEvaluation(pos,perspective);}
  }else score=tsMaterialEvaluation(pos,perspective);
  if(isCheck(pos,other(perspective)))score+=35;
  if(isCheck(pos,perspective))score-=35;
  return score;
}

function moveOrderingScore(pos:Position,move:Move):number{
  let score=0;
  const target=pos.board[move.to[0]]?.[move.to[1]];
  if(target)score+=values[target.kind]*10;
  if(move.promote)score+=500;
  if(move.drop)score+=50;
  return score;
}

function repetitionScore(pos:Position,perspective:Side,plyFromRoot:number):number|null{
  const repetition=repetitionStatus(pos);
  if(repetition.kind==='normal')return 0;
  if(repetition.kind==='perpetual-check'){
    return repetition.loser===perspective?-900000+plyFromRoot:900000-plyFromRoot;
  }
  return null;
}

function alphaBeta(
  pos:Position,
  depth:number,
  alpha:number,
  beta:number,
  perspective:Side,
  plyFromRoot:number,
  table:Map<string,number>,
  state:SearchState,
  materialEvaluator?:CpuMaterialEvaluator,
):number{
  if(Date.now()>=state.deadline)throw TIMEOUT;
  state.nodes++;

  const repeated=repetitionScore(pos,perspective,plyFromRoot);
  if(repeated!==null)return repeated;
  if(depth===0)return staticEvaluation(pos,perspective,materialEvaluator);

  const key=`${positionKey(pos)}|${depth}|${perspective}`;
  const cached=table.get(key);
  if(cached!==undefined)return cached;

  const moves=legalMoves(pos).sort((a,b)=>moveOrderingScore(pos,b)-moveOrderingScore(pos,a));
  if(moves.length===0){
    if(isCheck(pos,pos.turn))return pos.turn===perspective?-1000000+plyFromRoot:1000000-plyFromRoot;
    return 0;
  }

  const maximizing=pos.turn===perspective;
  let best=maximizing?-Infinity:Infinity;
  for(const move of moves){
    const score=alphaBeta(applyLegalMoveUnchecked(pos,move),depth-1,alpha,beta,perspective,plyFromRoot+1,table,state,materialEvaluator);
    if(maximizing){
      best=Math.max(best,score);
      alpha=Math.max(alpha,best);
    }else{
      best=Math.min(best,score);
      beta=Math.min(beta,best);
    }
    if(beta<=alpha)break;
  }
  table.set(key,best);
  return best;
}

export interface CpuSearchResult {
  move: Move | null;
  completedDepth: number;
  nodesVisited: number;
}

export function chooseCpuMove(pos:Position,level:CpuLevel,materialEvaluator?:CpuMaterialEvaluator):CpuSearchResult{
  const legal=legalMoves(pos);
  if(legal.length===0)return{move:null,completedDepth:0,nodesVisited:0};

  const budget=CPU_BUDGETS[level];
  const state:SearchState={deadline:Date.now()+budget.timeMs,nodes:0};
  const perspective=pos.turn;
  let bestMove=legal[0]!;
  let completedDepth=0;
  let ranked:{move:Move;score:number}[]=[];

  for(let depth=1;depth<=budget.maxDepth;depth++){
    const table=new Map<string,number>();
    const current:{move:Move;score:number}[]=[];
    try{
      const ordered=[...legal].sort((a,b)=>moveOrderingScore(pos,b)-moveOrderingScore(pos,a));
      let alpha=-Infinity;
      for(const move of ordered){
        if(Date.now()>=state.deadline)throw TIMEOUT;
        const score=alphaBeta(applyLegalMoveUnchecked(pos,move),depth-1,alpha,Infinity,perspective,1,table,state,materialEvaluator);
        current.push({move,score});
        alpha=Math.max(alpha,score);
      }
    }catch(error){
      if(error!==TIMEOUT)throw error;
      break;
    }
    current.sort((a,b)=>b.score-a.score);
    if(current.length){
      ranked=current;
      bestMove=current[0]!.move;
      completedDepth=depth;
    }
  }

  // Beginner deliberately varies among several reasonable moves; still pure algorithmic search.
  if(level==='beginner'&&ranked.length>1){
    const pool=ranked.slice(0,Math.min(budget.beginnerPool??1,ranked.length));
    bestMove=pool[Math.floor(Math.random()*pool.length)]!.move;
  }
  return{move:bestMove,completedDepth,nodesVisited:state.nodes};
}
