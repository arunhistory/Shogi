import {readFile,writeFile} from 'node:fs/promises';

const path='src/game/cpu-search-worker.ts';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  const count=source.split(oldText).length-1;
  if(count!==1)throw new Error(`${label}_ANCHOR_COUNT:${count}`);
  source=source.replace(oldText,newText);
}

replaceOnce(
`let parityKey:string|null=null;`,
`let parityKey:string|null=null;
let rootTitleLegalMoves:Move[]|null=null;
let rootTitleParityVerified=false;`,
'ROOT_CACHE_DECLARATIONS',
);

replaceOnce(
`    cachedEngine=null;
    parityKey=null;
    loadPromise=loadWasmShogiEngine(url);`,
`    cachedEngine=null;
    parityKey=null;
    rootTitleParityVerified=false;
    loadPromise=loadWasmShogiEngine(url);`,
'ENGINE_RESET',
);

replaceOnce(
`function assertRootParity(engine:WasmShogiEngine,position:Position):void{
  const key=positionKey(position);
  if(parityKey===key)return;
  const officialLegal=legalMoves(position);`,
`function assertRootParity(engine:WasmShogiEngine,position:Position,level:CpuLevel):void{
  if(level==='title'&&rootTitleParityVerified)return;
  const key=positionKey(position);
  if(level!=='title'&&parityKey===key)return;
  const officialLegal=level==='title'
    ?(rootTitleLegalMoves??(rootTitleLegalMoves=legalMoves(position)))
    :legalMoves(position);`,
'PARITY_PRECOMPUTE',
);

replaceOnce(
`  parityKey=key;
}`,
`  if(level==='title')rootTitleParityVerified=true;
  else parityKey=key;
}`,
'PARITY_COMPLETE',
);

replaceOnce(
`    rootPosition=message.position;
    rootWasmUrl=message.wasmUrl;
    parityKey=null;`,
`    rootPosition=message.position;
    rootWasmUrl=message.wasmUrl;
    rootTitleLegalMoves=null;
    rootTitleParityVerified=false;
    parityKey=null;`,
'INIT_RESET',
);

replaceOnce(
`    const official=legalMoves(position).find(candidate=>sameCpuMove(candidate,move));`,
`    const officialLegal=level==='title'
      ?(rootTitleLegalMoves??(rootTitleLegalMoves=legalMoves(position)))
      :legalMoves(position);
    const official=officialLegal.find(candidate=>sameCpuMove(candidate,move));`,
'LEGAL_REUSE',
);

replaceOnce(
`        assertRootParity(engine,position);`,
`        assertRootParity(engine,position,level);`,
'PARITY_CALL',
);

await writeFile(path,source);
