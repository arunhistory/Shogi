#include <cstdint>

namespace {
constexpr int32_t kInputCapacity = 128;
int32_t g_input[kInputCapacity] = {};

int32_t piece_value(int32_t code) {
  switch (code) {
    case 1: return 100;     // pawn
    case 2: return 320;     // lance
    case 3: return 360;     // knight
    case 4: return 520;     // silver
    case 5: return 600;     // gold
    case 6: return 900;     // bishop
    case 7: return 1000;    // rook
    case 8: return 100000;  // king
    case 9: return 600;     // tokin
    case 10: return 600;    // promoted lance
    case 11: return 600;    // promoted knight
    case 12: return 600;    // promoted silver
    case 13: return 1250;   // horse
    case 14: return 1350;   // dragon
    default: return 0;
  }
}
}  // namespace

// Deterministic, shogi-specific algorithm boundary. No generated AI, machine
// learning, neural network, NNUE, learned model, or external AI API is used.
extern "C" {

int32_t shogi_engine_version() { return 2; }

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

// Kept as a small generic ABI compatibility helper for diagnostics.
int32_t shogi_evaluate_material(const int32_t* pieces, int32_t count) {
  if (!pieces || count < 0) return 0;
  int32_t score = 0;
  for (int32_t i = 0; i < count; ++i) score += pieces[i];
  return score;
}

}
