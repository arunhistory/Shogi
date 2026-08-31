import {readFile,writeFile} from 'node:fs/promises';

const path='src/game/cpu-worker.ts';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  const count=source.split(oldText).length-1;
  if(count!==1)throw new Error(`${label}_ANCHOR_COUNT:${count}`);
  source=source.replace(oldText,newText);
}

replaceOnce(
`const workerPool:RootWorkerSlot[]=[];`,
`const workerPool:RootWorkerSlot[]=[];
let titleJobSequence=0;`,
'JOB_SEQUENCE_DECL',
);

replaceOnce(
`          jobId:\`${'${stage}-${lane}-${jobsIssued+jobs.length}-${crypto.randomUUID()}'}\`,`,
`          jobId:level==='title'?\`t-${'${++titleJobSequence}'}\`:\`${'${stage}-${lane}-${jobsIssued+jobs.length}-${crypto.randomUUID()}'}\`,`,
'JOB_ID_REUSE',
);

await writeFile(path,source);
