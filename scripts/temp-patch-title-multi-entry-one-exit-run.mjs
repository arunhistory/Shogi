import {readFile,writeFile} from 'node:fs/promises';

await import('./temp-patch-title-multi-entry-one-exit.mjs');
const path='src/game/cpu-worker.ts';
const source=await readFile(path,'utf8');
await writeFile(path,source.replace(/[ \t]+$/gm,''));