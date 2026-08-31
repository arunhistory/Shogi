import {readFile,writeFile} from 'node:fs/promises';

const path='cpp/engine_parallel.cpp';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  const count=source.split(oldText).length-1;
  if(count!==1)throw new Error(`${label}_ANCHOR_COUNT:${count}`);
  source=source.replace(oldText,newText);
}

replaceOnce(
`uint64_t parallel_contextual_tt_key(const Position& pos) {
  if (!g_title_history_hash_ready) return contextual_tt_key(pos);
  const uint64_t context = g_title_history_hash_stack[g_search_path_count];
  return hash_position(pos) ^ ((context << 1) | (context >> 63));
}`,
`uint64_t parallel_contextual_tt_key(const Position& pos) {
  if (!g_title_history_hash_ready) return contextual_tt_key(pos);
  const uint64_t context = g_title_history_hash_stack[g_search_path_count];
  const uint64_t position_hash = g_search_path_count > 0
    ? g_search_path[g_search_path_count - 1].key.primary
    : hash_position(pos);
  return position_hash ^ ((context << 1) | (context >> 63));
}`,
'POSITION_HASH_REUSE',
);

await writeFile(path,source);
