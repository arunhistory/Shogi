import { applyLegalMoveUnchecked, isCheck, legalMoves, positionKey, repetitionStatus } from './engine';
import type { BoardKind, CpuLevel, Move, Position, Side } from './types';

interface CpuBudget {
  maxDepth:number;
  timeMs:number;
  beginnerPool?:number;
}

export interface CpuParallelProfile {
  replyDeadlineMs:number;
  workerCap:number;
  logicalJobTarget:number;
  baseDepth:number;
  maxDepth:number;
  lanes:number;
  retention:number;
  minSurvivors:number;
  nodeBase:number;
}

// Serial search is now only the low-cost path and the safety fallback.
// Every budget is intentionally well below the user-facing two-second ceiling.
export const CPU_BUDGETS:Record<CpuLevel,CpuBudget>={
  beginner:{maxDepth:1,timeMs:90,beginnerPool:6},
  intermediate:{maxDepth:2,timeMs:180},
  amateur:{maxDepth:3,timeMs:360},
  pro:{maxDepth:4,timeMs:500},
  title:{maxDepth:5,timeMs:700},
};

// Difficulty is primarily created by how much parallel search density is packed
// into the same short reply window, not by making the player wait longer.
export const CPU_PARALLEL_PROFILES:Record<CpuLevel,CpuParallelProfile>={
  beginner:{replyDeadlineMs:240,workerCap:1,logicalJobTarget:1,baseDepth:1,maxDepth:1,lanes:1,retention:1,minSurvivors:1,nodeBase:600},
  intermediate:{replyDeadlineMs:650,workerCap:2,logicalJobTarget:12,baseDepth:1,maxDepth:3,lanes:1,retention:0.5,minSurvivors:2,nodeBase:900},
  amateur:{replyDeadlineMs:1000,workerCap:3,logicalJobTarget:32,baseDepth:2,maxDepth:5,lanes:2,retention:0.5,minSurvivors:4,nodeBase:1400},
  pro:{replyDeadlineMs:1450,workerCap:6,logicalJobTarget:96,baseDepth:2,maxDepth:7,lanes:3,retention:0.55,minSurvivors:6,nodeBase:2200},
  title:{replyDeadlineMs:1650,workerCap:12,logicalJobTarget:256,baseDepth:2,maxDepth:10,lanes:4,retention:0.65,minSurvivors:8,nodeBase:2800},
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

export function sameCpuMove(a:Move,b:Move):boolean{
  return a.to[0]===b.to[0]
    &&a.to[1]===b.to[1]
    &&a.from?.[0]===b.from?.[0]
    &&a.from?.[1]===b.from?.[1]
    &&a.drop===b.drop
    &&!!a.promote===!!b.promote;
}

export interface FastRankedMove { move:Move; score:number }

export function rankCpuMovesFast(pos:Position,materialEvaluator?:CpuMaterialEvaluator):FastRankedMove[]{
  const perspective=pos.turn;
  return legalMoves(pos)
    .map(move=>{
      const next=applyLegalMoveUnchecked(pos,move);
      const score=staticEvaluation(next,perspective,materialEvaluator)+Math.trunc(moveOrderingScore(pos,move)/20);
      return{move,score};
    })
    .sort((a,b)=>b.score-a.score);
}

export function chooseCpuFallbackMove(pos:Position,level:CpuLevel):Move|null{
  const ranked=rankCpuMovesFast(pos);
  if(ranked.length===0)return null;
  if(level==='beginner'){
    const count=Math.min(CPU_BUDGETS.beginner.beginnerPool??1,ranked.length);
    return ranked[Math.floor(Math.random()*count)]!.move;
  }
  return ranked[0]!.move;
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
  move:Move|null;
  completedDepth:number;
  nodesVisited:number;
}

export interface CpuRootScoreResult {
  score:number;
  completedDepth:number;
  nodesVisited:number;
  complete:boolean;
}

export function scoreCpuRootMove(
  pos:Position,
  move:Move,
  maxDepth:number,
  timeMs:number,
  materialEvaluator?:CpuMaterialEvaluator,
):CpuRootScoreResult{
  const legal=legalMoves(pos);
  const verified=legal.find(candidate=>sameCpuMove(candidate,move));
  if(!verified)throw new Error('CPU_ROOT_MOVE_ILLEGAL');
  const perspective=pos.turn;
  const next=applyLegalMoveUnchecked(pos,verified);
  const state:SearchState={deadline:Date.now()+Math.max(10,timeMs),nodes:0};
  let score=staticEvaluation(next,perspective,materialEvaluator);
  let completedDepth=0;
  let complete=true;
  for(let depth=1;depth<=Math.max(1,maxDepth);depth++){
    try{
      const table=new Map<string,number>();
      const current=alphaBeta(next,Math.max(0,depth-1),-Infinity,Infinity,perspective,1,table,state,materialEvaluator);
      score=current;
      completedDepth=depth;
    }catch(error){
      if(error!==TIMEOUT)throw error;
      complete=false;
      break;
    }
  }
  return{score,completedDepth,nodesVisited:state.nodes,complete};
}

export function chooseCpuMove(pos:Position,level:CpuLevel,materialEvaluator?:CpuMaterialEvaluator):CpuSearchResult{
  const legal=legalMoves(pos);
  if(legal.length===0)return{move:null,completedDepth:0,nodesVisited:0};

  const budget=CPU_BUDGETS[level];
  const state:SearchState={deadline:Date.now()+budget.timeMs,nodes:0};
  const perspective=pos.turn;
  let bestMove=chooseCpuFallbackMove(pos,level)??legal[0]!;
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

  if(level==='beginner'&&ranked.length>1){
    const pool=ranked.slice(0,Math.min(budget.beginnerPool??1,ranked.length));
    bestMove=pool[Math.floor(Math.random()*pool.length)]!.move;
  }
  return{move:bestMove,completedDepth,nodesVisited:state.nodes};
}
