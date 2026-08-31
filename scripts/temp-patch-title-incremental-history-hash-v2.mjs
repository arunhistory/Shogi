import {readFile,writeFile} from 'node:fs/promises';

const path='cpp/engine_parallel.cpp';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  if(!source.includes(oldText))throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  source=source.replace(oldText,newText);
}

// Redirect only the original parallel-search history operations before the
// wrapper implementations are inserted, so the wrappers cannot self-rewrite.
const pushAnchor='if (!push_search_history(next, pos.turn))';
const popAnchor='pop_search_history();';
const pushCount=source.split(pushAnchor).length-1;
const popCount=source.split(popAnchor).length-1;
if(pushCount!==3)throw new Error(`UNEXPECTED_PUSH_COUNT:${pushCount}`);
if(popCount!==3)throw new Error(`UNEXPECTED_POP_COUNT:${popCount}`);
source=source.replaceAll(pushAnchor,'if (!push_parallel_search_history(next, pos.turn))');
source=source.replaceAll(popAnchor,'pop_parallel_search_history();');

replaceOnce(
`int g_parallel_profile = 0;
`,
`int g_parallel_profile = 0;
uint64_t g_title_history_hash_stack[kMaxSearchPath + 1] = {};
bool g_title_history_hash_ready = false;

uint64_t extend_title_history_hash(uint64_t h, const SearchHistoryEntry& entry) {
  auto mix_byte = [&h](uint8_t value) { h ^= value; h *= 1099511628211ULL; };
  auto mix_u64 = [&mix_byte](uint64_t value) {
    for (int shift = 0; shift < 64; shift += 8) mix_byte(static_cast<uint8_t>((value >> shift) & 0xff));
  };
  mix_u64(entry.key.primary);
  mix_u64(entry.key.secondary);
  mix_byte(static_cast<uint8_t>(entry.mover + 1));
  mix_byte(entry.gave_check);
  return h;
}

void reset_title_history_hash() {
  g_title_history_hash_ready = g_parallel_profile >= 4;
  if (g_title_history_hash_ready) g_title_history_hash_stack[0] = history_context_hash();
}

bool push_parallel_search_history(const Position& next, int mover) {
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

void pop_parallel_search_history() {
  pop_search_history();
}

uint64_t parallel_contextual_tt_key(const Position& pos) {
  if (!g_title_history_hash_ready) return contextual_tt_key(pos);
  const uint64_t context = g_title_history_hash_stack[g_search_path_count];
  return hash_position(pos) ^ ((context << 1) | (context >> 63));
}
`,
  'HASH_HELPERS',
);

replaceOnce(
`uint64_t lane_key(const Position& pos, int ply) {
  uint64_t value = contextual_tt_key(pos);`,
`uint64_t lane_key(const Position& pos, int ply) {
  uint64_t value = parallel_contextual_tt_key(pos);`,
  'LANE_KEY',
);

replaceOnce(
`  g_parallel_profile = profile < 0 ? 0 : profile > 4 ? 4 : profile;
  if (repetition_code(root) != 0) return kParallelInvalidScore;`,
`  g_parallel_profile = profile < 0 ? 0 : profile > 4 ? 4 : profile;
  reset_title_history_hash();
  if (repetition_code(root) != 0) return kParallelInvalidScore;`,
  'ROOT_RESET',
);

await writeFile(path,source);
