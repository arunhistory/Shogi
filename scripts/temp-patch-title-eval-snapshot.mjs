import {readFile,writeFile} from 'node:fs/promises';

const path='cpp/engine_parallel.cpp';
let source=await readFile(path,'utf8');
const oldText=`int parallel_evaluate_for(const Position& pos, int perspective) {
  const int base = evaluate_for(pos, perspective);
  if (g_parallel_profile <= 1) return base;
  const int strategic = strategic_side_score(pos, perspective) - strategic_side_score(pos, -perspective);
  if (g_parallel_profile == 2) return base + strategic;
  const int mating = mating_pressure_score(pos, perspective) - mating_pressure_score(pos, -perspective);
  if (g_parallel_profile == 3) return base + strategic / 2 + mating * 3 / 2;
  return base + strategic / 3 + mating * 2;
}`;

const newText=`struct ParallelSideEvalSnapshot {
  int king = -1;
  int shield = 0;
  int danger = 0;
  int attacked_ring = 0;
  int attack_contacts = 0;
  int escape_like = 0;
  int activity = 0;
  int hand = 0;
  int promoted = 0;
  int exposure = 0;
  bool checked = false;
};

ParallelSideEvalSnapshot build_parallel_side_eval_snapshot(const Position& pos, int side) {
  ParallelSideEvalSnapshot snapshot;
  snapshot.king = king_square_for_side(pos, side);
  snapshot.activity = major_activity(pos, side);
  snapshot.hand = hand_initiative(pos, side);
  snapshot.promoted = promoted_invasion(pos, side);
  snapshot.exposure = attack_commitment_exposure(pos, side);
  snapshot.checked = is_check(pos, side);
  if (snapshot.king < 0) return snapshot;

  const int ky = row_of(snapshot.king), kx = col_of(snapshot.king);
  for (int dy = -1; dy <= 1; ++dy) {
    for (int dx = -1; dx <= 1; ++dx) {
      if (dy == 0 && dx == 0) continue;
      const int y = ky + dy, x = kx + dx;
      if (!inside(y, x)) continue;
      const int target = square_of(y, x);
      const int contacts = attack_count_on_square(pos, -side, target);
      snapshot.danger += contacts;
      if (contacts > 0) ++snapshot.attacked_ring;
      snapshot.attack_contacts += contacts > 3 ? 3 : contacts;
      const int occupant = pos.board[target];
      if (contacts == 0 && sign_of(occupant) != side) ++snapshot.escape_like;
      if (sign_of(occupant) == side) {
        const int kind = kind_of(occupant);
        if (kind == 5 || kind == 9 || kind == 10 || kind == 11 || kind == 12) snapshot.shield += 3;
        else if (kind == 4) snapshot.shield += 2;
        else if (kind != 8) snapshot.shield += 1;
      }
    }
  }
  return snapshot;
}

int title_strategic_from_snapshot(const ParallelSideEvalSnapshot& snapshot, int side) {
  int king_safety = -kMateScore / 2;
  if (snapshot.king >= 0) {
    const int ky = row_of(snapshot.king), kx = col_of(snapshot.king);
    const bool home_rank = side == 1 ? ky >= 7 : ky <= 1;
    const int edge_distance = abs_i(kx - 4);
    king_safety = snapshot.shield * 8 + (home_rank ? 18 : 0) + edge_distance * 4 - snapshot.danger * 13;
  }
  return king_safety + snapshot.activity * 4 + snapshot.hand * 3 / 4 + snapshot.promoted * 2;
}

int title_mating_from_defender_snapshot(const ParallelSideEvalSnapshot& defender) {
  int net = kMateScore / 2;
  if (defender.king >= 0) {
    net = defender.attacked_ring * 55
      + defender.attack_contacts * 14
      - defender.escape_like * 45
      - defender.shield * 12;
    if (defender.checked) net += 420;
  }
  return net + defender.exposure * 6;
}

int parallel_evaluate_for(const Position& pos, int perspective) {
  const int base = evaluate_for(pos, perspective);
  if (g_parallel_profile <= 1) return base;
  if (g_parallel_profile < 4) {
    const int strategic = strategic_side_score(pos, perspective) - strategic_side_score(pos, -perspective);
    if (g_parallel_profile == 2) return base + strategic;
    const int mating = mating_pressure_score(pos, perspective) - mating_pressure_score(pos, -perspective);
    return base + strategic / 2 + mating * 3 / 2;
  }

  const ParallelSideEvalSnapshot sente = build_parallel_side_eval_snapshot(pos, 1);
  const ParallelSideEvalSnapshot gote = build_parallel_side_eval_snapshot(pos, -1);
  const ParallelSideEvalSnapshot& own = perspective == 1 ? sente : gote;
  const ParallelSideEvalSnapshot& enemy = perspective == 1 ? gote : sente;
  const int strategic = title_strategic_from_snapshot(own, perspective)
    - title_strategic_from_snapshot(enemy, -perspective);
  const int mating = title_mating_from_defender_snapshot(enemy)
    - title_mating_from_defender_snapshot(own);
  return base + strategic / 3 + mating * 2;
}`;

if(!source.includes(oldText))throw new Error('TITLE_EVAL_ANCHOR_NOT_FOUND');
source=source.replace(oldText,newText);
await writeFile(path,source);
