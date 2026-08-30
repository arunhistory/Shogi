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
const INVALID=2147483647;
const NODE_LIMIT=220_000;

const bytes=await readFile(new URL('../public/wasm/shogi_engine.wasm',import.meta.url));
const {instance}=await WebAssembly.instantiate(bytes,{});
const wasm=instance.exports;
for(const name of [
  'memory','shogi_input_buffer','shogi_input_capacity','shogi_history_buffer','shogi_history_capacity',
  'shogi_search_root_move_with_history','shogi_search_future_root_move_with_history',
  'shogi_parallel_search_complete','shogi_nodes_searched',
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
function runFuture(state,move){
  const historyWords=write(state);
  const score=wasm.shogi_search_future_root_move_with_history(WORDS,historyWords,move,1,NODE_LIMIT,0);
  const nodes=wasm.shogi_nodes_searched();
  const complete=wasm.shogi_parallel_search_complete();
  return{score,nodes,complete};
}

// Sente's silver can either move quietly or capture a pawn. At the same
// nominal depth=1, the quiet move reaches the ordinary horizon. Capturing the
// pawn creates a reusable hand piece, so title future search extends through
// Gote's reply to Sente's next turn, where pawn drops are real legal futures.
const board=new Int32Array(81);
board[0*9+4]=-8;
board[8*9+4]=8;
board[4*9+4]=4;
board[3*9+4]=-1;
const state={turn:1,board,hands:new Int32Array(14)};
const quiet=encode({from:4*9+4,to:3*9+3});
const capture=encode({from:4*9+4,to:3*9+4});

let historyWords=write(state);
const baselineScore=wasm.shogi_search_root_move_with_history(WORDS,historyWords,capture,1,NODE_LIMIT,0,4);
assert.notEqual(baselineScore,INVALID,'baseline capture search rejected the legal move');
const baselineNodes=wasm.shogi_nodes_searched();

const quietFuture=runFuture(state,quiet);
const captureFuture=runFuture(state,capture);
const metrics={
  baselineNodes,
  baselineScore,
  quietFutureNodes:quietFuture.nodes,
  quietFutureScore:quietFuture.score,
  quietFutureComplete:quietFuture.complete,
  captureFutureNodes:captureFuture.nodes,
  captureFutureScore:captureFuture.score,
  captureFutureComplete:captureFuture.complete,
  nodeLimit:NODE_LIMIT,
};
console.log(JSON.stringify(metrics));

assert.notEqual(quietFuture.score,INVALID,'future quiet search rejected the legal move');
assert.notEqual(captureFuture.score,INVALID,'future capture search rejected the legal move');
assert.ok(captureFuture.nodes>baselineNodes,`hand acquisition did not expand beyond baseline: baseline=${baselineNodes}, future=${captureFuture.nodes}`);
assert.ok(captureFuture.nodes>quietFuture.nodes,`capture did not create more searched futures than quiet play: quiet=${quietFuture.nodes}, capture=${captureFuture.nodes}`);
assert.ok(captureFuture.nodes>=10,`future search did not reach the next hand-use turn: ${captureFuture.nodes}`);
assert.ok(captureFuture.nodes<=NODE_LIMIT,`future search exceeded its node ceiling: ${captureFuture.nodes}`);
assert.ok(quietFuture.nodes<=NODE_LIMIT,`quiet future search exceeded its node ceiling: ${quietFuture.nodes}`);

console.log(JSON.stringify({ok:true,...metrics}));
