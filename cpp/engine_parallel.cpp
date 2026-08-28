#include "engine_history.cpp"

namespace {
constexpr int32_t kParallelInvalidScore = 2147483647;
bool g_parallel_complete = true;
uint32_t g_parallel_lane = 0;

bool same_move_value(const Move& a, const Move& b) {
  return a.from == b.from && a.to == b.to && a.drop == b.drop && a.promote == b.promote;
}

bool decode_external_move(int32_t code, Move& out) {
  if (code < 0) return false;
  const int to = code & 0x7f;
  const int from = (code >> 7) & 0x7f;
  const int drop = (code >> 14) & 0x0f;
  const int promote = (code >> 18) & 1;
  if (to < 0 || to >= 81) return false;
  if (drop != 0) {
    if (drop < 1 || drop > 7 || from != 127 || promote != 0) return false;
    out = Move{-1, static_cast<int16_t>(to), static_cast<int8_t>(drop), 0};
    return true;
  }
  if (from < 0 || from >= 81) return false;
  out = Move{static_cast<int16_t>(from), static_cast<int16_t>(to), 0, static_cast<uint8_t>(promote)};
  return true;
}

uint64_t lane_key(const Position& pos, int ply) {
  uint64_t value = contextual_tt_key(pos);
  value ^= static_cast<uint64_t>(g_parallel_lane + 1) * 0x9e3779b97f4a7c15ULL;
  value ^= static_cast<uint64_t>(ply + 1) * 0xbf58476d1ce4e5b9ULL;
  return value;
}

int lane_offset(const Position& pos, int count, int ply) {
  if (count <= 1 || g_parallel_lane == 0) return 0;
  uint64_t value = lane_key(pos, ply);
  value ^= value >> 30;
  value *= 0xbf58476d1ce4e5b9ULL;
  value ^= value >> 27;
  value *= 0x94d049bb133111ebULL;
  value ^= value >> 31;
  return static_cast<int>(value % static_cast<uint64_t>(count));
}

int parallel_quiescence(const Position& pos, int alpha, int beta, int ply, int qdepth) {
  int terminal = 0;
  if (repetition_score(pos, ply, terminal)) return terminal;
  if (++g_nodes >= g_node_limit) {
    g_parallel_complete = false;
    return evaluate_for(pos, pos.turn);
  }
  const bool checked = is_check(pos, pos.turn);
  const int stand = evaluate_for(pos, pos.turn);
  if (!checked) {
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
  }
  if (qdepth >= 4) return checked ? stand - 200 : alpha;

  MoveList moves;
  generate_legal(pos, moves);
  if (moves.count == 0) return checked ? -kMateScore + ply : 0;
  order_moves(pos, moves, -1);
  const int offset = lane_offset(pos, moves.count, ply + qdepth);
  for (int step = 0; step < moves.count; ++step) {
    const int i = (offset + step) % moves.count;
    const Move& move = moves.items[i];
    const bool tactical = checked || (move.from >= 0 && pos.board[move.to] != 0) || move.promote;
    if (!tactical) continue;
    Position next;
    apply_move(pos, move, next);
    if (!push_search_history(next, pos.turn)) {
      g_parallel_complete = false;
      return evaluate_for(pos, pos.turn);
    }
    const int score = -parallel_quiescence(next, -beta, -alpha, ply + 1, qdepth + 1);
    pop_search_history();
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
    if (g_nodes >= g_node_limit) {
      g_parallel_complete = false;
      break;
    }
  }
  return alpha;
}

int parallel_negamax(const Position& pos, int depth, int alpha, int beta, int ply) {
  int terminal = 0;
  if (repetition_score(pos, ply, terminal)) return terminal;
  if (g_nodes >= g_node_limit) {
    g_parallel_complete = false;
    return evaluate_for(pos, pos.turn);
  }
  ++g_nodes;
  const int original_alpha = alpha;
  const uint64_t key = lane_key(pos, ply);
  TtEntry& entry = g_tt[key & (kTtSize - 1)];
  int32_t tt_move = -1;
  if (entry.key == key && entry.generation == g_generation) {
    tt_move = entry.move;
    if (entry.depth >= depth) {
      if (entry.flag == 1) return entry.score;
      if (entry.flag == 2 && entry.score >= beta) return entry.score;
      if (entry.flag == 3 && entry.score <= alpha) return entry.score;
    }
  }
  if (depth <= 0) return parallel_quiescence(pos, alpha, beta, ply, 0);

  MoveList moves;
  generate_legal(pos, moves);
  if (moves.count == 0) return is_check(pos, pos.turn) ? -kMateScore + ply : 0;
  order_moves(pos, moves, tt_move);
  const int offset = lane_offset(pos, moves.count, ply);
  int best = -kInfinity;
  int32_t best_move = -1;
  for (int step = 0; step < moves.count; ++step) {
    const int i = (offset + step) % moves.count;
    Position next;
    apply_move(pos, moves.items[i], next);
    if (!push_search_history(next, pos.turn)) {
      g_parallel_complete = false;
      return evaluate_for(pos, pos.turn);
    }
    const int score = -parallel_negamax(next, depth - 1, -beta, -alpha, ply + 1);
    pop_search_history();
    if (score > best) { best = score; best_move = encode_move(moves.items[i]); }
    if (score > alpha) alpha = score;
    if (alpha >= beta || g_nodes >= g_node_limit) {
      if (g_nodes >= g_node_limit) g_parallel_complete = false;
      break;
    }
  }
  entry.key = key;
  entry.depth = static_cast<int16_t>(depth);
  entry.score = best;
  entry.move = best_move;
  entry.generation = g_generation;
  entry.flag = best <= original_alpha ? 3 : best >= beta ? 2 : 1;
  return best;
}

int32_t parallel_root_score(const Position& root, const Move& requested, int max_depth, int node_limit, int lane) {
  if (repetition_code(root) != 0) return kParallelInvalidScore;
  MoveList legal;
  generate_legal(root, legal);
  if (legal.count == 0) return kParallelInvalidScore;
  bool found = false;
  Move verified{};
  for (int i = 0; i < legal.count; ++i) {
    if (same_move_value(legal.items[i], requested)) {
      verified = legal.items[i];
      found = true;
      break;
    }
  }
  if (!found) return kParallelInvalidScore;

  if (max_depth < 1) max_depth = 1;
  if (max_depth > 12) max_depth = 12;
  g_node_limit = node_limit < 100 ? 100 : node_limit > 250000 ? 250000 : node_limit;
  g_nodes = 0;
  g_parallel_complete = true;
  g_parallel_lane = static_cast<uint32_t>(lane < 0 ? -lane : lane);
  ++g_generation;
  if (g_generation == 0) { std::memset(g_tt, 0, sizeof(g_tt)); ++g_generation; }

  Position next;
  apply_move(root, verified, next);
  if (!push_search_history(next, root.turn)) {
    g_parallel_complete = false;
    return evaluate_for(root, root.turn);
  }
  const int score = -parallel_negamax(next, max_depth - 1, -kInfinity, kInfinity, 1);
  pop_search_history();
  return score;
}
}  // namespace

extern "C" {

int32_t shogi_search_root_move_with_history(
  int32_t position_count,
  int32_t history_word_count,
  int32_t encoded_move,
  int32_t max_depth,
  int32_t node_limit,
  int32_t lane
) {
  Position pos;
  Move move;
  if (!load_position(position_count, pos)) return kParallelInvalidScore;
  if (!load_search_history(history_word_count, pos)) return kParallelInvalidScore;
  if (!decode_external_move(encoded_move, move)) return kParallelInvalidScore;
  return parallel_root_score(pos, move, max_depth, node_limit, lane);
}

int32_t shogi_parallel_search_complete() { return g_parallel_complete ? 1 : 0; }

}
