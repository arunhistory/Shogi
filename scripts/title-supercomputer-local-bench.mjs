import {readFile} from 'node:fs/promises';

const files=process.argv.slice(2);
if(files.length<1)throw new Error('WASM_PATH_REQUIRED');
const NODE_LIMIT=5_000_000,SPECIALIST=Number(process.env.TITLE_SUPER_SPECIALIST??1);
const words=[1397245769,1,-2,-3,-4,-5,-8,-5,-4,-3,-2,0,-7,0,0,0,0,0,-6,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,0,6,0,0,0,0,0,7,0,2,3,4,5,8,5,4,3,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
if(words.length!==97)throw new Error(`POSITION_WORDS:${words.length}`);
if(!Number.isInteger(SPECIALIST)||SPECIALIST<1||SPECIALIST>20)throw new Error(`SPECIALIST:${SPECIALIST}`);

async function bench(path){
  const bytes=await readFile(path);
  const instantiateStart=performance.now();
  const {instance}=await WebAssembly.instantiate(bytes,{});
  const instantiateMs=performance.now()-instantiateStart;
  const e=instance.exports;
  for(const name of ['memory','shogi_input_buffer','shogi_input_capacity','shogi_legal_move_count','shogi_legal_move_at','shogi_super_search_specialist','shogi_super_nodes_searched'])if(!(name in e))throw new Error(`${path}:MISSING_EXPORT:${name}`);
  const input=new Int32Array(e.memory.buffer,e.shogi_input_buffer(),e.shogi_input_capacity());input.fill(0);input.set(words);
  const legalCount=Number(e.shogi_legal_move_count(97));
  const legal=new Set(Array.from({length:legalCount},(_,i)=>Number(e.shogi_legal_move_at(i))));
  const started=performance.now();
  const move=Number(e.shogi_super_search_specialist(97,SPECIALIST,12,NODE_LIMIT));
  const searchMs=performance.now()-started;
  const nodes=Number(e.shogi_super_nodes_searched());
  if(nodes!==NODE_LIMIT)throw new Error(`${path}:NODE_MISMATCH:${nodes}`);
  if(!legal.has(move))throw new Error(`${path}:ILLEGAL_MOVE:${move}`);
  return{path,bytes:bytes.byteLength,specialist:SPECIALIST,nodes,move,legalCount,instantiateMs,searchMs,nps:nodes/(searchMs/1000)};
}
const results=[];
for(const path of files)results.push(await bench(path));
console.log('LOCAL_SUPER_BENCH:'+JSON.stringify({ok:true,results}));