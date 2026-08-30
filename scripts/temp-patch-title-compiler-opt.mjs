import {readFile,writeFile} from 'node:fs/promises';

const path='scripts/build-wasm.sh';
let source=await readFile(path,'utf8');
const anchor=`  -O3 \\\n  -std=c++17 \\\n`;
const replacement=`  -O3 \\\n  -flto \\\n  -msimd128 \\\n  -std=c++17 \\\n`;
if(!source.includes(anchor))throw new Error('COMPILER_FLAGS_ANCHOR_NOT_FOUND');
source=source.replace(anchor,replacement);
await writeFile(path,source);
