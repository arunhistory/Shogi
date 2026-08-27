import type {
  Board,
  BoardKind,
  GameOutcome,
  Handicap,
  Hands,
  Move,
  Piece,
  PieceKind,
  Position,
  RepetitionStatus,
  Side,
} from './types';

const baseKinds: PieceKind[]=['king','rook','bishop','gold','silver','knight','lance','pawn'];
const promoteMap: Partial<Record<PieceKind,BoardKind>>={rook:'dragon',bishop:'horse',silver:'promotedSilver',knight:'promotedKnight',lance:'promotedLance',pawn:'tokin'};
const unpromoteMap: Record<BoardKind,PieceKind>={king:'king',rook:'rook',bishop:'bishop',gold:'gold',silver:'silver',knight:'knight',lance:'lance',pawn:'pawn',dragon:'rook',horse:'bishop',promotedSilver:'silver',promotedKnight:'knight',promotedLance:'lance',tokin:'pawn'};

export const emptyHands=():Hands=>({
  sente:Object.fromEntries(baseKinds.map(k=>[k,0])) as Record<PieceKind,number>,
  gote:Object.fromEntries(baseKinds.map(k=>[k,0])) as Record<PieceKind,number>,
});

const p=(side:Side,kind:BoardKind):Piece=>({side,kind});
const enemy=(s:Side):Side=>s==='sente'?'gote':'sente';
const inside=(y:number,x:number)=>y>=0&&y<9&&x>=0&&x<9;
const zone=(side:Side,y:number)=>side==='sente'?y<=2:y>=6;
const goldDirs=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,0]];

export function positionKey(pos:Position):string{
  return JSON.stringify([pos.turn,pos.board,pos.hands]);
}

export function initialPosition(handicap:Handicap='even'):Position{
  const board:Board=Array.from({length:9},()=>Array(9).fill(null));
  const back:PieceKind[]=['lance','knight','silver','gold','king','gold','silver','knight','lance'];
  for(let x=0;x<9;x++){
    board[0]![x]=p('gote',back[8-x]!);
    board[8]![x]=p('sente',back[x]!);
    board[2]![x]=p('gote','pawn');
    board[6]![x]=p('sente','pawn');
  }
  board[1]![1]=p('gote','rook');
  board[1]![7]=p('gote','bishop');
  board[7]![1]=p('sente','bishop');
  board[7]![7]=p('sente','rook');

  const remove=(kind:PieceKind)=>{
    for(let y=0;y<9;y++)for(let x=0;x<9;x++){
      if(board[y]![x]?.side==='gote'&&board[y]![x]?.kind===kind){
        board[y]![x]=null;
        return;
      }
    }
  };
  if(handicap==='rook')remove('rook');
  if(handicap==='bishop')remove('bishop');
  if(handicap==='two'){remove('rook');remove('bishop');}
  if(handicap==='four'){remove('rook');remove('bishop');remove('lance');remove('lance');}
  if(handicap==='six'){remove('rook');remove('bishop');remove('lance');remove('lance');remove('knight');remove('knight');}

  // 駒落ちは上手（画面上側=gote）が駒を落とし、上手から指す。
  const position:Position={board,hands:emptyHands(),turn:handicap==='even'?'sente':'gote',ply:0,history:[]};
  position.history.push({key:positionKey(position),mover:null,gaveCheck:false});
  return position;
}

function dirs(piece:Piece):{step:number[][];slide:number[][]}{
  const f=piece.side==='sente'?-1:1;
  const k=piece.kind;
  if(k==='king')return{step:[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]],slide:[]};
  if(k==='gold'||['promotedSilver','promotedKnight','promotedLance','tokin'].includes(k)){
    return{step:goldDirs.map(([dy,dx])=>[dy!*(piece.side==='sente'?1:-1),dx!]),slide:[]};
  }
  if(k==='silver')return{step:[[f,-1],[f,0],[f,1],[-f,-1],[-f,1]],slide:[]};
  if(k==='knight')return{step:[[2*f,-1],[2*f,1]],slide:[]};
  if(k==='lance')return{step:[],slide:[[f,0]]};
  if(k==='pawn')return{step:[[f,0]],slide:[]};
  if(k==='rook')return{step:[],slide:[[-1,0],[1,0],[0,-1],[0,1]]};
  if(k==='bishop')return{step:[],slide:[[-1,-1],[-1,1],[1,-1],[1,1]]};
  if(k==='dragon')return{step:[[-1,-1],[-1,1],[1,-1],[1,1]],slide:[[-1,0],[1,0],[0,-1],[0,1]]};
  return{step:[[-1,0],[1,0],[0,-1],[0,1]],slide:[[-1,-1],[-1,1],[1,-1],[1,1]]};
}

function pseudoTargets(pos:Position,y:number,x:number):[number,number][]{
  const piece=pos.board[y]?.[x];
  if(!piece)return[];
  const out:[number,number][]=[];
  const d=dirs(piece);
  for(const [dy,dx] of d.step){
    const ny=y+dy!,nx=x+dx!;
    if(inside(ny,nx)&&pos.board[ny]![nx]?.side!==piece.side)out.push([ny,nx]);
  }
  for(const [dy,dx] of d.slide){
    let ny=y+dy!,nx=x+dx!;
    while(inside(ny,nx)){
      const q=pos.board[ny]![nx];
      if(!q)out.push([ny,nx]);
      else{
        if(q.side!==piece.side)out.push([ny,nx]);
        break;
      }
      ny+=dy!;
      nx+=dx!;
    }
  }
  return out;
}

export function isCheck(pos:Position,side:Side):boolean{
  let king:[number,number]|null=null;
  for(let y=0;y<9;y++)for(let x=0;x<9;x++){
    const q=pos.board[y]![x];
    if(q?.side===side&&q.kind==='king')king=[y,x];
  }
  // 正常な対局状態では玉は必ず存在する。欠損状態を合法扱いしない。
  if(!king)return true;
  for(let y=0;y<9;y++)for(let x=0;x<9;x++){
    const q=pos.board[y]![x];
    if(q?.side===enemy(side)&&pseudoTargets(pos,y,x).some(([a,b])=>a===king![0]&&b===king![1]))return true;
  }
  return false;
}

function mustPromote(kind:PieceKind,side:Side,y:number):boolean{
  return ((kind==='pawn'||kind==='lance')&&(side==='sente'?y===0:y===8))
    ||(kind==='knight'&&(side==='sente'?y<=1:y>=7));
}

function rawApply(pos:Position,m:Move):Position{
  const mover=pos.turn;
  const next:Position={
    board:pos.board.map(r=>r.map(q=>q?{...q}:null)),
    hands:{sente:{...pos.hands.sente},gote:{...pos.hands.gote}},
    turn:enemy(pos.turn),
    ply:pos.ply+1,
    history:[...pos.history],
  };
  if(m.drop){
    next.board[m.to[0]]![m.to[1]]={side:mover,kind:m.drop};
    next.hands[mover][m.drop]--;
  }else if(m.from){
    const [fy,fx]=m.from;
    let piece=next.board[fy]![fx]!;
    const captured=next.board[m.to[0]]![m.to[1]];
    if(captured)next.hands[mover][unpromoteMap[captured.kind]]++;
    next.board[fy]![fx]=null;
    if(m.promote&&promoteMap[unpromoteMap[piece.kind]]){
      piece={...piece,kind:promoteMap[unpromoteMap[piece.kind]]!};
    }
    next.board[m.to[0]]![m.to[1]]=piece;
  }
  next.history.push({key:positionKey(next),mover,gaveCheck:isCheck(next,next.turn)});
  return next;
}

function legalDropBase(pos:Position,kind:PieceKind,y:number,x:number):boolean{
  if(pos.board[y]![x]||pos.hands[pos.turn][kind]<=0)return false;
  if((kind==='pawn'||kind==='lance')&&(pos.turn==='sente'?y===0:y===8))return false;
  if(kind==='knight'&&(pos.turn==='sente'?y<=1:y>=7))return false;
  if(kind==='pawn'){
    for(let yy=0;yy<9;yy++){
      const q=pos.board[yy]![x];
      if(q?.side===pos.turn&&q.kind==='pawn')return false;
    }
  }
  return true;
}

function legalMovesInternal(pos:Position,checkPawnDropMate:boolean):Move[]{
  const out:Move[]=[];
  for(let y=0;y<9;y++)for(let x=0;x<9;x++){
    const piece=pos.board[y]![x];
    if(piece?.side!==pos.turn)continue;
    for(const to of pseudoTargets(pos,y,x)){
      // 将棋は玉を実際に取って終わらない。玉を取る着手は生成しない。
      if(pos.board[to[0]]![to[1]]?.kind==='king')continue;
      const base=unpromoteMap[piece.kind];
      const canPromote=!!promoteMap[base]&&piece.kind===base&&(zone(piece.side,y)||zone(piece.side,to[0]));
      const forced=mustPromote(base,piece.side,to[0]);
      const variants:Move[]=forced
        ?[{from:[y,x],to,promote:true}]
        :canPromote
          ?[{from:[y,x],to},{from:[y,x],to,promote:true}]
          :[{from:[y,x],to}];
      for(const move of variants){
        if(!isCheck(rawApply(pos,move),piece.side))out.push(move);
      }
    }
  }

  for(const kind of baseKinds.filter(k=>k!=='king')){
    if(pos.hands[pos.turn][kind]<=0)continue;
    for(let y=0;y<9;y++)for(let x=0;x<9;x++){
      if(!legalDropBase(pos,kind,y,x))continue;
      const move:Move={drop:kind,to:[y,x]};
      const next=rawApply(pos,move);
      if(isCheck(next,pos.turn))continue;
      if(checkPawnDropMate&&kind==='pawn'&&isCheck(next,next.turn)&&legalMovesInternal(next,false).length===0)continue;
      out.push(move);
    }
  }
  return out;
}

export function legalMoves(pos:Position):Move[]{
  return legalMovesInternal(pos,true);
}

function moveEquals(a:Move,b:Move):boolean{
  return a.to[0]===b.to[0]
    &&a.to[1]===b.to[1]
    &&a.from?.[0]===b.from?.[0]
    &&a.from?.[1]===b.from?.[1]
    &&a.drop===b.drop
    &&!!a.promote===!!b.promote;
}

export function applyMove(pos:Position,m:Move):Position{
  const legal=legalMoves(pos).find(candidate=>moveEquals(candidate,m));
  if(!legal)throw new Error('ILLEGAL_MOVE');
  return rawApply(pos,legal);
}

export function isMate(pos:Position):boolean{
  return isCheck(pos,pos.turn)&&legalMoves(pos).length===0;
}

export function repetitionCount(pos:Position):number{
  const key=positionKey(pos);
  return pos.history.filter(entry=>entry.key===key).length;
}

export function repetitionStatus(pos:Position):RepetitionStatus{
  const key=positionKey(pos);
  const occurrences:number[]=[];
  pos.history.forEach((entry,index)=>{if(entry.key===key)occurrences.push(index);});
  if(occurrences.length<4)return{kind:'none'};

  const lastFour=occurrences.slice(-4);
  const start=lastFour[0]!;
  const end=lastFour[3]!;
  for(const side of ['sente','gote'] as const){
    const moves=pos.history.slice(start+1,end+1).filter(entry=>entry.mover===side);
    if(moves.length>0&&moves.every(entry=>entry.gaveCheck))return{kind:'perpetual-check',loser:side};
  }
  return{kind:'normal'};
}

export function gameOutcome(pos:Position):GameOutcome{
  if(isMate(pos))return{ended:true,reason:'mate',winner:enemy(pos.turn),loser:pos.turn};
  const repetition=repetitionStatus(pos);
  if(repetition.kind==='normal')return{ended:true,reason:'repetition',draw:true};
  if(repetition.kind==='perpetual-check')return{
    ended:true,
    reason:'perpetual-check',
    winner:enemy(repetition.loser),
    loser:repetition.loser,
  };
  return{ended:false};
}
