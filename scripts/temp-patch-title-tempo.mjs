import {readFile,writeFile} from 'node:fs/promises';

const path='src/game/cpu-worker.ts';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  if(!source.includes(oldText))throw new Error(label+'_ANCHOR_NOT_FOUND');
  source=source.replace(oldText,newText);
}

replaceOnce(
  "import { applyMove, gameOutcome, legalMoves, positionKey } from './engine';",
  "import { applyMove, gameOutcome, isCheck, legalMoves, positionKey } from './engine';",
  'IMPORT',
);

const moveKeyLine="const moveKey=(move:Move)=>`${move.from?.[0]??-1},${move.from?.[1]??-1}>${move.to[0]},${move.to[1]}|${move.drop??''}|${move.promote?1:0}`;";
replaceOnce(moveKeyLine,`${moveKeyLine}

let lastTitleMove:Move|null=null;
let lastTitleMovePly=-999;

function isImmediateOwnUndo(position:Position,move:Move):boolean{
  if(!lastTitleMove?.from||!move.from)return false;
  if(position.ply!==lastTitleMovePly+2)return false;
  if(lastTitleMove.promote||move.promote||lastTitleMove.drop||move.drop)return false;
  if(move.from[0]!==lastTitleMove.to[0]||move.from[1]!==lastTitleMove.to[1])return false;
  if(move.to[0]!==lastTitleMove.from[0]||move.to[1]!==lastTitleMove.from[1])return false;
  if(position.board[move.to[0]]?.[move.to[1]])return false;
  if(isCheck(position,position.turn))return false;
  try{
    const next=applyMove(position,move);
    const outcome=gameOutcome(next);
    if(outcome.ended&&'winner' in outcome&&outcome.winner===position.turn)return false;
    if(isCheck(next,next.turn))return false;
  }catch{return false;}
  return true;
}

function applyTitleTempoDiscipline(position:Position,ranked:RankedStageMove[]):RankedStageMove[]{
  if(!lastTitleMove||position.ply!==lastTitleMovePly+2)return ranked;
  return ranked.map(item=>{
    if(!isImmediateOwnUndo(position,item.move))return item;
    const penalty=650;
    return{...item,score:item.score-penalty,low:item.low-penalty,high:item.high-penalty};
  }).sort((a,b)=>b.score-a.score||b.depth-a.depth||b.completeSamples-a.completeSamples||b.nodes-a.nodes);
}`,'MOVE_KEY');

replaceOnce(
`      const chosen=validRanked.length?validRanked:ranked;
      finalRanked=chosen;
      bestMove=chosen[0]!.move;
      completedDepth=Math.max(completedDepth,chosen[0]!.depth);
      if(level==='title'){
        survivors=titleForecastCohort(chosen,stage,profile.minSurvivors);`,
`      const chosen=validRanked.length?validRanked:ranked;
      const disciplined=level==='title'?applyTitleTempoDiscipline(position,chosen):chosen;
      finalRanked=disciplined;
      bestMove=disciplined[0]!.move;
      completedDepth=Math.max(completedDepth,disciplined[0]!.depth);
      if(level==='title'){
        survivors=titleForecastCohort(disciplined,stage,profile.minSurvivors);`,
  'RANK',
);

replaceOnce(
`    const response:CpuResponse={requestId,positionKey:key,ok:true,wasmUsed:searched.wasmUsed,result:searched.result};
    self.postMessage(response);`,
`    if(level==='title'&&searched.result.move){
      lastTitleMove=searched.result.move;
      lastTitleMovePly=position.ply;
    }
    const response:CpuResponse={requestId,positionKey:key,ok:true,wasmUsed:searched.wasmUsed,result:searched.result};
    self.postMessage(response);`,
  'RESULT',
);

await writeFile(path,source);
