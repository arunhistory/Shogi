import {copyFile,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';

const id=Number(process.env.SPECIALIST_ID);
const budget=5_000_000;
const position=JSON.parse(process.env.POSITION_WORDS??'null');
const outputPath=process.env.SPECIALIST_OUTPUT??`/tmp/specialist-${String(id).padStart(2,'0')}.json`;

if(!Number.isInteger(id)||id<1||id>20)throw new Error('INVALID_SPECIALIST_ID');
if(!Array.isArray(position)||position.length!==97)throw new Error('POSITION_WORDS_INVALID');

async function runSerial(){
  const bytes=await readFile('public/wasm/title_supercomputer.wasm');
  const module=await WebAssembly.compile(bytes);
  const instance=await WebAssembly.instantiate(module,{});
  const w=instance.exports;
  for(const name of ['memory','shogi_input_buffer','shogi_input_capacity','shogi_super_search_specialist','shogi_super_best_score','shogi_super_nodes_searched']){
    if(!(name in w))throw new Error('WASM_EXPORT_MISSING:'+name);
  }
  const capacity=w.shogi_input_capacity();
  const pointer=w.shogi_input_buffer();
  if(capacity<97)throw new Error('WASM_INPUT_CAPACITY');
  const input=new Int32Array(w.memory.buffer,pointer,capacity);
  input.fill(0,0,97);
  input.set(Int32Array.from(position),0);
  const startedEpochMs=Date.now();
  const started=performance.now();
  const moveCode=w.shogi_super_search_specialist(97,id,12,budget);
  const elapsedMs=performance.now()-started;
  const endedEpochMs=Date.now();
  return{moveCode:Number(moveCode),score:Number(w.shogi_super_best_score()),nodes:Number(w.shogi_super_nodes_searched()),elapsedMs,startedEpochMs,endedEpochMs};
}

async function runDual12(){
  await copyFile('runtime/title-dual12.js','/tmp/title-dual12.cjs');
  await copyFile('runtime/title-dual12.wasm','/tmp/title-dual12.wasm');
  await copyFile('runtime/title-dual12.worker.js','/tmp/title-dual12.worker.js');
  const require=createRequire(import.meta.url);
  const createTitleDual12=require('/tmp/title-dual12.cjs');
  const wasmBinary=await readFile('/tmp/title-dual12.wasm');
  const module=await createTitleDual12({
    wasmBinary,
    locateFile:path=>`/tmp/${path}`,
  });
  try{
    const pointer=module._shogi_input_buffer();
    const capacity=module._shogi_input_capacity();
    if(capacity<97)throw new Error('DUAL12_INPUT_CAPACITY');
    const input=new Int32Array(module.HEAP32.buffer,pointer,capacity);
    input.fill(0,0,97);
    input.set(Int32Array.from(position),0);
    const startedEpochMs=Date.now();
    const started=performance.now();
    const moveCode=module._shogi_super_search_specialist(97,12,12,budget);
    const elapsedMs=performance.now()-started;
    const endedEpochMs=Date.now();
    return{moveCode:Number(moveCode),score:Number(module._shogi_super_best_score()),nodes:Number(module._shogi_super_nodes_searched()),elapsedMs,startedEpochMs,endedEpochMs};
  }finally{
    module.PThread?.terminateAllThreads?.();
  }
}

const result=id===12?await runDual12():await runSerial();
if(result.moveCode<0)throw new Error('NO_LEGAL_MOVE');
if(!Number.isInteger(result.nodes)||result.nodes<1||result.nodes>budget)throw new Error('NODE_COUNT_INVALID:'+result.nodes);
const payload={id,...result};
await writeFile(outputPath,JSON.stringify(payload));
console.log('GITHUB_SPECIALIST_RESULT:'+JSON.stringify(payload));
