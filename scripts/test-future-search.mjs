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

// Sente's silver captures a pawn. The ordinary depth-1 search reaches the
// post-capture horizon immediately. The future search extends through Gote's
// reply to Sente's next turn, where the newly captured pawn is now a real
// drop candidate. This validates that a hand acquisition creates additional
// searched futures rather than merely changing an evaluation number.
const board=new Int32Array(81);
board[0*9+4]=-8;
board[8*9+4]=8;
board[4*9+4]=4;
board[3*9+4]=-1;
const state={turn:1,board,hands:new Int32Array(14)};
const capture=encode({from:4*9+4,to:3*9+4});
let historyWords=write(state);
const baselineScore=wasm.shogi_search_root_move_with_history(WORDS,historyWords,capture,1,50_000,0,4);
assert.notEqual(baselineScore,INVALID,'baseline capture search rejected the legal move');
const baselineNodes=wasm.shogi_nodes_searched();

historyWords=write(state);
const futureScore=wasm.shogi_search_future_root_move_with_history(WORDS,historyWords,capture,1,50_000,0);
assert.notEqual(futureScore,INVALID,'future capture search rejected the legal move');
const futureNodes=wasm.shogi_nodes_searched();
assert.ok(futureNodes>baselineNodes,`hand acquisition did not expand future search: baseline=${baselineNodes}, future=${futureNodes}`);
assert.ok(futureNodes>=10,`future search did not reach the next hand-use turn: ${futureNodes}`);
assert.equal(wasm.shogi_parallel_search_complete(),1,'small hand-aware future search did not complete');

console.log(JSON.stringify({ok:true,baselineNodes,futureNodes,baselineScore,futureScore}));
