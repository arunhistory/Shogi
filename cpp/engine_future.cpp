#include "engine_parallel.cpp"

namespace {
constexpr int kFutureHandCredits = 6;
constexpr int kFutureCheckCredits = 2;
constexpr int kFutureDepthCap = 18;
constexpr int kForecastTableSize = 1 << 17;

struct ForecastTtEntry {
  uint64_t key = 0;
  int32_t score = 0;
  int32_t move = -1;
  int16_t depth = -1;
  uint8_t flag = 0;  // 1 exact, 2 lower, 3 upper
};

struct ForecastAtlasEntry {
  uint64_t key = 0;
  int32_t move = -1;
  int32_t score = 0;
  int16_t depth = -1;
  uint16_t observations = 0;
};

ForecastTtEntry g_forecast_tt[kForecastTableSize] = {};
ForecastAtlasEntry g_forecast_atlas[kForecastTableSize] = {};
int32_t g_forecast_tt_hits = 0;
int32_t g_forecast_atlas_hits = 0;

// Title forecasting previously rebuilt the FNV history-context hash from the
// complete root+search path at every TT probe. Numerical forecasting revisits
// enormous numbers of nearby states, so the title path keeps the exact same
// context hash incrementally. The stack mirrors push/pop_search_history and
// therefore changes computation cost, not repetition semantics or key values.
uint64_t g_future_context_stack[kMaxSearchPath + 1] = {};
int g_future_context_depth = 0;

uint64_t future_context_mix_byte(uint64_t hash, uint8_t value) {
  hash ^= value;
  hash *= 1099511628211ULL;
  return hash;
}

uint64_t future_context_mix_u64(uint64_t hash, uint64_t value) {
  for (int shift = 0; shift < 64; shift += 8) {
    hash = future_context_mix_byte(hash, static_cast<uint8_t>((value >> shift) & 0xff));
  }
  return hash;
}

uint64_t future_context_extend(uint64_t hash, const SearchHistoryEntry& entry) {
  hash = future_context_mix_u64(hash, entry.key.primary);
  hash = future_context_mix_u64(hash, entry.key.secondary);
  hash = future_context_mix_byte(hash, static_cast<uint8_t>(entry.mover + 1));
  hash = future_context_mix_byte(hash, entry.gave_check);
  return hash;
}

void future_context_reset() {
  g_future_context_depth = 0;
  // At a root job g_search_path_count is zero; this one legacy pass hashes the
  // observed game history. Every forecast descendant then updates in O(1).
  g_future_context_stack[0] = history_context_hash();
}

bool future_push_search_history(const Position& next, int mover) {
  if (!push_search_history(next, mover)) return false;
  if (g_future_context_depth >= kMaxSearchPath) {
    pop_search_history();
    return false;
  }
  const SearchHistoryEntry& entry = g_search_path[g_search_path_count - 1];
  g_future_context_stack[g_future_context_depth + 1] =
    future_context_extend(g_future_context_stack[g_future_context_depth], entry);
  ++g_future_context_depth;
  return true;
}

void future_pop_search_history() {
  if (g_future_context_depth > 0) --g_future_context_depth;
  pop_search_history();
}

uint64_t future_contextual_tt_key(const Position& pos) {
  const uint64_t context = g_future_context_stack[g_future_context_depth];
  return hash_position(pos) ^ ((context << 1) | (context >> 63));
}

uint64_t future_state_key(const Position& pos, int hand_credits, int check_credits) {
  uint64_t key = future_contextual_tt_key(pos);
  key ^= static_cast<uint64_t>(hand_credits + 1) * 0x9e3779b97f4a7c15ULL;
  key ^= static_cast<uint64_t>(check_credits + 1) * 0xbf58476d1ce4e5b9ULL;
  return key;
}

uint64_t forecast_atlas_key(const Position& pos) {
  // History is deliberately excluded here. The atlas is used only for move
  // ordering, never as a score cutoff, so equal board+hand+turn states reached
  // by different paths can safely share forecast guidance without weakening
  // repetition/perpetual-check correctness.
  return hash_position(pos);
}

int32_t forecast_atlas_move(const Position& pos) {
  const uint64_t key = forecast_atlas_key(pos);
  const ForecastAtlasEntry& entry = g_forecast_atlas[key & (kForecastTableSize - 1)];
  if (entry.key != key || entry.move < 0) return -1;
  ++g_forecast_atlas_hits;
  return entry.move;
}

void update_forecast_atlas(const Position& pos, int depth, int32_t move, int score) {
  if (move < 0) return;
  const uint64_t key = forecast_atlas_key(pos);
  ForecastAtlasEntry& entry = g_forecast_atlas[key & (kForecastTableSize - 1)];
  if (entry.key != key || depth >= entry.depth) {
    const uint16_t observations = entry.key == key && entry.observations < 65535
      ? static_cast<uint16_t>(entry.observations + 1)
      : static_cast<uint16_t>(1);
    entry.key = key;
    entry.move = move;
    entry.score = score;
    entry.depth = static_cast<int16_t>(depth);
    entry.observations = observations;
  } else if (entry.key == key && entry.observations < 65535) {
    ++entry.observations;
  }
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

int future_move_order_score(const Position& pos, const Move& move, int32_t preferred_move) {
  int score = move_order_score(pos, move, preferred_move);
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

void order_future_moves(const Position& pos, MoveList& list, int32_t preferred_move) {
  if (list.count <= 1) return;
  int scores[kMaxMoves] = {};
  for (int i = 0; i < list.count; ++i) scores[i] = future_move_order_score(pos, list.items[i], preferred_move);
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

  // A captured piece is a new future move generator. Ordinary full-width
  // search already reaches the capturer's next turn when depth >= 3, so only
  // horizon captures are extended far enough to expose every legal drop that
  // the newly acquired hand piece creates.
  if (captured && next_hand > 0 && depth < 3) {
    extension = 3 - depth;
    const int spend = extension > next_hand ? next_hand : extension;
    extension = spend;
    next_hand -= spend;
  }

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
  if (qdepth >= 1) return checked ? stand - 200 : alpha;

  MoveList moves;
  generate_legal(pos, moves);
  if (moves.count == 0) return checked ? -kMateScore + ply : 0;
  const int32_t atlas_move = forecast_atlas_move(pos);
  order_future_moves(pos, moves, atlas_move);
  const int offset = future_lane_offset(pos, moves.count, ply + qdepth);
  for (int step = 0; step < moves.count; ++step) {
    const Move& move = moves.items[(offset + step) % moves.count];
    Position next;
    apply_move(pos, move, next);
    const bool checking = is_check(next, next.turn);
    const bool tactical = checked || future_capture(pos, move) || move.promote || checking;
    if (!tactical) continue;
    if (!future_push_search_history(next, pos.turn)) {
      g_parallel_complete = false;
      return parallel_evaluate_for(pos, pos.turn);
    }
    const int score = -future_quiescence(next, -beta, -alpha, ply + 1, qdepth + 1);
    future_pop_search_history();
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
  ForecastTtEntry& entry = g_forecast_tt[key & (kForecastTableSize - 1)];
  int32_t preferred_move = -1;
  if (entry.key == key && entry.depth >= 0) {
    ++g_forecast_tt_hits;
    preferred_move = entry.move;
    if (entry.depth >= depth) {
      if (entry.flag == 1) return entry.score;
      if (entry.flag == 2 && entry.score >= beta) return entry.score;
      if (entry.flag == 3 && entry.score <= alpha) return entry.score;
    }
  }
  if (preferred_move < 0) preferred_move = forecast_atlas_move(pos);

  MoveList moves;
  generate_legal(pos, moves);
  if (moves.count == 0) return is_check(pos, pos.turn) ? -kMateScore + ply : 0;
  order_future_moves(pos, moves, preferred_move);
  const int offset = future_lane_offset(pos, moves.count, ply);

  int best = -kInfinity;
  int32_t best_move = -1;
  bool first = true;
  for (int step = 0; step < moves.count; ++step) {
    const Move& move = moves.items[(offset + step) % moves.count];
    Position next;
    apply_move(pos, move, next);
    if (!future_push_search_history(next, pos.turn)) {
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
    future_pop_search_history();

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

  // Only complete subtrees become exact forecast memory. The path-independent
  // atlas is guidance only and therefore safe to reuse across transpositions.
  if (g_parallel_complete) {
    if (entry.key != key || depth >= entry.depth) {
      entry.key = key;
      entry.depth = static_cast<int16_t>(depth);
      entry.score = best;
      entry.move = best_move;
      entry.flag = best <= original_alpha ? 3 : best >= beta ? 2 : 1;
    }
    update_forecast_atlas(pos, depth, best_move, best);
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
  g_node_limit = node_limit < 100 ? 100 : node_limit > 2000000 ? 2000000 : node_limit;
  g_nodes = 0;
  g_parallel_complete = true;
  g_parallel_profile = 4;
  g_parallel_lane = static_cast<uint32_t>(lane < 0 ? -lane : lane);
  g_forecast_tt_hits = 0;
  g_forecast_atlas_hits = 0;
  future_context_reset();

  Position next;
  apply_move(root, verified, next);
  if (!future_push_search_history(next, root.turn)) {
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
  future_pop_search_history();
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

int32_t shogi_forecast_tt_hits() { return g_forecast_tt_hits; }
int32_t shogi_forecast_atlas_hits() { return g_forecast_atlas_hits; }

}
