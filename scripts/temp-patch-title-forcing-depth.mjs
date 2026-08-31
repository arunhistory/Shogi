import {readFile,writeFile} from 'node:fs/promises';

const depth=Number(process.argv[2]??4);
if(!Number.isInteger(depth)||depth<4||depth>8)throw new Error('FORCING_DEPTH_MUST_BE_4_TO_8');
const path='cpp/engine_parallel.cpp';
let source=await readFile(path,'utf8');
const anchor='const bool seek_quiet_net = include_quiet_pressure && g_parallel_profile >= 4 && ply <= 4;';
if(!source.includes(anchor))throw new Error('FORCING_DEPTH_ANCHOR_NOT_FOUND');
source=source.replace(anchor,`const bool seek_quiet_net = include_quiet_pressure && g_parallel_profile >= 4 && ply <= ${depth};`);
await writeFile(path,source);
console.log(`TITLE_FORCING_DEPTH:${depth}`);
