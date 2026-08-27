import {copyFile,mkdir,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';

const here=dirname(fileURLToPath(import.meta.url));
const source=resolve(here,'../../public/wasm/shogi_engine.wasm');
const target=resolve(here,'../src/shogi_engine.wasm');
const info=await stat(source).catch(()=>null);
if(!info?.isFile()||info.size<=0)throw new Error('SHARED_SHOGI_WASM_MISSING');
await mkdir(dirname(target),{recursive:true});
await copyFile(source,target);
const staged=await stat(target);
if(staged.size!==info.size)throw new Error('SHOGI_WASM_STAGE_SIZE_MISMATCH');
console.log(JSON.stringify({ok:true,bytes:staged.size}));
