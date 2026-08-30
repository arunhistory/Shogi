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
  depthStep:number;
  lanes:number;
  retention:number;
  minSurvivors:number;
  nodeBase:number;
  jobTimeoutMs:number;
  profileCode:number;
  openingVariationWindow:number;
  variationWindow:number;
  variationPool:number;
}

// Serial search is the low-cost path and the safety fallback.
// Every budget remains below the user-facing two-second ceiling.
export const CPU_BUDGETS:Record<CpuLevel,CpuBudget>={
  beginner:{maxDepth:1,timeMs:90,beginnerPool:6},
  intermediate:{maxDepth:2,timeMs:180},
  amateur:{maxDepth:3,timeMs:360},
  pro:{maxDepth:4,timeMs:520},
  title:{maxDepth:6,timeMs:850},
};

// Pro and title are intentionally different search classes rather than the
// same evaluation with a larger worker count. Title jumps depth faster and
// narrows the root field harder so its short reply window is spent deeper.
export const CPU_PARALLEL_PROFILES:Record<CpuLevel,CpuParallelProfile>={
  beginner:{replyDeadlineMs:240,workerCap:1,logicalJobTarget:1,baseDepth:1,maxDepth:1,depthStep:1,lanes:1,retention:1,minSurvivors:1,nodeBase:600,jobTimeoutMs:120,profileCode:0,openingVariationWindow:999,variationWindow:999,variationPool:6},
  intermediate:{replyDeadlineMs:650,workerCap:2,logicalJobTarget:12,baseDepth:1,maxDepth:3,depthStep:1,lanes:1,retention:0.5,minSurvivors:2,nodeBase:900,jobTimeoutMs:180,profileCode:1,openingVariationWindow:70,variationWindow:45,variationPool:4},
  amateur:{replyDeadlineMs:1000,workerCap:3,logicalJobTarget:36,baseDepth:2,maxDepth:5,depthStep:1,lanes:2,retention:0.5,minSurvivors:4,nodeBase:1500,jobTimeoutMs:240,profileCode:2,openingVariationWindow:48,variationWindow:30,variationPool:3},
  pro:{replyDeadlineMs:1450,workerCap:6,logicalJobTarget:128,baseDepth:2,maxDepth:8,depthStep:1,lanes:3,retention:0.5,minSurvivors:5,nodeBase:2800,jobTimeoutMs:320,profileCode:3,openingVariationWindow:34,variationWindow:18,variationPool:3},
  title:{replyDeadlineMs:1650,workerCap:12,logicalJobTarget:320,baseDepth:3,maxDepth:12,depthStep:2,lanes:5,retention:0.38,minSurvivors:4,nodeBase:4200,jobTimeoutMs:420,profileCode:4,openingVariationWindow:18,variationWindow:6,variationPool:2},
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

function strategicSideScore(pos:Position,side:Side,level:CpuLevel):number{
  if(level==='beginner')return 0;
  const strength=level==='intermediate'?0.25:level==='amateur'?0.55:level==='pro'?0.9:1.25;
  let score=0;
  let king:[number,number]|null=null;
  for(let y=0;y<9;y++)for(let x=0;x<9;x++){
    const piece=pos.board[y]![x];
    if(!piece||piece.side!==side)continue;
    if(piece.kind==='king'){king=[y,x];continue;}
    const center=4-Math.abs(x-4);
    if(piece.kind==='rook'||piece.kind==='bishop'||piece.kind==='dragon'||piece.kind==='horse')score+=center*2;
    if(piece.kind==='silver'||piece.kind==='gold')score+=center;
    const progress=side==='sente'?8-y:y;
    if(['dragon','horse','promotedSilver','promotedKnight','promotedLance','tokin'].includes(piece.kind))score+=Math.max(0,progress-3)*3;
  }
  if(king){
    const [ky,kx]=king;
    let shield=0;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      if(!dy&&!dx)continue;
      const y=ky+dy,x=kx+dx;
      if(y<0||y>=9||x<0||x>=9)continue;
      const piece=pos.board[y]![x];
      if(piece?.side!==side)continue;
      shield+=piece.kind==='gold'?8:piece.kind==='silver'?7:piece.kind==='king'?0:3;
    }
    const backSafety=side==='sente'?Math.max(0,ky-5):Math.max(0,3-ky);
    const edgeSafety=Math.abs(kx-4);
    score+=shield+backSafety*4+edgeSafety*2;
  }
  const hands=pos.hands[side];
  score+=hands.rook*24+hands.bishop*20+hands.gold*10+hands.silver*8+hands.knight*4+hands.lance*3+hands.pawn*2;
  return Math.round(score*strength);
}

function staticEvaluation(pos:Position,perspective:Side,level:CpuLevel,materialEvaluator?:CpuMaterialEvaluator):number{
  let score:number;
  if(materialEvaluator){
    try{score=materialEvaluator(pos,perspective);}catch{score=tsMaterialEvaluation(pos,perspective);}
  }else score=tsMaterialEvaluation(pos,perspective);
  score+=strategicSideScore(pos,perspective,level)-strategicSideScore(pos,other(perspective),level);
  if(isCheck(pos,other(perspective)))score+=level==='title'?70:level==='pro'?55:35;
  if(isCheck(pos,perspective))score-=level==='title'?85:level==='pro'?65:35;
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
export interface CpuRankedCandidate { move:Move; score:number; depth?:number }

export function rankCpuMovesFast(pos:Position,level:CpuLevel='amateur',materialEvaluator?:CpuMaterialEvaluator):FastRankedMove[]{
  const perspective=pos.turn;
  return legalMoves(pos)
    .map(move=>{
      const next=applyLegalMoveUnchecked(pos,move);
      const score=staticEvaluation(next,perspective,level,materialEvaluator)+Math.trunc(moveOrderingScore(pos,move)/20);
      return{move,score};
    })
    .sort((a,b)=>b.score-a.score);
}

export function chooseCpuFallbackMove(pos:Position,level:CpuLevel):Move|null{
  const ranked=rankCpuMovesFast(pos,level);
  if(ranked.length===0)return null;
  if(level==='beginner'){
    const count=Math.min(CPU_BUDGETS.beginner.beginnerPool??1,ranked.length);
    return ranked[Math.floor(Math.random()*count)]!.move;
  }
  return ranked[0]!.move;
}

export function chooseCpuMoveFromRanked(
  level:CpuLevel,
  ply:number,
  ranked:readonly CpuRankedCandidate[],
  random:()=>number=Math.random,
):Move|null{
  if(ranked.length===0)return null;
  const ordered=[...ranked].sort((a,b)=>b.score-a.score||(b.depth??0)-(a.depth??0));
  const profile=CPU_PARALLEL_PROFILES[level];
  const top=ordered[0]!;
  const window=ply<16?profile.openingVariationWindow:profile.variationWindow;
  const pool=ordered.filter(item=>top.score-item.score<=window).slice(0,Math.max(1,profile.variationPool));
  if(pool.length<=1)return top.move;
  const scale=Math.max(1,window/2);
  const weights=pool.map(item=>Math.exp(-(top.score-item.score)/scale));
  const total=weights.reduce((sum,value)=>sum+value,0);
  const raw=random();
  const normalized=Number.isFinite(raw)?Math.min(0.999999,Math.max(0,raw)):0;
  let cursor=normalized*total;
  for(let index=0;index<pool.length;index++){
    cursor-=weights[index]!;
    if(cursor<=0)return pool[index]!.move;
  }
  return pool[pool.length-1]!.move;
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
  level:CpuLevel,
  materialEvaluator?:CpuMaterialEvaluator,
):number{
  if(Date.now()>=state.deadline)throw TIMEOUT;
  state.nodes++;

  const repeated=repetitionScore(pos,perspective,plyFromRoot);
  if(repeated!==null)return repeated;
  if(depth===0)return staticEvaluation(pos,perspective,level,materialEvaluator);

  const key=`${positionKey(pos)}|${depth}|${perspective}|${level}`;
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
    const score=alphaBeta(applyLegalMoveUnchecked(pos,move),depth-1,alpha,beta,perspective,plyFromRoot+1,table,state,level,materialEvaluator);
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
  level:CpuLevel='amateur',
  materialEvaluator?:CpuMaterialEvaluator,
):CpuRootScoreResult{
  const legal=legalMoves(pos);
  const verified=legal.find(candidate=>sameCpuMove(candidate,move));
  if(!verified)throw new Error('CPU_ROOT_MOVE_ILLEGAL');
  const perspective=pos.turn;
  const next=applyLegalMoveUnchecked(pos,verified);
  const state:SearchState={deadline:Date.now()+Math.max(10,timeMs),nodes:0};
  let score=staticEvaluation(next,perspective,level,materialEvaluator);
  let completedDepth=0;
  let complete=true;
  for(let depth=1;depth<=Math.max(1,maxDepth);depth++){
    try{
      const table=new Map<string,number>();
      const current=alphaBeta(next,Math.max(0,depth-1),-Infinity,Infinity,perspective,1,table,state,level,materialEvaluator);
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
        const score=alphaBeta(applyLegalMoveUnchecked(pos,move),depth-1,alpha,Infinity,perspective,1,table,state,level,materialEvaluator);
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

  if(ranked.length>1){
    const varied=chooseCpuMoveFromRanked(level,pos.ply,ranked);
    if(varied)bestMove=varied;
  }else if(level==='beginner'){
    const fallback=chooseCpuFallbackMove(pos,level);
    if(fallback)bestMove=fallback;
  }
  return{move:bestMove,completedDepth,nodesVisited:state.nodes};
}
