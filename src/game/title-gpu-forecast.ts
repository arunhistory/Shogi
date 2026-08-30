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
  reason?:string;
}

const FORECAST_LAYERS=500;
const LANES_PER_LAYER=64;
const SAMPLES_PER_LANE=3125;
const POSITION_WORDS=96;

const pieceCodes:Record<BoardKind,number>={
  pawn:1,
  lance:2,
  knight:3,
  silver:4,
  gold:5,
  bishop:6,
  rook:7,
  king:8,
  tokin:9,
  promotedLance:10,
  promotedKnight:11,
  promotedSilver:12,
  horse:13,
  dragon:14,
};

const handKinds:Exclude<PieceKind,'king'>[]=['pawn','lance','knight','silver','gold','bishop','rook'];
const dropCodes:Record<Exclude<PieceKind,'king'>,number>={
  pawn:1,lance:2,knight:3,silver:4,gold:5,bishop:6,rook:7,
};

interface GpuFabricRuntime {
  device:any;
  pipeline:any;
  bindGroupLayout:any;
}

let runtimePromise:Promise<GpuFabricRuntime|null>|null=null;

function encodePosition(position:Position):Int32Array{
  const words=new Int32Array(POSITION_WORDS);
  let index=0;
  for(const row of position.board){
    for(const piece of row){
      words[index++]=piece?(piece.side==='sente'?1:-1)*pieceCodes[piece.kind]:0;
    }
  }
  for(const side of ['sente','gote'] as const){
    for(const kind of handKinds)words[index++]=position.hands[side][kind];
  }
  words[index]=position.turn==='sente'?1:-1;
  return words;
}

function encodeMove(move:Move):number{
  const to=move.to[0]*9+move.to[1];
  if(move.drop){
    if(move.drop==='king')throw new Error('GPU_KING_DROP_INVALID');
    return (to|(127<<7)|(dropCodes[move.drop]<<14))>>>0;
  }
  if(!move.from)throw new Error('GPU_MOVE_SOURCE_MISSING');
  const from=move.from[0]*9+move.from[1];
  return (to|(from<<7)|(move.promote?1<<18:0))>>>0;
}

const shader=`
struct Params {
  iterations:u32,
  moveCount:u32,
  stateWords:u32,
  salt:u32,
};

@group(0) @binding(0) var<storage,read> baseState:array<i32>;
@group(0) @binding(1) var<storage,read> rootMoves:array<u32>;
@group(0) @binding(2) var<storage,read_write> output:array<u32>;
@group(0) @binding(3) var<uniform> params:Params;

var<workgroup> sharedState:array<i32,96>;
var<workgroup> laneSums:array<u32,64>;

fn baseKind(kind:u32)->u32{
  if(kind==9u){return 1u;}
  if(kind==10u){return 2u;}
  if(kind==11u){return 3u;}
  if(kind==12u){return 4u;}
  if(kind==13u){return 6u;}
  if(kind==14u){return 7u;}
  return kind;
}

fn promotedKind(kind:u32)->u32{
  if(kind==1u){return 9u;}
  if(kind==2u){return 10u;}
  if(kind==3u){return 11u;}
  if(kind==4u){return 12u;}
  if(kind==6u){return 13u;}
  if(kind==7u){return 14u;}
  return kind;
}

fn absCode(value:i32)->u32{
  return u32(select(value,-value,value<0));
}

fn handOffset(side:i32)->u32{
  return select(88u,81u,side>0);
}

fn mix32(value:u32)->u32{
  var x=value;
  x=x^(x>>16u);
  x=x*0x7feb352du;
  x=x^(x>>15u);
  x=x*0x846ca68bu;
  x=x^(x>>16u);
  return x;
}

fn applyRootMove(encoded:u32){
  let to=encoded&0x7fu;
  let source=(encoded>>7u)&0x7fu;
  let drop=(encoded>>14u)&0x0fu;
  let promote=((encoded>>18u)&1u)==1u;
  let side=sharedState[95];
  let offset=handOffset(side);

  if(drop!=0u){
    sharedState[to]=side*i32(drop);
    let handIndex=offset+(drop-1u);
    sharedState[handIndex]=sharedState[handIndex]-1;
  }else{
    let piece=sharedState[source];
    let captured=sharedState[to];
    if(captured!=0){
      let kind=baseKind(absCode(captured));
      if(kind>=1u&&kind<=7u){
        let handIndex=offset+(kind-1u);
        sharedState[handIndex]=sharedState[handIndex]+1;
      }
    }
    var kind=absCode(piece);
    if(promote){kind=promotedKind(kind);}
    sharedState[source]=0;
    sharedState[to]=side*i32(kind);
  }
  sharedState[95]=-side;
}

@compute @workgroup_size(64)
fn forecast(
  @builtin(workgroup_id) groupId:vec3<u32>,
  @builtin(local_invocation_index) lane:u32,
){
  let layer=groupId.x;
  if(layer>=${FORECAST_LAYERS}u){return;}

  var index=lane;
  loop{
    if(index>=params.stateWords){break;}
    sharedState[index]=baseState[index];
    index=index+${LANES_PER_LAYER}u;
  }
  workgroupBarrier();

  if(lane==0u){
    let moveIndex=layer%params.moveCount;
    applyRootMove(rootMoves[moveIndex]);
  }
  workgroupBarrier();

  var x=mix32(params.salt^((layer+1u)*0x9e3779b9u)^((lane+1u)*0x85ebca6bu));
  var acc=x^(layer<<16u)^lane;
  var iteration=0u;
  loop{
    if(iteration>=params.iterations){break;}
    let square=x%81u;
    let handIndex=81u+((x>>8u)%14u);
    let boardValue=bitcast<u32>(sharedState[square]);
    let handValue=bitcast<u32>(sharedState[handIndex]);
    let turnValue=bitcast<u32>(sharedState[95]);
    let feature=boardValue^(handValue<<7u)^(turnValue<<19u)^(iteration*0x27d4eb2du);
    acc=mix32(acc^feature^(square*0x165667b1u));
    x=mix32(x+acc+0x9e3779b9u);
    iteration=iteration+1u;
  }
  laneSums[lane]=acc;
  workgroupBarrier();

  if(lane==0u){
    var combined=0x811c9dc5u^layer;
    var i=0u;
    loop{
      if(i>=${LANES_PER_LAYER}u){break;}
      combined=mix32(combined^laneSums[i]^(i*0x01000193u));
      i=i+1u;
    }
    output[layer]=combined;
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
  const bindGroupLayout=device.createBindGroupLayout({
    entries:[
      {binding:0,visibility:4,buffer:{type:'read-only-storage'}},
      {binding:1,visibility:4,buffer:{type:'read-only-storage'}},
      {binding:2,visibility:4,buffer:{type:'storage'}},
      {binding:3,visibility:4,buffer:{type:'uniform'}},
    ],
  });
  const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[bindGroupLayout]});
  const pipeline=await device.createComputePipelineAsync({
    label:'title-forecast-500-layer-pipeline',
    layout:pipelineLayout,
    compute:{module,entryPoint:'forecast'},
  });
  return{device,pipeline,bindGroupLayout};
}

async function runtime():Promise<GpuFabricRuntime|null>{
  runtimePromise??=createRuntime().catch(()=>null);
  return runtimePromise;
}

export async function warmupTitleGpuForecastFabric():Promise<boolean>{
  return (await runtime())!==null;
}

export async function runTitleGpuForecastFabric(position:Position,moves:Move[]):Promise<TitleGpuForecastFabricResult>{
  const active=await runtime();
  const totalSamples=FORECAST_LAYERS*LANES_PER_LAYER*SAMPLES_PER_LANE;
  if(!active)return{
    supported:false,layers:FORECAST_LAYERS,lanesPerLayer:LANES_PER_LAYER,
    samplesPerLane:SAMPLES_PER_LANE,totalSamples,elapsedMs:0,samplesPerSecond:0,
    signaturesChecked:0,reason:'WEBGPU_UNAVAILABLE',
  };
  if(moves.length===0)return{
    supported:false,layers:FORECAST_LAYERS,lanesPerLayer:LANES_PER_LAYER,
    samplesPerLane:SAMPLES_PER_LANE,totalSamples,elapsedMs:0,samplesPerSecond:0,
    signaturesChecked:0,reason:'NO_LEGAL_MOVES',
  };

  const {device,pipeline,bindGroupLayout}=active;
  const usage=(globalThis as any).GPUBufferUsage;
  const mapMode=(globalThis as any).GPUMapMode;
  if(!usage||!mapMode)throw new Error('WEBGPU_CONSTANTS_MISSING');

  const state=encodePosition(position);
  const encodedMoves=new Uint32Array(moves.map(encodeMove));
  const outputBytes=FORECAST_LAYERS*Uint32Array.BYTES_PER_ELEMENT;
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
    const bindGroup=device.createBindGroup({
      layout:bindGroupLayout,
      entries:[
        {binding:0,resource:{buffer:stateBuffer}},
        {binding:1,resource:{buffer:moveBuffer}},
        {binding:2,resource:{buffer:outputBuffer}},
        {binding:3,resource:{buffer:paramsBuffer}},
      ],
    });

    const start=performance.now();
    const encoder=device.createCommandEncoder({label:'title-forecast-500-layer-encoder'});
    const pass=encoder.beginComputePass({label:'title-forecast-500-layer-pass'});
    pass.setPipeline(pipeline);
    pass.setBindGroup(0,bindGroup);
    pass.dispatchWorkgroups(FORECAST_LAYERS,1,1);
    pass.end();
    encoder.copyBufferToBuffer(outputBuffer,0,readback,0,outputBytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(mapMode.READ);
    const elapsedMs=performance.now()-start;
    const signatures=new Uint32Array(readback.getMappedRange().slice(0));
    let signaturesChecked=0;
    for(const value of signatures)if(value!==0)signaturesChecked++;
    readback.unmap();
    return{
      supported:true,
      layers:FORECAST_LAYERS,
      lanesPerLayer:LANES_PER_LAYER,
      samplesPerLane:SAMPLES_PER_LANE,
      totalSamples,
      elapsedMs,
      samplesPerSecond:elapsedMs>0?totalSamples/(elapsedMs/1000):0,
      signaturesChecked,
    };
  }finally{
    for(const buffer of [stateBuffer,moveBuffer,outputBuffer,paramsBuffer,readback])buffer.destroy();
  }
}
