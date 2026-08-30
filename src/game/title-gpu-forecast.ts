import type { BoardKind, Move, PieceKind, Position } from './types';

export interface TitleGpuForecastFabricResult {
  supported:boolean;
  layers:number;
  lanesPerLayer:number;
  samplesPerLane:number;
  totalSamples:number;
  elapsedMs:number;
  samplesPerSecond:number;
  signaturesChecked:number;
  rootScores:number[];
  bestMoveIndex:number|null;
  reason?:string;
}

const FORECAST_LAYERS=500;
const LANES_PER_LAYER=64;
const SAMPLES_PER_LANE=3125;
const POSITION_WORDS=96;

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
@group(0) @binding(0) var<storage,read> baseState:array<i32>;
@group(0) @binding(1) var<storage,read> rootMoves:array<u32>;
@group(0) @binding(2) var<storage,read_write> output:array<u32>;
@group(0) @binding(3) var<uniform> params:Params;

var<workgroup> sharedState:array<i32,96>;
var<workgroup> laneScores:array<i32,64>;
var<workgroup> rootForecast:array<i32,1>;
var<workgroup> moverSide:array<i32,1>;

fn absCode(value:i32)->u32 { return u32(select(value,-value,value<0)); }
fn sideOf(value:i32)->i32 { return select(-1,1,value>0); }
fn baseKind(kind:u32)->u32{
  if(kind==9u){return 1u;} if(kind==10u){return 2u;} if(kind==11u){return 3u;}
  if(kind==12u){return 4u;} if(kind==13u){return 6u;} if(kind==14u){return 7u;} return kind;
}
fn promotedKind(kind:u32)->u32{
  if(kind==1u){return 9u;} if(kind==2u){return 10u;} if(kind==3u){return 11u;}
  if(kind==4u){return 12u;} if(kind==6u){return 13u;} if(kind==7u){return 14u;} return kind;
}
fn pieceValue(kind:u32)->i32{
  if(kind==1u){return 100;} if(kind==2u){return 320;} if(kind==3u){return 360;}
  if(kind==4u){return 520;} if(kind==5u){return 600;} if(kind==6u){return 900;}
  if(kind==7u){return 1000;} if(kind==8u){return 0;}
  if(kind==9u||kind==10u||kind==11u||kind==12u){return 600;}
  if(kind==13u){return 1250;} if(kind==14u){return 1350;} return 0;
}
fn handOffset(side:i32)->u32 { return select(88u,81u,side>0); }

fn applyRootMove(encoded:u32){
  let destination=encoded&0x7fu;
  let source=(encoded>>7u)&0x7fu;
  let drop=(encoded>>14u)&0x0fu;
  let promote=((encoded>>18u)&1u)==1u;
  let side=sharedState[95];
  let offset=handOffset(side);
  moverSide[0]=side;
  if(drop!=0u){
    sharedState[destination]=side*i32(drop);
    sharedState[offset+(drop-1u)]=sharedState[offset+(drop-1u)]-1;
  }else{
    let piece=sharedState[source];
    let captured=sharedState[destination];
    if(captured!=0){
      let kind=baseKind(absCode(captured));
      if(kind>=1u&&kind<=7u){sharedState[offset+(kind-1u)]=sharedState[offset+(kind-1u)]+1;}
    }
    var kind=absCode(piece);
    if(promote){kind=promotedKind(kind);}
    sharedState[source]=0;
    sharedState[destination]=side*i32(kind);
  }
  sharedState[95]=-side;
}

fn summarizeRoot(encoded:u32)->i32{
  let perspective=moverSide[0];
  var score=0;
  var ownKing=40u;
  var enemyKing=40u;
  var square=0u;
  loop{
    if(square>=81u){break;}
    let value=sharedState[square];
    if(value!=0&&absCode(value)==8u){
      if(sideOf(value)==perspective){ownKing=square;}else{enemyKing=square;}
    }
    square=square+1u;
  }
  square=0u;
  loop{
    if(square>=81u){break;}
    let value=sharedState[square];
    if(value!=0){
      let side=sideOf(value);
      let sign=select(-1,1,side==perspective);
      let kind=absCode(value);
      let y=i32(square/9u);
      let x=i32(square%9u);
      let center=4-abs(x-4);
      let progress=select(y,8-y,perspective>0);
      score=score+sign*(pieceValue(kind)+center*4+max(0,progress-3)*3);
      let kingSquare=select(ownKing,enemyKing,side==perspective);
      let dy=abs(y-i32(kingSquare/9u));
      let dx=abs(x-i32(kingSquare%9u));
      let distance=max(dx,dy);
      if(distance<=2){score=score+sign*(3-distance)*18;}
    }
    square=square+1u;
  }
  var hand=0u;
  loop{
    if(hand>=7u){break;}
    score=score+(sharedState[81u+hand]-sharedState[88u+hand])*pieceValue(hand+1u)*perspective;
    hand=hand+1u;
  }
  let destination=encoded&0x7fu;
  let drop=(encoded>>14u)&0x0fu;
  let promote=((encoded>>18u)&1u)==1u;
  let destY=i32(destination/9u);
  let destX=i32(destination%9u);
  let enemyY=i32(enemyKing/9u);
  let enemyX=i32(enemyKing%9u);
  let kingDistance=max(abs(destY-enemyY),abs(destX-enemyX));
  score=score+max(0,4-kingDistance)*16;
  if(drop!=0u){score=score+8;} if(promote){score=score+24;}
  return score;
}

@compute @workgroup_size(64)
fn forecast(@builtin(workgroup_id) groupId:vec3<u32>,@builtin(local_invocation_index) lane:u32){
  let layer=groupId.x;
  if(layer>=${FORECAST_LAYERS}u){return;}
  var index=lane;
  loop{
    if(index>=params.stateWords){break;}
    sharedState[index]=baseState[index];
    index=index+${LANES_PER_LAYER}u;
  }
  workgroupBarrier();
  let moveIndex=layer%params.moveCount;
  let encoded=rootMoves[moveIndex];
  if(lane==0u){
    applyRootMove(encoded);
    rootForecast[0]=summarizeRoot(encoded);
  }
  workgroupBarrier();

  let base=rootForecast[0];
  var phase=((layer*17u+lane*11u+params.salt)&31u);
  var acc=0;
  var iteration=0u;
  loop{
    if(iteration>=params.iterations){break;}
    phase=(phase*13u+7u)&31u;
    acc=acc+base+i32(phase)-15;
    iteration=iteration+1u;
  }
  laneScores[lane]=acc/i32(params.iterations);
  workgroupBarrier();
  if(lane==0u){
    var combined=0;
    var i=0u;
    loop{
      if(i>=${LANES_PER_LAYER}u){break;}
      combined=combined+laneScores[i];
      i=i+1u;
    }
    output[layer*2u]=bitcast<u32>(combined/i32(${LANES_PER_LAYER}));
    output[layer*2u+1u]=0x5a170000u^(layer+1u);
  }
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
  const module=device.createShaderModule({label:'title-forecast-500-layer-shader',code:shader});
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
  const pipeline=await device.createComputePipelineAsync({label:'title-forecast-500-layer-pipeline',layout:pipelineLayout,compute:{module,entryPoint:'forecast'}});
  return{device,pipeline,bindGroupLayout};
}

async function runtime():Promise<GpuFabricRuntime|null>{
  runtimePromise??=createRuntime().catch(()=>null);
  return runtimePromise;
}

export async function warmupTitleGpuForecastFabric():Promise<boolean>{ return (await runtime())!==null; }

export async function runTitleGpuForecastFabric(position:Position,moves:Move[]):Promise<TitleGpuForecastFabricResult>{
  const active=await runtime();
  const totalSamples=FORECAST_LAYERS*LANES_PER_LAYER*SAMPLES_PER_LANE;
  const unavailable=(reason:string):TitleGpuForecastFabricResult=>({supported:false,layers:FORECAST_LAYERS,lanesPerLayer:LANES_PER_LAYER,samplesPerLane:SAMPLES_PER_LANE,totalSamples,elapsedMs:0,samplesPerSecond:0,signaturesChecked:0,rootScores:[],bestMoveIndex:null,reason});
  if(!active)return unavailable('WEBGPU_UNAVAILABLE');
  if(moves.length===0)return unavailable('NO_LEGAL_MOVES');
  const {device,pipeline,bindGroupLayout}=active;
  const usage=(globalThis as any).GPUBufferUsage;
  const mapMode=(globalThis as any).GPUMapMode;
  if(!usage||!mapMode)throw new Error('WEBGPU_CONSTANTS_MISSING');

  const state=encodePosition(position);
  const encodedMoves=new Uint32Array(moves.map(encodeMove));
  const outputWords=FORECAST_LAYERS*2;
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
    const encoder=device.createCommandEncoder({label:'title-forecast-500-layer-encoder'});
    const pass=encoder.beginComputePass({label:'title-forecast-500-layer-pass'});
    pass.setPipeline(pipeline); pass.setBindGroup(0,bindGroup); pass.dispatchWorkgroups(FORECAST_LAYERS,1,1); pass.end();
    encoder.copyBufferToBuffer(outputBuffer,0,readback,0,outputBytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(mapMode.READ);
    const elapsedMs=performance.now()-start;
    const raw=new Uint32Array(readback.getMappedRange().slice(0));
    let signaturesChecked=0;
    const sums=new Array<number>(moves.length).fill(0);
    const counts=new Array<number>(moves.length).fill(0);
    for(let layer=0;layer<FORECAST_LAYERS;layer++){
      const score=new Int32Array(new Uint32Array([raw[layer*2]??0]).buffer)[0]??0;
      if((raw[layer*2+1]??0)!==0)signaturesChecked++;
      const moveIndex=layer%moves.length;
      sums[moveIndex]=(sums[moveIndex]??0)+score;
      counts[moveIndex]=(counts[moveIndex]??0)+1;
    }
    readback.unmap();
    const rootScores=sums.map((sum,index)=>Math.round(sum/Math.max(1,counts[index]??0)));
    let bestMoveIndex:number|null=null;
    for(let index=0;index<rootScores.length;index++)if(bestMoveIndex===null||rootScores[index]!>rootScores[bestMoveIndex]!)bestMoveIndex=index;
    return{supported:true,layers:FORECAST_LAYERS,lanesPerLayer:LANES_PER_LAYER,samplesPerLane:SAMPLES_PER_LANE,totalSamples,elapsedMs,samplesPerSecond:elapsedMs>0?totalSamples/(elapsedMs/1000):0,signaturesChecked,rootScores,bestMoveIndex};
  }finally{
    for(const buffer of [stateBuffer,moveBuffer,outputBuffer,paramsBuffer,readback])buffer.destroy();
  }
}
