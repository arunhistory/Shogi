import {readFile,writeFile} from 'node:fs/promises';

await import('./temp-patch-title-multi-entry-one-exit.mjs');
const path='src/game/cpu-worker.ts';
let source=await readFile(path,'utf8');
// Type-only widening on the new outer guard only. The assertion disappears
// from emitted JavaScript, but prevents TypeScript from narrowing `level` in
// the copied canonical fallback loop.
const guard="  if(level==='title'){\n    // N-entry / 1-exit experiment:";
const widened="  if((level as CpuLevel)==='title'){\n    // N-entry / 1-exit experiment:";
if(!source.includes(guard))throw new Error('MULTI_ENTRY_GUARD_NOT_FOUND');
source=source.replace(guard,widened);
source=source.replace(/[ \t]+$/gm,'');
await writeFile(path,source);