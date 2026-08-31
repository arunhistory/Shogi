import {readFile,writeFile} from 'node:fs/promises';

const path='src/game/cpu-worker.ts';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  if(!source.includes(oldText))throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  source=source.replace(oldText,newText);
}

replaceOnce(
`  gpuForecastTransitions?:number;
  gpuForecastMs?:number;
}`,
`  gpuForecastTransitions?:number;
  gpuForecastMs?:number;
  titleEntryCount?:number;
  titleEntryJobsCompleted?:number;
  titleEntryPhaseMs?:number;
  titleConvergenceMs?:number;
}`,
'TELEMETRY_INTERFACE',
);

replaceOnce(
`  let stage=0;
  let finalRanked:RankedStageMove[]=[];`,
`  let stage=0;
  let finalRanked:RankedStageMove[]=[];
  let titleEntryCount=0;
  let titleEntryJobsCompleted=0;
  let titleEntryPhaseMs=0;
  let titleConvergenceMs=0;`,
'TELEMETRY_STATE',
);

const loopStart=source.indexOf(`  while(Date.now()<deadline-80&&jobsIssued<profile.logicalJobTarget&&survivors.length){`);
if(loopStart<0)throw new Error('STAGE_LOOP_START_NOT_FOUND');
const loopEnd=source.indexOf(`\n\n  const gpuForecast=`,loopStart);
if(loopEnd<0)throw new Error('STAGE_LOOP_END_NOT_FOUND');
const originalLoop=source.slice(loopStart,loopEnd);

const titleLoop=`  if(level==='title'){
    // N-entry / 1-exit experiment:
    // 1) preprocess once above,
    // 2) every physical slot becomes an independent entry for ~1s,
    // 3) merge once,
    // 4) reconverge all slots on the merged frontier until the hard deadline.
    // No entry waits for another entry's stage barrier during phase 2.
    const entryStarted=Date.now();
    const entryDeadline=Math.min(searchStarted+1000,hardDeadline-650);
    const convergenceDeadline=hardDeadline-80;
    titleEntryCount=Math.max(1,Math.min(slots.length,12));
    const entryRounds=4;
    const entryPlans=slots.slice(0,titleEntryCount).map((slot,entry)=>{
      const jobs:RootSearchJob[]=[];
      for(let round=0;round<entryRounds;round++){
        const depth=Math.min(profile.maxDepth,profile.baseDepth+round*profile.depthStep);
        const nodeLimit=Math.min(220_000,Math.trunc(profile.nodeBase*Math.pow(1.9,round)));
        const lane=(entry+round*titleEntryCount)%12;
        for(const move of survivors){
          jobs.push({
            jobId:\`entry-\${entry}-\${round}-\${jobs.length}-\${crypto.randomUUID()}\`,
            move,depth,nodeLimit,lane,level,profileCode:profile.profileCode,
          });
        }
      }
      return{slot,jobs};
    });
    jobsIssued+=entryPlans.reduce((sum,entry)=>sum+entry.jobs.length,0);
    const entryCompleted=(await Promise.all(
      entryPlans.map(entry=>runStage([entry.slot],entry.jobs,entryDeadline,profile.jobTimeoutMs)),
    )).flat();
    titleEntryPhaseMs=Date.now()-entryStarted;
    titleEntryJobsCompleted=entryCompleted.length;
    jobsCompleted+=entryCompleted.length;
    nodesVisited+=entryCompleted.reduce((sum,item)=>sum+(item.response.nodesVisited??0),0);
    wasmUsed ||= entryCompleted.some(item=>item.response.wasmUsed);

    const entryRanked=rankStageResults(survivors,entryCompleted,level);
    if(entryRanked.length){
      const validRanked=entryRanked.filter(item=>safeMoveKeys.has(moveKey(item.move)));
      const chosen=validRanked.length?validRanked:entryRanked;
      const disciplined=applyTitleTempoDiscipline(position,chosen);
      finalRanked=disciplined;
      bestMove=disciplined[0]!.move;
      completedDepth=Math.max(completedDepth,disciplined[0]!.depth);
      // Feed the merged frontier, not independent entry winners, into the
      // second phase. This is the single convergence point of the experiment.
      survivors=titleForecastCohort(disciplined,2,profile.minSurvivors);
    }

    const convergenceStarted=Date.now();
    let convergenceIssued=0;
    stage=3;
    while(Date.now()<convergenceDeadline-80&&convergenceIssued<profile.logicalJobTarget&&survivors.length){
      const depth=Math.min(profile.maxDepth,profile.baseDepth+stage*profile.depthStep);
      const remainingJobs=profile.logicalJobTarget-convergenceIssued;
      if(remainingJobs<survivors.length)break;
      const requestedLanes=titleLaneTarget(stage,slots.length);
      const fairLaneCount=Math.max(1,Math.min(requestedLanes,Math.floor(remainingJobs/survivors.length)));
      const nodeLimit=Math.min(220_000,Math.trunc(profile.nodeBase*Math.pow(1.9,stage)));
      const jobs:RootSearchJob[]=[];
      for(let lane=0;lane<fairLaneCount;lane++){
        for(const move of survivors){
          jobs.push({
            jobId:\`converge-\${stage}-\${lane}-\${convergenceIssued+jobs.length}-\${crypto.randomUUID()}\`,
            move,depth,nodeLimit,lane,level,profileCode:profile.profileCode,
          });
        }
      }
      if(!jobs.length)break;
      jobsIssued+=jobs.length;
      convergenceIssued+=jobs.length;
      const completed=await runStage(slots,jobs,convergenceDeadline,profile.jobTimeoutMs);
      jobsCompleted+=completed.length;
      nodesVisited+=completed.reduce((sum,item)=>sum+(item.response.nodesVisited??0),0);
      wasmUsed ||= completed.some(item=>item.response.wasmUsed);
      const ranked=rankStageResults(survivors,completed,level);
      if(stage>0&&ranked.length){
        const coverageFloor=Math.min(
          survivors.length,
          Math.max(profile.minSurvivors,Math.ceil(survivors.length*0.5)),
        );
        if(ranked.length<coverageFloor)break;
      }
      if(ranked.length){
        const validRanked=ranked.filter(item=>safeMoveKeys.has(moveKey(item.move)));
        const chosen=validRanked.length?validRanked:ranked;
        const disciplined=applyTitleTempoDiscipline(position,chosen);
        finalRanked=disciplined;
        bestMove=disciplined[0]!.move;
        completedDepth=Math.max(completedDepth,disciplined[0]!.depth);
        survivors=titleForecastCohort(disciplined,stage,profile.minSurvivors);
      }else if(Date.now()>=convergenceDeadline-120){
        break;
      }
      if(depth>=profile.maxDepth&&survivors.length===1)break;
      stage++;
    }
    titleConvergenceMs=Date.now()-convergenceStarted;
  }else{
${originalLoop.split('\n').map(line=>'  '+line).join('\n')}
  }`;

source=source.slice(0,loopStart)+titleLoop+source.slice(loopEnd);

replaceOnce(
`      physicalWorkers:slots.length,
      gpuForecastUsed:gpuComplete,`,
`      physicalWorkers:slots.length,
      titleEntryCount:level==='title'?titleEntryCount:undefined,
      titleEntryJobsCompleted:level==='title'?titleEntryJobsCompleted:undefined,
      titleEntryPhaseMs:level==='title'?titleEntryPhaseMs:undefined,
      titleConvergenceMs:level==='title'?titleConvergenceMs:undefined,
      gpuForecastUsed:gpuComplete,`,
'TELEMETRY_RESULT',
);

replaceOnce(
`      logicalJobsPlanned:profile.logicalJobTarget,`,
`      logicalJobsPlanned:level==='title'?jobsIssued:profile.logicalJobTarget,`,
'PLANNED_JOBS',
);

await writeFile(path,source);