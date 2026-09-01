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
assert(source.includes(includeAnchor),'CONVERGENCE_ENGINE_INCLUDE_ANCHOR_MISSING');
source=source.replace(includeAnchor,`#include <atomic>\n#include <condition_variable>\n#include <deque>\n#include <mutex>\n#include <thread>\n${includeAnchor}`);

const nodeGlobal='int32_t g_super_nodes = 0;\n';
assert(source.includes(nodeGlobal),'CONVERGENCE_ENGINE_NODE_GLOBAL_MISSING');
source=source.replace(nodeGlobal,`#ifndef SUPER_ENGINE_THREADS
#define SUPER_ENGINE_THREADS 8
#endif
static_assert(SUPER_ENGINE_THREADS>=2&&SUPER_ENGINE_THREADS<=8,"SUPER_ENGINE_THREADS must be 2..8");
constexpr int kSuperEngineThreads=SUPER_ENGINE_THREADS;
constexpr int kSuperNodeLease=256;
struct alignas(64) SuperNodeShard{std::atomic<int32_t> consumed{0};};
SuperNodeShard g_super_node_shards[8];
std::atomic<int32_t> g_super_node_pool{0};
thread_local int g_super_lane=0;
thread_local int g_super_node_lease=0;

inline int32_t super_nodes_now(){
  int32_t total=0;
  for(int i=0;i<kSuperEngineThreads;++i)total+=g_super_node_shards[i].consumed.load(std::memory_order_relaxed);
  return total;
}
inline void super_return_node_lease(){
  if(g_super_node_lease>0){g_super_node_pool.fetch_add(g_super_node_lease,std::memory_order_relaxed);g_super_node_lease=0;}
}
inline bool super_claim_node_lease(){
  int32_t available=g_super_node_pool.load(std::memory_order_relaxed);
  while(available>0){
    const int32_t take=available>kSuperNodeLease?kSuperNodeLease:available;
    if(g_super_node_pool.compare_exchange_weak(available,available-take,std::memory_order_relaxed,std::memory_order_relaxed)){g_super_node_lease=take;return true;}
  }
  return false;
}
inline bool super_take_node(){
  if(g_super_node_lease<=0&&!super_claim_node_lease())return false;
  --g_super_node_lease;
  g_super_node_shards[g_super_lane].consumed.fetch_add(1,std::memory_order_relaxed);
  return true;
}
inline void super_reset_nodes(int32_t limit){
  g_super_lane=0;g_super_node_lease=0;g_super_node_pool.store(limit,std::memory_order_relaxed);
  for(int i=0;i<8;++i)g_super_node_shards[i].consumed.store(0,std::memory_order_relaxed);
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
replaceRange('int super_qsearch(','int super_negamax(',qsearch,'CONVERGENCE_ENGINE_QSEARCH');

const serialNegamax=`int super_negamax_serial(Position&pos,int depth,int alpha,int beta,int perspective,int specialist,int ply){
  if(!super_take_node())return super_specialist_eval(pos,perspective,specialist)*(pos.turn==perspective?1:-1);
  if(depth<=0)return super_qsearch(pos,alpha,beta,perspective,specialist,0);
  MoveList moves;super_generate_legal(pos,moves);if(moves.count==0)return super_is_check(pos,pos.turn)?-kMateScore+ply:0;super_order_moves(pos,moves,specialist);
  int best=-kInfinity;
  for(int i=0;i<moves.count&&super_nodes_now()<g_node_limit;++i){const Move m=moves.items[i];SuperUndo undo;super_make_move(pos,m,undo);const int score=-super_negamax_serial(pos,depth-1,-beta,-alpha,perspective,specialist,ply+1);super_unmake_move(pos,m,undo);if(score>best)best=score;if(score>alpha)alpha=score;if(alpha>=beta)break;}
  return best;
}

struct SuperEngineSplit;
struct SuperEngineTask{
  Position pos{};
  int depth=0;
  int perspective=1;
  int ply=0;
  SuperEngineSplit*split=nullptr;
};
struct SuperEngineSplit{
  std::atomic<int>pending{0};
  std::atomic<int>alpha{-kInfinity};
  std::atomic<int>best{-kInfinity};
  std::atomic<bool>cutoff{false};
  int beta=kInfinity;
  std::mutex updateMutex;
};

std::mutex g_super_engine_queue_mutex;
std::condition_variable g_super_engine_queue_cv;
std::deque<SuperEngineTask> g_super_engine_queue;
std::atomic<bool> g_super_engine_stop{false};
std::atomic<int> g_super_engine_idle{0};

int super_negamax_engine(Position&pos,int depth,int alpha,int beta,int perspective,int ply);

inline bool super_engine_try_pop(SuperEngineTask&task){
  std::lock_guard<std::mutex>lock(g_super_engine_queue_mutex);
  if(g_super_engine_queue.empty())return false;
  task=std::move(g_super_engine_queue.front());g_super_engine_queue.pop_front();return true;
}
inline void super_engine_update_split(SuperEngineSplit&split,int score){
  std::lock_guard<std::mutex>lock(split.updateMutex);
  int best=split.best.load(std::memory_order_relaxed);if(score>best)split.best.store(score,std::memory_order_relaxed);
  int alpha=split.alpha.load(std::memory_order_relaxed);
  if(score>alpha){alpha=score;split.alpha.store(alpha,std::memory_order_release);if(alpha>=split.beta)split.cutoff.store(true,std::memory_order_release);}
}
void super_engine_execute(SuperEngineTask task){
  SuperEngineSplit&split=*task.split;
  if(!split.cutoff.load(std::memory_order_acquire)&&super_nodes_now()<g_node_limit){
    const int alphaSnapshot=split.alpha.load(std::memory_order_acquire);
    int score=-super_negamax_engine(task.pos,task.depth,-split.beta,-alphaSnapshot,task.perspective,task.ply);
    super_engine_update_split(split,score);
  }
  split.pending.fetch_sub(1,std::memory_order_release);
}
void super_engine_help_until(SuperEngineSplit&split){
  while(split.pending.load(std::memory_order_acquire)>0){
    SuperEngineTask task;
    if(super_engine_try_pop(task))super_engine_execute(std::move(task));else std::this_thread::yield();
  }
}
void super_engine_worker(int lane){
  g_super_lane=lane;g_super_node_lease=0;
  for(;;){
    SuperEngineTask task;
    {
      std::unique_lock<std::mutex>lock(g_super_engine_queue_mutex);
      super_return_node_lease();
      g_super_engine_idle.fetch_add(1,std::memory_order_relaxed);
      g_super_engine_queue_cv.wait(lock,[]{return g_super_engine_stop.load(std::memory_order_acquire)||!g_super_engine_queue.empty();});
      g_super_engine_idle.fetch_sub(1,std::memory_order_relaxed);
      if(g_super_engine_stop.load(std::memory_order_acquire)&&g_super_engine_queue.empty())break;
      task=std::move(g_super_engine_queue.front());g_super_engine_queue.pop_front();
    }
    super_engine_execute(std::move(task));
  }
  super_return_node_lease();
}
inline bool super_engine_should_split(int depth,int ply,int moveCount){
  if(depth<3||ply>7||moveCount<3||super_nodes_now()>=g_node_limit)return false;
  return g_super_engine_idle.load(std::memory_order_relaxed)>0;
}

int super_negamax_engine(Position&pos,int depth,int alpha,int beta,int perspective,int ply){
  if(!super_take_node())return super_specialist_eval(pos,perspective,0)*(pos.turn==perspective?1:-1);
  if(depth<=0)return super_qsearch(pos,alpha,beta,perspective,0,0);
  MoveList moves;super_generate_legal(pos,moves);if(moves.count==0)return super_is_check(pos,pos.turn)?-kMateScore+ply:0;super_order_moves(pos,moves,0);

  const Move first=moves.items[0];SuperUndo firstUndo;super_make_move(pos,first,firstUndo);
  int best=-super_negamax_engine(pos,depth-1,-beta,-alpha,perspective,ply+1);
  super_unmake_move(pos,first,firstUndo);
  if(best>alpha)alpha=best;
  if(alpha>=beta||moves.count<=1||super_nodes_now()>=g_node_limit)return best;

  if(!super_engine_should_split(depth,ply,moves.count)){
    for(int i=1;i<moves.count&&super_nodes_now()<g_node_limit;++i){const Move m=moves.items[i];SuperUndo undo;super_make_move(pos,m,undo);const int score=-super_negamax_engine(pos,depth-1,-beta,-alpha,perspective,ply+1);super_unmake_move(pos,m,undo);if(score>best)best=score;if(score>alpha)alpha=score;if(alpha>=beta)break;}
    return best;
  }

  SuperEngineSplit split;split.alpha.store(alpha,std::memory_order_relaxed);split.best.store(best,std::memory_order_relaxed);split.beta=beta;
  int taskCount=0;
  {
    std::lock_guard<std::mutex>lock(g_super_engine_queue_mutex);
    for(int i=1;i<moves.count;++i){
      if(split.cutoff.load(std::memory_order_relaxed)||super_nodes_now()>=g_node_limit)break;
      SuperEngineTask task;task.pos=pos;SuperUndo undo;super_make_move(task.pos,moves.items[i],undo);task.depth=depth-1;task.perspective=perspective;task.ply=ply+1;task.split=&split;g_super_engine_queue.push_back(std::move(task));++taskCount;
    }
    split.pending.store(taskCount,std::memory_order_release);
  }
  if(taskCount>0){g_super_engine_queue_cv.notify_all();super_engine_help_until(split);}
  return split.best.load(std::memory_order_acquire);
}

`;
replaceRange('int super_negamax(','int32_t super_search(',serialNegamax,'CONVERGENCE_ENGINE_NEGAMAX');

const search=`int32_t super_search_serial(const Position&root,int specialist,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){
  MoveList all;super_generate_legal(root,all);if(all.count==0)return-1;
  MoveList roots;if(restrictMoves&&restrictCount>0){for(int i=0;i<all.count;++i){const int32_t code=encode_move(all.items[i]);for(int j=0;j<restrictCount;++j)if(code==restrictMoves[j]){roots.add(all.items[i]);break;}}}else roots=all;
  if(roots.count==0)roots=all;super_order_moves(root,roots,specialist);g_node_limit=nodeLimit<100?100:nodeLimit>5000000?5000000:nodeLimit;super_reset_nodes(g_node_limit);
  int32_t bestMove=encode_move(roots.items[0]);int bestScore=-kInfinity;const int perspective=root.turn;Position work=root;
  for(int depth=1;depth<=maxDepth&&super_nodes_now()<g_node_limit;++depth){int layerBest=-kInfinity;int32_t layerMove=bestMove;bool completed=true;for(int i=0;i<roots.count;++i){const Move m=roots.items[i];SuperUndo undo;super_make_move(work,m,undo);const int score=-super_negamax_serial(work,depth-1,-kInfinity,kInfinity,perspective,specialist,1);super_unmake_move(work,m,undo);if(score>layerBest){layerBest=score;layerMove=encode_move(m);}if(super_nodes_now()>=g_node_limit){completed=false;break;}}if(completed||depth==1){bestMove=layerMove;bestScore=layerBest;}if(bestScore>=kMateScore-256)break;}
  super_return_node_lease();g_super_best_move=bestMove;g_super_best_score=bestScore;return bestMove;
}

int32_t super_search_convergence_engine(const Position&root,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){
  MoveList all;super_generate_legal(root,all);if(all.count==0)return-1;
  MoveList roots;if(restrictMoves&&restrictCount>0){for(int i=0;i<all.count;++i){const int32_t code=encode_move(all.items[i]);for(int j=0;j<restrictCount;++j)if(code==restrictMoves[j]){roots.add(all.items[i]);break;}}}else roots=all;
  if(roots.count==0)roots=all;super_order_moves(root,roots,0);g_node_limit=nodeLimit<100?100:nodeLimit>5000000?5000000:nodeLimit;super_reset_nodes(g_node_limit);

  {std::lock_guard<std::mutex>lock(g_super_engine_queue_mutex);g_super_engine_queue.clear();}
  g_super_engine_stop.store(false,std::memory_order_release);g_super_engine_idle.store(0,std::memory_order_relaxed);
  std::thread helpers[kSuperEngineThreads-1];for(int i=1;i<kSuperEngineThreads;++i)helpers[i-1]=std::thread(super_engine_worker,i);

  int32_t bestMove=encode_move(roots.items[0]);int bestScore=-kInfinity;const int perspective=root.turn;Position work=root;
  for(int depth=1;depth<=maxDepth&&super_nodes_now()<g_node_limit;++depth){
    int layerBest=-kInfinity;int32_t layerMove=bestMove;bool completed=true;
    for(int i=0;i<roots.count;++i){
      const Move m=roots.items[i];SuperUndo undo;super_make_move(work,m,undo);
      const int score=-super_negamax_engine(work,depth-1,-kInfinity,kInfinity,perspective,1);
      super_unmake_move(work,m,undo);
      if(score>layerBest){layerBest=score;layerMove=encode_move(m);}if(super_nodes_now()>=g_node_limit){completed=false;break;}
    }
    if(completed||depth==1){bestMove=layerMove;bestScore=layerBest;}if(bestScore>=kMateScore-256)break;
  }

  super_return_node_lease();
  g_super_engine_stop.store(true,std::memory_order_release);g_super_engine_queue_cv.notify_all();for(auto&helper:helpers)helper.join();
  {std::lock_guard<std::mutex>lock(g_super_engine_queue_mutex);g_super_engine_queue.clear();}
  g_super_best_move=bestMove;g_super_best_score=bestScore;return bestMove;
}

int32_t super_search(const Position&root,int specialist,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){
  if(specialist==0)return super_search_convergence_engine(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
  return super_search_serial(root,specialist,maxDepth,nodeLimit,restrictMoves,restrictCount);
}
`;
replaceRange('int32_t super_search(','}\n\nextern "C" {',search,'CONVERGENCE_ENGINE_SEARCH');

const getter='int32_t shogi_super_nodes_searched(){return g_super_nodes;}';
assert(source.includes(getter),'CONVERGENCE_ENGINE_GETTER_MISSING');
source=source.replace(getter,'int32_t shogi_super_nodes_searched(){return super_nodes_now();}');

await writeFile(output,source);
console.log(JSON.stringify({ok:true,input,output,bytes:source.length,architecture:'single shared split-point alpha-beta engine',threads:'compile-time SUPER_ENGINE_THREADS'}));
