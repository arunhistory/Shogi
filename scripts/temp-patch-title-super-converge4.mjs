import {readFile,writeFile} from 'node:fs/promises';

const input=process.argv[2]??'/tmp/title_supercomputer_inplace.cpp';
const output=process.argv[3]??'/tmp/title_supercomputer_converge4.cpp';
let source=await readFile(input,'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const replaceRange=(startToken,endToken,replacement,label)=>{
  const start=source.indexOf(startToken);assert(start>=0,`${label}_START_MISSING`);
  const end=source.indexOf(endToken,start+startToken.length);assert(end>start,`${label}_END_MISSING`);
  source=source.slice(0,start)+replacement+source.slice(end);
};

const includeAnchor='#include "engine_future.cpp"\n';
assert(source.includes(includeAnchor),'CONVERGE4_INCLUDE_ANCHOR_MISSING');
source=source.replace(includeAnchor,'#include <atomic>\n#include <mutex>\n#include <thread>\n'+includeAnchor);

const nodeGlobal='int32_t g_super_nodes = 0;\n';
assert(source.includes(nodeGlobal),'CONVERGE4_NODE_GLOBAL_MISSING');
source=source.replace(nodeGlobal,`std::atomic<int32_t> g_super_nodes{0};
inline int32_t super_nodes_now(){return g_super_nodes.load(std::memory_order_relaxed);}
inline bool super_take_node(){
  const int32_t claimed=g_super_nodes.fetch_add(1,std::memory_order_relaxed);
  if(claimed<g_node_limit)return true;
  g_super_nodes.fetch_sub(1,std::memory_order_relaxed);
  return false;
}
`);

const qsearch=`int super_qsearch(Position&pos,int alpha,int beta,int perspective,int specialist,int ply){
  if(!super_take_node())return super_specialist_eval(pos,perspective,specialist)*(pos.turn==perspective?1:-1);
  const int stand=super_specialist_eval(pos,perspective,specialist)*(pos.turn==perspective?1:-1);
  if(stand>=beta)return beta;if(stand>alpha)alpha=stand;
  if(ply>=1)return alpha;
  MoveList moves;super_generate_legal(pos,moves);super_order_moves(pos,moves,specialist);const int targetKing=king_square_for_side(pos,-pos.turn);
  for(int i=0;i<moves.count&&super_nodes_now()<g_node_limit;++i){
    const Move m=moves.items[i];const bool capture=m.from>=0&&pos.board[m.to]!=0;if(!capture&&!m.promote&&!m.drop)continue;
    SuperUndo undo;super_make_move(pos,m,undo);const bool checking=super_is_check_at(pos,pos.turn,targetKing);
    if(!capture&&!m.promote&&!checking){super_unmake_move(pos,m,undo);continue;}
    const int score=-super_qsearch(pos,-beta,-alpha,perspective,specialist,ply+1);super_unmake_move(pos,m,undo);
    if(score>=beta)return beta;if(score>alpha)alpha=score;
  }
  return alpha;
}

`;
replaceRange('int super_qsearch(','int super_negamax(',qsearch,'CONVERGE4_QSEARCH');

const negamax=`int super_negamax(Position&pos,int depth,int alpha,int beta,int perspective,int specialist,int ply){
  if(!super_take_node())return super_specialist_eval(pos,perspective,specialist)*(pos.turn==perspective?1:-1);
  if(depth<=0)return super_qsearch(pos,alpha,beta,perspective,specialist,0);
  MoveList moves;super_generate_legal(pos,moves);if(moves.count==0)return super_is_check(pos,pos.turn)?-kMateScore+ply:0;super_order_moves(pos,moves,specialist);
  int best=-kInfinity;
  for(int i=0;i<moves.count&&super_nodes_now()<g_node_limit;++i){const Move m=moves.items[i];SuperUndo undo;super_make_move(pos,m,undo);const int score=-super_negamax(pos,depth-1,-beta,-alpha,perspective,specialist,ply+1);super_unmake_move(pos,m,undo);if(score>best)best=score;if(score>alpha)alpha=score;if(alpha>=beta)break;}
  return best;
}

`;
replaceRange('int super_negamax(','int32_t super_search(',negamax,'CONVERGE4_NEGAMAX');

const search=`int32_t super_search_serial(const Position&root,int specialist,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){
  MoveList all;super_generate_legal(root,all);if(all.count==0)return-1;
  MoveList roots;if(restrictMoves&&restrictCount>0){for(int i=0;i<all.count;++i){const int32_t code=encode_move(all.items[i]);for(int j=0;j<restrictCount;++j)if(code==restrictMoves[j]){roots.add(all.items[i]);break;}}}else roots=all;
  if(roots.count==0)roots=all;super_order_moves(root,roots,specialist);g_node_limit=nodeLimit<100?100:nodeLimit>5000000?5000000:nodeLimit;g_super_nodes.store(0,std::memory_order_relaxed);
  int32_t bestMove=encode_move(roots.items[0]);int bestScore=-kInfinity;const int perspective=root.turn;Position work=root;
  for(int depth=1;depth<=maxDepth&&super_nodes_now()<g_node_limit;++depth){int layerBest=-kInfinity;int32_t layerMove=bestMove;bool completed=true;for(int i=0;i<roots.count;++i){const Move m=roots.items[i];SuperUndo undo;super_make_move(work,m,undo);const int score=-super_negamax(work,depth-1,-kInfinity,kInfinity,perspective,specialist,1);super_unmake_move(work,m,undo);if(score>layerBest){layerBest=score;layerMove=encode_move(m);}if(super_nodes_now()>=g_node_limit){completed=false;break;}}if(completed||depth==1){bestMove=layerMove;bestScore=layerBest;}if(bestScore>=kMateScore-256)break;}
  g_super_best_move=bestMove;g_super_best_score=bestScore;return bestMove;
}

int32_t super_search_converge4(const Position&root,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){
  MoveList all;super_generate_legal(root,all);if(all.count==0)return-1;
  MoveList roots;if(restrictMoves&&restrictCount>0){for(int i=0;i<all.count;++i){const int32_t code=encode_move(all.items[i]);for(int j=0;j<restrictCount;++j)if(code==restrictMoves[j]){roots.add(all.items[i]);break;}}}else roots=all;
  if(roots.count==0)roots=all;super_order_moves(root,roots,0);g_node_limit=nodeLimit<100?100:nodeLimit>5000000?5000000:nodeLimit;g_super_nodes.store(0,std::memory_order_relaxed);
  int32_t bestMove=encode_move(roots.items[0]);int bestScore=-kInfinity;const int perspective=root.turn;

  Position splitBase=root;MoveList splitMoves;
  std::atomic<int> splitNext{1},phase{0},done{0},splitDepth{0},splitPly{0},splitAlpha{-kInfinity},splitBest{-kInfinity};
  std::atomic<bool> stop{false},splitCutoff{false};int splitBeta=kInfinity;std::mutex splitBestMutex;

  auto processSplit=[&](){
    const int depth=splitDepth.load(std::memory_order_relaxed),ply=splitPly.load(std::memory_order_relaxed);
    for(;;){
      if(splitCutoff.load(std::memory_order_acquire)||super_nodes_now()>=g_node_limit)break;
      const int i=splitNext.fetch_add(1,std::memory_order_relaxed);if(i>=splitMoves.count)break;
      const int alphaSnapshot=splitAlpha.load(std::memory_order_acquire);
      Position work=splitBase;const Move m=splitMoves.items[i];SuperUndo undo;super_make_move(work,m,undo);
      const int score=-super_negamax(work,depth-1,-splitBeta,-alphaSnapshot,perspective,0,ply+1);
      super_unmake_move(work,m,undo);
      {
        std::lock_guard<std::mutex> lock(splitBestMutex);
        int best=splitBest.load(std::memory_order_relaxed);if(score>best)splitBest.store(score,std::memory_order_relaxed);
        int alpha=splitAlpha.load(std::memory_order_relaxed);if(score>alpha){alpha=score;splitAlpha.store(alpha,std::memory_order_release);if(alpha>=splitBeta)splitCutoff.store(true,std::memory_order_release);}
      }
    }
  };
  auto helperLoop=[&](){int seen=0;for(;;){while(!stop.load(std::memory_order_acquire)&&phase.load(std::memory_order_acquire)==seen)std::this_thread::yield();if(stop.load(std::memory_order_acquire))break;seen=phase.load(std::memory_order_acquire);processSplit();done.fetch_add(1,std::memory_order_release);}};
  std::thread helper1(helperLoop),helper2(helperLoop),helper3(helperLoop);

  auto negamax4=[&](Position&pos,int depth,int alpha,int beta,int ply)->int{
    if(!super_take_node())return super_specialist_eval(pos,perspective,0)*(pos.turn==perspective?1:-1);
    if(depth<=0)return super_qsearch(pos,alpha,beta,perspective,0,0);
    MoveList moves;super_generate_legal(pos,moves);if(moves.count==0)return super_is_check(pos,pos.turn)?-kMateScore+ply:0;super_order_moves(pos,moves,0);
    const Move first=moves.items[0];Position firstWork=pos;SuperUndo firstUndo;super_make_move(firstWork,first,firstUndo);
    int best=-super_negamax(firstWork,depth-1,-beta,-alpha,perspective,0,ply+1);super_unmake_move(firstWork,first,firstUndo);
    if(best>alpha)alpha=best;if(alpha>=beta||moves.count<=1||super_nodes_now()>=g_node_limit)return best;

    splitBase=pos;splitMoves=moves;splitNext.store(1,std::memory_order_relaxed);done.store(0,std::memory_order_relaxed);
    splitDepth.store(depth,std::memory_order_relaxed);splitPly.store(ply,std::memory_order_relaxed);splitAlpha.store(alpha,std::memory_order_release);splitBest.store(best,std::memory_order_relaxed);splitBeta=beta;splitCutoff.store(false,std::memory_order_release);
    phase.fetch_add(1,std::memory_order_release);processSplit();while(done.load(std::memory_order_acquire)<3)std::this_thread::yield();
    return splitBest.load(std::memory_order_relaxed);
  };

  Position work=root;
  for(int depth=1;depth<=maxDepth&&super_nodes_now()<g_node_limit;++depth){
    int layerBest=-kInfinity;int32_t layerMove=bestMove;bool completed=true;
    for(int i=0;i<roots.count;++i){
      const Move m=roots.items[i];SuperUndo undo;super_make_move(work,m,undo);const int score=-negamax4(work,depth-1,-kInfinity,kInfinity,1);super_unmake_move(work,m,undo);
      if(score>layerBest){layerBest=score;layerMove=encode_move(m);}if(super_nodes_now()>=g_node_limit){completed=false;break;}
    }
    if(completed||depth==1){bestMove=layerMove;bestScore=layerBest;}if(bestScore>=kMateScore-256)break;
  }
  stop.store(true,std::memory_order_release);phase.fetch_add(1,std::memory_order_release);helper1.join();helper2.join();helper3.join();
  g_super_best_move=bestMove;g_super_best_score=bestScore;return bestMove;
}

int32_t super_search(const Position&root,int specialist,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){
  if(specialist==0)return super_search_converge4(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
  return super_search_serial(root,specialist,maxDepth,nodeLimit,restrictMoves,restrictCount);
}
`;
replaceRange('int32_t super_search(','}\n\nextern "C" {',search,'CONVERGE4_SEARCH');

const getter='int32_t shogi_super_nodes_searched(){return g_super_nodes;}';
assert(source.includes(getter),'CONVERGE4_GETTER_MISSING');
source=source.replace(getter,'int32_t shogi_super_nodes_searched(){return super_nodes_now();}');

await writeFile(output,source);
console.log(JSON.stringify({ok:true,input,output,bytes:source.length}));
