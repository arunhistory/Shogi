#!/usr/bin/env sh
set -eu
mkdir -p public/wasm
emcc cpp/engine.cpp \
  -O3 \
  -s WASM=1 \
  -s STANDALONE_WASM=1 \
  --no-entry \
  -Wl,--export=shogi_engine_version \
  -Wl,--export=shogi_input_buffer \
  -Wl,--export=shogi_input_capacity \
  -Wl,--export=shogi_evaluate_material_codes \
  -Wl,--export=shogi_evaluate_material \
  -o public/wasm/shogi_engine.wasm
