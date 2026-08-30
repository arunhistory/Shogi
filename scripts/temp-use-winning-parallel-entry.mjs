import {readFile,writeFile} from 'node:fs/promises';

const path='scripts/build-wasm.sh';
let source=await readFile(path,'utf8');
const from='emcc cpp/engine_future.cpp \\\n';
const to='emcc cpp/engine_parallel.cpp \\\n';
if(!source.includes(from))throw new Error('PARALLEL_ENTRY_ANCHOR_NOT_FOUND');
source=source.replace(from,to);
await writeFile(path,source);
