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

function encode({from=-1,to,drop=0,promote=false}){
  const encodedFrom=from>=0?from:127;
  return (to&0x7f)|((encodedFrom&0x7f)<<7)|((drop&0x0f)<<14)|((promote?1:0)<<18);
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
const kingCaptureCode=encode({from:1*9+4,to:0*9+4});
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

const forcedPromotion=new Int32Array(81);
forcedPromotion[0*9+4]=-8;
forcedPromotion[8*9+4]=8;
forcedPromotion[1*9+0]=1;
writePosition({board:forcedPromotion});
const forcedFrom=1*9+0,forcedTo=0*9+0;
const forcedCodes=legalCodes();
assert.ok(forcedCodes.includes(encode({from:forcedFrom,to:forcedTo,promote:true})),'forced pawn promotion is missing');
assert.ok(!forcedCodes.includes(encode({from:forcedFrom,to:forcedTo,promote:false})),'illegal non-promotion on final rank was generated');

const optionalPromotion=new Int32Array(81);
optionalPromotion[0*9+4]=-8;
optionalPromotion[8*9+4]=8;
optionalPromotion[3*9+0]=1;
writePosition({board:optionalPromotion});
const optionalFrom=3*9+0,optionalTo=2*9+0;
const optionalCodes=legalCodes();
assert.ok(optionalCodes.includes(encode({from:optionalFrom,to:optionalTo,promote:false})),'legal non-promotion option is missing');
assert.ok(optionalCodes.includes(encode({from:optionalFrom,to:optionalTo,promote:true})),'legal promotion option is missing');

const selfCheck=new Int32Array(81);
selfCheck[0*9+0]=-8;
selfCheck[0*9+4]=-7;
selfCheck[7*9+4]=5;
selfCheck[8*9+4]=8;
writePosition({board:selfCheck});
assert.equal(wasm.shogi_is_check(WORDS,1),0,'blocked rook incorrectly gives check');
assert.ok(!legalCodes().includes(encode({from:7*9+4,to:7*9+3})),'move exposing own king to check was generated');

const escapablePawnCheck=new Int32Array(81);
escapablePawnCheck[0*9+4]=-8;
escapablePawnCheck[8*9+4]=8;
const pawnHand=new Int32Array(14);
pawnHand[0]=1;
writePosition({board:escapablePawnCheck,hands:pawnHand});
const checkingDrop=encode({to:1*9+4,drop:1});
assert.ok(legalCodes().includes(checkingDrop),'checking pawn drop with legal king escape was rejected');

const pawnDropMate=new Int32Array(81);
pawnDropMate[0*9+3]=-2;
pawnDropMate[0*9+4]=-8;
pawnDropMate[0*9+5]=-2;
pawnDropMate[2*9+4]=5;
pawnDropMate[8*9+4]=8;
writePosition({board:pawnDropMate,hands:pawnHand});
assert.ok(!legalCodes().includes(checkingDrop),'uchi-fuzume pawn drop was generated');

const matedPosition=pawnDropMate.slice();
matedPosition[1*9+4]=1;
writePosition({turn:-1,board:matedPosition});
assert.equal(wasm.shogi_is_check(WORDS,-1),1,'mated king is not reported in check');
assert.equal(wasm.shogi_is_mate(WORDS),1,'checkmate position is not reported as mate');
assert.equal(legalCodes().length,0,'checkmated side still has a legal move');

const invalid=new Int32Array(WORDS);
input.fill(0,0,WORDS);
input.set(invalid,0);
assert.equal(wasm.shogi_legal_move_count(WORDS),-1,'invalid serialized position was accepted');

console.log(JSON.stringify({ok:true,initialLegalMoves:initialLegal.length,nodes:wasm.shogi_nodes_searched()}));
