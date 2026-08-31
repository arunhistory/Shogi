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
  if (!push_search_history(next, mover)) return false;
  if (g_title_history_hash_ready) {
    const int depth = g_search_path_count;
    g_title_history_hash_stack[depth] = extend_title_history_hash(
      g_title_history_hash_stack[depth - 1],
      g_search_path[depth - 1]
    );
  }
  return true;
}
`,
`HistoryKey title_history_key_fast(const Position& pos) {
  uint64_t primary = 1469598103934665603ULL;
  uint64_t secondary = kSecondarySeed;
  auto mix = [&primary, &secondary](uint8_t value) {
    primary ^= value;
    primary *= 1099511628211ULL;
    secondary ^= value;
    secondary *= 1099511628211ULL;
  };
  for (int i = 0; i < 81; ++i) mix(static_cast<uint8_t>(pos.board[i] + 16));
  for (int s = 0; s < 2; ++s) {
    for (int k = 0; k < 7; ++k) mix(static_cast<uint8_t>(pos.hands[s][k]));
  }
  mix(static_cast<uint8_t>(pos.turn == 1 ? 1 : 2));
  return HistoryKey{primary, secondary};
}

bool push_parallel_search_history(const Position& next, int mover) {
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
'DUAL_HISTORY_KEY',
);

await writeFile(path,source);
