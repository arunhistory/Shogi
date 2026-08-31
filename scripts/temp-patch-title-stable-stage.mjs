import {readFile,writeFile} from 'node:fs/promises';

const path='src/game/cpu-worker.ts';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  if(!source.includes(oldText))throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  source=source.replace(oldText,newText);
}

replaceOnce(
`    const ranked=rankStageResults(survivors,completed,level);
    if(ranked.length){
      const validRanked=level==='title'
        ?ranked.filter(item=>safeMoveKeys.has(moveKey(item.move)))
        :ranked.filter(item=>safeAgainstImmediatePerpetualLoss(position,item.move));`,
`    const ranked=rankStageResults(survivors,completed,level);
    const fairTitleStage=level!=='title'||ranked.length===survivors.length;
    if(level==='title'&&!fairTitleStage){
      // A later search stage must not replace a completed earlier stage when
      // only a timing-dependent subset of candidates returned. The work is
      // still performed and accounted for; it is simply not used as an
      // unfair comparison set.
      break;
    }
    if(ranked.length){
      const validRanked=level==='title'
        ?ranked.filter(item=>safeMoveKeys.has(moveKey(item.move)))
        :ranked.filter(item=>safeAgainstImmediatePerpetualLoss(position,item.move));`,
  'TITLE_STAGE_FAIRNESS',
);

await writeFile(path,source);
