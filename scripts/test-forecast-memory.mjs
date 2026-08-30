import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const MAGIC=0x53484749;
const WORDS=97;
const HISTORY_MAGIC=0x48535431;
const HISTORY_ENTRY_WORDS=5;
const FNV_PRIME=1099511628211n;
const FNV_PRIMARY_SEED=1469598103934665603n;
const FNV_SECONDARY_SEED=0x84222325cbf29ce4n;
const MASK_64=(1n<<64n)-1n;
const NODE_LIMIT=80_000;

const bytes=await readFile(new URL('../public/wasm/shogi_engine.wasm',import.meta.url));
const {instance}=await WebAssembly.instantiate(bytes,{});
const wasm=instance.exports;
for(const name of [
  'memory','shogi_input_buffer','shogi_input_capacity','shogi_history_buffer','shogi_history_capacity',
  'shogi_search_future_root_move_with_history','shogi_parallel_search_complete','shogi_nodes_searched',
  'shogi_forecast_tt_hits','shogi_forecast_atlas_hits',
])assert.ok(wasm[name],`missing export: ${name}`);

const input=new Int32Array(wasm.memory.buffer,wasm.shogi_input_buffer(),wasm.shogi_input_capacity());
const history=new Int32Array(wasm.memory.buffer,wasm.shogi_history_buffer(),wasm.shogi_history_capacity());

function mix(hash,value){return((hash^BigInt(value&0xff))*FNV_PRIME)&MASK_64;}
function hashPosition(state,seed){
  let hash=seed;
  for(const code of state.board)hash=mix(hash,code+16);
  for(const count of state.hands)hash=mix(hash,count);
  hash=mix(hash,state.turn===1?1:2);
  return hash;
}
function split(value){return[
  Number(BigInt.asIntN(32,value&0xffffffffn)),
  Number(BigInt.asIntN(32,(value>>32n)&0xffffffffn)),
];}
function write(state){
  const words=new Int32Array(WORDS);
  words[0]=MAGIC;words[1]=state.turn;words.set(state.board,2);words.set(state.hands,83);
  input.fill(0,0,WORDS);input.set(words,0);
  const [pl,ph]=split(hashPosition(state,FNV_PRIMARY_SEED));
  const [sl,sh]=split(hashPosition(state,FNV_SECONDARY_SEED));
  history.fill(0,0,2+HISTORY_ENTRY_WORDS);
  history[0]=HISTORY_MAGIC;history[1]=1;
  history[2]=pl;history[3]=ph;history[4]=sl;history[5]=sh;history[6]=0;
  return 2+HISTORY_ENTRY_WORDS;
}
function encode({from=-1,to,drop=0,promote=false}){
  const encodedFrom=from>=0?from:127;
  return(to&0x7f)|((encodedFrom&0x7f)<<7)|((drop&0x0f)<<14)|((promote?1:0)<<18);
}
function forecast(state,move,lane=0){
  const historyWords=write(state);
  const score=wasm.shogi_search_future_root_move_with_history(WORDS,historyWords,move,2,NODE_LIMIT,lane);
  return{
    score,
    nodes:wasm.shogi_nodes_searched(),
    complete:wasm.shogi_parallel_search_complete(),
    ttHits:wasm.shogi_forecast_tt_hits(),
    atlasHits:wasm.shogi_forecast_atlas_hits(),
  };
}

// Small legal position with enough branching to populate a complete forecast
// subtree. The second identical forecast must assimilate the first forecast
// memory rather than rebuilding the same future from zero.
const board=new Int32Array(81);
board[0*9+4]=-8;
board[8*9+4]=8;
board[6*9+4]=4;
const state={turn:1,board,hands:new Int32Array(14)};
const move=encode({from:6*9+4,to:5*9+4});

const first=forecast(state,move,0);
const second=forecast(state,move,0);
console.log(JSON.stringify({first,second}));

assert.equal(first.complete,1,'first forecast did not complete; persistence test is inconclusive');
assert.equal(second.complete,1,'second forecast did not complete');
assert.ok(second.ttHits>0||second.atlasHits>0,'second forecast did not reuse forecast memory');
assert.ok(second.nodes<first.nodes,`forecast assimilation did not reduce repeated work: first=${first.nodes}, second=${second.nodes}`);

console.log(JSON.stringify({ok:true,first,second}));
