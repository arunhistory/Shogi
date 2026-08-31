import {readFile,writeFile} from 'node:fs/promises';

const path='cpp/engine_parallel.cpp';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  const count=source.split(oldText).length-1;
  if(count!==1)throw new Error(`${label}_ANCHOR_COUNT:${count}`);
  source=source.replace(oldText,newText);
}

replaceOnce(
`int lane_offset(const Position& pos, int count, int ply) {
  if (count <= 1 || g_parallel_lane == 0) return 0;
  uint64_t value = lane_key(pos, ply);
  value ^= value >> 30;
  value *= 0xbf58476d1ce4e5b9ULL;
  value ^= value >> 27;
  value *= 0x94d049bb133111ebULL;
  value ^= value >> 31;
  return static_cast<int>(value % static_cast<uint64_t>(count));
}
`,
`int lane_offset_from_key(uint64_t value, int count) {
  if (count <= 1 || g_parallel_lane == 0) return 0;
  value ^= value >> 30;
  value *= 0xbf58476d1ce4e5b9ULL;
  value ^= value >> 27;
  value *= 0x94d049bb133111ebULL;
  value ^= value >> 31;
  return static_cast<int>(value % static_cast<uint64_t>(count));
}

int lane_offset(const Position& pos, int count, int ply) {
  if (count <= 1 || g_parallel_lane == 0) return 0;
  return lane_offset_from_key(lane_key(pos, ply), count);
}
`,
'LANE_OFFSET_HELPER',
);

replaceOnce(
`void order_parallel_moves(const Position& pos, MoveList& list, int32_t tt_move, int ply, bool include_quiet_pressure) {
  order_moves(pos, list, tt_move);
  if (g_parallel_profile < 3 || list.count <= 1) return;`,
`int order_parallel_moves(const Position& pos, MoveList& list, int32_t tt_move, int ply, bool include_quiet_pressure) {
  order_moves(pos, list, tt_move);
  if (g_parallel_profile < 3 || list.count <= 1) return -1;`,
'ORDER_SIGNATURE',
);

replaceOnce(
`  list.count = 0;
  list.overflow = checks.overflow || pressure.overflow || rest.overflow;
  for (int i = 0; i < checks.count; ++i) list.add(checks.items[i]);
  for (int i = 0; i < pressure.count; ++i) list.add(pressure.items[i]);
  for (int i = 0; i < rest.count; ++i) list.add(rest.items[i]);
}

int parallel_quiescence`,
`  const int check_count = checks.count;
  list.count = 0;
  list.overflow = checks.overflow || pressure.overflow || rest.overflow;
  for (int i = 0; i < checks.count; ++i) list.add(checks.items[i]);
  for (int i = 0; i < pressure.count; ++i) list.add(pressure.items[i]);
  for (int i = 0; i < rest.count; ++i) list.add(rest.items[i]);
  return check_count;
}

int parallel_quiescence`,
'ORDER_RETURN_CHECK_COUNT',
);

replaceOnce(
`  order_parallel_moves(pos, moves, -1, ply + qdepth, false);
  const int offset = lane_offset(pos, moves.count, ply + qdepth);
  for (int step = 0; step < moves.count; ++step) {
    const int i = (offset + step) % moves.count;
    const Move& move = moves.items[i];
    Position next;
    bool next_ready = false;
    bool tactical = checked || (move.from >= 0 && pos.board[move.to] != 0) || move.promote;
    if (!tactical && g_parallel_profile >= 3) {
      apply_move(pos, move, next);
      next_ready = true;
      tactical = is_check(next, next.turn);
    }
    if (!tactical) continue;
    if (!next_ready) apply_move(pos, move, next);`,
`  const int ordered_check_count = order_parallel_moves(pos, moves, -1, ply + qdepth, false);
  const int offset = lane_offset(pos, moves.count, ply + qdepth);
  for (int step = 0; step < moves.count; ++step) {
    const int i = (offset + step) % moves.count;
    const Move& move = moves.items[i];
    Position next;
    bool next_ready = false;
    bool tactical = checked || (move.from >= 0 && pos.board[move.to] != 0) || move.promote;
    if (!tactical && g_parallel_profile >= 3) {
      if (g_parallel_profile >= 4 && ordered_check_count >= 0) {
        tactical = i < ordered_check_count;
      } else {
        apply_move(pos, move, next);
        next_ready = true;
        tactical = is_check(next, next.turn);
      }
    }
    if (!tactical) continue;
    if (!next_ready) apply_move(pos, move, next);`,
'QUIESCENCE_REUSE_CHECK_CLASSIFICATION',
);

replaceOnce(
`  order_parallel_moves(pos, moves, tt_move, ply, true);
  const int offset = lane_offset(pos, moves.count, ply);`,
`  order_parallel_moves(pos, moves, tt_move, ply, true);
  const int offset = g_parallel_profile >= 4
    ? lane_offset_from_key(key, moves.count)
    : lane_offset(pos, moves.count, ply);`,
'NEGAMAX_REUSE_LANE_KEY',
);

await writeFile(path,source);
