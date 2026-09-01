import {copyFile,readFile,readdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';

const budget=5_000_000;
const position=JSON.parse(process.env.POSITION_WORDS??'null');
const specialistsDir=process.env.SPECIALISTS_DIR??'/tmp/specialists';
const outputPath=process.env.CONVERGENCE_OUTPUT??'/tmp/convergence-result.json';
if(!Array.isArray(position)||position.length!==97)throw new Error('POSITION_WORDS_INVALID');

const files=(await readdir(specialistsDir)).filter(name=>/^specialist-\d\d\.json$/.test(name)).sort();
if(files.length!==20)throw new Error('SPECIALIST_RESULT_COUNT:'+files.length);
const specialists=[];
for(const file of files)specialists.push(JSON.parse(await readFile(`${specialistsDir}/${file}`,'utf8')));
specialists.sort((a,b)=>a.id-b.id);
for(let i=0;i<20;i++)if(specialists[i]?.id!==i+1)throw new Error('SPECIALIST_ID_SEQUENCE');

const candidates=specialists.map(row=>Number(row.moveCode)|0);
await copyFile('runtime/title-convergence.js','/tmp/title-convergence.cjs');
await copyFile('runtime/title-convergence.wasm','/tmp/title-convergence.wasm');
await copyFile('runtime/title-convergence.worker.js','/tmp/title-convergence.worker.js');
const require=createRequire(import.meta.url);
const createTitleConvergence=require('/tmp/title-convergence.cjs');
const module=await createTitleConvergence();
let convergence;
try{
  const pointer=module._shogi_input_buffer();
  const capacity=module._shogi_input_capacity();
  if(capacity<97+candidates.length)throw new Error('CONVERGENCE_INPUT_CAPACITY');
  const input=new Int32Array(module.HEAP32.buffer,pointer,capacity);
  input.fill(0,0,97+candidates.length);
  input.set(Int32Array.from(position),0);
  input.set(Int32Array.from(candidates),97);
  const started=performance.now();
  const moveCode=module._shogi_super_converge(97,candidates.length,14,budget);
  const elapsedMs=performance.now()-started;
  convergence={moveCode:Number(moveCode),score:Number(module._shogi_super_best_score()),nodes:Number(module._shogi_super_nodes_searched()),elapsedMs};
}finally{
  module.PThread?.terminateAllThreads?.();
}
if(convergence.moveCode<0)throw new Error('NO_LEGAL_MOVE');
if(!Number.isInteger(convergence.nodes)||convergence.nodes<1||convergence.nodes>budget)throw new Error('CONVERGENCE_NODE_COUNT_INVALID:'+convergence.nodes);

const elapsed=specialists.map(row=>Number(row.elapsedMs));
const starts=specialists.map(row=>Number(row.startedEpochMs));
const ends=specialists.map(row=>Number(row.endedEpochMs));
const specialistNodes=specialists.reduce((sum,row)=>sum+Number(row.nodes),0);
const mateShortCircuits=specialists.filter(row=>Number(row.nodes)<budget).length+(convergence.nodes<budget?1:0);
const payload={
  specialistCount:20,
  candidates,
  specialistMinMs:Math.min(...elapsed),
  specialistMaxMs:Math.max(...elapsed),
  specialistAvgMs:elapsed.reduce((a,b)=>a+b,0)/elapsed.length,
  specialistExecutionEnvelopeMs:Math.max(...ends)-Math.min(...starts),
  specialistNodes,
  mateShortCircuits,
  convergence,
  computePathMs:Math.max(...elapsed)+convergence.elapsedMs,
  specialists,
};
await writeFile(outputPath,JSON.stringify(payload));
console.log('GITHUB_CONVERGENCE_RESULT:'+JSON.stringify(payload));
