import {readFile,writeFile} from 'node:fs/promises';

const path='src/game/cpu-worker.ts';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  if(!source.includes(oldText))throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  source=source.replace(oldText,newText);
}

replaceOnce(
`  const safeLegal=legal.filter(move=>safeAgainstImmediatePerpetualLoss(position,move));
  const usable=safeLegal.length?safeLegal:legal;
  const fastRank=rankCpuMovesFast(position,level).map(item=>item.move).filter(move=>usable.some(candidate=>sameCpuMove(candidate,move)));
  let survivors=fastRank.length?fastRank:[...usable];
  const fallbackMove=chooseCpuFallbackMove(position,level);
  let bestMove:Move=fallbackMove&&usable.some(move=>sameCpuMove(move,fallbackMove))
    ?fallbackMove
    :(survivors[0]??usable[0]!);`,
`  const safeLegal=legal.filter(move=>safeAgainstImmediatePerpetualLoss(position,move));
  const safeMoveKeys=new Set(safeLegal.map(moveKey));
  const usable=safeLegal.length?safeLegal:legal;
  const fastRanked=rankCpuMovesFast(position,level);
  const fastRank=fastRanked.map(item=>item.move).filter(move=>usable.some(candidate=>sameCpuMove(candidate,move)));
  let survivors=fastRank.length?fastRank:[...usable];
  const fallbackMove=level==='title'?(fastRanked[0]?.move??null):chooseCpuFallbackMove(position,level);
  let bestMove:Move=fallbackMove&&usable.some(move=>sameCpuMove(move,fallbackMove))
    ?fallbackMove
    :(survivors[0]??usable[0]!);`,
  'FAST_RANK_DEDUP',
);

replaceOnce(
`      const validRanked=ranked.filter(item=>safeAgainstImmediatePerpetualLoss(position,item.move));
      const chosen=validRanked.length?validRanked:ranked;`,
`      const validRanked=level==='title'
        ?ranked.filter(item=>safeMoveKeys.has(moveKey(item.move)))
        :ranked.filter(item=>safeAgainstImmediatePerpetualLoss(position,item.move));
      const chosen=validRanked.length?validRanked:ranked;`,
  'SAFETY_RESULT_REUSE',
);

await writeFile(path,source);
