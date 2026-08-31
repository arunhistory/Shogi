import {readFile,writeFile} from 'node:fs/promises';

const path='cpp/engine_parallel.cpp';
let source=await readFile(path,'utf8');
const oldText=`  MoveList checks;
  MoveList pressure;
  MoveList rest;
  const bool seek_quiet_net = include_quiet_pressure && g_parallel_profile >= 4 && ply <= 4;
  const int baseline = seek_quiet_net ? mating_pressure_score(pos, pos.turn) : 0;
  for (int i = 0; i < list.count; ++i) {
    const Move move = list.items[i];
    Position next;
    apply_move(pos, move, next);
    if (is_check(next, next.turn)) {
      checks.add(move);
    } else if (seek_quiet_net && mating_pressure_score(next, pos.turn) >= baseline + 24) {
      pressure.add(move);
    } else {
      rest.add(move);
    }
  }
  list.count = 0;
  list.overflow = checks.overflow || pressure.overflow || rest.overflow;
  for (int i = 0; i < checks.count; ++i) list.add(checks.items[i]);
  for (int i = 0; i < pressure.count; ++i) list.add(pressure.items[i]);
  for (int i = 0; i < rest.count; ++i) list.add(rest.items[i]);`;
const newText=`  MoveList checks;
  MoveList pressure;
  MoveList rest;
  int check_scores[kMaxMoves] = {};
  const bool seek_quiet_net = include_quiet_pressure && g_parallel_profile >= 4 && ply <= 4;
  const int baseline = seek_quiet_net ? mating_pressure_score(pos, pos.turn) : 0;
  for (int i = 0; i < list.count; ++i) {
    const Move move = list.items[i];
    Position next;
    apply_move(pos, move, next);
    if (is_check(next, next.turn)) {
      const int index = checks.count;
      checks.add(move);
      if (checks.count > index) check_scores[index] = g_parallel_profile >= 4 ? mating_pressure_score(next, pos.turn) : 0;
    } else if (seek_quiet_net && mating_pressure_score(next, pos.turn) >= baseline + 24) {
      pressure.add(move);
    } else {
      rest.add(move);
    }
  }
  if (g_parallel_profile >= 4) {
    // Stable insertion sort: only the order of already-legal checking moves
    // changes. Equal scores retain the original move-order tie break.
    for (int i = 1; i < checks.count; ++i) {
      const Move move = checks.items[i];
      const int score = check_scores[i];
      int j = i;
      while (j > 0 && check_scores[j - 1] < score) {
        checks.items[j] = checks.items[j - 1];
        check_scores[j] = check_scores[j - 1];
        --j;
      }
      checks.items[j] = move;
      check_scores[j] = score;
    }
  }
  list.count = 0;
  list.overflow = checks.overflow || pressure.overflow || rest.overflow;
  for (int i = 0; i < checks.count; ++i) list.add(checks.items[i]);
  for (int i = 0; i < pressure.count; ++i) list.add(pressure.items[i]);
  for (int i = 0; i < rest.count; ++i) list.add(rest.items[i]);`;
if(!source.includes(oldText))throw new Error('CHECK_ORDER_ANCHOR_NOT_FOUND');
source=source.replace(oldText,newText);
await writeFile(path,source);
