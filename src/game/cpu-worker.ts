/// <reference lib="webworker" />
import { CPU_PARALLEL_PROFILES, chooseCpuFallbackMove, chooseCpuMove, rankCpuMovesFast, sameCpuMove } from './cpu';
import { applyMove, gameOutcome, legalMoves, positionKey } from './engine';
import type { CpuLevel, Move, Position } from './types';

interface CpuRequest {
  requestId:string;
  position:Position;
  level:CpuLevel;
  wasmUrl?:string;
}

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
  constructor(private readonly position:Position,private readonly wasmUrl?:string){
    this.worker=this.spawn();
  }

  private spawn():Worker{
    const worker=new Worker(new URL('./cpu-search-worker.ts',import.meta.url),{type:'module'});
    worker.postMessage({type:'init',position:this.position,wasmUrl:this.wasmUrl});
    return worker;
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
        if(replace&&this.worker===worker){
          worker.terminate();
          this.worker=this.spawn();
        }
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

function physicalWorkerCount(level:CpuLevel):number{
  const profile=CPU_PARALLEL_PROFILES[level];
  const reported=Number(navigator.hardwareConcurrency||4);
  const hardware=Number.isFinite(reported)&&reported>0?Math.trunc(reported):4;
  const computeSlots=Math.max(1,hardware-1);
  return Math.max(1,Math.min(profile.workerCap,computeSlots));
}

async function runStage(
  slots:RootWorkerSlot[],
  jobs:RootSearchJob[],
  deadline:number,
):Promise<CompletedJob[]>{
  let cursor=0;
  const completed:CompletedJob[]=[];
  await Promise.all(slots.map(async slot=>{
    while(cursor<jobs.length){
      const remaining=deadline-Date.now();
      if(remaining<=45)break;
      const job=jobs[cursor++]!;
      const timeout=Math.min(320,Math.max(45,remaining-25));
      const response=await slot.run(job,timeout);
      if(response?.ok&&typeof response.score==='number'&&Number.isFinite(response.score))completed.push({job,response});
    }
  }));
  return completed;
}

function rankStageResults(candidates:Move[],completed:CompletedJob[]):{move:Move;score:number;depth:number;nodes:number;wasm:boolean}[]{
  const byMove=new Map<string,CompletedJob[]>();
  for(const item of completed){
    const key=moveKey(item.job.move);
    const list=byMove.get(key)??[];
    list.push(item);
    byMove.set(key,list);
  }
  const ranked:{move:Move;score:number;depth:number;nodes:number;wasm:boolean}[]=[];
  for(const move of candidates){
    const results=byMove.get(moveKey(move));
    if(!results?.length)continue;
    const complete=results.filter(item=>item.response.complete);
    const chosen=complete.length?complete:results;
    const scores=chosen.map(item=>item.response.score!).filter(Number.isFinite);
    if(!scores.length)continue;
    ranked.push({
      move,
      score:median(scores),
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
  const fastRank=rankCpuMovesFast(position).map(item=>item.move).filter(move=>usable.some(candidate=>sameCpuMove(candidate,move)));
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
  const workerCount=physicalWorkerCount(level);
  const slots=Array.from({length:workerCount},()=>new RootWorkerSlot(position,wasmUrl));
  let jobsIssued=0;
  let jobsCompleted=0;
  let nodesVisited=0;
  let completedDepth=0;
  let wasmUsed=false;
  let stage=0;

  try{
    while(Date.now()<deadline-80&&jobsIssued<profile.logicalJobTarget&&survivors.length){
      const depth=Math.min(profile.maxDepth,profile.baseDepth+stage);
      const laneCount=Math.min(profile.lanes,1+stage);
      const remainingJobs=profile.logicalJobTarget-jobsIssued;
      const nodeLimit=Math.min(120_000,Math.trunc(profile.nodeBase*Math.pow(1.7,stage)));
      const jobs:RootSearchJob[]=[];
      outer:for(let lane=0;lane<laneCount;lane++){
        for(const move of survivors){
          jobs.push({jobId:`${stage}-${lane}-${jobsIssued+jobs.length}-${crypto.randomUUID()}`,move,depth,nodeLimit,lane});
          if(jobs.length>=remainingJobs)break outer;
        }
      }
      if(!jobs.length)break;
      jobsIssued+=jobs.length;
      const completed=await runStage(slots,jobs,deadline);
      jobsCompleted+=completed.length;
      nodesVisited+=completed.reduce((sum,item)=>sum+(item.response.nodesVisited??0),0);
      wasmUsed ||= completed.some(item=>item.response.wasmUsed);
      const ranked=rankStageResults(survivors,completed);
      if(ranked.length){
        const validRanked=ranked.filter(item=>safeAgainstImmediatePerpetualLoss(position,item.move));
        const chosen=validRanked.length?validRanked:ranked;
        bestMove=chosen[0]!.move;
        completedDepth=Math.max(completedDepth,chosen[0]!.depth);
        const keep=Math.min(
          chosen.length,
          Math.max(1,Math.min(profile.minSurvivors,chosen.length),Math.ceil(chosen.length*profile.retention)),
        );
        survivors=chosen.slice(0,keep).map(item=>item.move);
      }else if(Date.now()>=deadline-120){
        break;
      }
      if(depth>=profile.maxDepth&&survivors.length===1)break;
      stage++;
    }
  }finally{
    for(const slot of slots)slot.terminate();
  }

  if(!usable.some(move=>sameCpuMove(move,bestMove)))bestMove=usable[0]!;
  return{
    result:{
      move:bestMove,
      completedDepth,
      nodesVisited,
      logicalJobsPlanned:profile.logicalJobTarget,
      logicalJobsCompleted:jobsCompleted,
      physicalWorkers:workerCount,
    },
    wasmUsed,
  };
}

self.onmessage=async(event:MessageEvent<CpuRequest>)=>{
  const {requestId,position,level,wasmUrl}=event.data;
  const key=positionKey(position);
  try{
    const searched=await parallelSearch(position,level,wasmUrl);
    const response:CpuResponse={requestId,positionKey:key,ok:true,wasmUsed:searched.wasmUsed,result:searched.result};
    self.postMessage(response);
  }catch(error){
    try{
      const fallback=chooseCpuMove(position,level);
      const response:CpuResponse={requestId,positionKey:key,ok:true,wasmUsed:false,result:fallback};
      self.postMessage(response);
    }catch(fallbackError){
      const response:CpuResponse={
        requestId,positionKey:key,ok:false,wasmUsed:false,
        error:fallbackError instanceof Error?fallbackError.message:error instanceof Error?error.message:'CPU_SEARCH_FAILED',
      };
      self.postMessage(response);
    }
  }
};

export {};
