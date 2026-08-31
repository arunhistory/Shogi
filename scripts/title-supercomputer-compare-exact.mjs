import {readFile} from 'node:fs/promises';

const files=process.argv.slice(2);if(files.length<2)throw new Error('TWO_WASM_PATHS_REQUIRED');
const specialist=Number(process.env.TITLE_SUPER_SPECIALIST??1),nodeLimit=Number(process.env.TITLE_SUPER_NODES??5_000_000);
const words=[1397245769,1,-2,-3,-4,-5,-8,-5,-4,-3,-2,0,-7,0,0,0,0,0,-6,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,0,6,0,0,0,0,0,7,0,2,3,4,5,8,5,4,3,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
if(words.length!==97)throw new Error(`POSITION_WORDS:${words.length}`);
async function run(path){
  const bytes=await readFile(path),{instance}=await WebAssembly.instantiate(bytes,{}),e=instance.exports;
  for(const n of ['memory','shogi_input_buffer','shogi_input_capacity','shogi_legal_move_count','shogi_legal_move_at','shogi_super_search_specialist','shogi_super_best_score','shogi_super_nodes_searched'])if(!(n in e))throw new Error(`${path}:MISSING:${n}`);
  const input=new Int32Array(e.memory.buffer,e.shogi_input_buffer(),e.shogi_input_capacity());input.fill(0);input.set(words);
  const selftest=typeof e.shogi_super_inplace_selftest==='function'?Number(e.shogi_super_inplace_selftest(97)):null;if(selftest!==null&&selftest!==30)throw new Error(`${path}:SELFTEST:${selftest}`);
  input.fill(0);input.set(words);const count=Number(e.shogi_legal_move_count(97)),legal=new Set(Array.from({length:count},(_,i)=>Number(e.shogi_legal_move_at(i))));
  const t=performance.now(),move=Number(e.shogi_super_search_specialist(97,specialist,12,nodeLimit)),ms=performance.now()-t,nodes=Number(e.shogi_super_nodes_searched()),score=Number(e.shogi_super_best_score());
  if(nodes!==nodeLimit)throw new Error(`${path}:NODES:${nodes}`);if(!legal.has(move))throw new Error(`${path}:ILLEGAL:${move}`);
  return{path,bytes:bytes.byteLength,specialist,nodes,move,score,ms,nps:nodes/(ms/1000),selftest,legalCount:count};
}
const results=[];for(const f of files)results.push(await run(f));
const baseline=results[0];for(const x of results.slice(1)){if(x.move!==baseline.move||x.score!==baseline.score||x.nodes!==baseline.nodes||x.legalCount!==baseline.legalCount||x.selftest!==baseline.selftest)throw new Error(`BEHAVIOR_MISMATCH:${JSON.stringify({baseline,x})}`);}
console.log('EXACT_SUPER_COMPARE:'+JSON.stringify({ok:true,specialist,results,speedup:results[0].ms/results[1].ms,npsGain:results[1].nps/results[0].nps}));