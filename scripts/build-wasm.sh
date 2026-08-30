#!/usr/bin/env sh
set -eu
mkdir -p public/wasm
emcc cpp/engine_future.cpp \
  -O3 \
  -std=c++17 \
  -include initializer_list \
  -s WASM=1 \
  -s STANDALONE_WASM=1 \
  --no-entry \
  -Wl,--export=shogi_engine_version \
  -Wl,--export=shogi_input_buffer \
  -Wl,--export=shogi_input_capacity \
  -Wl,--export=shogi_history_buffer \
  -Wl,--export=shogi_history_capacity \
  -Wl,--export=shogi_evaluate_material_codes \
  -Wl,--export=shogi_evaluate_material \
  -Wl,--export=shogi_evaluate_position \
  -Wl,--export=shogi_legal_move_count \
  -Wl,--export=shogi_legal_move_at \
  -Wl,--export=shogi_is_check \
  -Wl,--export=shogi_is_mate \
  -Wl,--export=shogi_repetition_status_with_history \
  -Wl,--export=shogi_search_best_move \
  -Wl,--export=shogi_search_best_move_with_history \
  -Wl,--export=shogi_search_root_move_with_history \
  -Wl,--export=shogi_search_future_root_move_with_history \
  -Wl,--export=shogi_parallel_search_complete \
  -Wl,--export=shogi_nodes_searched \
  -o public/wasm/shogi_engine.wasm
