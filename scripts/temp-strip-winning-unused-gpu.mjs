import {readFile,writeFile} from 'node:fs/promises';

const path='src/game/cpu-worker.ts';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  if(!source.includes(oldText))throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  source=source.replace(oldText,newText);
}
function removeSection(start,end,label){
  const from=source.indexOf(start);
  if(from<0)throw new Error(`${label}_START_NOT_FOUND`);
  const to=source.indexOf(end,from);
  if(to<0)throw new Error(`${label}_END_NOT_FOUND`);
  source=source.slice(0,from)+source.slice(to);
}

replaceOnce("import { runTitleGpuForecastFabric, warmupTitleGpuForecastFabric } from './title-gpu-forecast';\n",'', 'GPU_IMPORT');
replaceOnce("import type { TitleGpuForecastFabricResult } from './title-gpu-forecast';\n",'', 'GPU_TYPE_IMPORT');
removeSection('async function settleBeforeDeadline<T>(', 'class RootWorkerSlot {', 'GPU_DEADLINE_HELPER');
removeSection('function fuseGpuForecast(', 'async function parallelSearch(', 'GPU_FUSION');
replaceOnce(
`  const searchStarted=Date.now();
  const hardDeadline=searchStarted+(level==='title'?1900:profile.replyDeadlineMs);
  const deadline=searchStarted+profile.replyDeadlineMs;
  const gpuForecastPromise:Promise<TitleGpuForecastFabricResult|null>=level==='title'
    ?runTitleGpuForecastFabric(position,usable).catch(()=>null)
    :Promise.resolve(null);
`,
`  const searchStarted=Date.now();
  const deadline=searchStarted+profile.replyDeadlineMs;
`,
'GPU_START',
);
replaceOnce(
"  const gpuForecast=level==='title'?await settleBeforeDeadline(gpuForecastPromise,hardDeadline):null;\n\n",
'',
'GPU_WAIT',
);
replaceOnce(
`  if(finalRanked.length){
    if(gpuForecast?.supported&&gpuForecast.complete)finalRanked=fuseGpuForecast(finalRanked,usable,gpuForecast);
    const varied=chooseCpuMoveFromRanked(level,position.ply,finalRanked);
    if(varied&&usable.some(move=>sameCpuMove(move,varied)))bestMove=varied;
  }else if(gpuForecast?.supported&&gpuForecast.complete&&gpuForecast.bestMoveIndex!==null){
    bestMove=usable[gpuForecast.bestMoveIndex]??bestMove;
  }
`,
`  if(finalRanked.length){
    const varied=chooseCpuMoveFromRanked(level,position.ply,finalRanked);
    if(varied&&usable.some(move=>sameCpuMove(move,varied)))bestMove=varied;
  }
`,
'GPU_FINAL_SELECTION',
);
replaceOnce(
`  const gpuComplete=!!gpuForecast?.supported&&gpuForecast.complete;
  return{
`,
`  return{
`,
'GPU_COMPLETE',
);
replaceOnce(
`      gpuForecastUsed:gpuComplete,
      gpuForecastComplete:gpuComplete,
      gpuForecastLayers:gpuForecast?.supported?gpuForecast.layers:0,
      gpuForecastSamples:gpuForecast?.supported?gpuForecast.totalSamples:0,
      gpuForecastPlannedSamples:gpuForecast?.supported?gpuForecast.plannedSamples:0,
      gpuForecastTransitions:gpuForecast?.supported?gpuForecast.stateTransitions:0,
      gpuForecastMs:gpuForecast?.supported?gpuForecast.elapsedMs:0,
`,
`      gpuForecastUsed:false,
      gpuForecastComplete:false,
      gpuForecastLayers:0,
      gpuForecastSamples:0,
      gpuForecastPlannedSamples:0,
      gpuForecastTransitions:0,
      gpuForecastMs:0,
`,
'GPU_RESULT',
);
replaceOnce("    if(message.level==='title')void warmupTitleGpuForecastFabric();\n",'', 'GPU_WARMUP');

if(source.includes('TitleGpuForecastFabricResult')||source.includes('runTitleGpuForecastFabric')||source.includes('warmupTitleGpuForecastFabric')||source.includes('fuseGpuForecast')||source.includes('settleBeforeDeadline')){
  throw new Error('GPU_PATH_REMAINS');
}
await writeFile(path,source);
