import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const MAGIC=0x53484749;
const WORDS=97;
const wasmPath=new URL('../public/wasm/shogi_engine.wasm',import.meta.url);
const bytes=await readFile(wasmPath);
const {instance}=await WebAssembly.instantiate(bytes,{});
const wasm=instance.exports;

for(const name of [
  'memory','shogi_engine_version','shogi_input_buffer','shogi_input_capacity',
  'shogi_legal_move_count','shogi_legal_move_at','shogi_is_check','shogi_is_mate',
  'shogi_search_best_move','shogi_nodes_searched',
])assert.ok(wasm[name],`missing export: ${name}`);
assert.ok(wasm.shogi_engine_version()>=3,'unexpected engine version');

const pointer=wasm.shogi_input_buffer();
const capacity=wasm.shogi_input_capacity();
assert.ok(capacity>=WORDS,'input buffer too small');
const input=new Int32Array(wasm.memory.buffer,pointer,capacity);

function writePosition({turn=1,board,hands}){
  const words=new Int32Array(WORDS);
  words[0]=MAGIC;
  words[1]=turn;
  words.set(board,2);
  words.set(hands??new Int32Array(14),83);
  input.fill(0,0,WORDS);
  input.set(words,0);
}

function initialBoard(){
  const board=new Int32Array(81);
  const back=[2,3,4,5,8,5,4,3,2];
  for(let x=0;x<9;x++){
    board[x]=-back[x];
    board[2*9+x]=-1;
    board[6*9+x]=1;
    board[8*9+x]=back[x];
  }
  board[1*9+1]=-7;
  board[1*9+7]=-6;
  board[7*9+1]=6;
  board[7*9+7]=7;
  return board;
}

function legalCodes(){
  const count=wasm.shogi_legal_move_count(WORDS);
  assert.ok(count>=0&&count<=768,`invalid legal count: ${count}`);
  return Array.from({length:count},(_,index)=>wasm.shogi_legal_move_at(index));
}

function decode(code){
  return{
    to:code&0x7f,
    from:(code>>7)&0x7f,
    drop:(code>>14)&0x0f,
    promote:((code>>18)&1)===1,
  };
}

writePosition({board:initialBoard()});
const initialLegal=legalCodes();
assert.ok(initialLegal.length>0,'initial position has no legal moves');
const best=wasm.shogi_search_best_move(WORDS,2,20_000);
assert.ok(initialLegal.includes(best),'search returned a move outside the legal root set');
assert.ok(wasm.shogi_nodes_searched()>0,'search did not visit nodes');

const noKingCapture=new Int32Array(81);
noKingCapture[0*9+4]=-8;
noKingCapture[1*9+4]=7;
noKingCapture[8*9+4]=8;
writePosition({board:noKingCapture});
const kingCaptureCode=(0*9+4)|((1*9+4)<<7);
assert.ok(!legalCodes().includes(kingCaptureCode),'king capture was generated');

const nifuBoard=new Int32Array(81);
nifuBoard[0*9+4]=-8;
nifuBoard[8*9+4]=8;
nifuBoard[6*9+3]=1;
const hands=new Int32Array(14);
hands[0]=1; // sente pawn in hand
writePosition({board:nifuBoard,hands});
const nifuMoves=legalCodes().map(decode).filter(move=>move.drop===1);
assert.ok(nifuMoves.every(move=>move.to%9!==3),'nifu pawn drop was generated');
assert.ok(nifuMoves.every(move=>Math.floor(move.to/9)!==0),'dead-end pawn drop was generated');

const invalid=new Int32Array(WORDS);
input.fill(0,0,WORDS);
input.set(invalid,0);
assert.equal(wasm.shogi_legal_move_count(WORDS),-1,'invalid serialized position was accepted');

console.log(JSON.stringify({ok:true,initialLegalMoves:initialLegal.length,nodes:wasm.shogi_nodes_searched()}));
