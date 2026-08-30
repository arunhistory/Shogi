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

// Title class uses a single generated attack map for many simultaneous tactical
// questions. That makes each evaluation richer without repeatedly rescanning the
// whole board for every king-ring square.
struct TitleAttackMap {
  uint8_t attacks[2][kBoardSquares];
  int king[2];
};

int title_slot(int side) { return side == 1 ? 0 : 1; }

void title_mark_attack(TitleAttackMap& map, int side, int y, int x) {
  if (!inside(y, x)) return;
  uint8_t& value = map.attacks[title_slot(side)][square_of(y, x)];
  if (value < 7) ++value;
}

void title_mark_ray(const Position& pos, TitleAttackMap& map, int side, int y, int x, int dy, int dx) {
  y += dy;
  x += dx;
  while (inside(y, x)) {
    title_mark_attack(map, side, y, x);
    if (pos.board[square_of(y, x)] != 0) break;
    y += dy;
    x += dx;
  }
}

void title_mark_piece_attacks(const Position& pos, TitleAttackMap& map, int square) {
  const int code = pos.board[square];
  const int side = sign_of(code);
  if (side == 0) return;
  const int kind = kind_of(code);
  const int y = row_of(square), x = col_of(square);
  const int forward = side == 1 ? -1 : 1;
  const bool gold_like = kind == 5 || kind == 9 || kind == 10 || kind == 11 || kind == 12;

  if (kind == 8) {
    for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
      if (dy != 0 || dx != 0) title_mark_attack(map, side, y + dy, x + dx);
    }
    return;
  }
  if (gold_like) {
    title_mark_attack(map, side, y + forward, x - 1);
    title_mark_attack(map, side, y + forward, x);
    title_mark_attack(map, side, y + forward, x + 1);
    title_mark_attack(map, side, y, x - 1);
    title_mark_attack(map, side, y, x + 1);
    title_mark_attack(map, side, y - forward, x);
    return;
  }
  if (kind == 4) {
    title_mark_attack(map, side, y + forward, x - 1);
    title_mark_attack(map, side, y + forward, x);
    title_mark_attack(map, side, y + forward, x + 1);
    title_mark_attack(map, side, y - forward, x - 1);
    title_mark_attack(map, side, y - forward, x + 1);
    return;
  }
  if (kind == 3) {
    title_mark_attack(map, side, y + forward * 2, x - 1);
    title_mark_attack(map, side, y + forward * 2, x + 1);
    return;
  }
  if (kind == 1) {
    title_mark_attack(map, side, y + forward, x);
    return;
  }
  if (kind == 2) {
    title_mark_ray(pos, map, side, y, x, forward, 0);
    return;
  }
  if (kind == 6 || kind == 13) {
    title_mark_ray(pos, map, side, y, x, -1, -1);
    title_mark_ray(pos, map, side, y, x, -1, 1);
    title_mark_ray(pos, map, side, y, x, 1, -1);
    title_mark_ray(pos, map, side, y, x, 1, 1);
    if (kind == 13) {
      title_mark_attack(map, side, y - 1, x);
      title_mark_attack(map, side, y + 1, x);
      title_mark_attack(map, side, y, x - 1);
      title_mark_attack(map, side, y, x + 1);
    }
    return;
  }
  if (kind == 7 || kind == 14) {
    title_mark_ray(pos, map, side, y, x, -1, 0);
    title_mark_ray(pos, map, side, y, x, 1, 0);
    title_mark_ray(pos, map, side, y, x, 0, -1);
    title_mark_ray(pos, map, side, y, x, 0, 1);
    if (kind == 14) {
      title_mark_attack(map, side, y - 1, x - 1);
      title_mark_attack(map, side, y - 1, x + 1);
      title_mark_attack(map, side, y + 1, x - 1);
      title_mark_attack(map, side, y + 1, x + 1);
    }
  }
}

void build_title_attack_map(const Position& pos, TitleAttackMap& map) {
  std::memset(&map, 0, sizeof(map));
  map.king[0] = -1;
  map.king[1] = -1;
  for (int square = 0; square < kBoardSquares; ++square) {
    const int code = pos.board[square];
    const int side = sign_of(code);
    if (side == 0) continue;
    if (kind_of(code) == 8) map.king[title_slot(side)] = square;
    title_mark_piece_attacks(pos, map, square);
  }
}

int title_piece_weight(int kind) {
  if (kind == 7 || kind == 14) return 10;
  if (kind == 6 || kind == 13) return 9;
  if (kind == 5 || kind == 9 || kind == 10 || kind == 11 || kind == 12) return 6;
  if (kind == 4) return 5;
  if (kind == 3 || kind == 2) return 3;
  if (kind == 1) return 1;
  return 0;
}

int title_escape_count_from_map(const Position& pos, const TitleAttackMap& map, int attacker_side, int defender_side) {
  const int king = map.king[title_slot(defender_side)];
  if (king < 0) return 0;
  const int ky = row_of(king), kx = col_of(king);
  const int attacker_slot = title_slot(attacker_side);
  int escapes = 0;
  for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
    if (dy == 0 && dx == 0) continue;
    const int y = ky + dy, x = kx + dx;
    if (!inside(y, x)) continue;
    const int target = square_of(y, x);
    if (sign_of(pos.board[target]) == defender_side) continue;
    if (map.attacks[attacker_slot][target] == 0) ++escapes;
  }
  return escapes;
}

int title_king_pressure_from_map(const Position& pos, const TitleAttackMap& map, int attacker_side, int defender_side) {
  const int king = map.king[title_slot(defender_side)];
  if (king < 0) return kMateScore / 2;
  const int attacker_slot = title_slot(attacker_side);
  const int defender_slot = title_slot(defender_side);
  const int ky = row_of(king), kx = col_of(king);
  int attacked_ring = 0;
  int contacts = 0;
  int double_contacts = 0;
  int dominated = 0;
  int shield = 0;
  int overloaded_shield = 0;
  int zone_control = 0;

  for (int dy = -2; dy <= 2; ++dy) for (int dx = -2; dx <= 2; ++dx) {
    if (dy == 0 && dx == 0) continue;
    const int y = ky + dy, x = kx + dx;
    if (!inside(y, x)) continue;
    const int target = square_of(y, x);
    const int attack = map.attacks[attacker_slot][target];
    if (attack > 0) zone_control += (abs_i(dy) <= 1 && abs_i(dx) <= 1) ? 2 : 1;
  }

  for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
    if (dy == 0 && dx == 0) continue;
    const int y = ky + dy, x = kx + dx;
    if (!inside(y, x)) continue;
    const int target = square_of(y, x);
    const int attack = map.attacks[attacker_slot][target];
    const int defend = map.attacks[defender_slot][target];
    const int occupant = pos.board[target];
    if (attack > 0) ++attacked_ring;
    contacts += attack > 3 ? 3 : attack;
    if (attack >= 2) ++double_contacts;
    if (attack > defend) ++dominated;
    if (sign_of(occupant) == defender_side) {
      const int kind = kind_of(occupant);
      shield += title_piece_weight(kind);
      if (attack > 0 && attack >= defend) overloaded_shield += title_piece_weight(kind);
    }
  }

  const int escapes = title_escape_count_from_map(pos, map, attacker_side, defender_side);
  int score = attacked_ring * 70
    + contacts * 16
    + double_contacts * 30
    + dominated * 22
    + zone_control * 8
    + overloaded_shield * 10
    - escapes * 72
    - shield * 5;
  if (is_check(pos, defender_side)) score += 520;
  score += map.attacks[attacker_slot][king] * 45;
  return score;
}

int title_piece_pressure_from_map(const Position& pos, const TitleAttackMap& map, int attacker_side) {
  const int defender_side = -attacker_side;
  const int attacker_slot = title_slot(attacker_side);
  const int defender_slot = title_slot(defender_side);
  const int defender_king = map.king[defender_slot];
  int score = 0;
  for (int square = 0; square < kBoardSquares; ++square) {
    const int code = pos.board[square];
    const int side = sign_of(code);
    if (side == 0 || kind_of(code) == 8) continue;
    const int weight = title_piece_weight(kind_of(code));
    const int attack = map.attacks[attacker_slot][square];
    const int defend = map.attacks[defender_slot][square];
    if (side == defender_side && attack > 0) {
      score += weight * (attack > defend ? 20 : 5);
      if (defender_king >= 0) {
        const int distance = abs_i(row_of(square) - row_of(defender_king)) + abs_i(col_of(square) - col_of(defender_king));
        if (distance <= 2) score += weight * (attack >= defend ? 12 : 4);
      }
    } else if (side == attacker_side) {
      const int enemy_attack = map.attacks[defender_slot][square];
      const int own_defend = map.attacks[attacker_slot][square];
      if (enemy_attack > own_defend) score -= weight * 14;
      else if (own_defend > 0 && enemy_attack > 0) score += weight * 2;
    }
  }
  return score;
}

int title_space_control_from_map(const Position& pos, const TitleAttackMap& map, int side) {
  const int slot = title_slot(side);
  int score = 0;
  for (int square = 0; square < kBoardSquares; ++square) {
    const int y = row_of(square), x = col_of(square);
    const bool enemy_half = side == 1 ? y <= 4 : y >= 4;
    if (!enemy_half || map.attacks[slot][square] == 0) continue;
    score += 2;
    if (x >= 2 && x <= 6) ++score;
    if (pos.board[square] == 0 && map.attacks[slot][square] >= 2) ++score;
  }
  return score;
}

int title_hand_force(const Position& pos, int side) {
  const int index = side_index(side);
  return pos.hands[index][6] * 70
    + pos.hands[index][5] * 62
    + pos.hands[index][4] * 42
    + pos.hands[index][3] * 34
    + pos.hands[index][2] * 28
    + pos.hands[index][1] * 22
    + pos.hands[index][0] * 8;
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

int title_complex_side_score_from_map(const Position& pos, const TitleAttackMap& map, int side) {
  const int defender = -side;
  const int king_pressure = title_king_pressure_from_map(pos, map, side, defender);
  const int piece_pressure = title_piece_pressure_from_map(pos, map, side);
  const int space = title_space_control_from_map(pos, map, side);
  const int induced = attack_commitment_exposure(pos, defender) * 6;
  const int escapes = title_escape_count_from_map(pos, map, side, defender);
  const int hand_synergy = title_hand_force(pos, side) * (9 - (escapes > 8 ? 8 : escapes)) / 18;
  return king_pressure + piece_pressure + space * 3 + induced + hand_synergy;
}

int title_forcing_pressure_from_map(const Position& pos, const TitleAttackMap& map, int side) {
  const int defender = -side;
  return title_king_pressure_from_map(pos, map, side, defender)
    + title_piece_pressure_from_map(pos, map, side) / 2
    + attack_commitment_exposure(pos, defender) * 5;
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
  int score = attacked_ring * 36 + attack_contacts * 9 - escape_like * 28 - shield * 8;
  if (is_check(pos, defender_side)) score += 280;
  return score;
}

int mating_pressure_score(const Position& pos, int attacker_side) {
  if (g_parallel_profile < 3) return 0;
  if (g_parallel_profile >= 4) {
    TitleAttackMap map;
    build_title_attack_map(pos, map);
    return title_forcing_pressure_from_map(pos, map, attacker_side);
  }
  const int defender_side = -attacker_side;
  return king_net_pressure(pos, attacker_side, defender_side) + attack_commitment_exposure(pos, defender_side) * 4;
}

int parallel_evaluate_for(const Position& pos, int perspective) {
  const int base = evaluate_for(pos, perspective);
  if (g_parallel_profile <= 1) return base;
  if (g_parallel_profile == 2) {
    const int strategic = strategic_side_score(pos, perspective) - strategic_side_score(pos, -perspective);
    return base + strategic;
  }
  if (g_parallel_profile == 3) {
    const int strategic = strategic_side_score(pos, perspective) - strategic_side_score(pos, -perspective);
    const int mating = mating_pressure_score(pos, perspective) - mating_pressure_score(pos, -perspective);
    return base + strategic / 2 + mating * 3 / 2;
  }

  TitleAttackMap map;
  build_title_attack_map(pos, map);
  const int complex = title_complex_side_score_from_map(pos, map, perspective)
    - title_complex_side_score_from_map(pos, map, -perspective);
  const int activity = major_activity(pos, perspective) - major_activity(pos, -perspective);
  const int invasion = promoted_invasion(pos, perspective) - promoted_invasion(pos, -perspective);
  const int hand = hand_initiative(pos, perspective) - hand_initiative(pos, -perspective);
  return base + complex + activity * 2 + invasion * 2 + hand / 2;
}

void order_parallel_moves(const Position& pos, MoveList& list, int32_t tt_move, int ply, bool include_quiet_pressure) {
  order_moves(pos, list, tt_move);
  if (g_parallel_profile < 3 || list.count <= 1) return;
  MoveList checks;
  MoveList pressure;
  MoveList rest;
  const bool seek_quiet_net = include_quiet_pressure && g_parallel_profile >= 4 && ply <= 5;
  const int baseline = seek_quiet_net ? mating_pressure_score(pos, pos.turn) : 0;
  for (int i = 0; i < list.count; ++i) {
    const Move move = list.items[i];
    Position next;
    apply_move(pos, move, next);
    if (is_check(next, next.turn)) {
      checks.add(move);
    } else if (seek_quiet_net && mating_pressure_score(next, pos.turn) >= baseline + 55) {
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
  const int qlimit = g_parallel_profile >= 4 ? 7 : g_parallel_profile >= 3 ? 5 : 4;
  if (qdepth >= qlimit) return checked ? stand - 200 : alpha;

  MoveList moves;
  generate_legal(pos, moves);
  if (moves.count == 0) return checked ? -kMateScore + ply : 0;
  order_parallel_moves(pos, moves, -1, ply + qdepth, false);
  const int offset = lane_offset(pos, moves.count, ply + qdepth);
  const int quiet_baseline = g_parallel_profile >= 4 && !checked && qdepth < 2 ? mating_pressure_score(pos, pos.turn) : 0;
  int quiet_threats = 0;
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
    if (!tactical && g_parallel_profile >= 4 && qdepth < 2 && quiet_threats < 2) {
      if (!next_ready) {
        apply_move(pos, move, next);
        next_ready = true;
      }
      if (mating_pressure_score(next, pos.turn) >= quiet_baseline + 90) {
        tactical = true;
        ++quiet_threats;
      }
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

int parallel_negamax(const Position& pos, int depth, int alpha, int beta, int ply, int extensions_left) {
  int terminal = 0;
  if (repetition_score(pos, ply, terminal)) return terminal;
  if (g_nodes >= g_node_limit) {
    g_parallel_complete = false;
    return parallel_evaluate_for(pos, pos.turn);
  }
  ++g_nodes;
  const int original_alpha = alpha;
  uint64_t key = lane_key(pos, ply);
  if (g_parallel_profile >= 4) key ^= static_cast<uint64_t>(extensions_left + 1) * 0xd6e8feb86659fd93ULL;
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
    int child_depth = depth - 1;
    int child_extensions = extensions_left;
    if (g_parallel_profile >= 4 && child_extensions > 0 && depth <= 5 && is_check(next, next.turn)) {
      child_depth = depth;
      --child_extensions;
    }
    const int score = -parallel_negamax(next, child_depth, -beta, -alpha, ply + 1, child_extensions);
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
  const int extensions = g_parallel_profile >= 4 ? 2 : 0;
  const int score = -parallel_negamax(next, max_depth - 1, -kInfinity, kInfinity, 1, extensions);
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
