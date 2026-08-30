/// <reference lib="webworker" />
import {
  CPU_PARALLEL_PROFILES,
  chooseCpuFallbackMove,
  chooseCpuMove,
  chooseCpuMoveFromRanked,
  rankCpuMovesFast,
  sameCpuMove,
} from './cpu';
import { applyMove, gameOutcome, legalMoves, positionKey } from './engine';
import type { CpuLevel, Move, Position } from './types';

interface CpuWarmupRequest {
  type:'warmup';
  position:Position;
  level:CpuLevel;
  wasmUrl?:string;
}

interface CpuSearchRequest {
  type?:'search';
  requestId:string;
  position:Position;
  level:CpuLevel;
  wasmUrl?:string;
}

type CpuWorkerRequest=CpuWarmupRequest|CpuSearchRequest;

interface CpuResult {
  move:Move|null;
  completedDepth:number;
  nodesVisited:number;
  logicalJobsPlanned?:number;
  logicalJobsCompleted?:number;
  physicalWorkers?:number;
}

interface CpuResponse {
  requestId:string;
  positionKey:string;
  ok:boolean;
  wasmUsed:boolean;
  result?:CpuResult;
  error?:string;
}

interface RootSearchJob {
  jobId:string;
  move:Move;
  depth:number;
  nodeLimit:number;
  lane:number;
  level:CpuLevel;
  profileCode:number;
}

interface RootJobResponse {
  type:'result';
  jobId:string;
  ok:boolean;
  score?:number;
  depth?:number;
  nodesVisited?:number;
  complete?:boolean;
  wasmUsed:boolean;
  error?:string;
}

interface CompletedJob {
  job:RootSearchJob;
  response:RootJobResponse;
}

interface RankedStageMove {
  move:Move;
  score:number;
  depth:number;
  nodes:number;
  wasm:boolean;
}

interface TitleChannelStat {
  move:Move;
  stableScore?:number;
  complexScore?:number;
  depth:number;
  nodes:number;
  wasm:boolean;
  stableComplete:boolean;
  complexComplete:boolean;
}

const moveKey=(move:Move)=>`${move.from?.[0]??-1},${move.from?.[1]??-1}>${move.to[0]},${move.to[1]}|${move.drop??''}|${move.promote?1:0}`;

function safeAgainstImmediatePerpetualLoss(position:Position,move:Move):boolean{
  try{
    const outcome=gameOutcome(applyMove(position,move));
    return !(outcome.ended&&outcome.reason==='perpetual-check'&&outcome.loser===position.turn);
  }catch{return false;}
}

function median(values:number[]):number{
  const ordered=[...values].sort((a,b)=>a-b);
  if(ordered.length===0)return-Infinity;
  const middle=Math.floor(ordered.length/2);
  return ordered.length%2?ordered[middle]!:(ordered[middle-1]!+ordered[middle]!)/2;
}

class RootWorkerSlot {
  private worker:Worker;
  private position:Position|null=null;
  private wasmUrl:string|undefined;

  constructor(wasmUrl?:string){
    this.wasmUrl=wasmUrl;
    this.worker=this.spawn();
    this.worker.postMessage({type:'warmup',wasmUrl:this.wasmUrl});
  }

  private spawn():Worker{
    return new Worker(new URL('./cpu-search-worker.ts',import.meta.url),{type:'module'});
  }

  warmup(wasmUrl?:string){
    this.wasmUrl=wasmUrl;
    this.worker.postMessage({type:'warmup',wasmUrl:this.wasmUrl});
  }

  prepare(position:Position,wasmUrl?:string){
    this.position=position;
    this.wasmUrl=wasmUrl;
    this.worker.postMessage({type:'init',position,wasmUrl});
  }

  private replace(){
    this.worker.terminate();
    this.worker=this.spawn();
    this.worker.postMessage({type:'warmup',wasmUrl:this.wasmUrl});
    if(this.position)this.worker.postMessage({type:'init',position:this.position,wasmUrl:this.wasmUrl});
  }

  async run(job:RootSearchJob,timeoutMs:number):Promise<RootJobResponse|null>{
    const worker=this.worker;
    return await new Promise(resolve=>{
      let settled=false;
      const finish=(value:RootJobResponse|null,replace:boolean)=>{
        if(settled)return;
        settled=true;
        clearTimeout(timer);
        worker.onmessage=null;
        worker.onerror=null;
        if(replace&&this.worker===worker)this.replace();
        resolve(value);
      };
      const timer=setTimeout(()=>finish(null,true),Math.max(25,timeoutMs));
      worker.onmessage=(event:MessageEvent<RootJobResponse>)=>{
        const response=event.data;
        if(response?.type!=='result'||response.jobId!==job.jobId)return;
        finish(response,false);
      };
      worker.onerror=()=>finish(null,true);
      worker.postMessage({type:'search',...job});
    });
  }

  terminate(){this.worker.terminate();}
}

const workerPool:RootWorkerSlot[]=[];

function physicalWorkerCount(level:CpuLevel):number{
  const profile=CPU_PARALLEL_PROFILES[level];
  const reported=Number(navigator.hardwareConcurrency||4);
  const hardware=Number.isFinite(reported)&&reported>0?Math.trunc(reported):4;
  const computeSlots=Math.max(1,hardware-1);
  return Math.max(1,Math.min(profile.workerCap,computeSlots));
}

function ensureWorkerPool(level:CpuLevel,wasmUrl?:string,position?:Position):RootWorkerSlot[]{
  const target=physicalWorkerCount(level);
  while(workerPool.length<target)workerPool.push(new RootWorkerSlot(wasmUrl));
  while(workerPool.length>target)workerPool.pop()!.terminate();
  for(const slot of workerPool){
    slot.warmup(wasmUrl);
    if(position)slot.prepare(position,wasmUrl);
  }
  return workerPool;
}

async function runStage(
  slots:RootWorkerSlot[],
  jobs:RootSearchJob[],
  deadline:number,
  jobTimeoutMs:number,
):Promise<CompletedJob[]>{
  let cursor=0;
  const completed:CompletedJob[]=[];
  await Promise.all(slots.map(async slot=>{
    while(cursor<jobs.length){
      const remaining=deadline-Date.now();
      if(remaining<=45)break;
      const job=jobs[cursor++]!;
      const timeout=Math.min(jobTimeoutMs,Math.max(45,remaining-25));
      const response=await slot.run(job,timeout);
      if(response?.ok&&typeof response.score==='number'&&Number.isFinite(response.score))completed.push({job,response});
    }
  }));
  return completed;
}

function titleRankPercentiles(stats:TitleChannelStat[],channel:'stableScore'|'complexScore'):Map<string,number>{
  const available=stats.filter(item=>Number.isFinite(item[channel]));
  available.sort((a,b)=>(b[channel]??-Infinity)-(a[channel]??-Infinity));
  const result=new Map<string,number>();
  if(available.length===1){
    result.set(moveKey(available[0]!.move),1);
    return result;
  }
  const denominator=Math.max(1,available.length-1);
  for(let index=0;index<available.length;index++){
    result.set(moveKey(available[index]!.move),(available.length-1-index)/denominator);
  }
  return result;
}

function rankTitleStageResults(candidates:Move[],completed:CompletedJob[]):RankedStageMove[]{
  const byMove=new Map<string,CompletedJob[]>();
  for(const item of completed){
    const key=moveKey(item.job.move);
    const list=byMove.get(key)??[];
    list.push(item);
    byMove.set(key,list);
  }

  const stats:TitleChannelStat[]=[];
  for(const move of candidates){
    const results=byMove.get(moveKey(move));
    if(!results?.length)continue;
    const stable=results.filter(item=>item.job.profileCode===3);
    const complex=results.filter(item=>item.job.profileCode===4);
    const stableComplete=stable.filter(item=>item.response.complete);
    const complexComplete=complex.filter(item=>item.response.complete);
    const stableChosen=stableComplete.length?stableComplete:stable;
    const complexChosen=complexComplete.length?complexComplete:complex;
    const stableScores=stableChosen.map(item=>item.response.score!).filter(Number.isFinite);
    const complexScores=complexChosen.map(item=>item.response.score!).filter(Number.isFinite);
    if(!stableScores.length&&!complexScores.length)continue;
    stats.push({
      move,
      stableScore:stableScores.length?median(stableScores):undefined,
      complexScore:complexScores.length?median(complexScores):undefined,
      depth:Math.max(...results.map(item=>item.response.depth??item.job.depth)),
      nodes:results.reduce((sum,item)=>sum+(item.response.nodesVisited??0),0),
      wasm:results.some(item=>item.response.wasmUsed),
      stableComplete:stableComplete.length>0,
      complexComplete:complexComplete.length>0,
    });
  }

  const stableRanks=titleRankPercentiles(stats,'stableScore');
  const complexRanks=titleRankPercentiles(stats,'complexScore');
  const ranked:RankedStageMove[]=[];
  for(const item of stats){
    const key=moveKey(item.move);
    const stable=stableRanks.get(key);
    const complex=complexRanks.get(key);
    const stableMate=(item.stableScore??-Infinity)>9_000_000;
    const complexMate=(item.complexScore??-Infinity)>9_000_000;
    let consensus:number;
    if(stableMate&&complexMate){
      consensus=10_000_000;
    }else if(stableMate){
      consensus=9_000_000+(complex??0)*100_000;
    }else if(complexMate){
      consensus=8_500_000+(stable??0)*100_000;
    }else if(stable!==undefined&&complex!==undefined){
      const floor=Math.min(stable,complex);
      const agreement=1-Math.abs(stable-complex);
      consensus=(stable*0.50+complex*0.30+floor*0.15+agreement*0.05)*1_000_000;
    }else{
      const single=stable??complex??0;
      consensus=single*650_000-250_000;
    }
    if(!item.stableComplete)consensus-=18_000;
    if(!item.complexComplete)consensus-=18_000;
    ranked.push({move:item.move,score:consensus,depth:item.depth,nodes:item.nodes,wasm:item.wasm});
  }
  return ranked.sort((a,b)=>b.score-a.score||b.depth-a.depth||b.nodes-a.nodes);
}

function rankStageResults(candidates:Move[],completed:CompletedJob[],level:CpuLevel):RankedStageMove[]{
  if(level==='title')return rankTitleStageResults(candidates,completed);
  const byMove=new Map<string,CompletedJob[]>();
  for(const item of completed){
    const key=moveKey(item.job.move);
    const list=byMove.get(key)??[];
    list.push(item);
    byMove.set(key,list);
  }
  const ranked:RankedStageMove[]=[];
  for(const move of candidates){
    const results=byMove.get(moveKey(move));
    if(!results?.length)continue;
    const complete=results.filter(item=>item.response.complete);
    const chosen=complete.length?complete:results;
    const scores=chosen.map(item=>item.response.score!).filter(Number.isFinite);
    if(!scores.length)continue;
    const incompletePenalty=complete.length?0:level==='pro'?12:0;
    ranked.push({
      move,
      score:median(scores)-incompletePenalty,
      depth:Math.max(...chosen.map(item=>item.response.depth??item.job.depth)),
      nodes:chosen.reduce((sum,item)=>sum+(item.response.nodesVisited??0),0),
      wasm:chosen.some(item=>item.response.wasmUsed),
    });
  }
  return ranked.sort((a,b)=>b.score-a.score||b.depth-a.depth||b.nodes-a.nodes);
}

async function parallelSearch(position:Position,level:CpuLevel,wasmUrl?:string):Promise<{result:CpuResult;wasmUsed:boolean}>{
  const profile=CPU_PARALLEL_PROFILES[level];
  const legal=legalMoves(position);
  if(legal.length===0)return{result:{move:null,completedDepth:0,nodesVisited:0,logicalJobsPlanned:0,logicalJobsCompleted:0,physicalWorkers:0},wasmUsed:false};

  const safeLegal=legal.filter(move=>safeAgainstImmediatePerpetualLoss(position,move));
  const usable=safeLegal.length?safeLegal:legal;
  const fastRank=rankCpuMovesFast(position,level).map(item=>item.move).filter(move=>usable.some(candidate=>sameCpuMove(candidate,move)));
  let survivors=fastRank.length?fastRank:[...usable];
  const fallbackMove=chooseCpuFallbackMove(position,level);
  let bestMove:Move=fallbackMove&&usable.some(move=>sameCpuMove(move,fallbackMove))
    ?fallbackMove
    :(survivors[0]??usable[0]!);

  if(level==='beginner'){
    const serial=chooseCpuMove(position,level);
    const move=serial.move&&usable.some(candidate=>sameCpuMove(candidate,serial.move!))?serial.move:bestMove;
    return{result:{...serial,move,logicalJobsPlanned:1,logicalJobsCompleted:1,physicalWorkers:1},wasmUsed:false};
  }

  const deadline=Date.now()+profile.replyDeadlineMs;
  const slots=ensureWorkerPool(level,wasmUrl,position);
  let jobsIssued=0;
  let jobsCompleted=0;
  let nodesVisited=0;
  let completedDepth=0;
  let wasmUsed=false;
  let stage=0;
  let finalRanked:RankedStageMove[]=[];

  while(Date.now()<deadline-80&&jobsIssued<profile.logicalJobTarget&&survivors.length){
    const depth=Math.min(profile.maxDepth,profile.baseDepth+stage*profile.depthStep);
    const laneCount=Math.min(profile.lanes,1+stage);
    const remainingJobs=profile.logicalJobTarget-jobsIssued;
    const growth=level==='title'?1.9:1.7;
    const nodeLimit=Math.min(220_000,Math.trunc(profile.nodeBase*Math.pow(growth,stage)));
    const jobs:RootSearchJob[]=[];
    const analysisProfiles=level==='title'?[3,4]:[profile.profileCode];
    outer:for(let lane=0;lane<laneCount;lane++){
      for(const analysisProfile of analysisProfiles){
        for(const move of survivors){
          jobs.push({
            jobId:`${stage}-${lane}-${analysisProfile}-${jobsIssued+jobs.length}-${crypto.randomUUID()}`,
            move,depth,nodeLimit,lane,level,profileCode:analysisProfile,
          });
          if(jobs.length>=remainingJobs)break outer;
        }
      }
    }
    if(!jobs.length)break;
    jobsIssued+=jobs.length;
    const completed=await runStage(slots,jobs,deadline,profile.jobTimeoutMs);
    jobsCompleted+=completed.length;
    nodesVisited+=completed.reduce((sum,item)=>sum+(item.response.nodesVisited??0),0);
    wasmUsed ||= completed.some(item=>item.response.wasmUsed);
    const ranked=rankStageResults(survivors,completed,level);
    if(ranked.length){
      const validRanked=ranked.filter(item=>safeAgainstImmediatePerpetualLoss(position,item.move));
      const chosen=validRanked.length?validRanked:ranked;
      finalRanked=chosen;
      bestMove=chosen[0]!.move;
      completedDepth=Math.max(completedDepth,chosen[0]!.depth);
      const retentionTarget=Math.ceil(chosen.length*profile.retention);
      const survivorFloor=Math.min(profile.minSurvivors,chosen.length);
      const keep=Math.max(1,Math.min(chosen.length,Math.max(survivorFloor,retentionTarget)));
      survivors=chosen.slice(0,keep).map(item=>item.move);
    }else if(Date.now()>=deadline-120){
      break;
    }
    if(depth>=profile.maxDepth&&survivors.length===1)break;
    stage++;
  }

  if(finalRanked.length){
    const varied=chooseCpuMoveFromRanked(level,position.ply,finalRanked);
    if(varied&&usable.some(move=>sameCpuMove(move,varied)))bestMove=varied;
  }
  if(!usable.some(move=>sameCpuMove(move,bestMove)))bestMove=usable[0]!;
  return{
    result:{
      move:bestMove,
      completedDepth,
      nodesVisited,
      logicalJobsPlanned:profile.logicalJobTarget,
      logicalJobsCompleted:jobsCompleted,
      physicalWorkers:slots.length,
    },
    wasmUsed,
  };
}

self.onmessage=async(event:MessageEvent<CpuWorkerRequest>)=>{
  const message=event.data;
  if(message.type==='warmup'){
    ensureWorkerPool(message.level,message.wasmUrl,message.position);
    return;
  }

  const {requestId,position,level,wasmUrl}=message;
  const key=positionKey(position);
  try{
    const searched=await parallelSearch(position,level,wasmUrl);
    const response:CpuResponse={requestId,positionKey:key,ok:true,wasmUsed:searched.wasmUsed,result:searched.result};
    self.postMessage(response);
  }catch(error){
    const fallback=chooseCpuFallbackMove(position,level);
    const response:CpuResponse=fallback
      ?{requestId,positionKey:key,ok:true,wasmUsed:false,result:{move:fallback,completedDepth:0,nodesVisited:0,logicalJobsCompleted:0,physicalWorkers:workerPool.length}}
      :{requestId,positionKey:key,ok:false,wasmUsed:false,error:error instanceof Error?error.message:'CPU_SEARCH_FAILED'};
    self.postMessage(response);
  }
};

export {};
