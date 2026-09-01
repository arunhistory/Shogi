import {readFile,writeFile} from 'node:fs/promises';

const input=process.argv[2]??'/tmp/title_supercomputer_engine.cpp';
const output=process.argv[3]??'/tmp/title_supercomputer_practical.cpp';
let source=await readFile(input,'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

const searchToken='int32_t super_search(const Position&root,int specialist,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){';
const start=source.indexOf(searchToken);
assert(start>=0,'PRACTICAL_SEARCH_START_MISSING');
const externAnchor='}\n\nextern "C" {';
const searchEnd=source.indexOf(externAnchor,start);
assert(searchEnd>start,'PRACTICAL_SEARCH_END_MISSING');

const replacement=`int32_t super_search_dual12(const Position&root,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){
  MoveList all;super_generate_legal(root,all);if(all.count==0)return-1;
  MoveList roots;if(restrictMoves&&restrictCount>0){for(int i=0;i<all.count;++i){const int32_t code=encode_move(all.items[i]);for(int j=0;j<restrictCount;++j)if(code==restrictMoves[j]){roots.add(all.items[i]);break;}}}else roots=all;
  if(roots.count==0)roots=all;super_order_moves(root,roots,12);g_node_limit=nodeLimit<100?100:nodeLimit>5000000?5000000:nodeLimit;super_reset_nodes(g_node_limit);
  int32_t bestMove=encode_move(roots.items[0]);int bestScore=-kInfinity;const int perspective=root.turn;constexpr int kUnset=-kInfinity-1;
  int scores[kMaxMoves];std::atomic<int>nextRoot{0},phase{0},helperDone{0};std::atomic<bool>stop{false};
  auto runRoots=[&](int depthValue){
    for(;;){
      if(super_nodes_now()>=g_node_limit)break;
      const int i=nextRoot.fetch_add(1,std::memory_order_relaxed);if(i>=roots.count)break;
      Position work=root;const Move m=roots.items[i];SuperUndo undo;super_make_move(work,m,undo);
      const int score=-super_negamax_serial(work,depthValue-1,-kInfinity,kInfinity,perspective,12,1);
      super_unmake_move(work,m,undo);scores[i]=score;
    }
  };
  std::thread helper([&](){
    g_super_lane=1;g_super_node_lease=0;int seen=0;
    for(;;){
      int p=phase.load(std::memory_order_acquire);
      while(p==seen&&!stop.load(std::memory_order_acquire)){std::this_thread::yield();p=phase.load(std::memory_order_acquire);}
      if(stop.load(std::memory_order_acquire))break;
      seen=p;runRoots(seen);super_return_node_lease();helperDone.store(seen,std::memory_order_release);
    }
    super_return_node_lease();
  });
  for(int depth=1;depth<=maxDepth&&super_nodes_now()<g_node_limit;++depth){
    for(int i=0;i<roots.count;++i)scores[i]=kUnset;nextRoot.store(0,std::memory_order_relaxed);helperDone.store(0,std::memory_order_relaxed);
    phase.store(depth,std::memory_order_release);runRoots(depth);
    while(helperDone.load(std::memory_order_acquire)!=depth)std::this_thread::yield();
    int layerBest=-kInfinity;int32_t layerMove=bestMove;bool completed=super_nodes_now()<g_node_limit;
    for(int i=0;i<roots.count;++i){if(scores[i]==kUnset){completed=false;continue;}if(scores[i]>layerBest){layerBest=scores[i];layerMove=encode_move(roots.items[i]);}}
    if(completed||depth==1){bestMove=layerMove;bestScore=layerBest;}
    if(bestScore>=kMateScore-256)break;
  }
  stop.store(true,std::memory_order_release);phase.fetch_add(1,std::memory_order_release);helper.join();super_return_node_lease();
  g_super_best_move=bestMove;g_super_best_score=bestScore;return bestMove;
}

int32_t super_search(const Position&root,int specialist,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){
  if(specialist==0)return super_search_convergence_engine(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
  if(specialist==12)return super_search_dual12(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
  return super_search_serial(root,specialist,maxDepth,nodeLimit,restrictMoves,restrictCount);
}
`;

source=source.slice(0,start)+replacement+source.slice(searchEnd+1);
assert(source.includes('if(specialist==12)return super_search_dual12'),'PRACTICAL_DUAL12_DISPATCH_MISSING');
assert(source.includes('if(specialist==0)return super_search_convergence_engine'),'PRACTICAL_CONVERGENCE_DISPATCH_MISSING');
await writeFile(output,source);
console.log(JSON.stringify({ok:true,input,output,bytes:source.length,architecture:'dual12 plus shared multicore convergence'}));
