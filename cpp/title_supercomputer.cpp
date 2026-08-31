#include "engine_future.cpp"

namespace {
int32_t g_super_best_score = 0;
int32_t g_super_best_move = -1;
int32_t g_super_nodes = 0;

int super_base_eval(const Position& pos,int perspective){
  int score=0;
  for(int i=0;i<81;++i){
    const int code=pos.board[i];if(!code)continue;
    const int side=sign_of(code),kind=kind_of(code);
    int value=piece_value(kind)+advancement_bonus(kind,side,row_of(i));
    if(kind!=8)value+=(4-abs_i(col_of(i)-4))*2;
    score+=side==perspective?value:-value;
  }
  for(int side:{1,-1}){
    const int sign=side==perspective?1:-1;
    for(int kind=1;kind<=7;++kind)score+=sign*pos.hands[side_index(side)][kind-1]*piece_value(kind);
  }
  return score;
}

inline void super_mark(uint8_t*map,int y,int x){if(inside(y,x)&&map[square_of(y,x)]<255)++map[square_of(y,x)];}
void super_slide_map(const Position&pos,uint8_t*map,int y,int x,int dy,int dx){
  y+=dy;x+=dx;
  while(inside(y,x)){
    const int sq=square_of(y,x);if(map[sq]<255)++map[sq];
    if(pos.board[sq]!=0)break;
    y+=dy;x+=dx;
  }
}

void super_attack_map(const Position&pos,int side,uint8_t*map){
  std::memset(map,0,81);
  for(int sq=0;sq<81;++sq){
    const int code=pos.board[sq];if(sign_of(code)!=side)continue;
    const int kind=kind_of(code),y=row_of(sq),x=col_of(sq),f=side==1?-1:1;
    if(kind==8){for(int dy=-1;dy<=1;++dy)for(int dx=-1;dx<=1;++dx)if(dy||dx)super_mark(map,y+dy,x+dx);continue;}
    if(kind==5||kind==9||kind==10||kind==11||kind==12){super_mark(map,y+f,x-1);super_mark(map,y+f,x);super_mark(map,y+f,x+1);super_mark(map,y,x-1);super_mark(map,y,x+1);super_mark(map,y-f,x);continue;}
    if(kind==4){super_mark(map,y+f,x-1);super_mark(map,y+f,x);super_mark(map,y+f,x+1);super_mark(map,y-f,x-1);super_mark(map,y-f,x+1);continue;}
    if(kind==3){super_mark(map,y+2*f,x-1);super_mark(map,y+2*f,x+1);continue;}
    if(kind==1){super_mark(map,y+f,x);continue;}
    if(kind==2){super_slide_map(pos,map,y,x,f,0);continue;}
    if(kind==7||kind==14){super_slide_map(pos,map,y,x,-1,0);super_slide_map(pos,map,y,x,1,0);super_slide_map(pos,map,y,x,0,-1);super_slide_map(pos,map,y,x,0,1);if(kind==14){super_mark(map,y-1,x-1);super_mark(map,y-1,x+1);super_mark(map,y+1,x-1);super_mark(map,y+1,x+1);}continue;}
    if(kind==6||kind==13){super_slide_map(pos,map,y,x,-1,-1);super_slide_map(pos,map,y,x,-1,1);super_slide_map(pos,map,y,x,1,-1);super_slide_map(pos,map,y,x,1,1);if(kind==13){super_mark(map,y-1,x);super_mark(map,y+1,x);super_mark(map,y,x-1);super_mark(map,y,x+1);}}
  }
}

int super_hand_power(const Position&pos,int side){
  const int si=side_index(side);int score=0;
  for(int kind=1;kind<=7;++kind)score+=pos.hands[si][kind-1]*piece_value(kind);
  return score;
}

int super_drop_potential(const Position&pos,int side){
  bool pawnFile[9]={};
  for(int sq=0;sq<81;++sq)if(pos.board[sq]==side){pawnFile[col_of(sq)]=true;}
  const int si=side_index(side);int score=0;
  for(int kind=1;kind<=7;++kind){
    const int held=pos.hands[si][kind-1];if(!held)continue;
    int open=0;
    for(int sq=0;sq<81;++sq){
      if(pos.board[sq]!=0)continue;
      const int y=row_of(sq),x=col_of(sq);
      if((kind==1||kind==2)&&(side==1?y==0:y==8))continue;
      if(kind==3&&(side==1?y<=1:y>=7))continue;
      if(kind==1&&pawnFile[x])continue;
      ++open;
    }
    score+=held*(piece_value(kind)/20+4)+open*(kind>=6?3:1);
  }
  return score;
}

int super_promotion_potential(const Position&pos,int side){
  int score=0;
  for(int sq=0;sq<81;++sq){
    const int code=pos.board[sq];if(sign_of(code)!=side)continue;
    const int kind=kind_of(code),base=base_kind(kind);if(kind!=base||!promotable(kind))continue;
    const int y=row_of(sq);const int distance=side==1?y:(8-y);
    if(promotion_zone(side,y))score+=18;else if(distance<=3)score+=8;else if(distance<=4)score+=3;
  }
  return score;
}

int super_capture_potential(const Position&pos,int side,const uint8_t*attacks){
  int score=0;
  for(int sq=0;sq<81;++sq){const int code=pos.board[sq];if(sign_of(code)==-side&&attacks[sq])score+=piece_value(kind_of(code))*(attacks[sq]>1?3:2)/2;}
  return score;
}

int super_map_activity(const uint8_t*attacks){
  int score=0;for(int sq=0;sq<81;++sq)if(attacks[sq])score+=1+(attacks[sq]>1)+(attacks[sq]>3);return score;
}

int super_king_escape_count(const Position&pos,int side,const uint8_t*enemyAttacks){
  const int king=king_square_for_side(pos,side);if(king<0)return 0;
  int n=0;const int y=row_of(king),x=col_of(king);
  for(int dy=-1;dy<=1;++dy)for(int dx=-1;dx<=1;++dx){if(!dy&&!dx)continue;const int yy=y+dy,xx=x+dx;if(!inside(yy,xx))continue;const int sq=square_of(yy,xx);if(sign_of(pos.board[sq])==side||enemyAttacks[sq])continue;++n;}
  return n;
}

int super_king_safety(const Position&pos,int side,const uint8_t*enemyAttacks){
  const int king=king_square_for_side(pos,side);if(king<0)return-kMateScore/2;
  int shield=0,danger=enemyAttacks[king]?10:0;const int y=row_of(king),x=col_of(king);
  for(int dy=-1;dy<=1;++dy)for(int dx=-1;dx<=1;++dx){if(!dy&&!dx)continue;const int yy=y+dy,xx=x+dx;if(!inside(yy,xx))continue;const int sq=square_of(yy,xx),code=pos.board[sq];danger+=enemyAttacks[sq];if(sign_of(code)==side){const int kind=kind_of(code);shield+=kind==5||kind>=9?3:kind==4?2:1;}}
  return shield*18-danger*22+super_king_escape_count(pos,side,enemyAttacks)*12;
}

int super_ring_pressure(const Position&pos,int attacker,int defender,const uint8_t*attackMap){
  const int king=king_square_for_side(pos,defender);if(king<0)return kMateScore/2;
  int pressure=attackMap[king]?500:0,escapes=0;const int y=row_of(king),x=col_of(king);
  for(int dy=-1;dy<=1;++dy)for(int dx=-1;dx<=1;++dx){if(!dy&&!dx)continue;const int yy=y+dy,xx=x+dx;if(!inside(yy,xx))continue;const int sq=square_of(yy,xx);pressure+=attackMap[sq]*35;if(!attackMap[sq]&&sign_of(pos.board[sq])!=defender)++escapes;}
  return pressure-escapes*45+super_capture_potential(pos,attacker,attackMap)/8;
}

int super_forcing_potential(const Position&pos,int side,const uint8_t*attackMap){
  const int enemyKing=king_square_for_side(pos,-side);
  int score=enemyKing>=0?attackMap[enemyKing]*120:10000;
  score+=super_capture_potential(pos,side,attackMap)/5;
  if(enemyKing>=0){const int y=row_of(enemyKing),x=col_of(enemyKing);for(int dy=-1;dy<=1;++dy)for(int dx=-1;dx<=1;++dx)if(dy||dx){const int yy=y+dy,xx=x+dx;if(inside(yy,xx))score+=attackMap[square_of(yy,xx)]*12;}}
  return score;
}

int super_specialist_eval(const Position&pos,int perspective,int specialist){
  const int enemy=-perspective;
  const int base=super_base_eval(pos,perspective);
  uint8_t ownMap[81],enemyMap[81];bool mapsReady=false;
  auto maps=[&](){if(!mapsReady){super_attack_map(pos,perspective,ownMap);super_attack_map(pos,enemy,enemyMap);mapsReady=true;}};
  switch(specialist){
    case 0:return base;
    case 1:{maps();return base+super_king_safety(pos,perspective,enemyMap)*9-super_ring_pressure(pos,enemy,perspective,enemyMap)*3;}
    case 2:{maps();return base+super_ring_pressure(pos,perspective,enemy,ownMap)*12-super_king_escape_count(pos,enemy,ownMap)*450;}
    case 3:{maps();return base+super_ring_pressure(pos,perspective,enemy,ownMap)*8+super_forcing_potential(pos,perspective,ownMap)*25+super_capture_potential(pos,perspective,ownMap)/3;}
    case 4:{maps();return base-super_ring_pressure(pos,enemy,perspective,enemyMap)*9-super_forcing_potential(pos,enemy,enemyMap)*30-super_king_safety(pos,perspective,enemyMap)*2;}
    case 5:{maps();return base+super_king_safety(pos,perspective,enemyMap)*8-super_ring_pressure(pos,enemy,perspective,enemyMap)*7+super_map_activity(ownMap)*8;}
    case 6:{maps();return base-super_map_activity(enemyMap)*18+super_capture_potential(pos,perspective,ownMap)/2-super_ring_pressure(pos,enemy,perspective,enemyMap)*4;}
    case 7:{maps();return base-super_ring_pressure(pos,enemy,perspective,enemyMap)*5-super_drop_potential(pos,enemy)*10+super_forcing_potential(pos,perspective,ownMap)*25;}
    case 8:{maps();return base+super_drop_potential(pos,perspective)*20+super_forcing_potential(pos,perspective,ownMap)*20+super_ring_pressure(pos,perspective,enemy,ownMap)*4;}
    case 9:{maps();return base-super_drop_potential(pos,enemy)*24-super_ring_pressure(pos,enemy,perspective,enemyMap)*5-super_king_safety(pos,perspective,enemyMap)*3;}
    case 10:return base+(super_drop_potential(pos,perspective)-super_drop_potential(pos,enemy))*20+super_hand_power(pos,perspective)/8-super_hand_power(pos,enemy)/8;
    case 11:{maps();return base*2+super_capture_potential(pos,perspective,ownMap)/2-super_capture_potential(pos,enemy,enemyMap)/3;}
    case 12:{maps();return base+(super_map_activity(ownMap)-super_map_activity(enemyMap))*30+super_ring_pressure(pos,perspective,enemy,ownMap)*3-super_ring_pressure(pos,enemy,perspective,enemyMap)*3;}
    case 13:{maps();return base+(super_map_activity(ownMap)-super_map_activity(enemyMap))*42+super_king_safety(pos,perspective,enemyMap)*2;}
    case 14:return base+(super_promotion_potential(pos,perspective)-super_promotion_potential(pos,enemy))*300;
    case 15:{maps();return base+(super_forcing_potential(pos,perspective,ownMap)-super_forcing_potential(pos,enemy,enemyMap))*80;}
    case 16:{maps();return base+(super_king_escape_count(pos,perspective,enemyMap)-super_king_escape_count(pos,enemy,ownMap))*240+super_king_safety(pos,perspective,enemyMap)*3;}
    case 17:{maps();return base+super_king_safety(pos,perspective,enemyMap)*5-super_ring_pressure(pos,enemy,perspective,enemyMap)*5-super_capture_potential(pos,enemy,enemyMap)/2;}
    case 18:{maps();return base+super_king_safety(pos,perspective,enemyMap)*7-super_ring_pressure(pos,enemy,perspective,enemyMap)*8-super_drop_potential(pos,enemy)*14;}
    case 19:{maps();return base+(super_map_activity(ownMap)-super_map_activity(enemyMap))*25+(super_drop_potential(pos,perspective)-super_drop_potential(pos,enemy))*12+super_king_safety(pos,perspective,enemyMap)*3-super_king_safety(pos,enemy,ownMap)*3;}
    case 20:{maps();return base+static_cast<int>((hash_position(pos)>>17)&1023)-512+(super_forcing_potential(pos,perspective,ownMap)-super_forcing_potential(pos,enemy,enemyMap))*15;}
    default:return base;
  }
}

int super_move_priority(const Position&pos,const Move&m,int specialist){
  int score=0;
  if(m.from>=0&&pos.board[m.to])score+=30000+piece_value(kind_of(pos.board[m.to]))*24-piece_value(kind_of(pos.board[m.from]))*2;
  if(m.promote)score+=12000;
  if(m.drop)score+=piece_value(m.drop)+(specialist==8?9000:0);
  const int enemyKing=king_square_for_side(pos,-pos.turn);
  if(enemyKing>=0){const int d=abs_i(row_of(m.to)-row_of(enemyKing))+abs_i(col_of(m.to)-col_of(enemyKing));if(d<=2)score+=(specialist==2||specialist==3||specialist==15?7000:1800);}
  return score;
}

void super_order_moves(const Position&pos,MoveList&moves,int specialist){
  if(moves.count<=1)return;
  int scores[kMaxMoves];for(int i=0;i<moves.count;++i)scores[i]=super_move_priority(pos,moves.items[i],specialist);
  for(int i=1;i<moves.count;++i){Move move=moves.items[i];int score=scores[i],j=i;while(j>0&&score>scores[j-1]){moves.items[j]=moves.items[j-1];scores[j]=scores[j-1];--j;}moves.items[j]=move;scores[j]=score;}
}

int super_qsearch(const Position&pos,int alpha,int beta,int perspective,int specialist,int ply){
  if(g_super_nodes>=g_node_limit)return super_specialist_eval(pos,perspective,specialist)*(pos.turn==perspective?1:-1);
  ++g_super_nodes;
  const int stand=super_specialist_eval(pos,perspective,specialist)*(pos.turn==perspective?1:-1);
  if(stand>=beta)return beta;if(stand>alpha)alpha=stand;
  if(ply>=1)return alpha;
  MoveList moves;generate_legal(pos,moves);super_order_moves(pos,moves,specialist);
  for(int i=0;i<moves.count&&g_super_nodes<g_node_limit;++i){
    const Move&m=moves.items[i];const bool capture=m.from>=0&&pos.board[m.to]!=0;
    if(!capture&&!m.promote&&!m.drop)continue;
    Position next;apply_move(pos,m,next);const bool checking=is_check(next,next.turn);
    if(!capture&&!m.promote&&!checking)continue;
    const int score=-super_qsearch(next,-beta,-alpha,perspective,specialist,ply+1);if(score>=beta)return beta;if(score>alpha)alpha=score;
  }
  return alpha;
}

int super_negamax(const Position&pos,int depth,int alpha,int beta,int perspective,int specialist,int ply){
  if(g_super_nodes>=g_node_limit)return super_specialist_eval(pos,perspective,specialist)*(pos.turn==perspective?1:-1);
  ++g_super_nodes;
  if(depth<=0)return super_qsearch(pos,alpha,beta,perspective,specialist,0);
  MoveList moves;generate_legal(pos,moves);if(moves.count==0)return is_check(pos,pos.turn)?-kMateScore+ply:0;super_order_moves(pos,moves,specialist);
  int best=-kInfinity;
  for(int i=0;i<moves.count&&g_super_nodes<g_node_limit;++i){Position next;apply_move(pos,moves.items[i],next);const int score=-super_negamax(next,depth-1,-beta,-alpha,perspective,specialist,ply+1);if(score>best)best=score;if(score>alpha)alpha=score;if(alpha>=beta)break;}
  return best;
}

int32_t super_search(const Position&root,int specialist,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){
  MoveList all;generate_legal(root,all);if(all.count==0)return-1;
  MoveList roots;
  if(restrictMoves&&restrictCount>0){for(int i=0;i<all.count;++i){const int32_t code=encode_move(all.items[i]);for(int j=0;j<restrictCount;++j)if(code==restrictMoves[j]){roots.add(all.items[i]);break;}}}else roots=all;
  if(roots.count==0)roots=all;super_order_moves(root,roots,specialist);
  g_node_limit=nodeLimit<100?100:nodeLimit>5000000?5000000:nodeLimit;g_super_nodes=0;
  int32_t bestMove=encode_move(roots.items[0]);int bestScore=-kInfinity;const int perspective=root.turn;
  for(int depth=1;depth<=maxDepth&&g_super_nodes<g_node_limit;++depth){int layerBest=-kInfinity;int32_t layerMove=bestMove;bool completed=true;for(int i=0;i<roots.count;++i){Position next;apply_move(root,roots.items[i],next);const int score=-super_negamax(next,depth-1,-kInfinity,kInfinity,perspective,specialist,1);if(score>layerBest){layerBest=score;layerMove=encode_move(roots.items[i]);}if(g_super_nodes>=g_node_limit){completed=false;break;}}if(completed||depth==1){bestMove=layerMove;bestScore=layerBest;}if(bestScore>=kMateScore-256)break;}
  g_super_best_move=bestMove;g_super_best_score=bestScore;return bestMove;
}
}

extern "C" {
int32_t shogi_super_search_specialist(int32_t count,int32_t specialist,int32_t max_depth,int32_t node_limit){Position pos;if(!load_position(count,pos)||specialist<1||specialist>20)return-1;if(max_depth<1)max_depth=1;if(max_depth>12)max_depth=12;return super_search(pos,specialist,max_depth,node_limit,nullptr,0);}
int32_t shogi_super_converge(int32_t position_words,int32_t candidate_count,int32_t max_depth,int32_t node_limit){Position pos;if(position_words<kPositionWords||!load_position(position_words,pos))return-1;if(candidate_count<1)candidate_count=1;if(candidate_count>20)candidate_count=20;const int32_t*candidates=&g_input[position_words];if(max_depth<1)max_depth=1;if(max_depth>14)max_depth=14;return super_search(pos,0,max_depth,node_limit,candidates,candidate_count);}
int32_t shogi_super_best_score(){return g_super_best_score;}
int32_t shogi_super_nodes_searched(){return g_super_nodes;}
}
