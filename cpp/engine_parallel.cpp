#include "engine_history.cpp"

namespace {
constexpr int32_t kParallelInvalidScore = 2147483647;
bool g_parallel_complete = true;
uint32_t g_parallel_lane = 0;
int g_parallel_profile = 0;

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

int king_square_for_side(const Position& pos, int side) {
  for (int square = 0; square < kBoardSquares; ++square) {
    if (pos.board[square] == side * 8) return square;
  }
  return -1;
}

int ray_activity(const Position& pos, int from, int side, int dy, int dx) {
  int score = 0;
  int y = row_of(from) + dy;
  int x = col_of(from) + dx;
  while (inside(y, x)) {
    const int target = pos.board[square_of(y, x)];
    if (target == 0) {
      ++score;
    } else {
      if (sign_of(target) == -side) ++score;
      break;
    }
    y += dy;
    x += dx;
  }
  return score;
}

int major_activity(const Position& pos, int side) {
  int score = 0;
  for (int square = 0; square < kBoardSquares; ++square) {
    const int code = pos.board[square];
    if (sign_of(code) != side) continue;
    const int kind = kind_of(code);
    if (kind == 7 || kind == 14) {
      score += ray_activity(pos, square, side, -1, 0);
      score += ray_activity(pos, square, side, 1, 0);
      score += ray_activity(pos, square, side, 0, -1);
      score += ray_activity(pos, square, side, 0, 1);
      if (kind == 14) score += 2;
    }
    if (kind == 6 || kind == 13) {
      score += ray_activity(pos, square, side, -1, -1);
      score += ray_activity(pos, square, side, -1, 1);
      score += ray_activity(pos, square, side, 1, -1);
      score += ray_activity(pos, square, side, 1, 1);
      if (kind == 13) score += 2;
    }
  }
  return score;
}

int king_safety_score(const Position& pos, int side) {
  const int king = king_square_for_side(pos, side);
  if (king < 0) return -kMateScore / 2;
  const int ky = row_of(king), kx = col_of(king);
  int shield = 0;
  int danger = 0;
  for (int dy = -1; dy <= 1; ++dy) {
    for (int dx = -1; dx <= 1; ++dx) {
      if (dy == 0 && dx == 0) continue;
      const int y = ky + dy, x = kx + dx;
      if (!inside(y, x)) continue;
      const int square = square_of(y, x);
      const int occupant = pos.board[square];
      if (sign_of(occupant) == side) {
        const int kind = kind_of(occupant);
        if (kind == 5 || kind == 9 || kind == 10 || kind == 11 || kind == 12) shield += 3;
        else if (kind == 4) shield += 2;
        else if (kind != 8) shield += 1;
      }
      for (int attacker = 0; attacker < kBoardSquares; ++attacker) {
        if (sign_of(pos.board[attacker]) == -side && attacks_square(pos, attacker, square)) ++danger;
      }
    }
  }
  const bool home_rank = side == 1 ? ky >= 7 : ky <= 1;
  const int edge_distance = abs_i(kx - 4);
  const int shield_weight = g_parallel_profile >= 4 ? 8 : g_parallel_profile >= 3 ? 7 : 5;
  const int danger_weight = g_parallel_profile >= 4 ? 13 : g_parallel_profile >= 3 ? 10 : 7;
  return shield * shield_weight + (home_rank ? 18 : 0) + edge_distance * 4 - danger * danger_weight;
}

int hand_initiative(const Position& pos, int side) {
  const int index = side_index(side);
  int score = 0;
  score += pos.hands[index][6] * 26;
  score += pos.hands[index][5] * 22;
  score += pos.hands[index][4] * 12;
  score += pos.hands[index][3] * 10;
  score += pos.hands[index][2] * 5;
  score += pos.hands[index][1] * 4;
  score += pos.hands[index][0] * 2;
  return score;
}

int promoted_invasion(const Position& pos, int side) {
  int score = 0;
  for (int square = 0; square < kBoardSquares; ++square) {
    const int code = pos.board[square];
    if (sign_of(code) != side) continue;
    const int kind = kind_of(code);
    if (kind < 9) continue;
    const int y = row_of(square);
    const int progress = side == 1 ? 8 - y : y;
    if (progress >= 5) score += (progress - 4) * 5;
  }
  return score;
}

int strategic_side_score(const Position& pos, int side) {
  if (g_parallel_profile <= 1) return 0;
  int score = king_safety_score(pos, side);
  const int activity = major_activity(pos, side);
  if (g_parallel_profile == 2) {
    score = score / 2 + activity * 2;
  } else if (g_parallel_profile == 3) {
    score += activity * 3 + hand_initiative(pos, side) / 2 + promoted_invasion(pos, side);
  } else {
    score += activity * 4 + hand_initiative(pos, side) * 3 / 4 + promoted_invasion(pos, side) * 2;
  }
  return score;
}

int attack_count_on_square(const Position& pos, int attacker_side, int target) {
  int count = 0;
  for (int from = 0; from < kBoardSquares; ++from) {
    if (sign_of(pos.board[from]) == attacker_side && attacks_square(pos, from, target)) ++count;
  }
  return count;
}

int king_net_pressure(const Position& pos, int attacker_side, int defender_side) {
  const int king = king_square_for_side(pos, defender_side);
  if (king < 0) return kMateScore / 2;
  const int ky = row_of(king), kx = col_of(king);
  int attacked_ring = 0;
  int attack_contacts = 0;
  int escape_like = 0;
  int shield = 0;
  for (int dy = -1; dy <= 1; ++dy) {
    for (int dx = -1; dx <= 1; ++dx) {
      if (dy == 0 && dx == 0) continue;
      const int y = ky + dy, x = kx + dx;
      if (!inside(y, x)) continue;
      const int target = square_of(y, x);
      const int contacts = attack_count_on_square(pos, attacker_side, target);
      if (contacts > 0) ++attacked_ring;
      attack_contacts += contacts > 3 ? 3 : contacts;
      const int occupant = pos.board[target];
      if (contacts == 0 && sign_of(occupant) != defender_side) ++escape_like;
      if (sign_of(occupant) == defender_side) {
        const int kind = kind_of(occupant);
        if (kind == 5 || kind == 9 || kind == 10 || kind == 11 || kind == 12) shield += 3;
        else if (kind == 4) shield += 2;
        else if (kind != 8) shield += 1;
      }
    }
  }
  const bool title = g_parallel_profile >= 4;
  int score = attacked_ring * (title ? 55 : 36)
    + attack_contacts * (title ? 14 : 9)
    - escape_like * (title ? 45 : 28)
    - shield * (title ? 12 : 8);
  if (is_check(pos, defender_side)) score += title ? 420 : 280;
  return score;
}

int attack_commitment_exposure(const Position& pos, int side) {
  const int king = king_square_for_side(pos, side);
  if (king < 0) return 100;
  const int ky = row_of(king), kx = col_of(king);
  int exposure = 0;
  for (int square = 0; square < kBoardSquares; ++square) {
    const int code = pos.board[square];
    if (sign_of(code) != side) continue;
    const int kind = kind_of(code);
    if (kind == 8 || kind == 1) continue;
    const int y = row_of(square), x = col_of(square);
    const int progress = side == 1 ? 8 - y : y;
    const int distance = abs_i(y - ky) + abs_i(x - kx);
    if (progress < 4 || distance < 3) continue;
    int weight = 2;
    if (kind == 7 || kind == 14) weight = 5;
    else if (kind == 6 || kind == 13) weight = 4;
    else if (kind == 4 || kind == 5 || kind == 9 || kind == 10 || kind == 11 || kind == 12) weight = 3;
    exposure += (progress - 3) * weight + (distance > 3 ? distance - 3 : 0);
  }
  return exposure;
}

int mating_pressure_score(const Position& pos, int attacker_side) {
  if (g_parallel_profile < 3) return 0;
  const int defender_side = -attacker_side;
  const int net = king_net_pressure(pos, attacker_side, defender_side);
  const int induced = attack_commitment_exposure(pos, defender_side) * (g_parallel_profile >= 4 ? 6 : 4);
  return net + induced;
}

int parallel_evaluate_for(const Position& pos, int perspective) {
  const int base = evaluate_for(pos, perspective);
  if (g_parallel_profile <= 1) return base;
  const int strategic = strategic_side_score(pos, perspective) - strategic_side_score(pos, -perspective);
  if (g_parallel_profile == 2) return base + strategic;
  const int mating = mating_pressure_score(pos, perspective) - mating_pressure_score(pos, -perspective);
  if (g_parallel_profile == 3) return base + strategic / 2 + mating * 3 / 2;
  return base + strategic / 3 + mating * 2;
}

void order_parallel_moves(const Position& pos, MoveList& list, int32_t tt_move, int ply, bool include_quiet_pressure) {
  order_moves(pos, list, tt_move);
  if (g_parallel_profile < 3 || list.count <= 1) return;
  MoveList checks;
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
  for (int i = 0; i < rest.count; ++i) list.add(rest.items[i]);
}

int parallel_quiescence(const Position& pos, int alpha, int beta, int ply, int qdepth) {
  int terminal = 0;
  if (repetition_score(pos, ply, terminal)) return terminal;
  if (++g_nodes >= g_node_limit) {
    g_parallel_complete = false;
    return parallel_evaluate_for(pos, pos.turn);
  }
  const bool checked = is_check(pos, pos.turn);
  const int stand = parallel_evaluate_for(pos, pos.turn);
  if (!checked) {
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
  }
  const int qlimit = g_parallel_profile >= 4 ? 6 : g_parallel_profile >= 3 ? 5 : 4;
  if (qdepth >= qlimit) return checked ? stand - 200 : alpha;

  MoveList moves;
  generate_legal(pos, moves);
  if (moves.count == 0) return checked ? -kMateScore + ply : 0;
  order_parallel_moves(pos, moves, -1, ply + qdepth, false);
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
    if (!next_ready) apply_move(pos, move, next);
    if (!push_search_history(next, pos.turn)) {
      g_parallel_complete = false;
      return parallel_evaluate_for(pos, pos.turn);
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
    return parallel_evaluate_for(pos, pos.turn);
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
  order_parallel_moves(pos, moves, tt_move, ply, true);
  const int offset = lane_offset(pos, moves.count, ply);
  int best = -kInfinity;
  int32_t best_move = -1;
  for (int step = 0; step < moves.count; ++step) {
    const int i = (offset + step) % moves.count;
    Position next;
    apply_move(pos, moves.items[i], next);
    if (!push_search_history(next, pos.turn)) {
      g_parallel_complete = false;
      return parallel_evaluate_for(pos, pos.turn);
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

int32_t parallel_root_score(const Position& root, const Move& requested, int max_depth, int node_limit, int lane, int profile) {
  g_parallel_profile = profile < 0 ? 0 : profile > 4 ? 4 : profile;
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
    return parallel_evaluate_for(root, root.turn);
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
  int32_t lane,
  int32_t profile
) {
  Position pos;
  Move move;
  if (!load_position(position_count, pos)) return kParallelInvalidScore;
  if (!load_search_history(history_word_count, pos)) return kParallelInvalidScore;
  if (!decode_external_move(encoded_move, move)) return kParallelInvalidScore;
  return parallel_root_score(pos, move, max_depth, node_limit, lane, profile);
}

int32_t shogi_parallel_search_complete() { return g_parallel_complete ? 1 : 0; }

}
