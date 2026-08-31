import {readFile,writeFile} from 'node:fs/promises';

const input=process.argv[2]??'/tmp/title_supercomputer_metrics.cpp';
const output=process.argv[3]??'/tmp/title_supercomputer_inplace.cpp';
let source=await readFile(input,'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const replaceRange=(startToken,endToken,replacement,label)=>{
  const start=source.indexOf(startToken);assert(start>=0,`${label}_START_MISSING`);
  const end=source.indexOf(endToken,start+startToken.length);assert(end>start,`${label}_END_MISSING`);
  source=source.slice(0,start)+replacement+source.slice(end);
};

const insertAnchor='void super_generate_legal(const Position&pos,MoveList&out);\n';
assert(source.includes(insertAnchor),'INPLACE_INSERT_ANCHOR_MISSING');
const inplace=`struct SuperUndo{int8_t fromPiece=0;int8_t toPiece=0;int8_t oldTurn=1;int8_t capturedBase=0;};
inline void super_make_move(Position&pos,const Move&move,SuperUndo&undo){
  const int side=pos.turn;undo.oldTurn=pos.turn;undo.toPiece=pos.board[move.to];undo.fromPiece=move.from>=0?pos.board[move.from]:0;undo.capturedBase=0;
  if(move.drop>0){pos.board[move.to]=static_cast<int8_t>(side*move.drop);--pos.hands[side_index(side)][move.drop-1];}
  else{int code=pos.board[move.from];const int captured=pos.board[move.to];pos.board[move.from]=0;if(captured!=0){const int base=base_kind(kind_of(captured));if(base>=1&&base<=7){++pos.hands[side_index(side)][base-1];undo.capturedBase=static_cast<int8_t>(base);}}if(move.promote)code=side*promoted_kind(base_kind(kind_of(code)));pos.board[move.to]=static_cast<int8_t>(code);}
  pos.turn=static_cast<int8_t>(-side);
}
inline void super_unmake_move(Position&pos,const Move&move,const SuperUndo&undo){
  const int side=undo.oldTurn;pos.turn=undo.oldTurn;
  if(move.drop>0){pos.board[move.to]=undo.toPiece;++pos.hands[side_index(side)][move.drop-1];}
  else{pos.board[move.from]=undo.fromPiece;pos.board[move.to]=undo.toPiece;if(undo.capturedBase>0)--pos.hands[side_index(side)][undo.capturedBase-1];}
}
inline bool super_position_equal(const Position&a,const Position&b){return std::memcmp(&a,&b,sizeof(Position))==0;}

`;
source=source.replace(insertAnchor,inplace+insertAnchor);

const drops=`void super_generate_drops(const Position&pos,MoveList&out){
  const int side=pos.turn,handSide=side_index(side),ownKing=king_square_for_side(pos,side),enemyKing=king_square_for_side(pos,-side);bool pawnFile[9]={};
  if(pos.hands[handSide][0]>0)for(int sq=0;sq<81;++sq)if(pos.board[sq]==side)pawnFile[col_of(sq)]=true;
  Position work=pos;
  for(int kind=1;kind<=7;++kind){
    if(pos.hands[handSide][kind-1]<=0)continue;
    for(int to=0;to<81;++to){
      if(pos.board[to]!=0)continue;const int y=row_of(to),x=col_of(to);
      if((kind==1||kind==2)&&(side==1?y==0:y==8))continue;
      if(kind==3&&(side==1?y<=1:y>=7))continue;
      if(kind==1&&pawnFile[x])continue;
      const Move move{-1,static_cast<int16_t>(to),static_cast<int8_t>(kind),0};SuperUndo undo;super_make_move(work,move,undo);
      const bool selfCheck=super_is_check_at(work,side,ownKing);bool pawnMate=false;
      if(!selfCheck&&kind==1&&super_is_check_at(work,work.turn,enemyKing)){MoveList replies;super_generate_legal(work,replies);pawnMate=replies.count==0;}
      super_unmake_move(work,move,undo);if(selfCheck||pawnMate)continue;out.add(move);
    }
  }
}
`;
replaceRange('void super_generate_drops(const Position&pos,MoveList&out){','void super_generate_legal(const Position&pos,MoveList&out){',drops,'INPLACE_DROPS');

const legal=`void super_generate_legal(const Position&pos,MoveList&out){
  out.count=0;out.overflow=false;const int ownKing=king_square_for_side(pos,pos.turn);MoveList pseudo;generate_board_pseudo(pos,pseudo);Position work=pos;
  for(int i=0;i<pseudo.count;++i){const Move move=pseudo.items[i];SuperUndo undo;super_make_move(work,move,undo);const int king=move.from==ownKing?move.to:ownKing;const bool legal=!super_is_check_at(work,pos.turn,king);super_unmake_move(work,move,undo);if(legal)out.add(move);}
  super_generate_drops(pos,out);
}

`;
replaceRange('void super_generate_legal(const Position&pos,MoveList&out){','int super_base_eval(',legal,'INPLACE_LEGAL');

const qsearch=`int super_qsearch(Position&pos,int alpha,int beta,int perspective,int specialist,int ply){
  if(g_super_nodes>=g_node_limit)return super_specialist_eval(pos,perspective,specialist)*(pos.turn==perspective?1:-1);
  ++g_super_nodes;
  const int stand=super_specialist_eval(pos,perspective,specialist)*(pos.turn==perspective?1:-1);
  if(stand>=beta)return beta;if(stand>alpha)alpha=stand;
  if(ply>=1)return alpha;
  MoveList moves;super_generate_legal(pos,moves);super_order_moves(pos,moves,specialist);const int targetKing=king_square_for_side(pos,-pos.turn);
  for(int i=0;i<moves.count&&g_super_nodes<g_node_limit;++i){
    const Move m=moves.items[i];const bool capture=m.from>=0&&pos.board[m.to]!=0;if(!capture&&!m.promote&&!m.drop)continue;
    SuperUndo undo;super_make_move(pos,m,undo);const bool checking=super_is_check_at(pos,pos.turn,targetKing);
    if(!capture&&!m.promote&&!checking){super_unmake_move(pos,m,undo);continue;}
    const int score=-super_qsearch(pos,-beta,-alpha,perspective,specialist,ply+1);super_unmake_move(pos,m,undo);
    if(score>=beta)return beta;if(score>alpha)alpha=score;
  }
  return alpha;
}

`;
replaceRange('int super_qsearch(','int super_negamax(',qsearch,'INPLACE_QSEARCH');

const negamax=`int super_negamax(Position&pos,int depth,int alpha,int beta,int perspective,int specialist,int ply){
  if(g_super_nodes>=g_node_limit)return super_specialist_eval(pos,perspective,specialist)*(pos.turn==perspective?1:-1);
  ++g_super_nodes;
  if(depth<=0)return super_qsearch(pos,alpha,beta,perspective,specialist,0);
  MoveList moves;super_generate_legal(pos,moves);if(moves.count==0)return super_is_check(pos,pos.turn)?-kMateScore+ply:0;super_order_moves(pos,moves,specialist);
  int best=-kInfinity;
  for(int i=0;i<moves.count&&g_super_nodes<g_node_limit;++i){const Move m=moves.items[i];SuperUndo undo;super_make_move(pos,m,undo);const int score=-super_negamax(pos,depth-1,-beta,-alpha,perspective,specialist,ply+1);super_unmake_move(pos,m,undo);if(score>best)best=score;if(score>alpha)alpha=score;if(alpha>=beta)break;}
  return best;
}

`;
replaceRange('int super_negamax(','int32_t super_search(',negamax,'INPLACE_NEGAMAX');

const search=`int32_t super_search(const Position&root,int specialist,int maxDepth,int nodeLimit,const int32_t*restrictMoves,int restrictCount){
  MoveList all;super_generate_legal(root,all);if(all.count==0)return-1;
  MoveList roots;if(restrictMoves&&restrictCount>0){for(int i=0;i<all.count;++i){const int32_t code=encode_move(all.items[i]);for(int j=0;j<restrictCount;++j)if(code==restrictMoves[j]){roots.add(all.items[i]);break;}}}else roots=all;
  if(roots.count==0)roots=all;super_order_moves(root,roots,specialist);g_node_limit=nodeLimit<100?100:nodeLimit>5000000?5000000:nodeLimit;g_super_nodes=0;
  int32_t bestMove=encode_move(roots.items[0]);int bestScore=-kInfinity;const int perspective=root.turn;Position work=root;
  for(int depth=1;depth<=maxDepth&&g_super_nodes<g_node_limit;++depth){int layerBest=-kInfinity;int32_t layerMove=bestMove;bool completed=true;for(int i=0;i<roots.count;++i){const Move m=roots.items[i];SuperUndo undo;super_make_move(work,m,undo);const int score=-super_negamax(work,depth-1,-kInfinity,kInfinity,perspective,specialist,1);super_unmake_move(work,m,undo);if(score>layerBest){layerBest=score;layerMove=encode_move(m);}if(g_super_nodes>=g_node_limit){completed=false;break;}}if(completed||depth==1){bestMove=layerMove;bestScore=layerBest;}if(bestScore>=kMateScore-256)break;}
  g_super_best_move=bestMove;g_super_best_score=bestScore;return bestMove;
}
`;
replaceRange('int32_t super_search(','}\n\nextern "C" {',search+'}\n\n','INPLACE_SEARCH');

const externAnchor='extern "C" {\n';
assert(source.includes(externAnchor),'INPLACE_EXTERN_MISSING');
source=source.replace(externAnchor,externAnchor+`int32_t shogi_super_inplace_selftest(int32_t count){Position pos;if(!load_position(count,pos))return-1;MoveList moves;super_generate_legal(pos,moves);for(int i=0;i<moves.count;++i){const Position before=pos;SuperUndo undo;super_make_move(pos,moves.items[i],undo);super_unmake_move(pos,moves.items[i],undo);if(!super_position_equal(pos,before))return-1000-i;}return moves.count;}\n`);

await writeFile(output,source);
console.log(JSON.stringify({ok:true,input,output,bytes:source.length}));