// Pure shogi CPU engine for WebAssembly.
// No machine learning, neural network, NNUE, generated model, or external AI is used.
// Input layout (int32[96]): board[81], sente hands[7], gote hands[7], turn (+1 sente/-1 gote).

extern "C" {

typedef int i32;
typedef unsigned long long u64;

void* memcpy(void* dst, const void* src, unsigned long n){ unsigned char* d=(unsigned char*)dst; const unsigned char* s=(const unsigned char*)src; for(unsigned long i=0;i<n;i++) d[i]=s[i]; return dst; }
void* memset(void* dst, int v, unsigned long n){ unsigned char* d=(unsigned char*)dst; for(unsigned long i=0;i<n;i++) d[i]=(unsigned char)v; return dst; }

struct State { i32 b[81]; i32 h[2][7]; i32 turn; };
struct Move { i32 from, to, drop, promote, score; };

static i32 g_input[96];
static i32 g_nodes = 0;
static i32 g_node_limit = 0;
static const i32 INF = 100000000;
static const i32 MATE = 90000000;
static const i32 MAX_MOVES = 600;

static i32 abs_i(i32 x){ return x < 0 ? -x : x; }
static i32 side_index(i32 side){ return side > 0 ? 0 : 1; }
static i32 y_of(i32 sq){ return sq / 9; }
static i32 x_of(i32 sq){ return sq % 9; }
static bool inside(i32 y,i32 x){ return y>=0&&y<9&&x>=0&&x<9; }
static i32 sign_of(i32 p){ return p>0?1:(p<0?-1:0); }
static i32 base_piece(i32 k){ if(k==9)return 2;if(k==10)return 3;if(k==11)return 5;if(k==12)return 6;if(k==13)return 7;if(k==14)return 8;return k; }
static i32 promote_piece(i32 k){ if(k==2)return 9;if(k==3)return 10;if(k==5)return 11;if(k==6)return 12;if(k==7)return 13;if(k==8)return 14;return k; }
static i32 hand_index(i32 base){ if(base==2)return 0;if(base==3)return 1;if(base==4)return 2;if(base==5)return 3;if(base==6)return 4;if(base==7)return 5;if(base==8)return 6;return -1; }
static bool zone(i32 side,i32 y){ return side>0 ? y<=2 : y>=6; }
static bool must_promote(i32 base,i32 side,i32 y){
  if((base==8||base==7) && (side>0?y==0:y==8)) return true;
  return base==6 && (side>0?y<=1:y>=7);
}

static void load_state(State& s){
  for(i32 i=0;i<81;i++) s.b[i]=g_input[i];
  i32 k=81;
  for(i32 side=0;side<2;side++) for(i32 h=0;h<7;h++) s.h[side][h]=g_input[k++];
  s.turn=g_input[95]>=0?1:-1;
}

static bool attacks_from(const State& s,i32 from,i32 target){
  i32 p=s.b[from]; if(!p) return false;
  i32 side=sign_of(p), k=abs_i(p), fy=y_of(from), fx=x_of(from), ty=y_of(target), tx=x_of(target);
  i32 dy=ty-fy, dx=tx-fx, f=side>0?-1:1;
  if(k==1) return abs_i(dy)<=1 && abs_i(dx)<=1 && (dy||dx);
  if(k==4||k==11||k==12||k==13||k==14){
    i32 rdy=side>0?dy:-dy;
    return (rdy==-1 && abs_i(dx)<=1) || (rdy==0 && abs_i(dx)==1) || (rdy==1 && dx==0);
  }
  if(k==5) return (dy==f && abs_i(dx)<=1) || (dy==-f && abs_i(dx)==1);
  if(k==6) return dy==2*f && abs_i(dx)==1;
  if(k==8) return dy==f && dx==0;
  if(k==7){
    if(dx!=0 || (side>0?dy>=0:dy<=0)) return false;
    i32 sy=dy>0?1:-1; for(i32 y=fy+sy;y!=ty;y+=sy) if(s.b[y*9+fx]) return false; return true;
  }
  bool rookLine=(dy==0)^(dx==0), bishopLine=abs_i(dy)==abs_i(dx) && dy!=0;
  if((k==2||k==9) && rookLine){
    i32 sy=dy==0?0:(dy>0?1:-1), sx=dx==0?0:(dx>0?1:-1);
    for(i32 y=fy+sy,x=fx+sx;y!=ty||x!=tx;y+=sy,x+=sx) if(s.b[y*9+x]) return false; return true;
  }
  if((k==3||k==10) && bishopLine){
    i32 sy=dy>0?1:-1,sx=dx>0?1:-1; for(i32 y=fy+sy,x=fx+sx;y!=ty;y+=sy,x+=sx) if(s.b[y*9+x]) return false; return true;
  }
  if(k==9) return abs_i(dy)==1 && abs_i(dx)==1;
  if(k==10) return (abs_i(dy)+abs_i(dx))==1;
  return false;
}

static bool in_check(const State& s,i32 side){
  i32 king=-1; for(i32 i=0;i<81;i++) if(s.b[i]==side){ king=i; break; }
  if(king<0) return true;
  for(i32 i=0;i<81;i++) if(sign_of(s.b[i])==-side && attacks_from(s,i,king)) return true;
  return false;
}

static void apply_unchecked(const State& s,const Move& m,State& n){
  n=s; i32 side=s.turn, si=side_index(side);
  if(m.drop>0){ i32 base = m.drop==1?2:m.drop==2?3:m.drop==3?4:m.drop==4?5:m.drop==5?6:m.drop==6?7:8; n.b[m.to]=side*base; n.h[si][m.drop-1]--; }
  else {
    i32 p=n.b[m.from], cap=n.b[m.to];
    if(cap){ i32 hi=hand_index(base_piece(abs_i(cap))); if(hi>=0)n.h[si][hi]++; }
    n.b[m.from]=0; i32 kind=abs_i(p); if(m.promote)kind=promote_piece(kind); n.b[m.to]=side*kind;
  }
  n.turn=-side;
}

static void add_move(Move* out,i32& count,i32 from,i32 to,i32 drop,i32 promote,const State& s){
  if(count>=MAX_MOVES) return;
  if(drop==0 && abs_i(s.b[to])==1) return; // kings are never captured; checkmate terminates the game.
  Move m{from,to,drop,promote,0}; State n; apply_unchecked(s,m,n); if(!in_check(n,s.turn)) out[count++]=m;
}

static void add_piece_target(Move* out,i32& count,const State& s,i32 from,i32 to){
  if(to<0||to>=81) return; i32 p=s.b[from],side=sign_of(p); if(sign_of(s.b[to])==side)return;
  i32 kind=abs_i(p),base=base_piece(kind),fy=y_of(from),ty=y_of(to);
  bool promotable=(kind==base)&&(base==2||base==3||base==5||base==6||base==7||base==8)&&(zone(side,fy)||zone(side,ty));
  if(must_promote(base,side,ty)) add_move(out,count,from,to,0,1,s);
  else { add_move(out,count,from,to,0,0,s); if(promotable)add_move(out,count,from,to,0,1,s); }
}

static void gen_step(Move* out,i32& count,const State& s,i32 from,i32 dy,i32 dx){ i32 y=y_of(from)+dy,x=x_of(from)+dx; if(inside(y,x))add_piece_target(out,count,s,from,y*9+x); }
static void gen_slide(Move* out,i32& count,const State& s,i32 from,i32 dy,i32 dx){
  i32 y=y_of(from)+dy,x=x_of(from)+dx,side=sign_of(s.b[from]); while(inside(y,x)){ i32 to=y*9+x; if(sign_of(s.b[to])==side)break; add_piece_target(out,count,s,from,to); if(s.b[to])break; y+=dy;x+=dx; }
}

static i32 generate_legal(const State& s,Move* out){
  i32 count=0,side=s.turn,f=side>0?-1:1;
  for(i32 from=0;from<81;from++){
    i32 p=s.b[from]; if(sign_of(p)!=side)continue; i32 k=abs_i(p);
    if(k==1){for(i32 dy=-1;dy<=1;dy++)for(i32 dx=-1;dx<=1;dx++)if(dy||dx)gen_step(out,count,s,from,dy,dx);}
    else if(k==4||k==11||k==12||k==13||k==14){i32 sf=side>0?1:-1;gen_step(out,count,s,from,-1*sf,-1);gen_step(out,count,s,from,-1*sf,0);gen_step(out,count,s,from,-1*sf,1);gen_step(out,count,s,from,0,-1);gen_step(out,count,s,from,0,1);gen_step(out,count,s,from,1*sf,0);}
    else if(k==5){gen_step(out,count,s,from,f,-1);gen_step(out,count,s,from,f,0);gen_step(out,count,s,from,f,1);gen_step(out,count,s,from,-f,-1);gen_step(out,count,s,from,-f,1);}
    else if(k==6){gen_step(out,count,s,from,2*f,-1);gen_step(out,count,s,from,2*f,1);}
    else if(k==7)gen_slide(out,count,s,from,f,0);
    else if(k==8)gen_step(out,count,s,from,f,0);
    else if(k==2||k==9){gen_slide(out,count,s,from,-1,0);gen_slide(out,count,s,from,1,0);gen_slide(out,count,s,from,0,-1);gen_slide(out,count,s,from,0,1);if(k==9){gen_step(out,count,s,from,-1,-1);gen_step(out,count,s,from,-1,1);gen_step(out,count,s,from,1,-1);gen_step(out,count,s,from,1,1);}}
    else if(k==3||k==10){gen_slide(out,count,s,from,-1,-1);gen_slide(out,count,s,from,-1,1);gen_slide(out,count,s,from,1,-1);gen_slide(out,count,s,from,1,1);if(k==10){gen_step(out,count,s,from,-1,0);gen_step(out,count,s,from,1,0);gen_step(out,count,s,from,0,-1);gen_step(out,count,s,from,0,1);}}
  }
  i32 si=side_index(side);
  for(i32 drop=1;drop<=7;drop++)if(s.h[si][drop-1]>0){
    i32 base=drop==1?2:drop==2?3:drop==3?4:drop==4?5:drop==5?6:drop==6?7:8;
    for(i32 to=0;to<81;to++)if(!s.b[to]){
      i32 y=y_of(to),x=x_of(to); if((base==8||base==7)&&(side>0?y==0:y==8))continue; if(base==6&&(side>0?y<=1:y>=7))continue;
      if(base==8){ bool nifu=false; for(i32 yy=0;yy<9;yy++)if(s.b[yy*9+x]==side*8){nifu=true;break;} if(nifu)continue; }
      add_move(out,count,-1,to,drop,0,s);
    }
  }
  return count;
}

static i32 piece_value(i32 k){
  if(k==1)return 0;if(k==2)return 1000;if(k==3)return 900;if(k==4)return 600;if(k==5)return 520;if(k==6)return 360;if(k==7)return 320;if(k==8)return 100;
  if(k==9)return 1350;if(k==10)return 1250;if(k==11)return 620;if(k==12)return 600;if(k==13)return 580;if(k==14)return 550;return 0;
}
static i32 eval_sente(const State& s){
  i32 score=0;
  for(i32 sq=0;sq<81;sq++)if(s.b[sq]){ i32 side=sign_of(s.b[sq]),k=abs_i(s.b[sq]),v=piece_value(k); score+=side*v; if(k!=1){i32 y=y_of(sq);score+=side*(side>0?(8-y):y)*3;} }
  static const i32 handVal[7]={1000,900,600,520,360,320,100};
  for(i32 h=0;h<7;h++) score+=(s.h[0][h]-s.h[1][h])*handVal[h];
  return score;
}
static i32 evaluate(const State& s){ i32 v=eval_sente(s); return s.turn>0?v:-v; }
static i32 move_order(const State& s,const Move& m){
  i32 score=0; if(m.drop)score=20; else {i32 cap=abs_i(s.b[m.to]); if(cap)score+=10000+piece_value(cap)-piece_value(abs_i(s.b[m.from]))/10; if(m.promote)score+=800;} return score;
}
static void sort_moves(const State& s,Move* m,i32 n){ for(i32 i=1;i<n;i++){Move key=m[i];key.score=move_order(s,key);i32 j=i-1;while(j>=0){i32 sj=m[j].score?m[j].score:move_order(s,m[j]);m[j].score=sj;if(sj>=key.score)break;m[j+1]=m[j];j--;}m[j+1]=key;} }

static i32 search(const State& s,i32 depth,i32 alpha,i32 beta,i32 ply){
  if(g_nodes++>=g_node_limit)return evaluate(s);
  Move moves[MAX_MOVES]; i32 n=generate_legal(s,moves);
  if(n==0)return in_check(s,s.turn)?(-MATE+ply):0;
  if(depth<=0)return evaluate(s);
  sort_moves(s,moves,n);
  i32 best=-INF;
  for(i32 i=0;i<n;i++){State next;apply_unchecked(s,moves[i],next);i32 score=-search(next,depth-1,-beta,-alpha,ply+1);if(score>best)best=score;if(score>alpha)alpha=score;if(alpha>=beta||g_nodes>=g_node_limit)break;}
  return best;
}

static i32 pack_move(const Move& m){ i32 packed=(m.to&0x7f); if(m.drop)packed|=((m.drop&0x0f)<<15); else {packed|=((m.from&0x7f)<<7);if(m.promote)packed|=(1<<14);} return packed; }

i32 shogi_engine_version(){ return 2; }
i32 shogi_position_buffer(){ return (i32)(long long)(&g_input[0]); }
i32 shogi_last_nodes(){ return g_nodes; }

i32 shogi_find_best_move(i32 level){
  State root;load_state(root);Move rootMoves[MAX_MOVES];i32 n=generate_legal(root,rootMoves);if(n<=0)return -1;sort_moves(root,rootMoves,n);
  i32 maxDepth=2;g_node_limit=2000;
  if(level==1){maxDepth=3;g_node_limit=12000;} else if(level==2){maxDepth=4;g_node_limit=70000;} else if(level==3){maxDepth=5;g_node_limit=300000;} else if(level>=4){maxDepth=7;g_node_limit=1400000;}
  Move best=rootMoves[0];i32 bestScore=-INF;g_nodes=0;
  for(i32 depth=1;depth<=maxDepth;depth++){
    Move iterationBest=best;i32 iterationScore=-INF;sort_moves(root,rootMoves,n);
    for(i32 i=0;i<n;i++){State next;apply_unchecked(root,rootMoves[i],next);i32 score=-search(next,depth-1,-INF,INF,1);if(score>iterationScore){iterationScore=score;iterationBest=rootMoves[i];}if(g_nodes>=g_node_limit)break;}
    if(g_nodes<g_node_limit||depth==1){best=iterationBest;bestScore=iterationScore;}
    if(g_nodes>=g_node_limit||bestScore>MATE-1000)break;
  }
  return pack_move(best);
}

}
