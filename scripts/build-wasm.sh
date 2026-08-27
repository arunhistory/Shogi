#!/usr/bin/env sh
set -eu
MODE="${1:-build}"
TMP="${TMPDIR:-/tmp}/shogi_engine.$$.wasm"
OUT="src/game/engineBinary.ts"
cleanup(){ rm -f "$TMP" "$TMP.ts"; }
trap cleanup EXIT
clang++ --target=wasm32 -Oz -nostdlib -fno-exceptions -fno-rtti -fno-builtin cpp/engine.cpp \
  -Wl,--no-entry \
  -Wl,--strip-all \
  -Wl,--export=shogi_engine_version \
  -Wl,--export=shogi_position_buffer \
  -Wl,--export=shogi_find_best_move \
  -Wl,--export=shogi_last_nodes \
  -Wl,--export-memory \
  -Wl,--initial-memory=2097152 \
  -o "$TMP"
node scripts/embed-wasm.mjs "$TMP" "$TMP.ts"
if [ "$MODE" = "--verify" ]; then
  cmp -s "$TMP.ts" "$OUT" || { echo "Embedded WebAssembly is out of date. Run npm run build:wasm." >&2; exit 1; }
else
  cp "$TMP.ts" "$OUT"
fi
