import {readFile,writeFile} from 'node:fs/promises';

const input=process.argv[2]??'cpp/title_supercomputer.cpp';
const output=process.argv[3]??'/tmp/title_supercomputer_fast.cpp';
let source=await readFile(input,'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

const globals=`int32_t g_super_nodes = 0;\n`;
assert(source.includes(globals),'FASTPATH_GLOBAL_ANCHOR_MISSING');
const fastLegal=`
// SuperTitle hot path: preserve the exact legal-move rules while avoiding the
// generic O(81 attackers) check scan for every candidate.  A king can only be
// checked by local step sources or the first occupied square on each ray, so
// check detection starts at the king and walks outward numerically.
inline bool super_code_is(const Position&pos,int y,int x,int side,int kind){
  return inside(y,x)&&pos.board[square_of(y,x)]==side*kind;
}
inline bool super_gold_like(const Position&pos,int y,int x,int side){
  if(!inside(y,x))return false;const int c=pos.board[square_of(y,x)];if(sign_of(c)!=side)return false;const int k=kind_of(c);return k==5||k==9||k==10||k==11||k==12;
}
bool super_is_check(const Position&pos,int side){
  const int king=king_square_for_side(pos,side);if(king<0)return true;
  const int attacker=-side,ky=row_of(king),kx=col_of(king),f=attacker==1?-1:1;
  if(super_code_is(pos,ky-f,kx,attacker,1))return true;
  if(super_code_is(pos,ky-2*f,kx-1,attacker,3)||super_code_is(pos,ky-2*f,kx+1,attacker,3))return true;
  for(int dx=-1;dx<=1;++dx)if(super_code_is(pos,ky-f,kx-dx,attacker,4))return true;
  if(super_code_is(pos,ky+f,kx-1,attacker,4)||super_code_is(pos,ky+f,kx+1,attacker,4))return true;
  for(int dx=-1;dx<=1;++dx)if(super_gold_like(pos,ky-f,kx-dx,attacker))return true;
  if(super_gold_like(pos,ky,kx-1,attacker)||super_gold_like(pos,ky,kx+1,attacker)||super_gold_like(pos,ky+f,kx,attacker))return true;
  for(int dy=-1;dy<=1;++dy)for(int dx=-1;dx<=1;++dx)if((dy||dx)&&super_code_is(pos,ky+dy,kx+dx,attacker,8))return true;
  for(int dy:{-1,1})for(int dx:{-1,1})if(super_code_is(pos,ky+dy,kx+dx,attacker,14))return true;
  if(super_code_is(pos,ky-1,kx,attacker,13)||super_code_is(pos,ky+1,kx,attacker,13)||super_code_is(pos,ky,kx-1,attacker,13)||super_code_is(pos,ky,kx+1,attacker,13))return true;
  const int orth[4][2]={{-1,0},{1,0},{0,-1},{0,1}};
  for(const auto&d:orth){int y=ky+d[0],x=kx+d[1];while(inside(y,x)){const int c=pos.board[square_of(y,x)];if(c){if(sign_of(c)==attacker){const int k=kind_of(c);if(k==7||k==14)return true;if(d[1]==0&&d[0]==-f&&k==2)return true;}break;}y+=d[0];x+=d[1];}}
  const int diag[4][2]={{-1,-1},{-1,1},{1,-1},{1,1}};
  for(const auto&d:diag){int y=ky+d[0],x=kx+d[1];while(inside(y,x)){const int c=pos.board[square_of(y,x)];if(c){if(sign_of(c)==attacker){const int k=kind_of(c);if(k==6||k==13)return true;}break;}y+=d[0];x+=d[1];}}
  return false;
}

void super_generate_legal(const Position&pos,MoveList&out);
void super_generate_drops(const Position&pos,MoveList&out){
  const int side=pos.turn,handSide=side_index(side);bool pawnFile[9]={};
  if(pos.hands[handSide][0]>0)for(int sq=0;sq<81;++sq)if(pos.board[sq]==side)pawnFile[col_of(sq)]=true;
  for(int kind=1;kind<=7;++kind){
    if(pos.hands[handSide][kind-1]<=0)continue;
    for(int to=0;to<81;++to){
      if(pos.board[to]!=0)continue;const int y=row_of(to),x=col_of(to);
      if((kind==1||kind==2)&&(side==1?y==0:y==8))continue;
      if(kind==3&&(side==1?y<=1:y>=7))continue;
      if(kind==1&&pawnFile[x])continue;
      const Move move{-1,static_cast<int16_t>(to),static_cast<int8_t>(kind),0};Position next;apply_move(pos,move,next);
      if(super_is_check(next,side))continue;
      if(kind==1&&super_is_check(next,next.turn)){MoveList replies;super_generate_legal(next,replies);if(replies.count==0)continue;}
      out.add(move);
    }
  }
}
void super_generate_legal(const Position&pos,MoveList&out){
  out.count=0;out.overflow=false;MoveList pseudo;generate_board_pseudo(pos,pseudo);
  for(int i=0;i<pseudo.count;++i){Position next;apply_move(pos,pseudo.items[i],next);if(!super_is_check(next,pos.turn))out.add(pseudo.items[i]);}
  super_generate_drops(pos,out);
}
`;
source=source.replace(globals,globals+fastLegal);

assert(source.includes('int super_move_priority(const Position&pos,const Move&m,int specialist){'),'PRIORITY_ANCHOR_MISSING');
source=source.replace('int super_move_priority(const Position&pos,const Move&m,int specialist){','int super_move_priority(const Position&pos,const Move&m,int specialist,int enemyKing){');
source=source.replace('  const int enemyKing=king_square_for_side(pos,-pos.turn);\n','');
const orderOld=`  int scores[kMaxMoves];for(int i=0;i<moves.count;++i)scores[i]=super_move_priority(pos,moves.items[i],specialist);\n  for(int i=1;i<moves.count;++i){Move move=moves.items[i];int score=scores[i],j=i;while(j>0&&score>scores[j-1]){moves.items[j]=moves.items[j-1];scores[j]=scores[j-1];--j;}moves.items[j]=move;scores[j]=score;}\n`;
assert(source.includes(orderOld),'ORDER_ANCHOR_MISSING');
const orderNew=`  const int enemyKing=king_square_for_side(pos,-pos.turn);\n  int scores[kMaxMoves];for(int i=0;i<moves.count;++i)scores[i]=super_move_priority(pos,moves.items[i],specialist,enemyKing);\n  for(int gap=moves.count/2;gap>0;gap/=2)for(int i=gap;i<moves.count;++i){Move move=moves.items[i];int score=scores[i],j=i;while(j>=gap&&score>scores[j-gap]){moves.items[j]=moves.items[j-gap];scores[j]=scores[j-gap];j-=gap;}moves.items[j]=move;scores[j]=score;}\n`;
source=source.replace(orderOld,orderNew);

const replacements=[
  ['MoveList moves;generate_legal(pos,moves);super_order_moves(pos,moves,specialist);','MoveList moves;super_generate_legal(pos,moves);super_order_moves(pos,moves,specialist);'],
  ['MoveList moves;generate_legal(pos,moves);if(moves.count==0)return is_check(pos,pos.turn)?-kMateScore+ply:0;super_order_moves(pos,moves,specialist);','MoveList moves;super_generate_legal(pos,moves);if(moves.count==0)return super_is_check(pos,pos.turn)?-kMateScore+ply:0;super_order_moves(pos,moves,specialist);'],
  ['MoveList all;generate_legal(root,all);if(all.count==0)return-1;','MoveList all;super_generate_legal(root,all);if(all.count==0)return-1;'],
  ['Position next;apply_move(pos,m,next);const bool checking=is_check(next,next.turn);','Position next;apply_move(pos,m,next);const bool checking=super_is_check(next,next.turn);']
];
for(const [before,after] of replacements){assert(source.includes(before),`REPLACEMENT_ANCHOR_MISSING:${before.slice(0,32)}`);source=source.replace(before,after);}

await writeFile(output,source);
console.log(JSON.stringify({ok:true,input,output,bytes:source.length}));
