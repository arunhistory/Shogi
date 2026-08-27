#include <cstdint>
// Performance-critical engine boundary. The browser build may compile this file
// to WebAssembly with Emscripten. Rules remain deterministic; no ML/AI model is used.
extern "C" {
int32_t shogi_engine_version() { return 1; }
int32_t shogi_evaluate_material(const int32_t* pieces, int32_t count) {
  if (!pieces || count < 0) return 0;
  int32_t score = 0;
  for (int32_t i = 0; i < count; ++i) score += pieces[i];
  return score;
}
}
