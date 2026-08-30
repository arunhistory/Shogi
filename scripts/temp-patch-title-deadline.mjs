import {readFile,writeFile} from 'node:fs/promises';

const path='src/game/cpu.ts';
let source=await readFile(path,'utf8');
const oldText='title:{replyDeadlineMs:1650,workerCap:12,logicalJobTarget:455,baseDepth:3,maxDepth:12,depthStep:2,lanes:5,retention:0.38,minSurvivors:4,nodeBase:4200,jobTimeoutMs:420,profileCode:4,openingVariationWindow:0,variationWindow:0,variationPool:1},';
const newText='title:{replyDeadlineMs:1450,workerCap:12,logicalJobTarget:455,baseDepth:3,maxDepth:12,depthStep:2,lanes:5,retention:0.38,minSurvivors:4,nodeBase:4200,jobTimeoutMs:340,profileCode:4,openingVariationWindow:0,variationWindow:0,variationPool:1},';
if(!source.includes(oldText))throw new Error('TITLE_PROFILE_ANCHOR_NOT_FOUND');
source=source.replace(oldText,newText);
await writeFile(path,source);
