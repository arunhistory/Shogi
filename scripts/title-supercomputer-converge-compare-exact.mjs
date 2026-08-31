import {readFile} from 'node:fs/promises';
import {titleSuperBenchPosition as words} from './title-supercomputer-bench-position.mjs';

const files=process.argv.slice(2);if(files.length<2)throw new Error('TWO_WASM_PATHS_REQUIRED');
const nodeLimit=5_000_000;
const candidates=[9795,6957,7215,7602,9795,9795,7215,7215,7602,6957,7215,7215,7215,7215,7215,7602,9795,7602,7215,7215];
async function run(path){
  const bytes=await readFile(path),{instance}=await WebAssembly.instantiate(bytes,{}),e=instance.exports;
  for(const n of ['memory','shogi_input_buffer','shogi_input_capacity','shogi_super_converge','shogi_super_best_score','shogi_super_nodes_searched'])if(!(n in e))throw new Error(`${path}:MISSING:${n}`);
  const input=new Int32Array(e.memory.buffer,e.shogi_input_buffer(),e.shogi_input_capacity());input.fill(0);input.set(words,0);input.set(candidates,97);
  const t=performance.now(),move=Number(e.shogi_super_converge(97,candidates.length,14,nodeLimit)),ms=performance.now()-t,nodes=Number(e.shogi_super_nodes_searched()),score=Number(e.shogi_super_best_score());
  if(nodes!==nodeLimit)throw new Error(`${path}:NODES:${nodes}`);
  return{path,bytes:bytes.byteLength,nodes,move,score,ms,nps:nodes/(ms/1000)};
}
const results=[];for(const f of files)results.push(await run(f));const b=results[0];for(const x of results.slice(1))if(x.move!==b.move||x.score!==b.score||x.nodes!==b.nodes)throw new Error(`CONVERGENCE_BEHAVIOR_MISMATCH:${JSON.stringify({b,x})}`);
console.log('EXACT_CONVERGENCE_COMPARE:'+JSON.stringify({ok:true,results,speedup:results[0].ms/results[1].ms,npsGain:results[1].nps/results[0].nps}));