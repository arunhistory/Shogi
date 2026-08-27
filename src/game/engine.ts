import type { Board, BoardKind, Handicap, Hands, Move, Piece, PieceKind, Position, Side } from './types';

const baseKinds: PieceKind[]=['king','rook','bishop','gold','silver','knight','lance','pawn'];
const promoteMap: Partial<Record<PieceKind,BoardKind>>={rook:'dragon',bishop:'horse',silver:'promotedSilver',knight:'promotedKnight',lance:'promotedLance',pawn:'tokin'};
const unpromoteMap: Record<BoardKind,PieceKind>={king:'king',rook:'rook',bishop:'bishop',gold:'gold',silver:'silver',knight:'knight',lance:'lance',pawn:'pawn',dragon:'rook',horse:'bishop',promotedSilver:'silver',promotedKnight:'knight',promotedLance:'lance',tokin:'pawn'};
export const emptyHands=():Hands=>({sente:Object.fromEntries(baseKinds.map(k=>[k,0])) as Record<PieceKind,number>,gote:Object.fromEntries(baseKinds.map(k=>[k,0])) as Record<PieceKind,number>});
const p=(side:Side,kind:BoardKind):Piece=>({side,kind});
export function initialPosition(handicap:Handicap='even'):Position{
 const b:Board=Array.from({length:9},()=>Array(9).fill(null));
 const back:PieceKind[]=['lance','knight','silver','gold','king','gold','silver','knight','lance'];
 for(let x=0;x<9;x++){b[0]![x]=p('gote',back[8-x]!);b[8]![x]=p('sente',back[x]!);b[2]![x]=p('gote','pawn');b[6]![x]=p('sente','pawn');}
 b[1]![1]=p('gote','rook'); b[1]![7]=p('gote','bishop'); b[7]![1]=p('sente','bishop'); b[7]![7]=p('sente','rook');
 const remove=(kind:PieceKind)=>{for(let y=0;y<9;y++)for(let x=0;x<9;x++)if(b[y]![x]?.side==='gote'&&b[y]![x]?.kind===kind){b[y]![x]=null;return;}};
 if(handicap==='rook') remove('rook'); if(handicap==='bishop') remove('bishop');
 if(handicap==='two'){remove('rook');remove('bishop');}
 if(handicap==='four'){remove('rook');remove('bishop');remove('lance');remove('lance');}
 if(handicap==='six'){remove('rook');remove('bishop');remove('lance');remove('lance');remove('knight');remove('knight');}
 return {board:b,hands:emptyHands(),turn:handicap==='even'?'sente':'gote',ply:0,history:[]};
}
const inside=(y:number,x:number)=>y>=0&&y<9&&x>=0&&x<9;
const goldDirs=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,0]];
function dirs(piece:Piece):{step:number[][];slide:number[][]}{const f=piece.side==='sente'?-1:1; const k=piece.kind;
 if(k==='king')return{step:[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]],slide:[]};
 if(k==='gold'||['promotedSilver','promotedKnight','promotedLance','tokin'].includes(k))return{step:goldDirs.map(([dy,dx])=>[dy!*(piece.side==='sente'?1:-1),dx!]),slide:[]};
 if(k==='silver')return{step:[[f,-1],[f,0],[f,1],[-f,-1],[-f,1]],slide:[]};
 if(k==='knight')return{step:[[2*f,-1],[2*f,1]],slide:[]};
 if(k==='lance')return{step:[],slide:[[f,0]]};
 if(k==='pawn')return{step:[[f,0]],slide:[]};
 if(k==='rook')return{step:[],slide:[[-1,0],[1,0],[0,-1],[0,1]]};
 if(k==='bishop')return{step:[],slide:[[-1,-1],[-1,1],[1,-1],[1,1]]};
 if(k==='dragon')return{step:[[-1,-1],[-1,1],[1,-1],[1,1]],slide:[[-1,0],[1,0],[0,-1],[0,1]]};
 return{step:[[-1,0],[1,0],[0,-1],[0,1]],slide:[[-1,-1],[-1,1],[1,-1],[1,1]]};
}
function pseudoTargets(pos:Position,y:number,x:number):[number,number][]{const piece=pos.board[y]?.[x];if(!piece)return[];const out:[number,number][]=[];const d=dirs(piece);
 for(const [dy,dx] of d.step){const ny=y+dy!,nx=x+dx!;if(inside(ny,nx)&&pos.board[ny]![nx]?.side!==piece.side)out.push([ny,nx]);}
 for(const [dy,dx] of d.slide){let ny=y+dy!,nx=x+dx!;while(inside(ny,nx)){const q=pos.board[ny]![nx];if(!q)out.push([ny,nx]);else{if(q.side!==piece.side)out.push([ny,nx]);break;}ny+=dy!;nx+=dx!;}}
 return out;}
const enemy=(s:Side):Side=>s==='sente'?'gote':'sente';
export function isCheck(pos:Position,side:Side):boolean{let king:[number,number]|null=null;for(let y=0;y<9;y++)for(let x=0;x<9;x++){const q=pos.board[y]![x];if(q?.side===side&&q.kind==='king')king=[y,x];}if(!king)return true;for(let y=0;y<9;y++)for(let x=0;x<9;x++){const q=pos.board[y]![x];if(q?.side===enemy(side)&&pseudoTargets(pos,y,x).some(([a,b])=>a===king![0]&&b===king![1]))return true;}return false;}
const zone=(side:Side,y:number)=>side==='sente'?y<=2:y>=6;
function mustPromote(kind:PieceKind,side:Side,y:number){return (kind==='pawn'||kind==='lance')&&(side==='sente'?y===0:y===8)||kind==='knight'&&(side==='sente'?y<=1:y>=7);}
function rawApply(pos:Position,m:Move):Position{const n:Position={board:pos.board.map(r=>r.map(q=>q?{...q}:null)),hands:{sente:{...pos.hands.sente},gote:{...pos.hands.gote}},turn:enemy(pos.turn),ply:pos.ply+1,history:[...pos.history]};
 if(m.drop){n.board[m.to[0]]![m.to[1]]={side:pos.turn,kind:m.drop};n.hands[pos.turn][m.drop]--;}
 else if(m.from){const [fy,fx]=m.from;let q=n.board[fy]![fx]!;const captured=n.board[m.to[0]]![m.to[1]];if(captured)n.hands[pos.turn][unpromoteMap[captured.kind]]++;n.board[fy]![fx]=null;if(m.promote&&promoteMap[unpromoteMap[q.kind]])q={...q,kind:promoteMap[unpromoteMap[q.kind]]!};n.board[m.to[0]]![m.to[1]]=q;}
 n.history.push(positionKey(n));return n;}
function legalDropBase(pos:Position,kind:PieceKind,y:number,x:number):boolean{if(pos.board[y]![x]||pos.hands[pos.turn][kind]<=0)return false;if((kind==='pawn'||kind==='lance')&&(pos.turn==='sente'?y===0:y===8))return false;if(kind==='knight'&&(pos.turn==='sente'?y<=1:y>=7))return false;if(kind==='pawn'){for(let yy=0;yy<9;yy++){const q=pos.board[yy]![x];if(q?.side===pos.turn&&q.kind==='pawn')return false;}}return true;}
export function legalMoves(pos:Position):Move[]{const out:Move[]=[];for(let y=0;y<9;y++)for(let x=0;x<9;x++){const q=pos.board[y]![x];if(q?.side!==pos.turn)continue;for(const to of pseudoTargets(pos,y,x)){const base=unpromoteMap[q.kind];const can=!!promoteMap[base]&&q.kind===base&&(zone(q.side,y)||zone(q.side,to[0]));const forced=mustPromote(base,q.side,to[0]);const variants:Move[]=forced?[{from:[y,x],to,promote:true}]:can?[{from:[y,x],to},{from:[y,x],to,promote:true}]:[{from:[y,x],to}];for(const m of variants)if(!isCheck(rawApply(pos,m),q.side))out.push(m);}}
 for(const kind of baseKinds.filter(k=>k!=='king'))if(pos.hands[pos.turn][kind]>0)for(let y=0;y<9;y++)for(let x=0;x<9;x++)if(legalDropBase(pos,kind,y,x)){const m:Move={drop:kind,to:[y,x]};const n=rawApply(pos,m);if(isCheck(n,pos.turn))continue;if(kind==='pawn'&&isCheck(n,n.turn)&&legalMovesWithoutPawnDropMate(n).length===0)continue;out.push(m);}return out;}
function legalMovesWithoutPawnDropMate(pos:Position):Move[]{return legalMovesGuard(pos,false);}
function legalMovesGuard(pos:Position,checkPawnMate:boolean):Move[]{const out:Move[]=[];for(let y=0;y<9;y++)for(let x=0;x<9;x++){const q=pos.board[y]![x];if(q?.side!==pos.turn)continue;for(const to of pseudoTargets(pos,y,x)){const base=unpromoteMap[q.kind];const can=!!promoteMap[base]&&q.kind===base&&(zone(q.side,y)||zone(q.side,to[0]));for(const m of (mustPromote(base,q.side,to[0])?[{from:[y,x] as [number,number],to,promote:true}]:can?[{from:[y,x] as [number,number],to},{from:[y,x] as [number,number],to,promote:true}]:[{from:[y,x] as [number,number],to}]))if(!isCheck(rawApply(pos,m),q.side))out.push(m);}}
 for(const kind of baseKinds.filter(k=>k!=='king'))if(pos.hands[pos.turn][kind]>0)for(let y=0;y<9;y++)for(let x=0;x<9;x++)if(legalDropBase(pos,kind,y,x)){const m:Move={drop:kind,to:[y,x]},n=rawApply(pos,m);if(!isCheck(n,pos.turn)&&(!checkPawnMate||kind!=='pawn'||!isCheck(n,n.turn)||legalMovesGuard(n,false).length>0))out.push(m);}return out;}
export function applyMove(pos:Position,m:Move):Position{const ok=legalMoves(pos).some(x=>JSON.stringify(x)===JSON.stringify(m));if(!ok)throw new Error('ILLEGAL_MOVE');return rawApply(pos,m);}
export function isMate(pos:Position){return isCheck(pos,pos.turn)&&legalMoves(pos).length===0;}
export function positionKey(pos:Position){return JSON.stringify([pos.turn,pos.board,pos.hands]);}
export function repetitionCount(pos:Position){const key=positionKey(pos);return pos.history.filter(k=>k===key).length;}
