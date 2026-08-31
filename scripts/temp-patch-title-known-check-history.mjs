import {readFile,writeFile} from 'node:fs/promises';

const path='cpp/engine_parallel.cpp';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  const count=source.split(oldText).length-1;
  if(count!==1)throw new Error(`${label}_ANCHOR_COUNT:${count}`);
  source=source.replace(oldText,newText);
}

replaceOnce(
`bool push_parallel_search_history(const Position& next, int mover) {
  if (!g_title_history_hash_ready) return push_search_history(next, mover);
  if (g_search_path_count >= kMaxSearchPath) return false;
  g_search_path[g_search_path_count++] = SearchHistoryEntry{
    title_history_key_fast(next),
    static_cast<int8_t>(mover),
    static_cast<uint8_t>(is_check(next, next.turn) ? 1 : 0),
  };
  const int depth = g_search_path_count;
  g_title_history_hash_stack[depth] = extend_title_history_hash(
    g_title_history_hash_stack[depth - 1],
    g_search_path[depth - 1]
  );
  return true;
}
`,
`bool push_parallel_search_history_known(const Position& next, int mover, bool gave_check) {
  if (!g_title_history_hash_ready) return push_search_history(next, mover);
  if (g_search_path_count >= kMaxSearchPath) return false;
  g_search_path[g_search_path_count++] = SearchHistoryEntry{
    title_history_key_fast(next),
    static_cast<int8_t>(mover),
    static_cast<uint8_t>(gave_check ? 1 : 0),
  };
  const int depth = g_search_path_count;
  g_title_history_hash_stack[depth] = extend_title_history_hash(
    g_title_history_hash_stack[depth - 1],
    g_search_path[depth - 1]
  );
  return true;
}

bool push_parallel_search_history(const Position& next, int mover) {
  if (!g_title_history_hash_ready) return push_search_history(next, mover);
  return push_parallel_search_history_known(next, mover, is_check(next, next.turn));
}
`,
'KNOWN_CHECK_HELPER',
);

replaceOnce(
`    if (!push_parallel_search_history(next, pos.turn)) {
      g_parallel_complete = false;
      return parallel_evaluate_for(pos, pos.turn);
    }
    const int score = -parallel_quiescence(next, -beta, -alpha, ply + 1, qdepth + 1);`,
`    const bool gave_check = g_parallel_profile >= 4 && ordered_check_count >= 0
      ? i < ordered_check_count
      : is_check(next, next.turn);
    if (!push_parallel_search_history_known(next, pos.turn, gave_check)) {
      g_parallel_complete = false;
      return parallel_evaluate_for(pos, pos.turn);
    }
    const int score = -parallel_quiescence(next, -beta, -alpha, ply + 1, qdepth + 1);`,
'QUIESCENCE_PUSH',
);

replaceOnce(
`  order_parallel_moves(pos, moves, tt_move, ply, true);
  const int offset = g_parallel_profile >= 4
    ? lane_offset_from_key(key, moves.count)
    : lane_offset(pos, moves.count, ply);`,
`  const int ordered_check_count = order_parallel_moves(pos, moves, tt_move, ply, true);
  const int offset = g_parallel_profile >= 4
    ? lane_offset_from_key(key, moves.count)
    : lane_offset(pos, moves.count, ply);`,
'NEGAMAX_CHECK_COUNT',
);

replaceOnce(
`    if (!push_parallel_search_history(next, pos.turn)) {
      g_parallel_complete = false;
      return parallel_evaluate_for(pos, pos.turn);
    }
    const int score = -parallel_negamax(next, depth - 1, -beta, -alpha, ply + 1);`,
`    const bool gave_check = g_parallel_profile >= 4 && ordered_check_count >= 0
      ? i < ordered_check_count
      : is_check(next, next.turn);
    if (!push_parallel_search_history_known(next, pos.turn, gave_check)) {
      g_parallel_complete = false;
      return parallel_evaluate_for(pos, pos.turn);
    }
    const int score = -parallel_negamax(next, depth - 1, -beta, -alpha, ply + 1);`,
'NEGAMAX_PUSH',
);

await writeFile(path,source);
