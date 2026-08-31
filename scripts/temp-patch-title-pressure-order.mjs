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
  int pressure_scores[kMaxMoves] = {};
  const bool seek_quiet_net = include_quiet_pressure && g_parallel_profile >= 4 && ply <= 4;
  const int baseline = seek_quiet_net ? mating_pressure_score(pos, pos.turn) : 0;
  for (int i = 0; i < list.count; ++i) {
    const Move move = list.items[i];
    Position next;
    apply_move(pos, move, next);
    if (is_check(next, next.turn)) {
      checks.add(move);
    } else if (seek_quiet_net) {
      const int pressure_score = mating_pressure_score(next, pos.turn);
      if (pressure_score >= baseline + 24) {
        const int index = pressure.count;
        pressure.add(move);
        if (pressure.count > index) pressure_scores[index] = pressure_score;
      } else {
        rest.add(move);
      }
    } else {
      rest.add(move);
    }
  }
  if (g_parallel_profile >= 4) {
    // Stable sort only the pressure cohort. The score was already required
    // for cohort admission, so this adds no new position evaluation.
    for (int i = 1; i < pressure.count; ++i) {
      const Move move = pressure.items[i];
      const int score = pressure_scores[i];
      int j = i;
      while (j > 0 && pressure_scores[j - 1] < score) {
        pressure.items[j] = pressure.items[j - 1];
        pressure_scores[j] = pressure_scores[j - 1];
        --j;
      }
      pressure.items[j] = move;
      pressure_scores[j] = score;
    }
  }
  list.count = 0;
  list.overflow = checks.overflow || pressure.overflow || rest.overflow;
  for (int i = 0; i < checks.count; ++i) list.add(checks.items[i]);
  for (int i = 0; i < pressure.count; ++i) list.add(pressure.items[i]);
  for (int i = 0; i < rest.count; ++i) list.add(rest.items[i]);`;
if(!source.includes(oldText))throw new Error('PRESSURE_ORDER_ANCHOR_NOT_FOUND');
source=source.replace(oldText,newText);
await writeFile(path,source);
