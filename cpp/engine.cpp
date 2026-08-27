#include <cstdint>
#include <cstring>

namespace {
constexpr int32_t kInputCapacity = 512;
constexpr int32_t kPositionMagic = 0x53484749;  // SHGI
constexpr int32_t kPositionWords = 97;
constexpr int kBoardSquares = 81;
constexpr int kMaxMoves = 768;
constexpr int kMateScore = 10000000;
constexpr int kInfinity = 20000000;
constexpr int kTtSize = 1 << 16;

int32_t g_input[kInputCapacity] = {};

struct Position {
  int8_t board[kBoardSquares] = {};
  int8_t hands[2][7] = {};
  int8_t turn = 1;  // sente=1, gote=-1
};

struct Move {
  int16_t from = -1;
  int16_t to = -1;
  int8_t drop = 0;  // base kind 1..7, 0 when board move
  uint8_t promote = 0;
};

struct MoveList {
  Move items[kMaxMoves] = {};
  int count = 0;
  bool overflow = false;
  void add(const Move& move) {
    if (count >= kMaxMoves) { overflow = true; return; }
    items[count++] = move;
  }
};

struct TtEntry {
  uint64_t key = 0;
  int32_t score = 0;
  int32_t move = -1;
  int16_t depth = -1;
  uint8_t flag = 0;  // 1 exact, 2 lower, 3 upper
  uint8_t generation = 0;
};

TtEntry g_tt[kTtSize] = {};
uint8_t g_generation = 0;
int32_t g_nodes = 0;
int32_t g_node_limit = 100000;
MoveList g_last_legal;

inline int side_index(int side) { return side == 1 ? 0 : 1; }
inline int row_of(int square) { return square / 9; }
inline int col_of(int square) { return square % 9; }
inline bool inside(int y, int x) { return y >= 0 && y < 9 && x >= 0 && x < 9; }
inline int square_of(int y, int x) { return y * 9 + x; }
inline int abs_i(int value) { return value < 0 ? -value : value; }
inline int sign_of(int code) { return code > 0 ? 1 : code < 0 ? -1 : 0; }
inline int kind_of(int code) { return abs_i(code); }

int base_kind(int kind) {
  switch (kind) {
    case 9: return 1;
    case 10: return 2;
    case 11: return 3;
    case 12: return 4;
    case 13: return 6;
    case 14: return 7;
    default: return kind;
  }
}

int promoted_kind(int base) {
  switch (base) {
    case 1: return 9;
    case 2: return 10;
    case 3: return 11;
    case 4: return 12;
    case 6: return 13;
    case 7: return 14;
    default: return base;
  }
}

bool promotable(int kind) {
  const int base = base_kind(kind);
  return base == 1 || base == 2 || base == 3 || base == 4 || base == 6 || base == 7;
}

bool promotion_zone(int side, int y) { return side == 1 ? y <= 2 : y >= 6; }

bool must_promote(int base, int side, int y) {
  if ((base == 1 || base == 2) && (side == 1 ? y == 0 : y == 8)) return true;
  if (base == 3 && (side == 1 ? y <= 1 : y >= 7)) return true;
  return false;
}

int piece_value(int kind) {
  switch (kind) {
    case 1: return 100;
    case 2: return 320;
    case 3: return 360;
    case 4: return 520;
    case 5: return 600;
    case 6: return 900;
    case 7: return 1000;
    case 8: return 0;
    case 9: return 610;
    case 10: return 610;
    case 11: return 610;
    case 12: return 610;
    case 13: return 1250;
    case 14: return 1350;
    default: return 0;
  }
}

bool load_position(int32_t count, Position& out) {
  if (count < kPositionWords || count > kInputCapacity) return false;
  if (g_input[0] != kPositionMagic) return false;
  if (g_input[1] != 1 && g_input[1] != -1) return false;
  out = Position{};
  out.turn = static_cast<int8_t>(g_input[1]);
  for (int i = 0; i < kBoardSquares; ++i) {
    const int code = g_input[2 + i];
    if (code < -14 || code > 14) return false;
    if (code != 0 && kind_of(code) == 0) return false;
    out.board[i] = static_cast<int8_t>(code);
  }
  for (int side = 0; side < 2; ++side) {
    for (int kind = 0; kind < 7; ++kind) {
      const int value = g_input[83 + side * 7 + kind];
      if (value < 0 || value > 40) return false;
      out.hands[side][kind] = static_cast<int8_t>(value);
    }
  }
  return true;
}

bool path_clear(const Position& pos, int from, int to) {
  const int fy = row_of(from), fx = col_of(from), ty = row_of(to), tx = col_of(to);
  const int dy = ty == fy ? 0 : (ty > fy ? 1 : -1);
  const int dx = tx == fx ? 0 : (tx > fx ? 1 : -1);
  int y = fy + dy, x = fx + dx;
  while (y != ty || x != tx) {
    if (pos.board[square_of(y, x)] != 0) return false;
    y += dy; x += dx;
  }
  return true;
}

bool attacks_square(const Position& pos, int from, int to) {
  const int code = pos.board[from];
  if (code == 0 || from == to) return false;
  const int side = sign_of(code), kind = kind_of(code);
  const int fy = row_of(from), fx = col_of(from), ty = row_of(to), tx = col_of(to);
  const int dy = ty - fy, dx = tx - fx, ady = abs_i(dy), adx = abs_i(dx);
  const int f = side == 1 ? -1 : 1;
  if (kind == 8) return ady <= 1 && adx <= 1;
  if (kind == 5 || kind == 9 || kind == 10 || kind == 11 || kind == 12) {
    return (dy == f && adx <= 1) || (dy == 0 && adx == 1) || (dy == -f && dx == 0);
  }
  if (kind == 4) return (dy == f && adx <= 1) || (dy == -f && adx == 1);
  if (kind == 3) return dy == 2 * f && adx == 1;
  if (kind == 1) return dy == f && dx == 0;
  if (kind == 2) return dx == 0 && ((f < 0 && dy < 0) || (f > 0 && dy > 0)) && path_clear(pos, from, to);
  if (kind == 7 || kind == 14) {
    if ((dy == 0 || dx == 0) && path_clear(pos, from, to)) return true;
    if (kind == 14 && ady == 1 && adx == 1) return true;
    return false;
  }
  if (kind == 6 || kind == 13) {
    if (ady == adx && path_clear(pos, from, to)) return true;
    if (kind == 13 && ((ady == 1 && dx == 0) || (adx == 1 && dy == 0))) return true;
    return false;
  }
  return false;
}

bool is_check(const Position& pos, int side) {
  int king = -1;
  for (int i = 0; i < kBoardSquares; ++i) {
    if (pos.board[i] == side * 8) { king = i; break; }
  }
  if (king < 0) return true;
  for (int i = 0; i < kBoardSquares; ++i) {
    if (sign_of(pos.board[i]) == -side && attacks_square(pos, i, king)) return true;
  }
  return false;
}

void apply_move(const Position& pos, const Move& move, Position& next) {
  next = pos;
  const int side = pos.turn;
  if (move.drop > 0) {
    next.board[move.to] = static_cast<int8_t>(side * move.drop);
    --next.hands[side_index(side)][move.drop - 1];
  } else {
    int code = next.board[move.from];
    const int captured = next.board[move.to];
    next.board[move.from] = 0;
    if (captured != 0) {
      const int base = base_kind(kind_of(captured));
      if (base >= 1 && base <= 7) ++next.hands[side_index(side)][base - 1];
    }
    if (move.promote) code = side * promoted_kind(base_kind(kind_of(code)));
    next.board[move.to] = static_cast<int8_t>(code);
  }
  next.turn = static_cast<int8_t>(-side);
}

void add_variant_moves(const Position& pos, int from, int to, MoveList& pseudo) {
  const int code = pos.board[from];
  const int side = sign_of(code), kind = kind_of(code), base = base_kind(kind);
  const bool can_promote = kind == base && promotable(kind) && (promotion_zone(side, row_of(from)) || promotion_zone(side, row_of(to)));
  if (must_promote(base, side, row_of(to))) {
    pseudo.add(Move{static_cast<int16_t>(from), static_cast<int16_t>(to), 0, 1});
  } else {
    pseudo.add(Move{static_cast<int16_t>(from), static_cast<int16_t>(to), 0, 0});
    if (can_promote) pseudo.add(Move{static_cast<int16_t>(from), static_cast<int16_t>(to), 0, 1});
  }
}

void add_step(const Position& pos, int from, int dy, int dx, MoveList& pseudo) {
  const int side = sign_of(pos.board[from]);
  const int y = row_of(from) + dy, x = col_of(from) + dx;
  if (!inside(y, x)) return;
  const int to = square_of(y, x), target = pos.board[to];
  if (sign_of(target) == side || kind_of(target) == 8) return;
  add_variant_moves(pos, from, to, pseudo);
}

void add_slide(const Position& pos, int from, int dy, int dx, MoveList& pseudo) {
  const int side = sign_of(pos.board[from]);
  int y = row_of(from) + dy, x = col_of(from) + dx;
  while (inside(y, x)) {
    const int to = square_of(y, x), target = pos.board[to];
    if (sign_of(target) == side) break;
    if (kind_of(target) == 8) break;
    add_variant_moves(pos, from, to, pseudo);
    if (target != 0) break;
    y += dy; x += dx;
  }
}

void generate_board_pseudo(const Position& pos, MoveList& pseudo) {
  for (int from = 0; from < kBoardSquares; ++from) {
    const int code = pos.board[from];
    if (sign_of(code) != pos.turn) continue;
    const int side = pos.turn, kind = kind_of(code), f = side == 1 ? -1 : 1;
    if (kind == 8) {
      for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) if (dy || dx) add_step(pos, from, dy, dx, pseudo);
    } else if (kind == 5 || kind == 9 || kind == 10 || kind == 11 || kind == 12) {
      add_step(pos, from, f, -1, pseudo); add_step(pos, from, f, 0, pseudo); add_step(pos, from, f, 1, pseudo);
      add_step(pos, from, 0, -1, pseudo); add_step(pos, from, 0, 1, pseudo); add_step(pos, from, -f, 0, pseudo);
    } else if (kind == 4) {
      add_step(pos, from, f, -1, pseudo); add_step(pos, from, f, 0, pseudo); add_step(pos, from, f, 1, pseudo);
      add_step(pos, from, -f, -1, pseudo); add_step(pos, from, -f, 1, pseudo);
    } else if (kind == 3) {
      add_step(pos, from, 2 * f, -1, pseudo); add_step(pos, from, 2 * f, 1, pseudo);
    } else if (kind == 2) {
      add_slide(pos, from, f, 0, pseudo);
    } else if (kind == 1) {
      add_step(pos, from, f, 0, pseudo);
    } else if (kind == 7 || kind == 14) {
      add_slide(pos, from, -1, 0, pseudo); add_slide(pos, from, 1, 0, pseudo); add_slide(pos, from, 0, -1, pseudo); add_slide(pos, from, 0, 1, pseudo);
      if (kind == 14) { add_step(pos, from, -1, -1, pseudo); add_step(pos, from, -1, 1, pseudo); add_step(pos, from, 1, -1, pseudo); add_step(pos, from, 1, 1, pseudo); }
    } else if (kind == 6 || kind == 13) {
      add_slide(pos, from, -1, -1, pseudo); add_slide(pos, from, -1, 1, pseudo); add_slide(pos, from, 1, -1, pseudo); add_slide(pos, from, 1, 1, pseudo);
      if (kind == 13) { add_step(pos, from, -1, 0, pseudo); add_step(pos, from, 1, 0, pseudo); add_step(pos, from, 0, -1, pseudo); add_step(pos, from, 0, 1, pseudo); }
    }
  }
}

bool has_unpromoted_pawn_on_file(const Position& pos, int side, int x) {
  for (int y = 0; y < 9; ++y) if (pos.board[square_of(y, x)] == side * 1) return true;
  return false;
}

void generate_legal(const Position& pos, MoveList& out);

void generate_drops(const Position& pos, MoveList& out) {
  const int side = pos.turn, hand_side = side_index(side);
  for (int kind = 1; kind <= 7; ++kind) {
    if (pos.hands[hand_side][kind - 1] <= 0) continue;
    for (int to = 0; to < kBoardSquares; ++to) {
      if (pos.board[to] != 0) continue;
      const int y = row_of(to), x = col_of(to);
      if ((kind == 1 || kind == 2) && (side == 1 ? y == 0 : y == 8)) continue;
      if (kind == 3 && (side == 1 ? y <= 1 : y >= 7)) continue;
      if (kind == 1 && has_unpromoted_pawn_on_file(pos, side, x)) continue;
      const Move move{-1, static_cast<int16_t>(to), static_cast<int8_t>(kind), 0};
      Position next;
      apply_move(pos, move, next);
      if (is_check(next, side)) continue;
      if (kind == 1 && is_check(next, next.turn)) {
        MoveList replies;
        generate_legal(next, replies);
        if (replies.count == 0) continue;  // uchi-fuzume
      }
      out.add(move);
    }
  }
}

void generate_legal(const Position& pos, MoveList& out) {
  out.count = 0; out.overflow = false;
  MoveList pseudo;
  generate_board_pseudo(pos, pseudo);
  for (int i = 0; i < pseudo.count; ++i) {
    Position next;
    apply_move(pos, pseudo.items[i], next);
    if (!is_check(next, pos.turn)) out.add(pseudo.items[i]);
  }
  generate_drops(pos, out);
}

int32_t encode_move(const Move& move) {
  if (move.to < 0 || move.to >= 81) return -1;
  const int from = move.from >= 0 ? move.from : 127;
  return (move.to & 0x7f) | ((from & 0x7f) << 7) | ((move.drop & 0x0f) << 14) | ((move.promote ? 1 : 0) << 18);
}

bool same_move_code(const Move& move, int32_t code) { return encode_move(move) == code; }

uint64_t hash_position(const Position& pos) {
  uint64_t h = 1469598103934665603ULL;
  auto mix = [&h](uint8_t value) { h ^= value; h *= 1099511628211ULL; };
  for (int i = 0; i < 81; ++i) mix(static_cast<uint8_t>(pos.board[i] + 16));
  for (int s = 0; s < 2; ++s) for (int k = 0; k < 7; ++k) mix(static_cast<uint8_t>(pos.hands[s][k]));
  mix(static_cast<uint8_t>(pos.turn == 1 ? 1 : 2));
  return h;
}

int advancement_bonus(int kind, int side, int y) {
  const int progress = side == 1 ? 8 - y : y;
  if (kind == 1) return progress * 4;
  if (kind == 2) return progress * 2;
  if (kind == 3 || kind == 4) return progress * 3;
  return 0;
}

int evaluate_for(const Position& pos, int perspective) {
  int score = 0;
  for (int i = 0; i < 81; ++i) {
    const int code = pos.board[i];
    if (!code) continue;
    const int side = sign_of(code), kind = kind_of(code);
    int value = piece_value(kind) + advancement_bonus(kind, side, row_of(i));
    if (kind != 8) {
      const int center = 4 - abs_i(col_of(i) - 4);
      value += center * 2;
    }
    score += side == perspective ? value : -value;
  }
  for (int side : {1, -1}) {
    const int multiplier = side == perspective ? 1 : -1;
    for (int kind = 1; kind <= 7; ++kind) score += multiplier * pos.hands[side_index(side)][kind - 1] * piece_value(kind);
  }
  if (is_check(pos, perspective)) score -= 180;
  if (is_check(pos, -perspective)) score += 180;
  return score;
}

int move_order_score(const Position& pos, const Move& move, int32_t tt_move) {
  int score = same_move_code(move, tt_move) ? 1000000 : 0;
  if (move.from >= 0 && pos.board[move.to] != 0) {
    score += 10000 + piece_value(kind_of(pos.board[move.to])) * 10 - piece_value(kind_of(pos.board[move.from]));
  }
  if (move.promote) score += 5000;
  if (move.drop) score += piece_value(move.drop) / 4;
  return score;
}

void order_moves(const Position& pos, MoveList& list, int32_t tt_move) {
  for (int i = 0; i < list.count; ++i) {
    int best = i, best_score = move_order_score(pos, list.items[i], tt_move);
    for (int j = i + 1; j < list.count; ++j) {
      const int score = move_order_score(pos, list.items[j], tt_move);
      if (score > best_score) { best = j; best_score = score; }
    }
    if (best != i) { const Move tmp = list.items[i]; list.items[i] = list.items[best]; list.items[best] = tmp; }
  }
}

int quiescence(const Position& pos, int alpha, int beta, int ply, int qdepth) {
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
    Position next; apply_move(pos, move, next);
    const int score = -quiescence(next, -beta, -alpha, ply + 1, qdepth + 1);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
    if (g_nodes >= g_node_limit) break;
  }
  return alpha;
}

int negamax(const Position& pos, int depth, int alpha, int beta, int ply) {
  if (g_nodes >= g_node_limit) return evaluate_for(pos, pos.turn);
  ++g_nodes;
  const int original_alpha = alpha;
  const uint64_t key = hash_position(pos);
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
  if (depth <= 0) return quiescence(pos, alpha, beta, ply, 0);

  MoveList moves;
  generate_legal(pos, moves);
  if (moves.count == 0) return is_check(pos, pos.turn) ? -kMateScore + ply : 0;
  order_moves(pos, moves, tt_move);
  int best = -kInfinity;
  int32_t best_move = -1;
  for (int i = 0; i < moves.count; ++i) {
    Position next; apply_move(pos, moves.items[i], next);
    const int score = -negamax(next, depth - 1, -beta, -alpha, ply + 1);
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

int32_t search_best_move(const Position& root, int max_depth, int node_limit) {
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
    const uint64_t root_key = hash_position(root);
    const TtEntry& root_entry = g_tt[root_key & (kTtSize - 1)];
    const int32_t tt_move = root_entry.key == root_key ? root_entry.move : completed_best;
    order_moves(root, root_moves, tt_move);
    int best_score = -kInfinity;
    int32_t best_move = completed_best;
    bool completed = true;
    int alpha = -kInfinity;
    for (int i = 0; i < root_moves.count; ++i) {
      Position next; apply_move(root, root_moves.items[i], next);
      const int score = -negamax(next, depth - 1, -kInfinity, -alpha, 1);
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

// Pure deterministic shogi algorithms only. No generative AI, ML, neural
// network, NNUE, learned model, or external AI service is used.
extern "C" {

int32_t shogi_engine_version() { return 3; }
int32_t* shogi_input_buffer() { return g_input; }
int32_t shogi_input_capacity() { return kInputCapacity; }

int32_t shogi_evaluate_material_codes(int32_t count) {
  if (count < 0 || count > kInputCapacity) return 0;
  int32_t score = 0;
  for (int32_t i = 0; i < count; ++i) {
    const int32_t signed_code = g_input[i];
    if (signed_code == 0) continue;
    const int32_t code = signed_code < 0 ? -signed_code : signed_code;
    const int32_t value = piece_value(code);
    score += signed_code < 0 ? -value : value;
  }
  return score;
}

int32_t shogi_evaluate_material(const int32_t* pieces, int32_t count) {
  if (!pieces || count < 0) return 0;
  int32_t score = 0;
  for (int32_t i = 0; i < count; ++i) score += pieces[i];
  return score;
}

int32_t shogi_evaluate_position(int32_t count, int32_t perspective) {
  Position pos;
  if (!load_position(count, pos) || (perspective != 1 && perspective != -1)) return 0;
  return evaluate_for(pos, perspective);
}

int32_t shogi_legal_move_count(int32_t count) {
  Position pos;
  if (!load_position(count, pos)) return -1;
  generate_legal(pos, g_last_legal);
  if (g_last_legal.overflow) return -2;
  return g_last_legal.count;
}

int32_t shogi_legal_move_at(int32_t index) {
  if (index < 0 || index >= g_last_legal.count) return -1;
  return encode_move(g_last_legal.items[index]);
}

int32_t shogi_is_check(int32_t count, int32_t side) {
  Position pos;
  if (!load_position(count, pos) || (side != 1 && side != -1)) return -1;
  return is_check(pos, side) ? 1 : 0;
}

int32_t shogi_is_mate(int32_t count) {
  Position pos;
  if (!load_position(count, pos)) return -1;
  if (!is_check(pos, pos.turn)) return 0;
  MoveList moves; generate_legal(pos, moves);
  return moves.count == 0 ? 1 : 0;
}

int32_t shogi_search_best_move(int32_t count, int32_t max_depth, int32_t node_limit) {
  Position pos;
  if (!load_position(count, pos)) return -1;
  return search_best_move(pos, max_depth, node_limit);
}

int32_t shogi_nodes_searched() { return g_nodes; }

}
