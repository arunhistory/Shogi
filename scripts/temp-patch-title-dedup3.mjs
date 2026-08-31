import {readFile,writeFile} from 'node:fs/promises';

const cpuPath='src/game/cpu.ts';
let cpu=await readFile(cpuPath,'utf8');
const workerPath='src/game/cpu-worker.ts';
let worker=await readFile(workerPath,'utf8');

function replaceOnce(source,oldText,newText,label){
  if(!source.includes(oldText))throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.replace(oldText,newText);
}

cpu=replaceOnce(
  cpu,
  `function moveOrderingScore(pos:Position,move:Move,level:CpuLevel='amateur'):number{`,
  `function moveOrderingScore(pos:Position,move:Move,level:CpuLevel='amateur',applied?:Position):number{`,
  'ORDER_SIGNATURE',
);

cpu=replaceOnce(
  cpu,
`  if(level==='pro'||level==='title'){
    const next=applyLegalMoveUnchecked(pos,move);
    if(isCheck(next,next.turn))score+=level==='title'?12000:9000;
  }`,
`  if(level==='pro'||level==='title'){
    const next=applied??applyLegalMoveUnchecked(pos,move);
    if(isCheck(next,next.turn))score+=level==='title'?12000:9000;
  }`,
  'ORDER_APPLIED_REUSE',
);

cpu=replaceOnce(
  cpu,
  `export function rankCpuMovesFast(pos:Position,level:CpuLevel='amateur',materialEvaluator?:CpuMaterialEvaluator):FastRankedMove[]{
  const perspective=pos.turn;
  return legalMoves(pos)
    .map(move=>{
      const next=applyLegalMoveUnchecked(pos,move);
      const score=staticEvaluation(next,perspective,level,materialEvaluator)
        +Math.trunc(moveOrderingScore(pos,move,level)/20)
        +forcingRootBonus(next,perspective,level);`,
  `export function rankCpuMovesFast(pos:Position,level:CpuLevel='amateur',materialEvaluator?:CpuMaterialEvaluator,precomputedLegal?:readonly Move[]):FastRankedMove[]{
  const perspective=pos.turn;
  const legal=precomputedLegal?[...precomputedLegal]:legalMoves(pos);
  return legal
    .map(move=>{
      const next=applyLegalMoveUnchecked(pos,move);
      const score=staticEvaluation(next,perspective,level,materialEvaluator)
        +Math.trunc(moveOrderingScore(pos,move,level,level==='title'?next:undefined)/20)
        +forcingRootBonus(next,perspective,level);`,
  'FAST_RANK_REUSE',
);

worker=replaceOnce(
  worker,
  `  const fastRanked=rankCpuMovesFast(position,level);`,
  `  const fastRanked=rankCpuMovesFast(position,level,undefined,level==='title'?legal:undefined);`,
  'WORKER_LEGAL_REUSE',
);

await writeFile(cpuPath,cpu);
await writeFile(workerPath,worker);
