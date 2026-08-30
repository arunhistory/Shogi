import {readFile,writeFile} from 'node:fs/promises';

const MAGIC=0x53484749;
const WORDS=97;
const HISTORY_MAGIC=0x48535431;
const HISTORY_ENTRY_WORDS=5;
const FNV_PRIME=1099511628211n;
const FNV_PRIMARY_SEED=1469598103934665603n;
const FNV_SECONDARY_SEED=0x84222325cbf29ce4n;
const MASK64=(1n<<64n)-1n;

const path=process.argv[2]??'public/wasm/shogi_engine.wasm';
const outputPath=process.argv[3]??'';
const bytes=await readFile(path);
const {instance}=await WebAssembly.instantiate(bytes,{});
const wasm=instance.exports;
for(const name of ['memory','shogi_input_buffer','shogi_input_capacity','shogi_history_buffer','shogi_history_capacity','shogi_legal_move_count','shogi_legal_move_at','shogi_search_root_move_with_history','shogi_parallel_search_complete','shogi_nodes_searched']){
  if(typeof wasm[name]!=='function'&&name!=='memory')throw new Error(`MISSING_EXPORT:${name}`);
}

const input=new Int32Array(wasm.memory.buffer,wasm.shogi_input_buffer(),wasm.shogi_input_capacity());
const history=new Int32Array(wasm.memory.buffer,wasm.shogi_history_buffer(),wasm.shogi_history_capacity());

function mix(hash,value){return ((hash^BigInt(value&0xff))*FNV_PRIME)&MASK64;}
function hashPosition(state,seed){
  let hash=seed;
  for(const code of state.board)hash=mix(hash,code+16);
  for(const count of state.hands)hash=mix(hash,count);
  hash=mix(hash,state.turn===1?1:2);
  return hash;
}
function split(value){return [Number(BigInt.asIntN(32,value&0xffffffffn)),Number(BigInt.asIntN(32,(value>>32n)&0xffffffffn))];}
function writeState(state){
  const words=new Int32Array(WORDS);
  words[0]=MAGIC; words[1]=state.turn; words.set(state.board,2); words.set(state.hands,83);
  input.fill(0,0,WORDS); input.set(words);
  const [pl,ph]=split(hashPosition(state,FNV_PRIMARY_SEED));
  const [sl,sh]=split(hashPosition(state,FNV_SECONDARY_SEED));
  history.fill(0,0,2+HISTORY_ENTRY_WORDS);
  history[0]=HISTORY_MAGIC; history[1]=1;
  history[2]=pl; history[3]=ph; history[4]=sl; history[5]=sh; history[6]=0;
  return 2+HISTORY_ENTRY_WORDS;
}
function initialBoard(){
  const board=new Int32Array(81);
  const back=[2,3,4,5,8,5,4,3,2];
  for(let x=0;x<9;x++){
    board[x]=-back[x]; board[18+x]=-1; board[54+x]=1; board[72+x]=back[x];
  }
  board[10]=-7; board[16]=-6; board[64]=6; board[70]=7;
  return board;
}
function emptyState(turn=1){return {turn,board:new Int32Array(81),hands:new Int32Array(14)};}
function selectedMoves(codes){
  const indexes=[0,1,2,3,4,5,Math.floor(codes.length/2),Math.max(0,codes.length-3),Math.max(0,codes.length-2),Math.max(0,codes.length-1)];
  return [...new Set(indexes.filter(index=>index>=0&&index<codes.length).map(index=>codes[index]))];
}

const initial={turn:1,board:initialBoard(),hands:new Int32Array(14)};
const tactical=emptyState(-1);
tactical.board[4]=-8; tactical.board[12]=-5; tactical.board[14]=-4; tactical.board[22]=-7;
tactical.board[58]=7; tactical.board[66]=4; tactical.board[68]=5; tactical.board[76]=8;
tactical.board[28]=-1; tactical.board[29]=-1; tactical.board[51]=1; tactical.board[52]=1;
tactical.hands[3]=1; tactical.hands[5]=1; tactical.hands[7]=2; tactical.hands[9]=1; tactical.hands[12]=1;

const drops=emptyState(1);
drops.board[4]=-8; drops.board[76]=8; drops.board[21]=-5; drops.board[59]=5; drops.board[31]=-1; drops.board[49]=1;
drops.hands[0]=2; drops.hands[2]=1; drops.hands[3]=1; drops.hands[6]=1;
drops.hands[7]=2; drops.hands[9]=1; drops.hands[10]=1; drops.hands[12]=1;

const mateNet=emptyState(1);
mateNet.board[0]=-8; mateNet.board[18]=5; mateNet.board[20]=3; mateNet.board[80]=8; mateNet.hands[6]=1;

const cases=[['initial',initial],['tactical',tactical],['drops',drops],['mate-net',mateNet]];
const results=[];
for(const [name,state] of cases){
  const historyWords=writeState(state);
  const legalCount=wasm.shogi_legal_move_count(WORDS);
  if(legalCount<=0||legalCount>768)throw new Error(`LEGAL_COUNT:${name}:${legalCount}`);
  const legal=Array.from({length:legalCount},(_,i)=>wasm.shogi_legal_move_at(i));
  const moves=selectedMoves(legal);
  const probes=[];
  for(const encodedMove of moves){
    for(const lane of [0,1]){
      writeState(state);
      const score=wasm.shogi_search_root_move_with_history(WORDS,historyWords,encodedMove,4,20000,lane,4);
      const nodes=wasm.shogi_nodes_searched();
      const complete=wasm.shogi_parallel_search_complete();
      if(score===2147483647)throw new Error(`INVALID_SCORE:${name}:${encodedMove}:${lane}`);
      probes.push({move:encodedMove,lane,score,nodes,complete});
    }
  }
  results.push({name,legalCount,probes});
}
const result={wasmBytes:bytes.byteLength,cases:results};
const semantic={cases:results};
const json=JSON.stringify(result);
console.log(`TITLE_EQUIVALENCE:${json}`);
if(outputPath)await writeFile(outputPath,JSON.stringify(semantic));
