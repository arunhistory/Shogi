import {applyMove,gameOutcome,legalMoves} from '../src/game/engine';
import type {Move} from '../src/game/types';
import {writeFileSync} from 'node:fs';

const stateB64=process.env.STATE_B64??'';
const moveCode=Number(process.env.MOVE_CODE);
const specialistMaxMs=Number(process.env.SPECIALIST_MAX_MS??0);
const specialistEnvelopeMs=Number(process.env.SPECIALIST_ENVELOPE_MS??0);
const specialistNodes=Number(process.env.SPECIALIST_NODES??0);
const convergenceNodes=Number(process.env.CONVERGENCE_NODES??0);
const convergenceMs=Number(process.env.CONVERGENCE_MS??0);
const convergenceScore=Number(process.env.CONVERGENCE_SCORE??0);
const mateShortCircuits=Number(process.env.MATE_SHORT_CIRCUITS??0);
const outputPath=process.env.TITLE_STEP_OUTPUT??'/tmp/title-step-result.json';

if(!stateB64)throw new Error('STATE_B64_REQUIRED');
if(!Number.isInteger(moveCode)||moveCode<0)throw new Error('MOVE_CODE_INVALID');
const state=JSON.parse(Buffer.from(stateB64,'base64').toString('utf8'));
if(!state||state.version!==1||!state.position)throw new Error('STATE_INVALID');
if(state.position.turn!==state.titleSide)throw new Error(`TITLE_STEP_WRONG_TURN:${state.position.turn}`);

function decodeMove(code:number):Move|null{
  const to=code&0x7f,from=(code>>7)&0x7f,drop=(code>>14)&0xf,promote=((code>>18)&1)===1;
  if(to<0||to>=81)return null;
  const dst:[number,number]=[Math.floor(to/9),to%9];
  if(drop){
    const kinds:Record<number,Move['drop']>={1:'pawn',2:'lance',3:'knight',4:'silver',5:'gold',6:'bishop',7:'rook'};
    const kind=kinds[drop];if(!kind||from!==127||promote)return null;
    return{drop:kind,to:dst};
  }
  if(from<0||from>=81)return null;
  return{from:[Math.floor(from/9),from%9],to:dst,...(promote?{promote:true}:{})};
}
function sameMove(a:Move,b:Move):boolean{
  return a.to[0]===b.to[0]&&a.to[1]===b.to[1]
    &&a.from?.[0]===b.from?.[0]&&a.from?.[1]===b.from?.[1]
    &&a.drop===b.drop&&!!a.promote===!!b.promote;
}

const decoded=decodeMove(moveCode);if(!decoded)throw new Error('TITLE_MOVE_DECODE_FAILED');
const legal=legalMoves(state.position);
const verified=legal.find(candidate=>sameMove(candidate,decoded));
if(!verified)throw new Error(`TITLE_ILLEGAL_MOVE:${moveCode}`);
const position=applyMove(state.position,verified);
const computePathMs=specialistMaxMs+convergenceMs;
const next={
  ...state,
  position,
  round:Number(state.round??0)+1,
  titleMoves:Number(state.titleMoves??0)+1,
  titleTotalMs:Number(state.titleTotalMs??0)+computePathMs,
  titleMaxMs:Math.max(Number(state.titleMaxMs??0),computePathMs),
  titleSpecialistNodes:Number(state.titleSpecialistNodes??0)+specialistNodes,
  titleConvergenceNodes:Number(state.titleConvergenceNodes??0)+convergenceNodes,
  titleMateShortCircuits:Number(state.titleMateShortCircuits??0)+mateShortCircuits,
  titleSpecialistEnvelopeTotalMs:Number(state.titleSpecialistEnvelopeTotalMs??0)+specialistEnvelopeMs,
  firstTitleMoveCode:state.firstTitleMoveCode??moveCode,
  lastTitleMoveCode:moveCode,
};
const outcome=gameOutcome(position);
const encoded=Buffer.from(JSON.stringify(next),'utf8').toString('base64');
if(encoded.length>60000)throw new Error(`STATE_TOO_LARGE:${encoded.length}`);
const result={stateB64:encoded,gameEnded:outcome.ended,outcome,title:{move:verified,moveCode,score:convergenceScore,computePathMs,specialistMaxMs,specialistEnvelopeMs,convergenceMs,specialistNodes,convergenceNodes,mateShortCircuits},round:next.round,stateBytes:Buffer.byteLength(JSON.stringify(next),'utf8')};
writeFileSync(outputPath,JSON.stringify(result));
console.log('TITLE_STEP_RESULT:'+JSON.stringify(result));
