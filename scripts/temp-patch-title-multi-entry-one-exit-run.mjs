import {readFile,writeFile} from 'node:fs/promises';

await import('./temp-patch-title-multi-entry-one-exit.mjs');
const path='src/game/cpu-worker.ts';
let source=await readFile(path,'utf8');
// Type-only widening: emitted JavaScript remains level==='title'. This prevents
// TypeScript from rejecting canonical Title checks copied into the non-Title
// branch after control-flow narrowing; runtime processing is unchanged.
source=source.replace(/level==='title'/g,"(level as CpuLevel)==='title'");
source=source.replace(/[ \t]+$/gm,'');
await writeFile(path,source);