import {readFile,writeFile} from 'node:fs/promises';

const input=process.argv[2]??'/tmp/title_supercomputer_inplace.cpp';
const output=process.argv[3]??'/tmp/title_supercomputer_dual12.cpp';
let source=await readFile(input,'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const replaceRange=(startToken,endToken,replacement,label)=>{
  const start=source.indexOf(startToken);assert(start>=0,`${label}_START_MISSING`);
  const end=source.indexOf(endToken,start+startToken.length);assert(end>start,`${label}_END_MISSING`);
  source=source.slice(0,start)+replacement+source.slice(end);
};

const includeAnchor='#include "engine_future.cpp"\n';
assert(source.includes(includeAnchor),'DUAL12_INCLUDE_ANCHOR_MISSING');
source=source.replace(includeAnchor,'#include <atomic>\n#include <thread>\n'+includeAnchor);

const nodeGlobal='int32_t g_super_nodes = 0;\n';
assert(source.includes(nodeGlobal),'DUAL12_NODE_GLOBAL_MISSING');
source=source.replace(nodeGlobal,`std::atomic<int32_t> g_super_nodes{0};
inline int32_t super_nodes_now(){return g_super_nodes.load(std::memory_order_relaxed);}
inline bool super_take_node(){
  int32_t current=g_super_nodes.load(std::memory_order_relaxed);
  while(current<g_node_limit){
    if(g_super_nodes.compare_exchange_weak(current,current+1,std::memory_order_relaxed,std::memory_order_relaxed))return true;
  }
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
replaceRange('int super_qsearch(','int super_negamax(',qsearch,'DUAL12_QSEARCH');

const negamax=`int super_negamax(Position&pos,int depth,int alpha,int beta,int perspective,int specialist,int ply){
  if(!super_take_node())return super_specialist_eval(pos,perspective,specialist)*(pos.turn==perspective?1:-1);
  if(depth<=0)return super_qsearch(pos,alpha,beta,perspective,specialist,0);
  MoveList moves;super_generate_legal(pos,moves);if(moves.count==0)return super_is_check(pos,pos.turn)?-kMateScore+ply:0;super_order_moves(pos,moves,specialist);
  int best=-kInfinity;
  for(int i=0;i<moves.count&&super_nodes_now()<g_node_limit;++i){const Move m=moves.items[i];SuperUndo undo;super_make_move(pos,m,undo);const int score=-super_negamax(pos,depth-1,-beta,-alpha,perspective,specialist,ply+1);super_unmake_move(pos,m,undo);if(score>best)best=score;if(score>alpha)alpha=score;if(alpha>=beta)break;}
  return best;
}

`;
replaceRange('int super_negamax(','int32_t super_search(',negamax,'DUAL12_NEGAMAX');

const search=`int32_t super_search_serial(const Position&root,int specialist,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){
  MoveList all;super_generate_legal(root,all);if(all.count==0)return-1;
  MoveList roots;if(restrictMoves&&restrictCount>0){for(int i=0;i<all.count;++i){const int32_t code=encode_move(all.items[i]);for(int j=0;j<restrictCount;++j)if(code==restrictMoves[j]){roots.add(all.items[i]);break;}}}else roots=all;
  if(roots.count==0)roots=all;super_order_moves(root,roots,specialist);g_node_limit=nodeLimit<100?100:nodeLimit>5000000?5000000:nodeLimit;g_super_nodes.store(0,std::memory_order_relaxed);
  int32_t bestMove=encode_move(roots.items[0]);int bestScore=-kInfinity;const int perspective=root.turn;Position work=root;
  for(int depth=1;depth<=maxDepth&&super_nodes_now()<g_node_limit;++depth){int layerBest=-kInfinity;int32_t layerMove=bestMove;bool completed=true;for(int i=0;i<roots.count;++i){const Move m=roots.items[i];SuperUndo undo;super_make_move(work,m,undo);const int score=-super_negamax(work,depth-1,-kInfinity,kInfinity,perspective,specialist,1);super_unmake_move(work,m,undo);if(score>layerBest){layerBest=score;layerMove=encode_move(m);}if(super_nodes_now()>=g_node_limit){completed=false;break;}}if(completed||depth==1){bestMove=layerMove;bestScore=layerBest;}if(bestScore>=kMateScore-256)break;}
  g_super_best_move=bestMove;g_super_best_score=bestScore;return bestMove;
}

int32_t super_search_dual12(const Position&root,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){
  MoveList all;super_generate_legal(root,all);if(all.count==0)return-1;
  MoveList roots;if(restrictMoves&&restrictCount>0){for(int i=0;i<all.count;++i){const int32_t code=encode_move(all.items[i]);for(int j=0;j<restrictCount;++j)if(code==restrictMoves[j]){roots.add(all.items[i]);break;}}}else roots=all;
  if(roots.count==0)roots=all;super_order_moves(root,roots,12);g_node_limit=nodeLimit<100?100:nodeLimit>5000000?5000000:nodeLimit;g_super_nodes.store(0,std::memory_order_relaxed);
  int32_t bestMove=encode_move(roots.items[0]);int bestScore=-kInfinity;const int perspective=root.turn;
  constexpr int kUnset=-kInfinity-1;
  for(int depth=1;depth<=maxDepth&&super_nodes_now()<g_node_limit;++depth){
    int scores[kMaxMoves];for(int i=0;i<roots.count;++i)scores[i]=kUnset;
    std::atomic<int> nextRoot{0};
    auto runRoots=[&](){
      for(;;){
        if(super_nodes_now()>=g_node_limit)break;
        const int i=nextRoot.fetch_add(1,std::memory_order_relaxed);if(i>=roots.count)break;
        Position work=root;const Move m=roots.items[i];SuperUndo undo;super_make_move(work,m,undo);
        const int score=-super_negamax(work,depth-1,-kInfinity,kInfinity,perspective,12,1);
        super_unmake_move(work,m,undo);scores[i]=score;
      }
    };
    std::thread helper(runRoots);runRoots();helper.join();
    int layerBest=-kInfinity;int32_t layerMove=bestMove;bool completed=super_nodes_now()<g_node_limit;
    for(int i=0;i<roots.count;++i){if(scores[i]==kUnset){completed=false;continue;}if(scores[i]>layerBest){layerBest=scores[i];layerMove=encode_move(roots.items[i]);}}
    if(completed||depth==1){bestMove=layerMove;bestScore=layerBest;}
    if(bestScore>=kMateScore-256)break;
  }
  g_super_best_move=bestMove;g_super_best_score=bestScore;return bestMove;
}

int32_t super_search(const Position&root,int specialist,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){
  if(specialist==12)return super_search_dual12(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
  return super_search_serial(root,specialist,maxDepth,nodeLimit,restrictMoves,restrictCount);
}
`;
replaceRange('int32_t super_search(','}\n\nextern "C" {',search,'DUAL12_SEARCH');

const getter='int32_t shogi_super_nodes_searched(){return g_super_nodes;}';
assert(source.includes(getter),'DUAL12_GETTER_MISSING');
source=source.replace(getter,'int32_t shogi_super_nodes_searched(){return super_nodes_now();}');

await writeFile(output,source);
console.log(JSON.stringify({ok:true,input,output,bytes:source.length}));
