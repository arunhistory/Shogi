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
  const source=move.from[0]*9+move.from[1];
  return (to|(source<<7)|(move.promote?1<<18:0))>>>0;
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
var<workgroup> laneScores:array<i32,64>;
var<workgroup> kingSquares:array<u32,2>;

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

fn pieceValue(kind:u32)->i32{
  if(kind==1u){return 100;}
  if(kind==2u){return 320;}
  if(kind==3u){return 360;}
  if(kind==4u){return 520;}
  if(kind==5u){return 600;}
  if(kind==6u){return 900;}
  if(kind==7u){return 1000;}
  if(kind==8u){return 0;}
  if(kind==9u||kind==10u||kind==11u||kind==12u){return 600;}
  if(kind==13u){return 1250;}
  if(kind==14u){return 1350;}
  return 0;
}

fn handOffset(side:i32)->u32{
  return select(88u,81u,side>0);
}

fn applyRootMove(encoded:u32){
  let target=encoded&0x7fu;
  let source=(encoded>>7u)&0x7fu;
  let drop=(encoded>>14u)&0x0fu;
  let promote=((encoded>>18u)&1u)==1u;
  let side=sharedState[95];
  let offset=handOffset(side);

  if(drop!=0u){
    sharedState[target]=side*i32(drop);
    let handIndex=offset+(drop-1u);
    sharedState[handIndex]=sharedState[handIndex]-1;
  }else{
    let piece=sharedState[source];
    let captured=sharedState[target];
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
    sharedState[target]=side*i32(kind);
  }
  sharedState[95]=-side;
}

fn sideOf(value:i32)->i32{
  return select(-1,1,value>0);
}

fn chebyshev(a:u32,b:u32)->u32{
  let ay=i32(a/9u);
  let ax=i32(a%9u);
  let by=i32(b/9u);
  let bx=i32(b%9u);
  let dy=abs(ay-by);
  let dx=abs(ax-bx);
  return u32(max(dy,dx));
}

fn sampleFeature(square:u32,partner:u32,perspective:i32)->i32{
  let value=sharedState[square];
  if(value==0){return 0;}
  let side=sideOf(value);
  let kind=absCode(value);
  let sign=select(-1,1,side==perspective);
  let y=i32(square/9u);
  let x=i32(square%9u);
  let center=4-abs(x-4);
  let progress=select(y,8-y,perspective>0);
  var score=sign*(pieceValue(kind)/25+center+max(0,progress-3));

  let enemyKing=select(kingSquares[0],kingSquares[1],perspective>0);
  let ownKing=select(kingSquares[1],kingSquares[0],perspective>0);
  let enemyDistance=chebyshev(square,enemyKing);
  let ownDistance=chebyshev(square,ownKing);
  if(side==perspective&&enemyDistance<=2u){score=score+i32(3u-enemyDistance)*10;}
  if(side!=perspective&&ownDistance<=2u){score=score-i32(3u-ownDistance)*12;}

  let partnerValue=sharedState[partner];
  if(partnerValue!=0&&sideOf(partnerValue)!=side){
    let distance=chebyshev(square,partner);
    if(distance<=2u){score=score+sign*i32(3u-distance)*3;}
  }
  return score;
}

fn exactMaterial(perspective:i32)->i32{
  var score=0;
  var square=0u;
  loop{
    if(square>=81u){break;}
    let value=sharedState[square];
    if(value!=0){
      let sign=select(-1,1,sideOf(value)==perspective);
      score=score+sign*pieceValue(absCode(value));
    }
    square=square+1u;
  }
  var kind=0u;
  loop{
    if(kind>=7u){break;}
    let senteCount=sharedState[81u+kind];
    let goteCount=sharedState[88u+kind];
    let value=pieceValue(kind+1u);
    let delta=select(goteCount-senteCount,senteCount-goteCount,perspective>0);
    score=score+delta*value;
    kind=kind+1u;
  }
  return score;
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
    kingSquares[0]=81u;
    kingSquares[1]=81u;
    var square=0u;
    loop{
      if(square>=81u){break;}
      let value=sharedState[square];
      if(absCode(value)==8u){
        if(value>0){kingSquares[0]=square;}else{kingSquares[1]=square;}
      }
      square=square+1u;
    }
  }
  workgroupBarrier();

  let perspective=-sharedState[95];
  var acc=0;
  var iteration=0u;
  loop{
    if(iteration>=params.iterations){break;}
    let sampleIndex=iteration*${LANES_PER_LAYER}u+lane;
    let square=sampleIndex%81u;
    let partner=(sampleIndex/81u+layer*13u+lane*7u)%81u;
    let handIndex=81u+((sampleIndex/6561u+lane)%14u);
    let handSide=select(-1,1,handIndex<88u);
    let handKind=(handIndex-81u)%7u;
    let handSign=select(-1,1,handSide==perspective);
    let handFeature=handSign*sharedState[handIndex]*(pieceValue(handKind+1u)/80);
    acc=acc+sampleFeature(square,partner,perspective)+handFeature;
    iteration=iteration+1u;
  }
  laneScores[lane]=acc;
  workgroupBarrier();

  if(lane==0u){
    var combined=0;
    var i=0u;
    loop{
      if(i>=${LANES_PER_LAYER}u){break;}
      combined=combined+laneScores[i];
      i=i+1u;
    }
    let average=combined/i32(${LANES_PER_LAYER*SAMPLES_PER_LANE});
    let score=exactMaterial(perspective)+average*18;
    output[layer*2u]=bitcast<u32>(score);
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
    signaturesChecked:0,rootScores:[],bestMoveIndex:null,reason:'WEBGPU_UNAVAILABLE',
  };
  if(moves.length===0)return{
    supported:false,layers:FORECAST_LAYERS,lanesPerLayer:LANES_PER_LAYER,
    samplesPerLane:SAMPLES_PER_LANE,totalSamples,elapsedMs:0,samplesPerSecond:0,
    signaturesChecked:0,rootScores:[],bestMoveIndex:null,reason:'NO_LEGAL_MOVES',
  };

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
    const raw=new Uint32Array(readback.getMappedRange().slice(0));
    let signaturesChecked=0;
    const sums=new Array<number>(moves.length).fill(0);
    const counts=new Array<number>(moves.length).fill(0);
    for(let layer=0;layer<FORECAST_LAYERS;layer++){
      const score=new Int32Array(new Uint32Array([raw[layer*2]??0]).buffer)[0]??0;
      const signature=raw[layer*2+1]??0;
      if(signature!==0)signaturesChecked++;
      const moveIndex=layer%moves.length;
      sums[moveIndex]=(sums[moveIndex]??0)+score;
      counts[moveIndex]=(counts[moveIndex]??0)+1;
    }
    readback.unmap();
    const rootScores=sums.map((sum,index)=>Math.round(sum/Math.max(1,counts[index]??0)));
    let bestMoveIndex:number|null=null;
    for(let index=0;index<rootScores.length;index++){
      if(bestMoveIndex===null||rootScores[index]!>rootScores[bestMoveIndex]!)bestMoveIndex=index;
    }
    return{
      supported:true,
      layers:FORECAST_LAYERS,
      lanesPerLayer:LANES_PER_LAYER,
      samplesPerLane:SAMPLES_PER_LANE,
      totalSamples,
      elapsedMs,
      samplesPerSecond:elapsedMs>0?totalSamples/(elapsedMs/1000):0,
      signaturesChecked,
      rootScores,
      bestMoveIndex,
    };
  }finally{
    for(const buffer of [stateBuffer,moveBuffer,outputBuffer,paramsBuffer,readback])buffer.destroy();
  }
}
