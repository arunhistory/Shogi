import type { BoardKind, Move, PieceKind, Position } from './types';

export interface TitleGpuForecastFabricResult {
  supported:boolean;
  complete:boolean;
  layers:number;
  lanesPerLayer:number;
  samplesPerLane:number;
  plannedSamples:number;
  totalSamples:number;
  elapsedMs:number;
  samplesPerSecond:number;
  signaturesChecked:number;
  stateTransitions:number;
  rootScores:number[];
  bestMoveIndex:number|null;
  reason?:string;
}

const FORECAST_LAYERS=500;
const LANES_PER_LAYER=64;
const SAMPLES_PER_LANE=3125;
const POSITION_WORDS=96;
const OUTPUT_WORDS_PER_PATH=5;
const PATH_COUNT=FORECAST_LAYERS*LANES_PER_LAYER;

const pieceCodes:Record<BoardKind,number>={
  pawn:1,lance:2,knight:3,silver:4,gold:5,bishop:6,rook:7,king:8,
  tokin:9,promotedLance:10,promotedKnight:11,promotedSilver:12,horse:13,dragon:14,
};
const handKinds:Exclude<PieceKind,'king'>[]=['pawn','lance','knight','silver','gold','bishop','rook'];
const dropCodes:Record<Exclude<PieceKind,'king'>,number>={pawn:1,lance:2,knight:3,silver:4,gold:5,bishop:6,rook:7};

interface GpuFabricRuntime { device:any; pipeline:any; bindGroupLayout:any }
let runtimePromise:Promise<GpuFabricRuntime|null>|null=null;

function encodePosition(position:Position):Int32Array{
  const words=new Int32Array(POSITION_WORDS);
  let index=0;
  for(const row of position.board){
    for(const piece of row)words[index++]=piece?(piece.side==='sente'?1:-1)*pieceCodes[piece.kind]:0;
  }
  for(const side of ['sente','gote'] as const){
    for(const kind of handKinds)words[index++]=position.hands[side][kind];
  }
  words[index]=position.turn==='sente'?1:-1;
  return words;
}

function encodeMove(move:Move):number{
  const destination=move.to[0]*9+move.to[1];
  if(move.drop){
    if(move.drop==='king')throw new Error('GPU_KING_DROP_INVALID');
    return (destination|(127<<7)|(dropCodes[move.drop]<<14))>>>0;
  }
  if(!move.from)throw new Error('GPU_MOVE_SOURCE_MISSING');
  const source=move.from[0]*9+move.from[1];
  return (destination|(source<<7)|(move.promote?1<<18:0))>>>0;
}

const shader=`
struct Params { iterations:u32, moveCount:u32, stateWords:u32, salt:u32 };
struct Undo { source:u32, destination:u32, sourceValue:i32, destinationValue:i32, handIndex:u32, handValue:i32, turnValue:i32 };
struct CandidateEval { valid:u32, score:i32, encoded:u32 };
@group(0) @binding(0) var<storage,read> baseState:array<i32>;
@group(0) @binding(1) var<storage,read> rootMoves:array<u32>;
@group(0) @binding(2) var<storage,read_write> output:array<u32>;
@group(0) @binding(3) var<uniform> params:Params;

var<workgroup> states:array<i32,${POSITION_WORDS*LANES_PER_LAYER}>;

fn slot(lane:u32,word:u32)->u32{return lane*${POSITION_WORDS}u+word;}
fn getState(lane:u32,word:u32)->i32{return states[slot(lane,word)];}
fn setState(lane:u32,word:u32,value:i32){states[slot(lane,word)]=value;}
fn absI(value:i32)->i32{return select(value,-value,value<0);}
fn absCode(value:i32)->u32{return u32(absI(value));}
fn sideOf(value:i32)->i32{return select(-1,1,value>0);}
fn rowOf(square:u32)->i32{return i32(square/9u);}
fn colOf(square:u32)->i32{return i32(square%9u);}
fn inside(y:i32,x:i32)->bool{return y>=0&&y<9&&x>=0&&x<9;}
fn squareOf(y:i32,x:i32)->u32{return u32(y*9+x);}
fn baseKind(kind:u32)->u32{
  if(kind==9u){return 1u;} if(kind==10u){return 2u;} if(kind==11u){return 3u;}
  if(kind==12u){return 4u;} if(kind==13u){return 6u;} if(kind==14u){return 7u;} return kind;
}
fn promotedKind(kind:u32)->u32{
  if(kind==1u){return 9u;} if(kind==2u){return 10u;} if(kind==3u){return 11u;}
  if(kind==4u){return 12u;} if(kind==6u){return 13u;} if(kind==7u){return 14u;} return kind;
}
fn promotable(kind:u32)->bool{
  let base=baseKind(kind);
  return base==1u||base==2u||base==3u||base==4u||base==6u||base==7u;
}
fn promotionZone(side:i32,y:i32)->bool{return select(y>=6,y<=2,side>0);}
fn mustPromote(base:u32,side:i32,y:i32)->bool{
  if((base==1u||base==2u)&&select(y==8,y==0,side>0)){return true;}
  if(base==3u&&select(y>=7,y<=1,side>0)){return true;}
  return false;
}
fn handOffset(side:i32)->u32{return select(88u,81u,side>0);}
fn pieceValue(kind:u32)->i32{
  if(kind==1u){return 100;} if(kind==2u){return 320;} if(kind==3u){return 360;}
  if(kind==4u){return 520;} if(kind==5u){return 600;} if(kind==6u){return 900;}
  if(kind==7u){return 1000;} if(kind==8u){return 0;}
  if(kind==9u||kind==10u||kind==11u||kind==12u){return 610;}
  if(kind==13u){return 1250;} if(kind==14u){return 1350;} return 0;
}
fn mix32(value:u32)->u32{
  var x=value+0x9e3779b9u;
  x=(x^(x>>16u))*0x85ebca6bu;
  x=(x^(x>>13u))*0xc2b2ae35u;
  return x^(x>>16u);
}
fn pathClear(lane:u32,source:u32,destination:u32)->bool{
  let sy=rowOf(source); let sx=colOf(source); let dy=rowOf(destination); let dx=colOf(destination);
  let stepY=select(select(-1,1,dy>sy),0,dy==sy);
  let stepX=select(select(-1,1,dx>sx),0,dx==sx);
  var y=sy+stepY; var x=sx+stepX;
  loop{
    if(y==dy&&x==dx){break;}
    if(!inside(y,x)){return false;}
    if(getState(lane,squareOf(y,x))!=0){return false;}
    y=y+stepY; x=x+stepX;
  }
  return true;
}
fn attacksSquare(lane:u32,source:u32,destination:u32)->bool{
  let code=getState(lane,source);
  if(code==0||source==destination){return false;}
  let side=sideOf(code); let kind=absCode(code);
  let sy=rowOf(source); let sx=colOf(source); let dy=rowOf(destination)-sy; let dx=colOf(destination)-sx;
  let ady=absI(dy); let adx=absI(dx); let f=select(1,-1,side>0);
  if(kind==8u){return ady<=1&&adx<=1;}
  if(kind==5u||kind==9u||kind==10u||kind==11u||kind==12u){
    return (dy==f&&adx<=1)||(dy==0&&adx==1)||(dy==-f&&dx==0);
  }
  if(kind==4u){return (dy==f&&adx<=1)||(dy==-f&&adx==1);}
  if(kind==3u){return dy==2*f&&adx==1;}
  if(kind==1u){return dy==f&&dx==0;}
  if(kind==2u){return dx==0&&((f<0&&dy<0)||(f>0&&dy>0))&&pathClear(lane,source,destination);}
  if(kind==7u||kind==14u){
    if((dy==0||dx==0)&&pathClear(lane,source,destination)){return true;}
    if(kind==14u&&ady==1&&adx==1){return true;}
    return false;
  }
  if(kind==6u||kind==13u){
    if(ady==adx&&pathClear(lane,source,destination)){return true;}
    if(kind==13u&&((ady==1&&dx==0)||(adx==1&&dy==0))){return true;}
    return false;
  }
  return false;
}
fn isCheck(lane:u32,side:i32)->bool{
  var king=81u;
  var square=0u;
  loop{
    if(square>=81u){break;}
    if(getState(lane,square)==side*8){king=square;break;}
    square=square+1u;
  }
  if(king>=81u){return true;}
  square=0u;
  loop{
    if(square>=81u){break;}
    let value=getState(lane,square);
    if(value!=0&&sideOf(value)==-side&&attacksSquare(lane,square,king)){return true;}
    square=square+1u;
  }
  return false;
}
fn hasPawnOnFile(lane:u32,side:i32,x:i32)->bool{
  var y=0;
  loop{
    if(y>=9){break;}
    if(getState(lane,squareOf(y,x))==side){return true;}
    y=y+1;
  }
  return false;
}
fn basicCandidateLegal(lane:u32,encoded:u32,side:i32)->bool{
  let destination=encoded&0x7fu;
  let source=(encoded>>7u)&0x7fu;
  let drop=(encoded>>14u)&0x0fu;
  let promote=((encoded>>18u)&1u)==1u;
  if(destination>=81u){return false;}
  if(drop!=0u){
    if(drop>7u||source!=127u||promote||getState(lane,destination)!=0){return false;}
    let handIndex=handOffset(side)+(drop-1u);
    if(getState(lane,handIndex)<=0){return false;}
    let y=rowOf(destination); let x=colOf(destination);
    if((drop==1u||drop==2u)&&select(y==8,y==0,side>0)){return false;}
    if(drop==3u&&select(y>=7,y<=1,side>0)){return false;}
    if(drop==1u&&hasPawnOnFile(lane,side,x)){return false;}
    return true;
  }
  if(source>=81u){return false;}
  let piece=getState(lane,source);
  if(piece==0||sideOf(piece)!=side){return false;}
  let destinationValue=getState(lane,destination);
  if(destinationValue!=0&&(sideOf(destinationValue)==side||absCode(destinationValue)==8u)){return false;}
  if(!attacksSquare(lane,source,destination)){return false;}
  let kind=absCode(piece); let base=baseKind(kind); let destinationY=rowOf(destination);
  let forced=mustPromote(base,side,destinationY);
  if(forced&&!promote){return false;}
  if(promote){
    if(kind!=base||!promotable(kind)){return false;}
    if(!(promotionZone(side,rowOf(source))||promotionZone(side,destinationY))){return false;}
  }
  return true;
}
fn applyEncoded(lane:u32,encoded:u32)->Undo{
  let destination=encoded&0x7fu;
  let source=(encoded>>7u)&0x7fu;
  let drop=(encoded>>14u)&0x0fu;
  let promote=((encoded>>18u)&1u)==1u;
  let side=getState(lane,95u);
  var undo=Undo(source,destination,0,getState(lane,destination),0xffffffffu,0,side);
  if(drop!=0u){
    let handIndex=handOffset(side)+(drop-1u);
    undo.handIndex=handIndex; undo.handValue=getState(lane,handIndex);
    setState(lane,handIndex,undo.handValue-1);
    setState(lane,destination,side*i32(drop));
  }else{
    undo.sourceValue=getState(lane,source);
    let captured=undo.destinationValue;
    if(captured!=0){
      let capturedBase=baseKind(absCode(captured));
      if(capturedBase>=1u&&capturedBase<=7u){
        let handIndex=handOffset(side)+(capturedBase-1u);
        undo.handIndex=handIndex; undo.handValue=getState(lane,handIndex);
        setState(lane,handIndex,undo.handValue+1);
      }
    }
    var kind=absCode(undo.sourceValue);
    if(promote){kind=promotedKind(kind);}
    setState(lane,source,0);
    setState(lane,destination,side*i32(kind));
  }
  setState(lane,95u,-side);
  return undo;
}
fn revertEncoded(lane:u32,undo:Undo){
  setState(lane,95u,undo.turnValue);
  if(undo.source<81u){setState(lane,undo.source,undo.sourceValue);}
  setState(lane,undo.destination,undo.destinationValue);
  if(undo.handIndex!=0xffffffffu){setState(lane,undo.handIndex,undo.handValue);}
}
fn evaluateFor(lane:u32,perspective:i32)->i32{
  var score=0;
  var ownKing=40u; var enemyKing=40u; var square=0u;
  loop{
    if(square>=81u){break;}
    let value=getState(lane,square);
    if(value!=0&&absCode(value)==8u){
      if(sideOf(value)==perspective){ownKing=square;}else{enemyKing=square;}
    }
    square=square+1u;
  }
  square=0u;
  loop{
    if(square>=81u){break;}
    let value=getState(lane,square);
    if(value!=0){
      let side=sideOf(value); let sign=select(-1,1,side==perspective); let kind=absCode(value);
      let y=rowOf(square); let x=colOf(square); let center=4-absI(x-4);
      let progress=select(y,8-y,side>0);
      score=score+sign*(pieceValue(kind)+center*3+max(0,progress-3)*2);
      let kingSquare=select(enemyKing,ownKing,side==perspective);
      let distance=max(absI(y-rowOf(kingSquare)),absI(x-colOf(kingSquare)));
      if(distance<=2){score=score+sign*(3-distance)*14;}
    }
    square=square+1u;
  }
  var hand=0u;
  loop{
    if(hand>=7u){break;}
    score=score+(getState(lane,81u+hand)-getState(lane,88u+hand))*pieceValue(hand+1u)*perspective;
    hand=hand+1u;
  }
  return score;
}
fn ownPieceCount(lane:u32,side:i32)->u32{
  var count=0u; var square=0u;
  loop{if(square>=81u){break;} if(getState(lane,square)!=0&&sideOf(getState(lane,square))==side){count=count+1u;} square= square+1u;}
  return count;
}
fn nthOwnSquare(lane:u32,side:i32,nth:u32)->u32{
  var seen=0u; var square=0u;
  loop{
    if(square>=81u){break;}
    let value=getState(lane,square);
    if(value!=0&&sideOf(value)==side){if(seen==nth){return square;} seen=seen+1u;}
    square=square+1u;
  }
  return 81u;
}
fn handKindCount(lane:u32,side:i32)->u32{
  var count=0u; var kind=1u;
  loop{if(kind>7u){break;} if(getState(lane,handOffset(side)+(kind-1u))>0){count=count+1u;} kind=kind+1u;}
  return count;
}
fn nthHandKind(lane:u32,side:i32,nth:u32)->u32{
  var seen=0u; var kind=1u;
  loop{
    if(kind>7u){break;}
    if(getState(lane,handOffset(side)+(kind-1u))>0){if(seen==nth){return kind;} seen=seen+1u;}
    kind=kind+1u;
  }
  return 0u;
}
fn boardCandidate(lane:u32,side:i32,seed:u32)->u32{
  let count=ownPieceCount(lane,side);
  if(count==0u){return 0xffffffffu;}
  let source=nthOwnSquare(lane,side,seed%count);
  if(source>=81u){return 0xffffffffu;}
  let kind=absCode(getState(lane,source)); let f=select(1,-1,side>0);
  let pattern=(seed>>8u)&63u; var dy=0; var dx=0;
  if(kind==8u){
    let p=pattern%8u;
    if(p==0u){dy=-1;dx=-1;}else if(p==1u){dy=-1;dx=0;}else if(p==2u){dy=-1;dx=1;}else if(p==3u){dy=0;dx=-1;}else if(p==4u){dy=0;dx=1;}else if(p==5u){dy=1;dx=-1;}else if(p==6u){dy=1;dx=0;}else{dy=1;dx=1;}
  }else if(kind==5u||kind==9u||kind==10u||kind==11u||kind==12u){
    let p=pattern%6u;
    if(p==0u){dy=f;dx=-1;}else if(p==1u){dy=f;dx=0;}else if(p==2u){dy=f;dx=1;}else if(p==3u){dy=0;dx=-1;}else if(p==4u){dy=0;dx=1;}else{dy=-f;dx=0;}
  }else if(kind==4u){
    let p=pattern%5u;
    if(p==0u){dy=f;dx=-1;}else if(p==1u){dy=f;dx=0;}else if(p==2u){dy=f;dx=1;}else if(p==3u){dy=-f;dx=-1;}else{dy=-f;dx=1;}
  }else if(kind==3u){dy=2*f;dx=select(-1,1,(pattern&1u)==1u);
  }else if(kind==2u){dy=f*(1+i32(pattern%8u));dx=0;
  }else if(kind==1u){dy=f;dx=0;
  }else if(kind==7u||kind==14u){
    let rookSpan=32u; let p=pattern%(select(rookSpan,36u,kind==14u));
    if(p<rookSpan){let dir=p/8u;let dist=1+i32(p%8u);if(dir==0u){dy=-dist;}else if(dir==1u){dy=dist;}else if(dir==2u){dx=-dist;}else{dx=dist;}}
    else{let q=p-rookSpan;if(q==0u){dy=-1;dx=-1;}else if(q==1u){dy=-1;dx=1;}else if(q==2u){dy=1;dx=-1;}else{dy=1;dx=1;}}
  }else if(kind==6u||kind==13u){
    let bishopSpan=32u; let p=pattern%(select(bishopSpan,36u,kind==13u));
    if(p<bishopSpan){let dir=p/8u;let dist=1+i32(p%8u);if(dir==0u){dy=-dist;dx=-dist;}else if(dir==1u){dy=-dist;dx=dist;}else if(dir==2u){dy=dist;dx=-dist;}else{dy=dist;dx=dist;}}
    else{let q=p-bishopSpan;if(q==0u){dy=-1;}else if(q==1u){dy=1;}else if(q==2u){dx=-1;}else{dx=1;}}
  }else{return 0xffffffffu;}
  let destinationY=rowOf(source)+dy; let destinationX=colOf(source)+dx;
  if(!inside(destinationY,destinationX)){return 0xffffffffu;}
  let destination=squareOf(destinationY,destinationX);
  let promote=((seed>>20u)&1u)==1u;
  return (destination|(source<<7u)|select(0u,1u<<18u,promote));
}
fn dropCandidate(lane:u32,side:i32,seed:u32)->u32{
  let count=handKindCount(lane,side);
  if(count==0u){return 0xffffffffu;}
  let kind=nthHandKind(lane,side,(seed>>5u)%count);
  if(kind==0u){return 0xffffffffu;}
  let destination=(seed>>12u)%81u;
  return destination|(127u<<7u)|(kind<<14u);
}
fn generatedCandidate(lane:u32,side:i32,seed:u32)->u32{
  let handCount=handKindCount(lane,side);
  if(handCount>0u&&(seed&7u)==0u){return dropCandidate(lane,side,seed);}
  return boardCandidate(lane,side,seed);
}
fn legalNoPawnMateRecursion(lane:u32,encoded:u32,side:i32)->bool{
  if(!basicCandidateLegal(lane,encoded,side)){return false;}
  let drop=(encoded>>14u)&0x0fu;
  let undo=applyEncoded(lane,encoded);
  var legal=!isCheck(lane,side);
  if(legal&&drop==1u&&isCheck(lane,-side)){legal=false;}
  revertEncoded(lane,undo);
  return legal;
}
fn hasConservativeReply(lane:u32,side:i32,seedBase:u32)->bool{
  var attempt=0u;
  loop{
    if(attempt>=256u){break;}
    let seed=mix32(seedBase+attempt*0x9e3779b9u);
    let encoded=generatedCandidate(lane,side,seed);
    if(encoded!=0xffffffffu&&legalNoPawnMateRecursion(lane,encoded,side)){return true;}
    attempt=attempt+1u;
  }
  return false;
}
fn evaluateCandidate(lane:u32,encoded:u32,side:i32,seed:u32)->CandidateEval{
  if(encoded==0xffffffffu||!basicCandidateLegal(lane,encoded,side)){return CandidateEval(0u,-20000000,encoded);}
  let drop=(encoded>>14u)&0x0fu;
  let undo=applyEncoded(lane,encoded);
  var legal=!isCheck(lane,side);
  if(legal&&drop==1u&&isCheck(lane,-side)){
    legal=hasConservativeReply(lane,-side,mix32(seed^0xa511e9b3u));
  }
  let score=select(-20000000,evaluateFor(lane,side),legal);
  revertEncoded(lane,undo);
  return CandidateEval(select(0u,1u,legal),score,encoded);
}
fn resetPath(lane:u32,rootEncoded:u32){
  var word=0u;
  loop{if(word>=params.stateWords){break;} setState(lane,word,baseState[word]); word=word+1u;}
  let ignoredRootUndo=applyEncoded(lane,rootEncoded);
}
fn pathSignature(lane:u32)->u32{
  var hash=2166136261u; var word=0u;
  loop{
    if(word>=params.stateWords){break;}
    hash=(hash^bitcast<u32>(getState(lane,word)))*16777619u;
    word=word+1u;
  }
  return hash;
}

@compute @workgroup_size(${LANES_PER_LAYER})
fn forecast(@builtin(workgroup_id) groupId:vec3<u32>,@builtin(local_invocation_index) lane:u32){
  let layer=groupId.x;
  if(layer>=${FORECAST_LAYERS}u){return;}
  let pathIndex=layer*${LANES_PER_LAYER}u+lane;
  let moveIndex=pathIndex%params.moveCount;
  let rootEncoded=rootMoves[moveIndex];
  let rootSide=baseState[95u];
  resetPath(lane,rootEncoded);

  var evaluated=0u;
  var transitions=1u;
  var rolloutPly=0u;
  var rollout=0u;
  var stalls=0u;
  var phase=mix32(params.salt^pathIndex^rootEncoded);
  var accumulated=0;
  var checkpoints=0u;

  loop{
    if(evaluated>=params.iterations){break;}
    let side=getState(lane,95u);
    var bestMove=0xffffffffu;
    var bestScore=-20000000;
    var accepted=0u;
    var attempts=0u;
    loop{
      if(accepted>=4u||evaluated>=params.iterations||attempts>=96u){break;}
      phase=mix32(phase+attempts+rolloutPly*0x85ebca6bu+rollout*0xc2b2ae35u);
      let encoded=generatedCandidate(lane,side,phase);
      let candidate=evaluateCandidate(lane,encoded,side,phase);
      if(candidate.valid==1u){
        evaluated=evaluated+1u;
        accepted=accepted+1u;
        if(candidate.score>bestScore||(candidate.score==bestScore&&candidate.encoded<bestMove)){
          bestScore=candidate.score;
          bestMove=candidate.encoded;
        }
      }
      attempts=attempts+1u;
    }

    if(bestMove==0xffffffffu){
      stalls=stalls+1u;
      if(stalls>=32u){break;}
      rollout=rollout+1u;
      rolloutPly=0u;
      resetPath(lane,rootEncoded);
      transitions=transitions+1u;
      phase=mix32(phase^rollout^0x27d4eb2du);
      continue;
    }

    stalls=0u;
    let ignoredMoveUndo=applyEncoded(lane,bestMove);
    transitions=transitions+1u;
    rolloutPly=rolloutPly+1u;
    accumulated=accumulated+evaluateFor(lane,rootSide);
    checkpoints=checkpoints+1u;

    if(rolloutPly>=64u){
      rollout=rollout+1u;
      rolloutPly=0u;
      resetPath(lane,rootEncoded);
      transitions=transitions+1u;
      phase=mix32(phase^rollout^0x165667b1u);
    }
  }

  let average=select(evaluateFor(lane,rootSide),accumulated/i32(checkpoints),checkpoints>0u);
  let outputBase=pathIndex*${OUTPUT_WORDS_PER_PATH}u;
  output[outputBase]=bitcast<u32>(average);
  output[outputBase+1u]=pathSignature(lane)^0x5a170000u^(pathIndex+1u);
  output[outputBase+2u]=evaluated;
  output[outputBase+3u]=transitions;
  output[outputBase+4u]=moveIndex;
}
`;

async function createRuntime():Promise<GpuFabricRuntime|null>{
  const gpu=(navigator as unknown as {gpu?:any}).gpu;
  if(!gpu)return null;
  const adapter=await gpu.requestAdapter({powerPreference:'high-performance'});
  if(!adapter)return null;
  if(Number(adapter.limits?.maxComputeWorkgroupsPerDimension??0)<FORECAST_LAYERS)return null;
  if(Number(adapter.limits?.maxComputeInvocationsPerWorkgroup??0)<LANES_PER_LAYER)return null;
  if(Number(adapter.limits?.maxComputeWorkgroupSizeX??0)<LANES_PER_LAYER)return null;
  if(Number(adapter.limits?.maxComputeWorkgroupStorageSize??0)<POSITION_WORDS*LANES_PER_LAYER*Int32Array.BYTES_PER_ELEMENT)return null;
  const requiredStorage=POSITION_WORDS*LANES_PER_LAYER*Int32Array.BYTES_PER_ELEMENT;
  const device=await adapter.requestDevice({requiredLimits:{maxComputeWorkgroupStorageSize:requiredStorage}});
  const module=device.createShaderModule({label:'title-forecast-500-layer-state-shader',code:shader});
  const info=await module.getCompilationInfo?.();
  if(info?.messages?.some((message:any)=>message.type==='error')){
    throw new Error(`GPU_SHADER_COMPILE:${info.messages.filter((message:any)=>message.type==='error').map((message:any)=>message.message).join('|')}`);
  }
  const bindGroupLayout=device.createBindGroupLayout({entries:[
    {binding:0,visibility:4,buffer:{type:'read-only-storage'}},
    {binding:1,visibility:4,buffer:{type:'read-only-storage'}},
    {binding:2,visibility:4,buffer:{type:'storage'}},
    {binding:3,visibility:4,buffer:{type:'uniform'}},
  ]});
  const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[bindGroupLayout]});
  const pipeline=await device.createComputePipelineAsync({label:'title-forecast-500-layer-state-pipeline',layout:pipelineLayout,compute:{module,entryPoint:'forecast'}});
  return{device,pipeline,bindGroupLayout};
}

async function runtime():Promise<GpuFabricRuntime|null>{
  runtimePromise??=createRuntime().catch(()=>null);
  return runtimePromise;
}

export async function warmupTitleGpuForecastFabric():Promise<boolean>{return (await runtime())!==null;}

export async function runTitleGpuForecastFabric(position:Position,moves:Move[]):Promise<TitleGpuForecastFabricResult>{
  const active=await runtime();
  const plannedSamples=PATH_COUNT*SAMPLES_PER_LANE;
  const unavailable=(reason:string):TitleGpuForecastFabricResult=>({
    supported:false,complete:false,layers:FORECAST_LAYERS,lanesPerLayer:LANES_PER_LAYER,
    samplesPerLane:SAMPLES_PER_LANE,plannedSamples,totalSamples:0,elapsedMs:0,samplesPerSecond:0,
    signaturesChecked:0,stateTransitions:0,rootScores:[],bestMoveIndex:null,reason,
  });
  if(!active)return unavailable('WEBGPU_UNAVAILABLE');
  if(moves.length===0)return unavailable('NO_LEGAL_MOVES');
  const {device,pipeline,bindGroupLayout}=active;
  const usage=(globalThis as any).GPUBufferUsage;
  const mapMode=(globalThis as any).GPUMapMode;
  if(!usage||!mapMode)throw new Error('WEBGPU_CONSTANTS_MISSING');

  const state=encodePosition(position);
  const encodedMoves=new Uint32Array(moves.map(encodeMove));
  const outputWords=PATH_COUNT*OUTPUT_WORDS_PER_PATH;
  const outputBytes=outputWords*Uint32Array.BYTES_PER_ELEMENT;
  const params=new Uint32Array([SAMPLES_PER_LANE,encodedMoves.length,POSITION_WORDS,0x5a17c3e1]);
  const stateBuffer=device.createBuffer({size:state.byteLength,usage:usage.STORAGE|usage.COPY_DST});
  const moveBuffer=device.createBuffer({size:encodedMoves.byteLength,usage:usage.STORAGE|usage.COPY_DST});
  const outputBuffer=device.createBuffer({size:outputBytes,usage:usage.STORAGE|usage.COPY_SRC});
  const paramsBuffer=device.createBuffer({size:params.byteLength,usage:usage.UNIFORM|usage.COPY_DST});
  const readback=device.createBuffer({size:outputBytes,usage:usage.COPY_DST|usage.MAP_READ});
  try{
    device.queue.writeBuffer(stateBuffer,0,state);
    device.queue.writeBuffer(moveBuffer,0,encodedMoves);
    device.queue.writeBuffer(paramsBuffer,0,params);
    const bindGroup=device.createBindGroup({layout:bindGroupLayout,entries:[
      {binding:0,resource:{buffer:stateBuffer}},{binding:1,resource:{buffer:moveBuffer}},
      {binding:2,resource:{buffer:outputBuffer}},{binding:3,resource:{buffer:paramsBuffer}},
    ]});
    const start=performance.now();
    const encoder=device.createCommandEncoder({label:'title-forecast-500-layer-state-encoder'});
    const pass=encoder.beginComputePass({label:'title-forecast-500-layer-state-pass'});
    pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);pass.dispatchWorkgroups(FORECAST_LAYERS,1,1);pass.end();
    encoder.copyBufferToBuffer(outputBuffer,0,readback,0,outputBytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(mapMode.READ);
    const elapsedMs=performance.now()-start;
    const raw=new Uint32Array(readback.getMappedRange().slice(0));
    let signaturesChecked=0;
    let totalSamples=0;
    let stateTransitions=0;
    const worstScores=new Array<number>(moves.length).fill(Infinity);
    const counts=new Array<number>(moves.length).fill(0);
    for(let pathIndex=0;pathIndex<PATH_COUNT;pathIndex++){
      const base=pathIndex*OUTPUT_WORDS_PER_PATH;
      const score=new Int32Array(new Uint32Array([raw[base]??0]).buffer)[0]??0;
      const signature=raw[base+1]??0;
      const samples=raw[base+2]??0;
      const transitions=raw[base+3]??0;
      const moveIndex=raw[base+4]??0;
      if(signature!==0)signaturesChecked++;
      totalSamples+=samples;
      stateTransitions+=transitions;
      if(moveIndex<moves.length&&Number.isFinite(score)){
        worstScores[moveIndex]=Math.min(worstScores[moveIndex]!,score);
        counts[moveIndex]=(counts[moveIndex]??0)+1;
      }
    }
    readback.unmap();
    const rootScores=worstScores.map((score,index)=>counts[index]!>0&&Number.isFinite(score)?score:-20_000_000);
    let bestMoveIndex:number|null=null;
    for(let index=0;index<rootScores.length;index++){
      if(bestMoveIndex===null||rootScores[index]!>rootScores[bestMoveIndex]!)bestMoveIndex=index;
    }
    const complete=totalSamples>=plannedSamples&&signaturesChecked===PATH_COUNT;
    return{
      supported:true,complete,layers:FORECAST_LAYERS,lanesPerLayer:LANES_PER_LAYER,
      samplesPerLane:SAMPLES_PER_LANE,plannedSamples,totalSamples,elapsedMs,
      samplesPerSecond:elapsedMs>0?totalSamples/(elapsedMs/1000):0,
      signaturesChecked,stateTransitions,rootScores,bestMoveIndex,
      reason:complete?undefined:'GPU_FUTURE_STATE_INCOMPLETE',
    };
  }finally{
    for(const buffer of [stateBuffer,moveBuffer,outputBuffer,paramsBuffer,readback])buffer.destroy();
  }
}
