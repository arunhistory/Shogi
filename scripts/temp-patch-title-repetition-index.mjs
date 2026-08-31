import {readFile,writeFile} from 'node:fs/promises';

const path='cpp/engine_parallel.cpp';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  const count=source.split(oldText).length-1;
  if(count!==1)throw new Error(`${label}_ANCHOR_COUNT:${count}`);
  source=source.replace(oldText,newText);
}

replaceOnce(
`void reset_title_history_hash() {
  g_title_history_hash_ready = g_parallel_profile >= 4;
  if (g_title_history_hash_ready) g_title_history_hash_stack[0] = history_context_hash();
}`,
`constexpr int kTitleRootOccurrenceTableSize = 2048;
HistoryKey g_title_root_occurrence_keys[kTitleRootOccurrenceTableSize] = {};
uint16_t g_title_root_occurrence_counts[kTitleRootOccurrenceTableSize] = {};
uint8_t g_title_root_occurrence_used[kTitleRootOccurrenceTableSize] = {};
bool g_title_root_occurrence_ready = false;

int title_root_occurrence_slot(const HistoryKey& key) {
  uint64_t mixed = key.primary ^ ((key.secondary << 1) | (key.secondary >> 63));
  int slot = static_cast<int>(mixed & (kTitleRootOccurrenceTableSize - 1));
  for (int probe = 0; probe < kTitleRootOccurrenceTableSize; ++probe) {
    if (!g_title_root_occurrence_used[slot] || same_history_key(g_title_root_occurrence_keys[slot], key)) return slot;
    slot = (slot + 1) & (kTitleRootOccurrenceTableSize - 1);
  }
  return -1;
}

void reset_title_root_occurrence_index() {
  g_title_root_occurrence_ready = false;
  if (!g_title_history_hash_ready || g_root_history_count < 24) return;
  std::memset(g_title_root_occurrence_used, 0, sizeof(g_title_root_occurrence_used));
  std::memset(g_title_root_occurrence_counts, 0, sizeof(g_title_root_occurrence_counts));
  for (int i = 0; i < g_root_history_count; ++i) {
    const HistoryKey& key = g_root_history[i].key;
    const int slot = title_root_occurrence_slot(key);
    if (slot < 0) return;
    if (!g_title_root_occurrence_used[slot]) {
      g_title_root_occurrence_used[slot] = 1;
      g_title_root_occurrence_keys[slot] = key;
    }
    if (g_title_root_occurrence_counts[slot] < 0xffff) ++g_title_root_occurrence_counts[slot];
  }
  g_title_root_occurrence_ready = true;
}

int title_root_occurrence_count(const HistoryKey& key) {
  if (!g_title_root_occurrence_ready) return -1;
  uint64_t mixed = key.primary ^ ((key.secondary << 1) | (key.secondary >> 63));
  int slot = static_cast<int>(mixed & (kTitleRootOccurrenceTableSize - 1));
  for (int probe = 0; probe < kTitleRootOccurrenceTableSize; ++probe) {
    if (!g_title_root_occurrence_used[slot]) return 0;
    if (same_history_key(g_title_root_occurrence_keys[slot], key)) return g_title_root_occurrence_counts[slot];
    slot = (slot + 1) & (kTitleRootOccurrenceTableSize - 1);
  }
  return -1;
}

void reset_title_history_hash() {
  g_title_history_hash_ready = g_parallel_profile >= 4;
  if (g_title_history_hash_ready) g_title_history_hash_stack[0] = history_context_hash();
  reset_title_root_occurrence_index();
}`,
'ROOT_OCCURRENCE_INDEX',
);

replaceOnce(
`  const SearchHistoryEntry& current_entry = g_search_path[g_search_path_count - 1];
  const HistoryKey& current = current_entry.key;
  int occurrences[4] = {-1, -1, -1, -1};`,
`  const SearchHistoryEntry& current_entry = g_search_path[g_search_path_count - 1];
  const HistoryKey& current = current_entry.key;
  const int indexed_root_count = title_root_occurrence_count(current);
  if (indexed_root_count >= 0) {
    int possible_occurrences = indexed_root_count;
    for (int i = 0; i < g_search_path_count; ++i) {
      if (same_history_key(g_search_path[i].key, current)) ++possible_occurrences;
    }
    if (possible_occurrences < 4) return 0;
  }
  int occurrences[4] = {-1, -1, -1, -1};`,
'REPETITION_FAST_REJECT',
);

await writeFile(path,source);
