import {readFile,writeFile} from 'node:fs/promises';

const profilePath='src/game/cpu.ts';
const workerPath='src/game/cpu-worker.ts';
let profile=await readFile(profilePath,'utf8');
let worker=await readFile(workerPath,'utf8');

const oldProfile="title:{replyDeadlineMs:1650,workerCap:12,logicalJobTarget:455,baseDepth:3,maxDepth:12,depthStep:2,lanes:5,retention:0.38,minSurvivors:4,nodeBase:4200,jobTimeoutMs:420,profileCode:4,openingVariationWindow:0,variationWindow:0,variationPool:1}";
const newProfile="title:{replyDeadlineMs:2100,workerCap:12,logicalJobTarget:455,baseDepth:3,maxDepth:12,depthStep:2,lanes:5,retention:0.38,minSurvivors:4,nodeBase:4200,jobTimeoutMs:420,profileCode:4,openingVariationWindow:0,variationWindow:0,variationPool:1}";
if(!profile.includes(oldProfile))throw new Error('TITLE_PROFILE_ANCHOR_NOT_FOUND');
profile=profile.replace(oldProfile,newProfile);

const oldHard="const hardDeadline=searchStarted+(level==='title'?1900:profile.replyDeadlineMs);";
const newHard="const hardDeadline=searchStarted+(level==='title'?2400:profile.replyDeadlineMs);";
if(!worker.includes(oldHard))throw new Error('TITLE_HARD_DEADLINE_ANCHOR_NOT_FOUND');
worker=worker.replace(oldHard,newHard);

await writeFile(profilePath,profile);
await writeFile(workerPath,worker);
