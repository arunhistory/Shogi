import {readFile,writeFile} from 'node:fs/promises';

const input=process.argv[2]??'/tmp/title_supercomputer_fast.cpp';
const output=process.argv[3]??'/tmp/title_supercomputer_metrics.cpp';
let source=await readFile(input,'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

// Exact same check rules as super_is_check, but the caller supplies the king
// square it already knows. This removes repeated 81-square king scans from the
// legal-move hot path without changing legality.
const legalDecl='void super_generate_legal(const Position&pos,MoveList&out);\n';
assert(source.includes(legalDecl),'METRICS_LEGAL_DECL_MISSING');
const checkAt=`bool super_is_check_at(const Position&pos,int side,int king){
  if(king<0)return true;
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
`;
source=source.replace(legalDecl,checkAt+'\n'+legalDecl);

const dropHead='  const int side=pos.turn,handSide=side_index(side);bool pawnFile[9]={};\n';
assert(source.includes(dropHead),'METRICS_DROP_HEAD_MISSING');
source=source.replace(dropHead,'  const int side=pos.turn,handSide=side_index(side),ownKing=king_square_for_side(pos,side),enemyKing=king_square_for_side(pos,-side);bool pawnFile[9]={};\n');
assert(source.includes('      if(super_is_check(next,side))continue;\n'),'METRICS_DROP_CHECK_MISSING');
source=source.replace('      if(super_is_check(next,side))continue;\n','      if(super_is_check_at(next,side,ownKing))continue;\n');
assert(source.includes('      if(kind==1&&super_is_check(next,next.turn)){MoveList replies;super_generate_legal(next,replies);if(replies.count==0)continue;}\n'),'METRICS_UCHIFU_CHECK_MISSING');
source=source.replace('      if(kind==1&&super_is_check(next,next.turn)){MoveList replies;super_generate_legal(next,replies);if(replies.count==0)continue;}\n','      if(kind==1&&super_is_check_at(next,next.turn,enemyKing)){MoveList replies;super_generate_legal(next,replies);if(replies.count==0)continue;}\n');

const legalHead='  out.count=0;out.overflow=false;MoveList pseudo;generate_board_pseudo(pos,pseudo);\n  for(int i=0;i<pseudo.count;++i){Position next;apply_move(pos,pseudo.items[i],next);if(!super_is_check(next,pos.turn))out.add(pseudo.items[i]);}\n';
assert(source.includes(legalHead),'METRICS_LEGAL_HEAD_MISSING');
source=source.replace(legalHead,'  out.count=0;out.overflow=false;const int ownKing=king_square_for_side(pos,pos.turn);MoveList pseudo;generate_board_pseudo(pos,pseudo);\n  for(int i=0;i<pseudo.count;++i){Position next;apply_move(pos,pseudo.items[i],next);const int king=pseudo.items[i].from==ownKing?pseudo.items[i].to:ownKing;if(!super_is_check_at(next,pos.turn,king))out.add(pseudo.items[i]);}\n');

// Preserve every specialist formula and coefficient, but compute only the side
// of the attack map each formula actually reads. King locations, capture scores
// and activity scores are memoized inside one evaluation instead of rescanning
// the same 81 numeric squares repeatedly.
const evalStart=source.indexOf('int super_specialist_eval(const Position&pos,int perspective,int specialist){');
const evalEnd=source.indexOf('\nint super_move_priority(',evalStart);
assert(evalStart>=0&&evalEnd>evalStart,'METRICS_EVAL_BLOCK_MISSING');
const optimizedEval=`int super_specialist_eval(const Position&pos,int perspective,int specialist){
  const int enemy=-perspective,base=super_base_eval(pos,perspective);
  uint8_t ownMap[81],enemyMap[81];bool ownReady=false,enemyReady=false,kingsReady=false;
  int ownKing=-1,enemyKing=-1,ownCapCache=-1,enemyCapCache=-1,ownActivityCache=-1,enemyActivityCache=-1;
  auto needOwn=[&](){if(!ownReady){super_attack_map(pos,perspective,ownMap);ownReady=true;}};
  auto needEnemy=[&](){if(!enemyReady){super_attack_map(pos,enemy,enemyMap);enemyReady=true;}};
  auto needKings=[&](){if(kingsReady)return;for(int sq=0;sq<81;++sq){const int c=pos.board[sq];if(c==perspective*8)ownKing=sq;else if(c==enemy*8)enemyKing=sq;if(ownKing>=0&&enemyKing>=0)break;}kingsReady=true;};
  auto ownCap=[&](){needOwn();if(ownCapCache<0)ownCapCache=super_capture_potential(pos,perspective,ownMap);return ownCapCache;};
  auto enemyCap=[&](){needEnemy();if(enemyCapCache<0)enemyCapCache=super_capture_potential(pos,enemy,enemyMap);return enemyCapCache;};
  auto ownActivity=[&](){needOwn();if(ownActivityCache<0)ownActivityCache=super_map_activity(ownMap);return ownActivityCache;};
  auto enemyActivity=[&](){needEnemy();if(enemyActivityCache<0)enemyActivityCache=super_map_activity(enemyMap);return enemyActivityCache;};
  auto escape=[&](int side,const uint8_t*map,int king){if(king<0)return 0;int n=0;const int y=row_of(king),x=col_of(king);for(int dy=-1;dy<=1;++dy)for(int dx=-1;dx<=1;++dx){if(!dy&&!dx)continue;const int yy=y+dy,xx=x+dx;if(!inside(yy,xx))continue;const int sq=square_of(yy,xx);if(sign_of(pos.board[sq])==side||map[sq])continue;++n;}return n;};
  auto safety=[&](int side,const uint8_t*map,int king){if(king<0)return-kMateScore/2;int shield=0,danger=map[king]?10:0;const int y=row_of(king),x=col_of(king);for(int dy=-1;dy<=1;++dy)for(int dx=-1;dx<=1;++dx){if(!dy&&!dx)continue;const int yy=y+dy,xx=x+dx;if(!inside(yy,xx))continue;const int sq=square_of(yy,xx),code=pos.board[sq];danger+=map[sq];if(sign_of(code)==side){const int kind=kind_of(code);shield+=kind==5||kind>=9?3:kind==4?2:1;}}return shield*18-danger*22+escape(side,map,king)*12;};
  auto ring=[&](int defender,const uint8_t*map,int king,int capture){if(king<0)return kMateScore/2;int pressure=map[king]?500:0,escapes=0;const int y=row_of(king),x=col_of(king);for(int dy=-1;dy<=1;++dy)for(int dx=-1;dx<=1;++dx){if(!dy&&!dx)continue;const int yy=y+dy,xx=x+dx;if(!inside(yy,xx))continue;const int sq=square_of(yy,xx);pressure+=map[sq]*35;if(!map[sq]&&sign_of(pos.board[sq])!=defender)++escapes;}return pressure-escapes*45+capture/8;};
  auto forcing=[&](const uint8_t*map,int king,int capture){int score=king>=0?map[king]*120:10000;score+=capture/5;if(king>=0){const int y=row_of(king),x=col_of(king);for(int dy=-1;dy<=1;++dy)for(int dx=-1;dx<=1;++dx)if(dy||dx){const int yy=y+dy,xx=x+dx;if(inside(yy,xx))score+=map[square_of(yy,xx)]*12;}}return score;};
  switch(specialist){
    case 0:return base;
    case 1:needEnemy();needKings();return base+safety(perspective,enemyMap,ownKing)*9-ring(perspective,enemyMap,ownKing,enemyCap())*3;
    case 2:needOwn();needKings();return base+ring(enemy,ownMap,enemyKing,ownCap())*12-escape(enemy,ownMap,enemyKing)*450;
    case 3:needOwn();needKings();return base+ring(enemy,ownMap,enemyKing,ownCap())*8+forcing(ownMap,enemyKing,ownCap())*25+ownCap()/3;
    case 4:needEnemy();needKings();return base-ring(perspective,enemyMap,ownKing,enemyCap())*9-forcing(enemyMap,ownKing,enemyCap())*30-safety(perspective,enemyMap,ownKing)*2;
    case 5:needEnemy();needOwn();needKings();return base+safety(perspective,enemyMap,ownKing)*8-ring(perspective,enemyMap,ownKing,enemyCap())*7+ownActivity()*8;
    case 6:needEnemy();needOwn();needKings();return base-enemyActivity()*18+ownCap()/2-ring(perspective,enemyMap,ownKing,enemyCap())*4;
    case 7:needEnemy();needOwn();needKings();return base-ring(perspective,enemyMap,ownKing,enemyCap())*5-super_drop_potential(pos,enemy)*10+forcing(ownMap,enemyKing,ownCap())*25;
    case 8:needOwn();needKings();return base+super_drop_potential(pos,perspective)*20+forcing(ownMap,enemyKing,ownCap())*20+ring(enemy,ownMap,enemyKing,ownCap())*4;
    case 9:needEnemy();needKings();return base-super_drop_potential(pos,enemy)*24-ring(perspective,enemyMap,ownKing,enemyCap())*5-safety(perspective,enemyMap,ownKing)*3;
    case 10:return base+(super_drop_potential(pos,perspective)-super_drop_potential(pos,enemy))*20+super_hand_power(pos,perspective)/8-super_hand_power(pos,enemy)/8;
    case 11:needOwn();needEnemy();return base*2+ownCap()/2-enemyCap()/3;
    case 12:needOwn();needEnemy();needKings();return base+(ownActivity()-enemyActivity())*30+ring(enemy,ownMap,enemyKing,ownCap())*3-ring(perspective,enemyMap,ownKing,enemyCap())*3;
    case 13:needOwn();needEnemy();needKings();return base+(ownActivity()-enemyActivity())*42+safety(perspective,enemyMap,ownKing)*2;
    case 14:return base+(super_promotion_potential(pos,perspective)-super_promotion_potential(pos,enemy))*300;
    case 15:needOwn();needEnemy();needKings();return base+(forcing(ownMap,enemyKing,ownCap())-forcing(enemyMap,ownKing,enemyCap()))*80;
    case 16:needOwn();needEnemy();needKings();return base+(escape(perspective,enemyMap,ownKing)-escape(enemy,ownMap,enemyKing))*240+safety(perspective,enemyMap,ownKing)*3;
    case 17:needEnemy();needKings();return base+safety(perspective,enemyMap,ownKing)*5-ring(perspective,enemyMap,ownKing,enemyCap())*5-enemyCap()/2;
    case 18:needEnemy();needKings();return base+safety(perspective,enemyMap,ownKing)*7-ring(perspective,enemyMap,ownKing,enemyCap())*8-super_drop_potential(pos,enemy)*14;
    case 19:needOwn();needEnemy();needKings();return base+(ownActivity()-enemyActivity())*25+(super_drop_potential(pos,perspective)-super_drop_potential(pos,enemy))*12+safety(perspective,enemyMap,ownKing)*3-safety(enemy,ownMap,enemyKing)*3;
    case 20:needOwn();needEnemy();needKings();return base+static_cast<int>((hash_position(pos)>>17)&1023)-512+(forcing(ownMap,enemyKing,ownCap())-forcing(enemyMap,ownKing,enemyCap()))*15;
    default:return base;
  }
}
`;
source=source.slice(0,evalStart)+optimizedEval+source.slice(evalEnd+1);

const qLoop='  MoveList moves;super_generate_legal(pos,moves);super_order_moves(pos,moves,specialist);\n  for(int i=0;i<moves.count&&g_super_nodes<g_node_limit;++i){\n';
assert(source.includes(qLoop),'METRICS_QLOOP_MISSING');
source=source.replace(qLoop,'  MoveList moves;super_generate_legal(pos,moves);super_order_moves(pos,moves,specialist);const int targetKing=king_square_for_side(pos,-pos.turn);\n  for(int i=0;i<moves.count&&g_super_nodes<g_node_limit;++i){\n');
assert(source.includes('Position next;apply_move(pos,m,next);const bool checking=super_is_check(next,next.turn);'),'METRICS_QCHECK_MISSING');
source=source.replace('Position next;apply_move(pos,m,next);const bool checking=super_is_check(next,next.turn);','Position next;apply_move(pos,m,next);const bool checking=super_is_check_at(next,next.turn,targetKing);');

await writeFile(output,source);
console.log(JSON.stringify({ok:true,input,output,bytes:source.length}));