import {readFile,writeFile} from 'node:fs/promises';

function replaceOnce(source,oldText,newText,label){
  if(!source.includes(oldText))throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.replace(oldText,newText);
}

const buildPath='scripts/build-wasm.sh';
let build=await readFile(buildPath,'utf8');
for(const [line,label] of [
  ['  -Wl,--export=shogi_evaluate_material_codes \\\n','MATERIAL_CODES_EXPORT'],
  ['  -Wl,--export=shogi_evaluate_material \\\n','MATERIAL_EXPORT'],
  ['  -Wl,--export=shogi_search_future_root_move_with_history \\\n','FUTURE_EXPORT'],
  ['  -Wl,--export=shogi_forecast_tt_hits \\\n','FORECAST_TT_EXPORT'],
  ['  -Wl,--export=shogi_forecast_atlas_hits \\\n','FORECAST_ATLAS_EXPORT'],
])build=replaceOnce(build,line,'',label);
await writeFile(buildPath,build);

const wasmPath='src/game/wasm.ts';
let wasm=await readFile(wasmPath,'utf8');
wasm=replaceOnce(
  wasm,
  "  shogi_search_future_root_move_with_history:(positionCount:number,historyWordCount:number,encodedMove:number,maxDepth:number,nodeLimit:number,lane:number)=>number;\n",
  '',
  'FUTURE_TYPE',
);
wasm=replaceOnce(
  wasm,
  "    &&typeof candidate.shogi_search_future_root_move_with_history==='function'\n",
  '',
  'FUTURE_VALIDATION',
);
await writeFile(wasmPath,wasm);
