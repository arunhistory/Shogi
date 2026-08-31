import {readFile,writeFile} from 'node:fs/promises';

const input=process.argv[2]??'/tmp/title_supercomputer_inplace.cpp';
const output=process.argv[3]??'/tmp/title_supercomputer_specialized.cpp';
let source=await readFile(input,'utf8');
const assert=(c,m)=>{if(!c)throw new Error(m);};
const replaceRange=(a,b,r,m)=>{const s=source.indexOf(a);assert(s>=0,m+'_START');const e=source.indexOf(b,s+a.length);assert(e>s,m+'_END');source=source.slice(0,s)+r+source.slice(e);};

const recursion=`template<int S> int super_qsearch_fixed(Position&pos,int alpha,int beta,int perspective,int ply){
  if(g_super_nodes>=g_node_limit)return super_specialist_eval(pos,perspective,S)*(pos.turn==perspective?1:-1);
  ++g_super_nodes;
  const int stand=super_specialist_eval(pos,perspective,S)*(pos.turn==perspective?1:-1);
  if(stand>=beta)return beta;if(stand>alpha)alpha=stand;
  if(ply>=1)return alpha;
  MoveList moves;super_generate_legal(pos,moves);super_order_moves(pos,moves,S);const int targetKing=king_square_for_side(pos,-pos.turn);
  for(int i=0;i<moves.count&&g_super_nodes<g_node_limit;++i){
    const Move m=moves.items[i];const bool capture=m.from>=0&&pos.board[m.to]!=0;if(!capture&&!m.promote&&!m.drop)continue;
    SuperUndo undo;super_make_move(pos,m,undo);const bool checking=super_is_check_at(pos,pos.turn,targetKing);
    if(!capture&&!m.promote&&!checking){super_unmake_move(pos,m,undo);continue;}
    const int score=-super_qsearch_fixed<S>(pos,-beta,-alpha,perspective,ply+1);super_unmake_move(pos,m,undo);
    if(score>=beta)return beta;if(score>alpha)alpha=score;
  }
  return alpha;
}

template<int S> int super_negamax_fixed(Position&pos,int depth,int alpha,int beta,int perspective,int ply){
  if(g_super_nodes>=g_node_limit)return super_specialist_eval(pos,perspective,S)*(pos.turn==perspective?1:-1);
  ++g_super_nodes;
  if(depth<=0)return super_qsearch_fixed<S>(pos,alpha,beta,perspective,0);
  MoveList moves;super_generate_legal(pos,moves);if(moves.count==0)return super_is_check(pos,pos.turn)?-kMateScore+ply:0;super_order_moves(pos,moves,S);
  int best=-kInfinity;
  for(int i=0;i<moves.count&&g_super_nodes<g_node_limit;++i){const Move m=moves.items[i];SuperUndo undo;super_make_move(pos,m,undo);const int score=-super_negamax_fixed<S>(pos,depth-1,-beta,-alpha,perspective,ply+1);super_unmake_move(pos,m,undo);if(score>best)best=score;if(score>alpha)alpha=score;if(alpha>=beta)break;}
  return best;
}

`;
replaceRange('int super_qsearch(','int32_t super_search(',recursion,'SPECIALIZE_RECURSION');

const fixedSearch=`template<int S> int32_t super_search_fixed(const Position&root,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){
  MoveList all;super_generate_legal(root,all);if(all.count==0)return-1;
  MoveList roots;if(restrictMoves&&restrictCount>0){for(int i=0;i<all.count;++i){const int32_t code=encode_move(all.items[i]);for(int j=0;j<restrictCount;++j)if(code==restrictMoves[j]){roots.add(all.items[i]);break;}}}else roots=all;
  if(roots.count==0)roots=all;super_order_moves(root,roots,S);g_node_limit=nodeLimit<100?100:nodeLimit>5000000?5000000:nodeLimit;g_super_nodes=0;
  int32_t bestMove=encode_move(roots.items[0]);int bestScore=-kInfinity;const int perspective=root.turn;Position work=root;
  for(int depth=1;depth<=maxDepth&&g_super_nodes<g_node_limit;++depth){int layerBest=-kInfinity;int32_t layerMove=bestMove;bool completed=true;for(int i=0;i<roots.count;++i){const Move m=roots.items[i];SuperUndo undo;super_make_move(work,m,undo);const int score=-super_negamax_fixed<S>(work,depth-1,-kInfinity,kInfinity,perspective,1);super_unmake_move(work,m,undo);if(score>layerBest){layerBest=score;layerMove=encode_move(m);}if(g_super_nodes>=g_node_limit){completed=false;break;}}if(completed||depth==1){bestMove=layerMove;bestScore=layerBest;}if(bestScore>=kMateScore-256)break;}
  g_super_best_move=bestMove;g_super_best_score=bestScore;return bestMove;
}

int32_t super_search(const Position&root,int specialist,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){
  switch(specialist){
    case 0:return super_search_fixed<0>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 1:return super_search_fixed<1>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 2:return super_search_fixed<2>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 3:return super_search_fixed<3>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 4:return super_search_fixed<4>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 5:return super_search_fixed<5>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 6:return super_search_fixed<6>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 7:return super_search_fixed<7>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 8:return super_search_fixed<8>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 9:return super_search_fixed<9>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 10:return super_search_fixed<10>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 11:return super_search_fixed<11>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 12:return super_search_fixed<12>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 13:return super_search_fixed<13>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 14:return super_search_fixed<14>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 15:return super_search_fixed<15>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 16:return super_search_fixed<16>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 17:return super_search_fixed<17>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 18:return super_search_fixed<18>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 19:return super_search_fixed<19>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    case 20:return super_search_fixed<20>(root,maxDepth,nodeLimit,restrictMoves,restrictCount);
    default:return-1;
  }
}
`;
replaceRange('int32_t super_search(','}\n\nextern "C" {',fixedSearch,'SPECIALIZE_SEARCH');
await writeFile(output,source);
console.log(JSON.stringify({ok:true,input,output,bytes:source.length}));