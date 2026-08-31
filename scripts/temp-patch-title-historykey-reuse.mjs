import {readFile,writeFile} from 'node:fs/promises';

const path='cpp/engine_parallel.cpp';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  const count=source.split(oldText).length-1;
  if(count!==1)throw new Error(`${label}_ANCHOR_COUNT:${count}`);
  source=source.replace(oldText,newText);
}

replaceOnce(
`int king_square_for_side(const Position& pos, int side) {`,
`int title_repetition_code_from_cached_current() {
  const SearchHistoryEntry& current_entry = g_search_path[g_search_path_count - 1];
  const HistoryKey& current = current_entry.key;
  int occurrences[4] = {-1, -1, -1, -1};
  int found = 0;
  const int total = combined_history_count();
  for (int i = 0; i < total; ++i) {
    if (!same_history_key(combined_history_at(i).key, current)) continue;
    if (found < 4) occurrences[found++] = i;
    else {
      occurrences[0] = occurrences[1];
      occurrences[1] = occurrences[2];
      occurrences[2] = occurrences[3];
      occurrences[3] = i;
    }
  }
  if (found < 4) return 0;

  const int start = occurrences[0], end = occurrences[3];
  for (int side : {1, -1}) {
    bool any = false;
    bool every_check = true;
    for (int i = start + 1; i <= end; ++i) {
      const SearchHistoryEntry& entry = combined_history_at(i);
      if (entry.mover != side) continue;
      any = true;
      if (!entry.gave_check) every_check = false;
    }
    if (any && every_check) return side == 1 ? 2 : 3;
  }
  return 1;
}

bool parallel_repetition_score(const Position& pos, int ply, int& score) {
  if (g_parallel_profile < 4 || g_search_path_count <= 0) return repetition_score(pos, ply, score);
  const int code = title_repetition_code_from_cached_current();
  if (code == 0) return false;
  if (code == 1) { score = 0; return true; }
  const int loser = code == 2 ? 1 : -1;
  score = loser == pos.turn ? -kMateScore + ply : kMateScore - ply;
  return true;
}

int king_square_for_side(const Position& pos, int side) {`,
'HISTORYKEY_HELPERS',
);

const repetitionAnchor='if (repetition_score(pos, ply, terminal)) return terminal;';
const repetitionCount=source.split(repetitionAnchor).length-1;
if(repetitionCount!==2)throw new Error(`REPETITION_CALL_COUNT:${repetitionCount}`);
source=source.replaceAll(repetitionAnchor,'if (parallel_repetition_score(pos, ply, terminal)) return terminal;');

await writeFile(path,source);
