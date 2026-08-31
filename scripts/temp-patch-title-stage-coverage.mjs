import {readFile,writeFile} from 'node:fs/promises';

const path='src/game/cpu-worker.ts';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  if(!source.includes(oldText))throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  source=source.replace(oldText,newText);
}

replaceOnce(
`    const ranked=rankStageResults(survivors,completed,level);
    if(ranked.length){`,
`    const ranked=rankStageResults(survivors,completed,level);
    if(level==='title'&&stage>0&&ranked.length){
      const coverageFloor=Math.min(
        survivors.length,
        Math.max(profile.minSurvivors,Math.ceil(survivors.length*0.5)),
      );
      if(ranked.length<coverageFloor){
        // Stage zero is always eligible because there is no prior parallel
        // result to retain. Later timing-dependent stages may replace it only
        // after they cover a meaningful share of the surviving candidates.
        // Completed work is still counted; only biased later selection is
        // rejected.
        break;
      }
    }
    if(ranked.length){`,
  'TITLE_STAGE_COVERAGE',
);

await writeFile(path,source);
