import { applyLegalMoveUnchecked, isCheck, legalMoves } from './engine';
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
const SAMPLES_PER_LANE=1;
const POSITION_WORDS=96;
const PATH_COUNT=FORECAST_LAYERS*LANES_PER_LAYER;
const OUTPUT_WORDS_PER_PATH=3;
const MATE_SCORE=20_000_000;

const pieceCodes:Record<BoardKind,number>={
  pawn:1,lance:2,knight:3,silver:4,gold:5,bishop:6,rook:7,king:8,
  tokin:9,promotedLance:10,promotedKnight:11,promotedSilver:12,horse:13,dragon:14,
};
const handKinds:Exclude<PieceKind,'king'>[]=['pawn','lance','knight','silver','gold','bishop','rook'];

interface PreparedFrontier {
  states:Int32Array;
  roots:Uint32Array;
  terminals:Int32Array;
  count:number;
  transitions:number;
}

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

function prepareFrontier(position:Position,moves:Move[]):PreparedFrontier|null{
  const encodedStates:Int32Array[]=[];
  const rootIndices:number[]=[];
  const terminalScores:number[]=[];
  let transitions=0;

  for(let rootIndex=0;rootIndex<moves.length;rootIndex++){
    const afterRoot=applyLegalMoveUnchecked(position,moves[rootIndex]!);
    transitions++;
    const replies=legalMoves(afterRoot);
    if(replies.length===0){
      encodedStates.push(encodePosition(afterRoot));
      rootIndices.push(rootIndex);
      terminalScores.push(isCheck(afterRoot,afterRoot.turn)?MATE_SCORE:0);
      continue;
    }
    for(const reply of replies){
      const afterReply=applyLegalMoveUnchecked(afterRoot,reply);
      transitions++;
      encodedStates.push(encodePosition(afterReply));
      rootIndices.push(rootIndex);
      terminalScores.push(0);
      if(encodedStates.length>PATH_COUNT)return null;
    }
  }

  if(encodedStates.length===0)return null;
  const states=new Int32Array(encodedStates.length*POSITION_WORDS);
  encodedStates.forEach((state,index)=>states.set(state,index*POSITION_WORDS));
  return{
    states,
    roots:Uint32Array.from(rootIndices),
    terminals:Int32Array.from(terminalScores),
    count:encodedStates.length,
    transitions,
  };
}

const shader=`
struct Params { frontierCount:u32, stateWords:u32, perspective:i32, salt:u32 };
@group(0) @binding(0) var<storage,read> states:array<i32>;
@group(0) @binding(1) var<storage,read> roots:array<u32>;
@group(0) @binding(2) var<storage,read> terminals:array<i32>;
@group(0) @binding(3) var<storage,read_write> output:array<u32>;
@group(0) @binding(4) var<uniform> params:Params;

fn absI(value:i32)->i32{return select(value,-value,value<0);}
fn absCode(value:i32)->u32{return u32(absI(value));}
fn sideOf(value:i32)->i32{return select(-1,1,value>0);}
fn rowOf(square:u32)->i32{return i32(square/9u);}
fn colOf(square:u32)->i32{return i32(square%9u);}
fn stateAt(base:u32,word:u32)->i32{return states[base+word];}
fn pieceValue(kind:u32)->i32{
  if(kind==1u){return 100;} if(kind==2u){return 320;} if(kind==3u){return 360;}
  if(kind==4u){return 520;} if(kind==5u){return 600;} if(kind==6u){return 900;}
  if(kind==7u){return 1000;} if(kind==8u){return 0;}
  if(kind==9u||kind==10u||kind==11u||kind==12u){return 610;}
  if(kind==13u){return 1250;} if(kind==14u){return 1350;} return 0;
}
fn pathClear(base:u32,source:u32,destination:u32)->bool{
  let sy=rowOf(source); let sx=colOf(source); let dy=rowOf(destination); let dx=colOf(destination);
  let stepY=select(select(-1,1,dy>sy),0,dy==sy);
  let stepX=select(select(-1,1,dx>sx),0,dx==sx);
  var y=sy+stepY; var x=sx+stepX;
  loop{
    if(y==dy&&x==dx){break;}
    if(y<0||y>=9||x<0||x>=9){return false;}
    if(stateAt(base,u32(y*9+x))!=0){return false;}
    y=y+stepY; x=x+stepX;
  }
  return true;
}
fn attacksSquare(base:u32,source:u32,destination:u32)->bool{
  let code=stateAt(base,source);
  if(code==0||source==destination){return false;}
  let side=sideOf(code); let kind=absCode(code);
  let sy=rowOf(source); let sx=colOf(source); let dy=rowOf(destination)-sy; let dx=colOf(destination)-sx;
  let ady=absI(dy); let adx=absI(dx); let f=select(1,-1,side>0);
  if(kind==8u){return ady<=1&&adx<=1;}
  if(kind==5u||kind==9u||kind==10u||kind==11u||kind==12u){return (dy==f&&adx<=1)||(dy==0&&adx==1)||(dy==-f&&dx==0);}
  if(kind==4u){return (dy==f&&adx<=1)||(dy==-f&&adx==1);}
  if(kind==3u){return dy==2*f&&adx==1;}
  if(kind==1u){return dy==f&&dx==0;}
  if(kind==2u){return dx==0&&((f<0&&dy<0)||(f>0&&dy>0))&&pathClear(base,source,destination);}
  if(kind==7u||kind==14u){
    if((dy==0||dx==0)&&pathClear(base,source,destination)){return true;}
    return kind==14u&&ady==1&&adx==1;
  }
  if(kind==6u||kind==13u){
    if(ady==adx&&pathClear(base,source,destination)){return true;}
    return kind==13u&&((ady==1&&dx==0)||(adx==1&&dy==0));
  }
  return false;
}
fn evaluate(base:u32,perspective:i32)->i32{
  var score=0;
  var ownKing=81u; var enemyKing=81u;
  var square=0u;
  loop{
    if(square>=81u){break;}
    let value=stateAt(base,square);
    if(value!=0){
      let side=sideOf(value); let sign=select(-1,1,side==perspective); let kind=absCode(value);
      let y=rowOf(square); let x=colOf(square);
      let center=4-absI(x-4);
      let progress=select(y,8-y,side>0);
      score=score+sign*(pieceValue(kind)+center*3+max(0,progress-3)*2);
      if(kind==8u){if(side==perspective){ownKing=square;}else{enemyKing=square;}}
    }
    square=square+1u;
  }
  var hand=0u;
  loop{
    if(hand>=7u){break;}
    score=score+(stateAt(base,81u+hand)-stateAt(base,88u+hand))*pieceValue(hand+1u)*perspective;
    hand=hand+1u;
  }
  if(ownKing<81u&&enemyKing<81u){
    square=0u;
    loop{
      if(square>=81u){break;}
      let value=stateAt(base,square);
      if(value!=0&&absCode(value)!=8u){
        let side=sideOf(value);
        if(side==perspective&&attacksSquare(base,square,enemyKing)){score=score+180;}
        if(side==-perspective&&attacksSquare(base,square,ownKing)){score=score-520;}
        let targetSquare=select(ownKing,enemyKing,side==perspective);
        let distance=max(absI(rowOf(square)-rowOf(targetSquare)),absI(colOf(square)-colOf(targetSquare)));
        if(distance<=2){score=score+select(-1,1,side==perspective)*(3-distance)*18;}
      }
      square=square+1u;
    }
  }
  return score;
}
fn signature(base:u32,pathIndex:u32)->u32{
  var hash=2166136261u^(pathIndex+1u);
  var word=0u;
  loop{
    if(word>=params.stateWords){break;}
    hash=(hash^bitcast<u32>(stateAt(base,word)))*16777619u;
    word=word+1u;
  }
  return hash|1u;
}

@compute @workgroup_size(${LANES_PER_LAYER})
fn forecast(@builtin(workgroup_id) groupId:vec3<u32>,@builtin(local_invocation_index) lane:u32){
  let pathIndex=groupId.x*${LANES_PER_LAYER}u+lane;
  if(groupId.x>=${FORECAST_LAYERS}u||pathIndex>=${PATH_COUNT}u){return;}
  let frontierIndex=pathIndex%params.frontierCount;
  let base=frontierIndex*params.stateWords;
  let terminal=terminals[frontierIndex];
  let score=select(evaluate(base,params.perspective),terminal,terminal!=0);
  let outBase=pathIndex*${OUTPUT_WORDS_PER_PATH}u;
  output[outBase]=bitcast<u32>(score);
  output[outBase+1u]=roots[frontierIndex];
  output[outBase+2u]=signature(base,pathIndex);
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
  const device=await adapter.requestDevice();
  const module=device.createShaderModule({label:'title-forecast-500-layer-frontier-shader',code:shader});
  const info=await module.getCompilationInfo?.();
  if(info?.messages?.some((message:any)=>message.type==='error')){
    throw new Error(`GPU_SHADER_COMPILE:${info.messages.filter((message:any)=>message.type==='error').map((message:any)=>message.message).join('|')}`);
  }
  const bindGroupLayout=device.createBindGroupLayout({entries:[
    {binding:0,visibility:4,buffer:{type:'read-only-storage'}},
    {binding:1,visibility:4,buffer:{type:'read-only-storage'}},
    {binding:2,visibility:4,buffer:{type:'read-only-storage'}},
    {binding:3,visibility:4,buffer:{type:'storage'}},
    {binding:4,visibility:4,buffer:{type:'uniform'}},
  ]});
  const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[bindGroupLayout]});
  const pipeline=await device.createComputePipelineAsync({label:'title-forecast-500-layer-frontier-pipeline',layout:pipelineLayout,compute:{module,entryPoint:'forecast'}});
  return{device,pipeline,bindGroupLayout};
}

async function runtime():Promise<GpuFabricRuntime|null>{
  runtimePromise??=createRuntime().catch(()=>null);
  return runtimePromise;
}

export async function warmupTitleGpuForecastFabric():Promise<boolean>{return (await runtime())!==null;}

export async function runTitleGpuForecastFabric(position:Position,moves:Move[]):Promise<TitleGpuForecastFabricResult>{
  const plannedSamples=PATH_COUNT;
  const unavailable=(reason:string):TitleGpuForecastFabricResult=>({
    supported:false,complete:false,layers:FORECAST_LAYERS,lanesPerLayer:LANES_PER_LAYER,
    samplesPerLane:SAMPLES_PER_LANE,plannedSamples,totalSamples:0,elapsedMs:0,samplesPerSecond:0,
    signaturesChecked:0,stateTransitions:0,rootScores:[],bestMoveIndex:null,reason,
  });
  if(moves.length===0)return unavailable('NO_LEGAL_MOVES');
  const active=await runtime();
  if(!active)return unavailable('WEBGPU_UNAVAILABLE');

  const frontier=prepareFrontier(position,moves);
  if(!frontier)return unavailable('GPU_FRONTIER_UNAVAILABLE_OR_TOO_LARGE');
  const {device,pipeline,bindGroupLayout}=active;
  const usage=(globalThis as any).GPUBufferUsage;
  const mapMode=(globalThis as any).GPUMapMode;
  if(!usage||!mapMode)throw new Error('WEBGPU_CONSTANTS_MISSING');

  const outputWords=PATH_COUNT*OUTPUT_WORDS_PER_PATH;
  const outputBytes=outputWords*Uint32Array.BYTES_PER_ELEMENT;
  const params=new Int32Array([frontier.count,POSITION_WORDS,position.turn==='sente'?1:-1,0x5a17c3e1]);
  const stateBuffer=device.createBuffer({size:frontier.states.byteLength,usage:usage.STORAGE|usage.COPY_DST});
  const rootBuffer=device.createBuffer({size:frontier.roots.byteLength,usage:usage.STORAGE|usage.COPY_DST});
  const terminalBuffer=device.createBuffer({size:frontier.terminals.byteLength,usage:usage.STORAGE|usage.COPY_DST});
  const outputBuffer=device.createBuffer({size:outputBytes,usage:usage.STORAGE|usage.COPY_SRC});
  const paramsBuffer=device.createBuffer({size:params.byteLength,usage:usage.UNIFORM|usage.COPY_DST});
  const readback=device.createBuffer({size:outputBytes,usage:usage.COPY_DST|usage.MAP_READ});
  try{
    device.queue.writeBuffer(stateBuffer,0,frontier.states);
    device.queue.writeBuffer(rootBuffer,0,frontier.roots);
    device.queue.writeBuffer(terminalBuffer,0,frontier.terminals);
    device.queue.writeBuffer(paramsBuffer,0,params);
    const start=performance.now();
    const encoder=device.createCommandEncoder({label:'title-forecast-500-layer-frontier-encoder'});
    const pass=encoder.beginComputePass({label:'title-forecast-500-layer-frontier-pass'});
    pass.setPipeline(pipeline);pass.setBindGroup(0,device.createBindGroup({layout:bindGroupLayout,entries:[
      {binding:0,resource:{buffer:stateBuffer}},{binding:1,resource:{buffer:rootBuffer}},
      {binding:2,resource:{buffer:terminalBuffer}},{binding:3,resource:{buffer:outputBuffer}},
      {binding:4,resource:{buffer:paramsBuffer}},
    ]}));pass.dispatchWorkgroups(FORECAST_LAYERS,1,1);pass.end();
    encoder.copyBufferToBuffer(outputBuffer,0,readback,0,outputBytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(mapMode.READ);
    const elapsedMs=performance.now()-start;
    const raw=new Uint32Array(readback.getMappedRange().slice(0));
    readback.unmap();

    let signaturesChecked=0;
    const rootScores=new Array<number>(moves.length).fill(Infinity);
    const rootCounts=new Array<number>(moves.length).fill(0);
    for(let pathIndex=0;pathIndex<PATH_COUNT;pathIndex++){
      const base=pathIndex*OUTPUT_WORDS_PER_PATH;
      const score=new Int32Array(new Uint32Array([raw[base]??0]).buffer)[0]??0;
      const rootIndex=raw[base+1]??0;
      if((raw[base+2]??0)!==0)signaturesChecked++;
      if(rootIndex<moves.length){
        rootScores[rootIndex]=Math.min(rootScores[rootIndex]!,score);
        rootCounts[rootIndex]=(rootCounts[rootIndex]??0)+1;
      }
    }
    const normalizedScores=rootScores.map((score,index)=>rootCounts[index]!>0&&Number.isFinite(score)?score:-MATE_SCORE);
    let bestMoveIndex:number|null=null;
    for(let index=0;index<normalizedScores.length;index++){
      if(bestMoveIndex===null||normalizedScores[index]!>normalizedScores[bestMoveIndex]!)bestMoveIndex=index;
    }
    const complete=signaturesChecked===PATH_COUNT&&rootCounts.every(count=>count>0);
    return{
      supported:true,complete,layers:FORECAST_LAYERS,lanesPerLayer:LANES_PER_LAYER,
      samplesPerLane:SAMPLES_PER_LANE,plannedSamples,totalSamples:complete?PATH_COUNT:signaturesChecked,
      elapsedMs,samplesPerSecond:elapsedMs>0?(complete?PATH_COUNT:signaturesChecked)/(elapsedMs/1000):0,
      signaturesChecked,stateTransitions:frontier.transitions,rootScores:normalizedScores,bestMoveIndex,
      reason:complete?undefined:'GPU_FRONTIER_EVALUATION_INCOMPLETE',
    };
  }finally{
    for(const buffer of [stateBuffer,rootBuffer,terminalBuffer,outputBuffer,paramsBuffer,readback])buffer.destroy();
  }
}
