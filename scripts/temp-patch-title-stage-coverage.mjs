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
    if(level==='title'&&ranked.length){
      const coverageFloor=Math.min(
        survivors.length,
        Math.max(profile.minSurvivors,Math.ceil(survivors.length*0.5)),
      );
      if(ranked.length<coverageFloor){
        // Timing can let only a tiny subset of a later stage finish. Do not
        // let that biased subset replace the last sufficiently broad Title
        // comparison. All completed work remains counted; only selection is
        // kept on the last stage with meaningful candidate coverage.
        break;
      }
    }
    if(ranked.length){`,
  'TITLE_STAGE_COVERAGE',
);

await writeFile(path,source);
