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
  std::atomic<int> nextRoot{1},phase{0},done{0},currentDepth{0},sharedAlpha{-kInfinity},sharedBestIndex{0};std::atomic<bool> stop{false};std::mutex bestMutex;
  auto searchShared=[&](int depth){
    for(;;){
      if(super_nodes_now()>=g_node_limit)break;
      const int i=nextRoot.fetch_add(1,std::memory_order_relaxed);if(i>=roots.count)break;
      const int alphaSnapshot=sharedAlpha.load(std::memory_order_acquire);
      Position work=root;const Move m=roots.items[i];SuperUndo undo;super_make_move(work,m,undo);
      const int score=-super_negamax(work,depth-1,-kInfinity,-alphaSnapshot,perspective,0,1);
      super_unmake_move(work,m,undo);
      if(score>alphaSnapshot){
        std::lock_guard<std::mutex> lock(bestMutex);
        const int current=sharedAlpha.load(std::memory_order_relaxed);
        if(score>current){sharedAlpha.store(score,std::memory_order_release);sharedBestIndex.store(i,std::memory_order_relaxed);}
      }
    }
  };
  auto helperLoop=[&](){int seen=0;for(;;){while(!stop.load(std::memory_order_acquire)&&phase.load(std::memory_order_acquire)==seen)std::this_thread::yield();if(stop.load(std::memory_order_acquire))break;seen=phase.load(std::memory_order_acquire);searchShared(currentDepth.load(std::memory_order_relaxed));done.fetch_add(1,std::memory_order_release);}};
  std::thread helper1(helperLoop),helper2(helperLoop),helper3(helperLoop);
  for(int depth=1;depth<=maxDepth&&super_nodes_now()<g_node_limit;++depth){
    Position firstWork=root;const Move first=roots.items[0];SuperUndo firstUndo;super_make_move(firstWork,first,firstUndo);const int firstScore=-super_negamax(firstWork,depth-1,-kInfinity,kInfinity,perspective,0,1);super_unmake_move(firstWork,first,firstUndo);
    sharedAlpha.store(firstScore,std::memory_order_release);sharedBestIndex.store(0,std::memory_order_relaxed);
    nextRoot.store(1,std::memory_order_relaxed);done.store(0,std::memory_order_relaxed);currentDepth.store(depth,std::memory_order_relaxed);
    if(super_nodes_now()<g_node_limit&&roots.count>1){phase.fetch_add(1,std::memory_order_release);searchShared(depth);while(done.load(std::memory_order_acquire)<3)std::this_thread::yield();}
    const bool completed=super_nodes_now()<g_node_limit&&nextRoot.load(std::memory_order_relaxed)>=roots.count;
    const int layerBest=sharedAlpha.load(std::memory_order_acquire);const int layerIndex=sharedBestIndex.load(std::memory_order_relaxed);const int32_t layerMove=encode_move(roots.items[layerIndex]);
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
