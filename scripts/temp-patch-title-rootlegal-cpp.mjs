import {readFile,writeFile} from 'node:fs/promises';

const path='cpp/engine_parallel.cpp';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  if(!source.includes(oldText))throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  source=source.replace(oldText,newText);
}

replaceOnce(
`uint32_t g_parallel_lane = 0;
int g_parallel_profile = 0;`,
`uint32_t g_parallel_lane = 0;
int g_parallel_profile = 0;
bool g_title_root_legal_cached = false;
HistoryKey g_title_root_legal_position_key{};
uint64_t g_title_root_legal_history_context = 0;
MoveList g_title_root_legal_cache;`,
  'CACHE_DECLARATION',
);

replaceOnce(
`  MoveList legal;
  generate_legal(root, legal);
  if (legal.count == 0) return kParallelInvalidScore;
  bool found = false;
  Move verified{};
  for (int i = 0; i < legal.count; ++i) {
    if (same_move_value(legal.items[i], requested)) {
      verified = legal.items[i];`,
`  MoveList local_legal;
  const MoveList* legal = &local_legal;
  if (g_parallel_profile >= 4) {
    const HistoryKey root_position_key = history_key(root);
    const uint64_t root_history_context = history_context_hash();
    if (!g_title_root_legal_cached
        || !same_history_key(g_title_root_legal_position_key, root_position_key)
        || g_title_root_legal_history_context != root_history_context) {
      generate_legal(root, g_title_root_legal_cache);
      g_title_root_legal_position_key = root_position_key;
      g_title_root_legal_history_context = root_history_context;
      g_title_root_legal_cached = true;
    }
    legal = &g_title_root_legal_cache;
  } else {
    generate_legal(root, local_legal);
  }
  if (legal->count == 0) return kParallelInvalidScore;
  bool found = false;
  Move verified{};
  for (int i = 0; i < legal->count; ++i) {
    if (same_move_value(legal->items[i], requested)) {
      verified = legal->items[i];`,
  'ROOT_LEGAL_CACHE',
);

await writeFile(path,source);
