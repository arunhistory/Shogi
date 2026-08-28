import type { Board, BoardKind, Hands, PieceKind, Side } from './types';

const version='v1';
const boardKinds:BoardKind[]=[
  'pawn','lance','knight','silver','gold','bishop','rook','king',
  'tokin','promotedLance','promotedKnight','promotedSilver','horse','dragon',
];
const handKinds:PieceKind[]=['king','rook','bishop','gold','silver','knight','lance','pawn'];
const kindIndex=new Map(boardKinds.map((kind,index)=>[kind,index] as const));

export interface PositionKeyData {
  turn:Side;
  board:Board;
  hands:Hands;
}

function emptyHands():Hands{
  const side=()=>Object.fromEntries(handKinds.map(kind=>[kind,0])) as Record<PieceKind,number>;
  return{sente:side(),gote:side()};
}

function encodeSquare(piece:Board[number][number]):string{
  if(piece===null)return'.';
  const index=kindIndex.get(piece.kind);
  if(index===undefined)throw new Error('INVALID_POSITION_KEY_PIECE');
  const base=piece.side==='sente'?65:97;
  if(piece.side!=='sente'&&piece.side!=='gote')throw new Error('INVALID_POSITION_KEY_SIDE');
  return String.fromCharCode(base+index);
}

function decodeSquare(char:string):Board[number][number]{
  if(char==='.')return null;
  const code=char.charCodeAt(0);
  const sente=code>=65&&code<65+boardKinds.length;
  const gote=code>=97&&code<97+boardKinds.length;
  if(!sente&&!gote)throw new Error('INVALID_POSITION_KEY_BOARD');
  const index=sente?code-65:code-97;
  return{side:sente?'sente':'gote',kind:boardKinds[index]!};
}

function encodeHand(hands:Hands,side:Side):string{
  return handKinds.map(kind=>{
    const count=hands?.[side]?.[kind];
    if(!Number.isSafeInteger(count)||count<0||count>40)throw new Error('INVALID_POSITION_KEY_HAND');
    return count.toString(36);
  }).join(',');
}

function decodeHand(value:string,hands:Hands,side:Side):void{
  const counts=value.split(',');
  if(counts.length!==handKinds.length)throw new Error('INVALID_POSITION_KEY_HAND');
  counts.forEach((raw,index)=>{
    if(!/^[0-9a-z]+$/.test(raw))throw new Error('INVALID_POSITION_KEY_HAND');
    const count=Number.parseInt(raw,36);
    if(!Number.isSafeInteger(count)||count<0||count>40)throw new Error('INVALID_POSITION_KEY_HAND');
    hands[side][handKinds[index]!]=count;
  });
}

export function encodePositionKey(position:PositionKeyData):string{
  if(position.turn!=='sente'&&position.turn!=='gote')throw new Error('INVALID_POSITION_KEY_TURN');
  if(!Array.isArray(position.board)||position.board.length!==9||!position.board.every(row=>Array.isArray(row)&&row.length===9))throw new Error('INVALID_POSITION_KEY_BOARD');
  const board=position.board.flatMap(row=>row.map(encodeSquare)).join('');
  return`${version}|${position.turn==='sente'?'S':'G'}|${board}|${encodeHand(position.hands,'sente')}|${encodeHand(position.hands,'gote')}`;
}

export function decodePositionKey(key:string):PositionKeyData{
  if(typeof key!=='string'||key.length===0||key.length>65_536)throw new Error('INVALID_HISTORY_KEY');
  if(key.startsWith(`${version}|`)){
    const parts=key.split('|');
    if(parts.length!==5)throw new Error('INVALID_HISTORY_KEY');
    const turnCode=parts[1]!;
    const boardCode=parts[2]!;
    const senteHands=parts[3]!;
    const goteHands=parts[4]!;
    if((turnCode!=='S'&&turnCode!=='G')||boardCode.length!==81)throw new Error('INVALID_HISTORY_KEY');
    const board:Board=Array.from({length:9},(_,row)=>Array.from({length:9},(_,column)=>decodeSquare(boardCode[row*9+column]!)));
    const hands=emptyHands();
    decodeHand(senteHands,hands,'sente');
    decodeHand(goteHands,hands,'gote');
    return{turn:turnCode==='S'?'sente':'gote',board,hands};
  }

  // Backward compatibility for positions produced before compact history keys.
  let parsed:unknown;
  try{parsed=JSON.parse(key);}catch{throw new Error('INVALID_HISTORY_KEY');}
  if(!Array.isArray(parsed)||parsed.length!==3)throw new Error('INVALID_HISTORY_KEY');
  const [turn,board,hands]=parsed;
  if((turn!=='sente'&&turn!=='gote')||!Array.isArray(board)||!hands||typeof hands!=='object')throw new Error('INVALID_HISTORY_KEY');
  return{turn,board:board as Board,hands:hands as Hands};
}
