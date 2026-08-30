import {readFile,writeFile} from 'node:fs/promises';

const path='src/game/cpu-search-worker.ts';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  if(!source.includes(oldText))throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  source=source.replace(oldText,newText);
}

replaceOnce(
  `let parityKey:string|null=null;`,
  `let parityKey:string|null=null;\nlet rootLegalMoves:Move[]=[];`,
  'CACHE_DECLARATION',
);

replaceOnce(
`function assertRootParity(engine:WasmShogiEngine,position:Position):void{
  const key=positionKey(position);
  if(parityKey===key)return;
  const officialLegal=legalMoves(position);`,
`function assertRootParity(engine:WasmShogiEngine,position:Position):void{
  if(parityKey!==null)return;
  const key=positionKey(position);
  const officialLegal=rootLegalMoves;`,
  'PARITY_CACHE',
);

replaceOnce(
`  if(message.type==='init'){
    rootPosition=message.position;
    rootWasmUrl=message.wasmUrl;
    parityKey=null;
    void engineFor(rootWasmUrl);
    return;
  }`,
`  if(message.type==='init'){
    rootPosition=message.position;
    rootWasmUrl=message.wasmUrl;
    rootLegalMoves=legalMoves(rootPosition);
    parityKey=null;
    void engineFor(rootWasmUrl);
    return;
  }`,
  'INIT_CACHE',
);

replaceOnce(
  `    const official=legalMoves(position).find(candidate=>sameCpuMove(candidate,move));`,
  `    const official=rootLegalMoves.find(candidate=>sameCpuMove(candidate,move));`,
  'SEARCH_CACHE',
);

await writeFile(path,source);
