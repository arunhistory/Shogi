#include "engine.cpp"

namespace {
constexpr int32_t kHistoryMagic = 0x48535431;  // HST1
constexpr int32_t kHistoryCapacity = 4096;
constexpr int32_t kHistoryEntryWords = 5;
constexpr int kMaxSearchPath = 32;
constexpr int kMaxRootHistory = (kHistoryCapacity - 2) / kHistoryEntryWords;
constexpr uint64_t kSecondarySeed = 0x84222325cbf29ce4ULL;

int32_t g_history_input[kHistoryCapacity] = {};

struct HistoryKey {
  uint64_t primary = 0;
  uint64_t secondary = 0;
};

struct SearchHistoryEntry {
  HistoryKey key{};
  int8_t mover = 0;  // 0=initial, 1=sente, -1=gote
  uint8_t gave_check = 0;
};

SearchHistoryEntry g_root_history[kMaxRootHistory] = {};
SearchHistoryEntry g_search_path[kMaxSearchPath] = {};
int g_root_history_count = 0;
int g_search_path_count = 0;

uint64_t join_u64(int32_t low, int32_t high) {
  return static_cast<uint64_t>(static_cast<uint32_t>(low)) |
         (static_cast<uint64_t>(static_cast<uint32_t>(high)) << 32);
}

uint64_t secondary_hash_position(const Position& pos) {
  uint64_t h = kSecondarySeed;
  auto mix = [&h](uint8_t value) { h ^= value; h *= 1099511628211ULL; };
  for (int i = 0; i < 81; ++i) mix(static_cast<uint8_t>(pos.board[i] + 16));
  for (int s = 0; s < 2; ++s) for (int k = 0; k < 7; ++k) mix(static_cast<uint8_t>(pos.hands[s][k]));
  mix(static_cast<uint8_t>(pos.turn == 1 ? 1 : 2));
  return h;
}

HistoryKey history_key(const Position& pos) {
  return HistoryKey{hash_position(pos), secondary_hash_position(pos)};
}

bool same_history_key(const HistoryKey& a, const HistoryKey& b) {
  return a.primary == b.primary && a.secondary == b.secondary;
}

bool load_search_history(int32_t word_count, const Position& root) {
  g_root_history_count = 0;
  g_search_path_count = 0;
  if (word_count == 0) return true;
  if (word_count < 2 || word_count > kHistoryCapacity) return false;
  if (g_history_input[0] != kHistoryMagic) return false;
  const int count = g_history_input[1];
  if (count < 0 || count > kMaxRootHistory) return false;
  if (2 + count * kHistoryEntryWords != word_count) return false;

  int offset = 2;
  for (int i = 0; i < count; ++i, offset += kHistoryEntryWords) {
    const uint64_t primary = join_u64(g_history_input[offset], g_history_input[offset + 1]);
    const uint64_t secondary = join_u64(g_history_input[offset + 2], g_history_input[offset + 3]);
    const int meta = g_history_input[offset + 4];
    if ((meta & ~7) != 0) return false;
    const int mover_code = meta & 3;
    const bool gave_check = (meta & 4) != 0;
    int mover = 0;
    if (mover_code == 1) mover = 1;
    else if (mover_code == 2) mover = -1;
    else if (mover_code != 0) return false;
    if (mover == 0 && gave_check) return false;
    g_root_history[i] = SearchHistoryEntry{HistoryKey{primary, secondary}, static_cast<int8_t>(mover), static_cast<uint8_t>(gave_check ? 1 : 0)};
  }
  g_root_history_count = count;
  if (count > 0 && !same_history_key(g_root_history[count - 1].key, history_key(root))) return false;
  return true;
}

int combined_history_count() { return g_root_history_count + g_search_path_count; }

const SearchHistoryEntry& combined_history_at(int index) {
  return index < g_root_history_count ? g_root_history[index] : g_search_path[index - g_root_history_count];
}

int repetition_code(const Position& pos) {
  const HistoryKey current = history_key(pos);
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

bool repetition_score(const Position& pos, int ply, int& score) {
  const int code = repetition_code(pos);
  if (code == 0) return false;
  if (code == 1) { score = 0; return true; }
  const int loser = code == 2 ? 1 : -1;
  score = loser == pos.turn ? -kMateScore + ply : kMateScore - ply;
  return true;
}

uint64_t history_context_hash() {
  uint64_t h = 1469598103934665603ULL;
  auto mix_byte = [&h](uint8_t value) { h ^= value; h *= 1099511628211ULL; };
  auto mix_u64 = [&mix_byte](uint64_t value) {
    for (int shift = 0; shift < 64; shift += 8) mix_byte(static_cast<uint8_t>((value >> shift) & 0xff));
  };
  const int total = combined_history_count();
  for (int i = 0; i < total; ++i) {
    const SearchHistoryEntry& entry = combined_history_at(i);
    mix_u64(entry.key.primary);
    mix_u64(entry.key.secondary);
    mix_byte(static_cast<uint8_t>(entry.mover + 1));
    mix_byte(entry.gave_check);
  }
  return h;
}

uint64_t contextual_tt_key(const Position& pos) {
  const uint64_t context = history_context_hash();
  return hash_position(pos) ^ ((context << 1) | (context >> 63));
}

bool push_search_history(const Position& next, int mover) {
  if (g_search_path_count >= kMaxSearchPath) return false;
  g_search_path[g_search_path_count++] = SearchHistoryEntry{
    history_key(next),
    static_cast<int8_t>(mover),
    static_cast<uint8_t>(is_check(next, next.turn) ? 1 : 0),
  };
  return true;
}

void pop_search_history() {
  if (g_search_path_count > 0) --g_search_path_count;
}

int history_quiescence(const Position& pos, int alpha, int beta, int ply, int qdepth) {
  int terminal = 0;
  if (repetition_score(pos, ply, terminal)) return terminal;
  if (++g_nodes >= g_node_limit) return evaluate_for(pos, pos.turn);
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
  for (int i = 0; i < moves.count; ++i) {
    const Move& move = moves.items[i];
    const bool tactical = checked || (move.from >= 0 && pos.board[move.to] != 0) || move.promote;
    if (!tactical) continue;
    Position next;
    apply_move(pos, move, next);
    if (!push_search_history(next, pos.turn)) return evaluate_for(pos, pos.turn);
    const int score = -history_quiescence(next, -beta, -alpha, ply + 1, qdepth + 1);
    pop_search_history();
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
    if (g_nodes >= g_node_limit) break;
  }
  return alpha;
}

int history_negamax(const Position& pos, int depth, int alpha, int beta, int ply) {
  int terminal = 0;
  if (repetition_score(pos, ply, terminal)) return terminal;
  if (g_nodes >= g_node_limit) return evaluate_for(pos, pos.turn);
  ++g_nodes;
  const int original_alpha = alpha;
  const uint64_t key = contextual_tt_key(pos);
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
  if (depth <= 0) return history_quiescence(pos, alpha, beta, ply, 0);

  MoveList moves;
  generate_legal(pos, moves);
  if (moves.count == 0) return is_check(pos, pos.turn) ? -kMateScore + ply : 0;
  order_moves(pos, moves, tt_move);
  int best = -kInfinity;
  int32_t best_move = -1;
  for (int i = 0; i < moves.count; ++i) {
    Position next;
    apply_move(pos, moves.items[i], next);
    if (!push_search_history(next, pos.turn)) return evaluate_for(pos, pos.turn);
    const int score = -history_negamax(next, depth - 1, -beta, -alpha, ply + 1);
    pop_search_history();
    if (score > best) { best = score; best_move = encode_move(moves.items[i]); }
    if (score > alpha) alpha = score;
    if (alpha >= beta || g_nodes >= g_node_limit) break;
  }
  entry.key = key;
  entry.depth = static_cast<int16_t>(depth);
  entry.score = best;
  entry.move = best_move;
  entry.generation = g_generation;
  entry.flag = best <= original_alpha ? 3 : best >= beta ? 2 : 1;
  return best;
}

int32_t history_search_best_move(const Position& root, int max_depth, int node_limit) {
  if (repetition_code(root) != 0) return -1;
  MoveList root_moves;
  generate_legal(root, root_moves);
  if (root_moves.count == 0) return -1;
  if (max_depth < 1) max_depth = 1;
  if (max_depth > 12) max_depth = 12;
  g_node_limit = node_limit < 100 ? 100 : node_limit > 5000000 ? 5000000 : node_limit;
  g_nodes = 0;
  ++g_generation;
  if (g_generation == 0) { std::memset(g_tt, 0, sizeof(g_tt)); ++g_generation; }

  int32_t completed_best = encode_move(root_moves.items[0]);
  for (int depth = 1; depth <= max_depth; ++depth) {
    if (g_nodes >= g_node_limit) break;
    const uint64_t root_key = contextual_tt_key(root);
    const TtEntry& root_entry = g_tt[root_key & (kTtSize - 1)];
    const int32_t tt_move = root_entry.key == root_key ? root_entry.move : completed_best;
    order_moves(root, root_moves, tt_move);
    int best_score = -kInfinity;
    int32_t best_move = completed_best;
    bool completed = true;
    int alpha = -kInfinity;
    for (int i = 0; i < root_moves.count; ++i) {
      Position next;
      apply_move(root, root_moves.items[i], next);
      if (!push_search_history(next, root.turn)) { completed = false; break; }
      const int score = -history_negamax(next, depth - 1, -kInfinity, -alpha, 1);
      pop_search_history();
      if (score > best_score) { best_score = score; best_move = encode_move(root_moves.items[i]); }
      if (score > alpha) alpha = score;
      if (g_nodes >= g_node_limit) { completed = false; break; }
    }
    if (completed || depth == 1) completed_best = best_move;
    if (best_score >= kMateScore - 256) { completed_best = best_move; break; }
  }
  return completed_best;
}
}  // namespace

extern "C" {

int32_t* shogi_history_buffer() { return g_history_input; }
int32_t shogi_history_capacity() { return kHistoryCapacity; }

int32_t shogi_repetition_status_with_history(int32_t position_count, int32_t history_word_count) {
  Position pos;
  if (!load_position(position_count, pos)) return -1;
  if (!load_search_history(history_word_count, pos)) return -1;
  return repetition_code(pos);
}

int32_t shogi_search_best_move_with_history(int32_t position_count, int32_t history_word_count, int32_t max_depth, int32_t node_limit) {
  Position pos;
  if (!load_position(position_count, pos)) return -1;
  if (!load_search_history(history_word_count, pos)) return -1;
  return history_search_best_move(pos, max_depth, node_limit);
}

}
