#include "engine_future.cpp"

namespace {
int32_t g_super_best_score = 0;
int32_t g_super_best_move = -1;
int32_t g_super_nodes = 0;

int super_count_attacks(const Position& pos,int side,int square){
  int n=0;
  for(int i=0;i<kBoardSquares;++i)if(sign_of(pos.board[i])==side&&attacks_square(pos,i,square))++n;
  return n;
}

int super_legal_count_for_side(Position pos,int side){
  pos.turn=static_cast<int8_t>(side);
  MoveList list; generate_legal(pos,list); return list.count;
}

int super_material_only(const Position& pos,int perspective){
  int score=0;
  for(int i=0;i<81;++i){const int c=pos.board[i];if(!c)continue;const int v=piece_value(kind_of(c));score+=sign_of(c)==perspective?v:-v;}
  for(int side:{1,-1}){const int m=side==perspective?1:-1;for(int k=1;k<=7;++k)score+=m*pos.hands[side_index(side)][k-1]*piece_value(k);}
  return score;
}

int super_drop_potential(const Position& pos,int side){
  const int si=side_index(side);int score=0;
  for(int k=1;k<=7;++k){const int c=pos.hands[si][k-1];if(!c)continue;score+=c*(piece_value(k)/25+4);}
  Position p=pos;p.turn=static_cast<int8_t>(side);MoveList list;generate_drops(p,list);score+=list.count*3;return score;
}

int super_promotion_potential(const Position& pos,int side){
  Position p=pos;p.turn=static_cast<int8_t>(side);MoveList list;generate_legal(p,list);int n=0;for(int i=0;i<list.count;++i)if(list.items[i].promote)++n;return n;
}

int super_capture_potential(const Position& pos,int side){
  Position p=pos;p.turn=static_cast<int8_t>(side);MoveList list;generate_legal(p,list);int score=0;for(int i=0;i<list.count;++i){const Move&m=list.items[i];if(m.from>=0&&pos.board[m.to])score+=piece_value(kind_of(pos.board[m.to]));}return score;
}

int super_forcing_potential(const Position& pos,int side){
  Position p=pos;p.turn=static_cast<int8_t>(side);MoveList list;generate_legal(p,list);int score=0;for(int i=0;i<list.count;++i){Position next;apply_move(p,list.items[i],next);if(is_check(next,next.turn))score+=20;if(list.items[i].from>=0&&p.board[list.items[i].to])score+=6;}return score;
}

int super_king_escape_count(const Position& pos,int side){
  const int k=king_square_for_side(pos,side);if(k<0)return 0;int n=0;const int y=row_of(k),x=col_of(k);for(int dy=-1;dy<=1;++dy)for(int dx=-1;dx<=1;++dx){if(!dy&&!dx)continue;const int yy=y+dy,xx=x+dx;if(!inside(yy,xx))continue;const int t=square_of(yy,xx);if(sign_of(pos.board[t])==side)continue;if(super_count_attacks(pos,-side,t)==0)++n;}return n;
}

int super_board_activity(const Position& pos,int side){
  int s=0;for(int i=0;i<81;++i){if(sign_of(pos.board[i])!=side)continue;const int k=kind_of(pos.board[i]);if(k==7||k==14){s+=ray_activity(pos,i,side,-1,0)+ray_activity(pos,i,side,1,0)+ray_activity(pos,i,side,0,-1)+ray_activity(pos,i,side,0,1);}else if(k==6||k==13){s+=ray_activity(pos,i,side,-1,-1)+ray_activity(pos,i,side,-1,1)+ray_activity(pos,i,side,1,-1)+ray_activity(pos,i,side,1,1);}else{s+=2;}}return s;
}

int super_specialist_eval(const Position& pos,int perspective,int specialist){
  const int enemy=-perspective;
  const int base=evaluate_for(pos,perspective);
  const int ownKing=king_square_for_side(pos,perspective),enemyKing=king_square_for_side(pos,enemy);
  const int ownDanger=ownKing<0?1000:super_count_attacks(pos,enemy,ownKing);
  const int enemyDanger=enemyKing<0?1000:super_count_attacks(pos,perspective,enemyKing);
  const int ownSafety=king_safety_score(pos,perspective),enemySafety=king_safety_score(pos,enemy);
  const int ownNet=king_net_pressure(pos,perspective,enemy),enemyNet=king_net_pressure(pos,enemy,perspective);
  const int ownDrop=super_drop_potential(pos,perspective),enemyDrop=super_drop_potential(pos,enemy);
  const int ownMat=super_material_only(pos,perspective);
  const int ownAct=super_board_activity(pos,perspective),enemyAct=super_board_activity(pos,enemy);
  switch(specialist){
    case 1:return base+ownSafety*9-ownDanger*900-enemyNet*2;
    case 2:return base+enemyDanger*1200+ownNet*12-super_king_escape_count(pos,enemy)*450;
    case 3:return base+ownNet*8+super_forcing_potential(pos,perspective)*55+super_capture_potential(pos,perspective)/3;
    case 4:return base-enemyNet*9-super_forcing_potential(pos,enemy)*60-ownDanger*700;
    case 5:return base+ownSafety*8-enemyNet*7+super_legal_count_for_side(pos,perspective)*8;
    case 6:return base-enemyAct*18-super_capture_potential(pos,perspective)/2-enemyNet*4;
    case 7:return base-enemyNet*5-enemyDrop*10+super_forcing_potential(pos,perspective)*25;
    case 8:return base+ownDrop*20+super_forcing_potential(pos,perspective)*20+ownNet*4;
    case 9:return base-enemyDrop*24-enemyNet*5-ownDanger*500;
    case 10:return base+(ownDrop-enemyDrop)*20+ownMat/8;
    case 11:return base+ownMat*2+super_capture_potential(pos,perspective)/2-super_capture_potential(pos,enemy)/3;
    case 12:return base+(ownAct-enemyAct)*30+ownNet*3-enemyNet*3;
    case 13:return base+(ownAct-enemyAct)*42+ownSafety*2;
    case 14:return base+(super_promotion_potential(pos,perspective)-super_promotion_potential(pos,enemy))*300;
    case 15:return base+(super_forcing_potential(pos,perspective)-super_forcing_potential(pos,enemy))*80;
    case 16:return base+(super_king_escape_count(pos,perspective)-super_king_escape_count(pos,enemy))*240+ownSafety*3;
    case 17:return base+ownSafety*5-ownDanger*1000-enemyNet*5-super_capture_potential(pos,enemy)/2;
    case 18:return base+ownSafety*7-enemyNet*8-enemyDrop*14-ownDanger*1100;
    case 19:return base+(ownAct-enemyAct)*25+(ownDrop-enemyDrop)*12+(ownSafety-enemySafety)*3;
    case 20:return base+static_cast<int>((hash_position(pos)>>17)&1023)-512+(super_forcing_potential(pos,perspective)-super_forcing_potential(pos,enemy))*15;
    default:return base;
  }
}

int super_qsearch(const Position&pos,int alpha,int beta,int perspective,int specialist,int ply){
  if(g_super_nodes>=g_node_limit)return super_specialist_eval(pos,perspective,specialist)*(pos.turn==perspective?1:-1);
  ++g_super_nodes;
  int stand=super_specialist_eval(pos,perspective,specialist)*(pos.turn==perspective?1:-1);
  if(stand>=beta)return beta;if(stand>alpha)alpha=stand;
  if(ply>=2)return alpha;
  MoveList moves;generate_legal(pos,moves);
  for(int i=0;i<moves.count&&g_super_nodes<g_node_limit;++i){const Move&m=moves.items[i];Position next;apply_move(pos,m,next);const bool tactical=(m.from>=0&&pos.board[m.to]!=0)||m.promote||is_check(next,next.turn)||m.drop>0;if(!tactical)continue;const int score=-super_qsearch(next,-beta,-alpha,perspective,specialist,ply+1);if(score>=beta)return beta;if(score>alpha)alpha=score;}
  return alpha;
}

int super_negamax(const Position&pos,int depth,int alpha,int beta,int perspective,int specialist,int ply){
  if(g_super_nodes>=g_node_limit)return super_specialist_eval(pos,perspective,specialist)*(pos.turn==perspective?1:-1);
  ++g_super_nodes;
  if(depth<=0)return super_qsearch(pos,alpha,beta,perspective,specialist,0);
  MoveList moves;generate_legal(pos,moves);if(moves.count==0)return is_check(pos,pos.turn)?-kMateScore+ply:0;
  int best=-kInfinity;
  for(int i=0;i<moves.count&&g_super_nodes<g_node_limit;++i){Position next;apply_move(pos,moves.items[i],next);const int score=-super_negamax(next,depth-1,-beta,-alpha,perspective,specialist,ply+1);if(score>best)best=score;if(score>alpha)alpha=score;if(alpha>=beta)break;}
  return best;
}

int32_t super_search(const Position&root,int specialist,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){
  MoveList all;generate_legal(root,all);if(all.count==0)return-1;
  MoveList roots;
  if(restrictMoves&&restrictCount>0){for(int i=0;i<all.count;++i){const int32_t code=encode_move(all.items[i]);for(int j=0;j<restrictCount;++j)if(code==restrictMoves[j]){roots.add(all.items[i]);break;}}}
  else roots=all;
  if(roots.count==0)roots=all;
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
