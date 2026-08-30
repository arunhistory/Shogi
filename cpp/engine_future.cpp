#include "engine_parallel.cpp"

namespace {
constexpr int kFutureHandCredits = 6;
constexpr int kFutureCheckCredits = 2;
constexpr int kFutureDepthCap = 18;

uint64_t future_state_key(const Position& pos, int hand_credits, int check_credits) {
  uint64_t key = contextual_tt_key(pos);
  key ^= static_cast<uint64_t>(hand_credits + 1) * 0x9e3779b97f4a7c15ULL;
  key ^= static_cast<uint64_t>(check_credits + 1) * 0xbf58476d1ce4e5b9ULL;
  return key;
}

int future_lane_offset(const Position& pos, int count, int ply) {
  if (count <= 1 || g_parallel_lane == 0) return 0;
  uint64_t value = hash_position(pos);
  value ^= static_cast<uint64_t>(g_parallel_lane + 1) * 0x94d049bb133111ebULL;
  value ^= static_cast<uint64_t>(ply + 1) * 0x9e3779b97f4a7c15ULL;
  value ^= value >> 30;
  value *= 0xbf58476d1ce4e5b9ULL;
  value ^= value >> 27;
  value *= 0x94d049bb133111ebULL;
  value ^= value >> 31;
  return static_cast<int>(value % static_cast<uint64_t>(count));
}

bool future_capture(const Position& pos, const Move& move) {
  return move.from >= 0 && move.to >= 0 && pos.board[move.to] != 0;
}

int future_move_order_score(const Position& pos, const Move& move, int32_t tt_move) {
  int score = move_order_score(pos, move, tt_move);
  if (future_capture(pos, move)) {
    const int captured = base_kind(kind_of(pos.board[move.to]));
    score += 30000 + piece_value(captured) * 20;
    if (captured == 7) score += 18000;
    else if (captured == 6) score += 15000;
    else if (captured == 5 || captured == 4) score += 7000;
  }
  if (move.drop > 0) {
    score += 10000 + piece_value(move.drop) * 6;
    const int enemy_king = king_square_for_side(pos, -pos.turn);
    if (enemy_king >= 0) {
      const int distance = abs_i(row_of(move.to) - row_of(enemy_king)) + abs_i(col_of(move.to) - col_of(enemy_king));
      score += distance <= 1 ? 18000 : distance == 2 ? 9000 : distance == 3 ? 3500 : 0;
    }
  }
  if (move.promote) score += 7000;
  Position next;
  apply_move(pos, move, next);
  if (is_check(next, next.turn)) score += 45000;
  return score;
}

void order_future_moves(const Position& pos, MoveList& list, int32_t tt_move) {
  if (list.count <= 1) return;
  int scores[kMaxMoves] = {};
  for (int i = 0; i < list.count; ++i) scores[i] = future_move_order_score(pos, list.items[i], tt_move);
  for (int i = 0; i < list.count; ++i) {
    int best = i;
    for (int j = i + 1; j < list.count; ++j) if (scores[j] > scores[best]) best = j;
    if (best != i) {
      const Move move = list.items[i];
      list.items[i] = list.items[best];
      list.items[best] = move;
      const int score = scores[i];
      scores[i] = scores[best];
      scores[best] = score;
    }
  }
}

struct FutureBudget {
  int depth = 0;
  int hand_credits = 0;
  int check_credits = 0;
};

FutureBudget future_child_budget(
  const Position& pos,
  const Move& move,
  const Position& next,
  int depth,
  int hand_credits,
  int check_credits
) {
  int extension = 0;
  int next_hand = hand_credits;
  int next_check = check_credits;
  const bool captured = future_capture(pos, move);
  const bool gave_check = is_check(next, next.turn);

  // A captured piece becomes a new future move generator, but extending every
  // capture wastes the search budget. If depth >= 3, ordinary full-width
  // search already reaches: capture -> opponent reply -> capturer's next turn,
  // where all legal drops are generated. Only a capture near the horizon needs
  // extra plies to guarantee that newly created hand is actually usable.
  if (captured && next_hand > 0 && depth < 3) {
    extension = 3 - depth;  // depth 1 => +2, depth 2 => +1.
    const int spend = extension > next_hand ? next_hand : extension;
    extension = spend;
    next_hand -= spend;
  }

  // A check extension is needed only at the horizon. Deeper checks are already
  // covered by normal search and extending all of them would overgrow one line.
  if (gave_check && next_check > 0 && depth <= 1) {
    if (extension == 0) extension = 1;
    --next_check;
  }

  int next_depth = depth - 1 + extension;
  if (next_depth > kFutureDepthCap) next_depth = kFutureDepthCap;
  return FutureBudget{next_depth, next_hand, next_check};
}

int future_quiescence(const Position& pos, int alpha, int beta, int ply, int qdepth) {
  int terminal = 0;
  if (repetition_score(pos, ply, terminal)) return terminal;
  if (g_nodes >= g_node_limit) {
    g_parallel_complete = false;
    return parallel_evaluate_for(pos, pos.turn);
  }
  ++g_nodes;

  const bool checked = is_check(pos, pos.turn);
  const int stand = parallel_evaluate_for(pos, pos.turn);
  if (!checked) {
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
  }
  // Full-width future search is the primary computation. The horizon gets one
  // tactical verification ply only, preventing leaf tactics from consuming the
  // budget intended to compare sibling hand-created futures.
  if (qdepth >= 1) return checked ? stand - 200 : alpha;

  MoveList moves;
  generate_legal(pos, moves);
  if (moves.count == 0) return checked ? -kMateScore + ply : 0;
  order_future_moves(pos, moves, -1);
  const int offset = future_lane_offset(pos, moves.count, ply + qdepth);
  for (int step = 0; step < moves.count; ++step) {
    const Move& move = moves.items[(offset + step) % moves.count];
    Position next;
    apply_move(pos, move, next);
    const bool checking = is_check(next, next.turn);
    // Full-width search has already enumerated ordinary hand drops. At the
    // horizon continue only tactical captures, promotions and checking drops.
    const bool tactical = checked
      || future_capture(pos, move)
      || move.promote
      || checking;
    if (!tactical) continue;
    if (!push_search_history(next, pos.turn)) {
      g_parallel_complete = false;
      return parallel_evaluate_for(pos, pos.turn);
    }
    const int score = -future_quiescence(next, -beta, -alpha, ply + 1, qdepth + 1);
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

int future_negamax(
  const Position& pos,
  int depth,
  int alpha,
  int beta,
  int ply,
  int hand_credits,
  int check_credits
) {
  int terminal = 0;
  if (repetition_score(pos, ply, terminal)) return terminal;
  if (g_nodes >= g_node_limit) {
    g_parallel_complete = false;
    return parallel_evaluate_for(pos, pos.turn);
  }
  ++g_nodes;
  if (depth <= 0) return future_quiescence(pos, alpha, beta, ply, 0);

  const int original_alpha = alpha;
  const uint64_t key = future_state_key(pos, hand_credits, check_credits);
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

  MoveList moves;
  generate_legal(pos, moves);
  if (moves.count == 0) return is_check(pos, pos.turn) ? -kMateScore + ply : 0;
  order_future_moves(pos, moves, tt_move);
  const int offset = future_lane_offset(pos, moves.count, ply);

  int best = -kInfinity;
  int32_t best_move = -1;
  bool first = true;
  for (int step = 0; step < moves.count; ++step) {
    const Move& move = moves.items[(offset + step) % moves.count];
    Position next;
    apply_move(pos, move, next);
    if (!push_search_history(next, pos.turn)) {
      g_parallel_complete = false;
      return parallel_evaluate_for(pos, pos.turn);
    }

    const FutureBudget budget = future_child_budget(pos, move, next, depth, hand_credits, check_credits);
    int score;
    if (first) {
      score = -future_negamax(next, budget.depth, -beta, -alpha, ply + 1, budget.hand_credits, budget.check_credits);
      first = false;
    } else {
      // Principal-variation search keeps every legal future available while
      // spending fewer nodes proving branches that cannot beat the current PV.
      score = -future_negamax(next, budget.depth, -alpha - 1, -alpha, ply + 1, budget.hand_credits, budget.check_credits);
      if (g_parallel_complete && score > alpha && score < beta) {
        score = -future_negamax(next, budget.depth, -beta, -alpha, ply + 1, budget.hand_credits, budget.check_credits);
      }
    }
    pop_search_history();

    if (score > best) {
      best = score;
      best_move = encode_move(move);
    }
    if (score > alpha) alpha = score;
    if (alpha >= beta || g_nodes >= g_node_limit || !g_parallel_complete) {
      if (g_nodes >= g_node_limit) g_parallel_complete = false;
      break;
    }
  }

  // Never cache a truncated subtree as an exact future. This keeps the state
  // graph reuse safe when a job reaches its node ceiling.
  if (g_parallel_complete) {
    entry.key = key;
    entry.depth = static_cast<int16_t>(depth);
    entry.score = best;
    entry.move = best_move;
    entry.generation = g_generation;
    entry.flag = best <= original_alpha ? 3 : best >= beta ? 2 : 1;
  }
  return best;
}

int32_t future_root_score(const Position& root, const Move& requested, int max_depth, int node_limit, int lane) {
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
  g_parallel_profile = 4;
  g_parallel_lane = static_cast<uint32_t>(lane < 0 ? -lane : lane);
  ++g_generation;
  if (g_generation == 0) {
    std::memset(g_tt, 0, sizeof(g_tt));
    ++g_generation;
  }

  Position next;
  apply_move(root, verified, next);
  if (!push_search_history(next, root.turn)) {
    g_parallel_complete = false;
    return parallel_evaluate_for(root, root.turn);
  }
  const FutureBudget budget = future_child_budget(
    root,
    verified,
    next,
    max_depth,
    kFutureHandCredits,
    kFutureCheckCredits
  );
  const int score = -future_negamax(
    next,
    budget.depth,
    -kInfinity,
    kInfinity,
    1,
    budget.hand_credits,
    budget.check_credits
  );
  pop_search_history();
  return score;
}
}  // namespace

extern "C" {

int32_t shogi_search_future_root_move_with_history(
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
  return future_root_score(pos, move, max_depth, node_limit, lane);
}

}
