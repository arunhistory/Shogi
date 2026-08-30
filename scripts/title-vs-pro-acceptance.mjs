import {spawnSync} from 'node:child_process';

const run=spawnSync(process.execPath,['scripts/title-vs-pro-replay.mjs'],{encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:16*1024*1024});
if(run.status!==0){process.stdout.write(run.stdout);process.exit(run.status??1);}
const lines=run.stdout.trim().split(/\r?\n/).filter(Boolean);
const result=JSON.parse(lines.at(-1));
const titleWon=result?.terminal?.ended===true&&result?.terminal?.winner==='gote';
const within82=Number(result?.finalPly)<=82;
const titleAverage=Number(result?.timingSummary?.title?.avgMs);
const fasterThanBaseline=Number.isFinite(titleAverage)&&titleAverage<2600;
console.log(JSON.stringify({titleWon,within82,fasterThanBaseline,titleAverageMs:titleAverage,finalPly:result?.finalPly,titleTiming:result?.timingSummary?.title,terminal:result?.terminal}));
if(!titleWon||!within82||!fasterThanBaseline)process.exit(1);
