import type { OrderPreference } from './setup';
import type { Handicap, Move, Position, Side } from './types';

export type TitlePhase='human_turn'|'cpu_pending'|'ended';
export type TitleOutcome=
  | {ended:false}
  | {ended:true;reason:'mate';winner:Side;loser:Side}
  | {ended:true;reason:'repetition';draw:true}
  | {ended:true;reason:'perpetual-check';winner:Side;loser:Side}
  | {ended:true;reason:'resignation';winner:Side;loser:Side};

export interface TitleResponse {
  ok:true;
  phase:TitlePhase;
  gameId:string;
  stateToken:string;
  position:Position;
  humanSide:Side;
  titleSide:Side;
  outcome:TitleOutcome;
  title?:{
    move:Move;
    moveCode:number;
    score:number;
    nodes:number;
    elapsedMs:number;
    specialistMaxMs:number;
    computePathMs:number;
  };
}

export interface TitleSession {gameId:string;stateToken:string}

export class TitleClientError extends Error{
  constructor(public readonly code:string,public readonly status:number,public readonly response:unknown){super(code);this.name='TitleClientError';}
}

function endpoint():string{
  const value=(import.meta.env.VITE_TITLE_SUPABASE_URL as string|undefined)?.trim();
  if(!value)throw new TitleClientError('TITLE_API_NOT_CONFIGURED',0,null);
  return value;
}
function publishableKey():string{
  const value=(import.meta.env.VITE_TITLE_SUPABASE_KEY as string|undefined)?.trim();
  if(!value)throw new TitleClientError('TITLE_API_NOT_CONFIGURED',0,null);
  return value;
}
function isSide(value:unknown):value is Side{return value==='sente'||value==='gote';}
function isPhase(value:unknown):value is TitlePhase{return value==='human_turn'||value==='cpu_pending'||value==='ended';}
function parseResponse(value:unknown):TitleResponse{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TitleClientError('TITLE_RESPONSE_INVALID',0,value);
  const data=value as Record<string,unknown>;
  if(data.ok!==true||!isPhase(data.phase)||typeof data.gameId!=='string'||typeof data.stateToken!=='string'||!data.position||typeof data.position!=='object'||!isSide(data.humanSide)||!isSide(data.titleSide)||!data.outcome||typeof data.outcome!=='object')throw new TitleClientError('TITLE_RESPONSE_INVALID',0,value);
  return value as TitleResponse;
}
async function post(body:Record<string,unknown>):Promise<TitleResponse>{
  const response=await fetch(endpoint(),{method:'POST',headers:{'content-type':'application/json',apikey:publishableKey()},body:JSON.stringify(body),cache:'no-store'});
  let data:unknown=null;
  try{data=await response.json();}catch{throw new TitleClientError(`TITLE_HTTP_${response.status}`,response.status,null);}
  if(!response.ok||(data as {ok?:unknown})?.ok!==true){
    const code=typeof (data as {error?:unknown})?.error==='string'?String((data as {error:string}).error):`TITLE_HTTP_${response.status}`;
    throw new TitleClientError(code,response.status,data);
  }
  return parseResponse(data);
}

export function startTitleMatch(config:{order:OrderPreference;senteHandicap:Handicap;goteHandicap:Handicap}){
  return post({action:'start_match',order:config.order,senteHandicap:config.senteHandicap,goteHandicap:config.goteHandicap});
}
export function submitTitleMove(session:TitleSession,move:Move){return post({action:'user_move',gameId:session.gameId,stateToken:session.stateToken,move});}
export function getTitleStatus(session:TitleSession){return post({action:'status',gameId:session.gameId,stateToken:session.stateToken});}
export function resignTitleMatch(session:TitleSession){return post({action:'resign',gameId:session.gameId,stateToken:session.stateToken});}
