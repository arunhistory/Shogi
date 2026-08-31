import {readFile,writeFile} from 'node:fs/promises';

const path='src/game/cpu-search-worker.ts';
let source=await readFile(path,'utf8');

function replaceOnce(oldText,newText,label){
  const count=source.split(oldText).length-1;
  if(count!==1)throw new Error(`${label}_ANCHOR_COUNT:${count}`);
  source=source.replace(oldText,newText);
}

replaceOnce(
`let rootTitleLegalMoves:Move[]|null=null;
let rootTitleParityVerified=false;`,
`let rootTitleLegalMoves:Move[]|null=null;
let rootTitleMoveMap:Map<string,Move>|null=null;
let rootTitleParityVerified=false;`,
'ROOT_MOVE_MAP_DECL',
);

replaceOnce(
`function sameRepetition(a:RepetitionStatus,b:RepetitionStatus):boolean{`,
`function exactCpuMoveKey(move:Move):string{
  return JSON.stringify([
    move.to[0],move.to[1],
    move.from?.[0]??null,move.from?.[1]??null,
    move.drop??null,!!move.promote,
  ]);
}

function titleOfficialMove(legal:Move[],move:Move):Move|undefined{
  if(!rootTitleMoveMap){
    rootTitleMoveMap=new Map<string,Move>();
    for(const candidate of legal)rootTitleMoveMap.set(exactCpuMoveKey(candidate),candidate);
  }
  const mapped=rootTitleMoveMap.get(exactCpuMoveKey(move));
  if(mapped&&sameCpuMove(mapped,move))return mapped;
  return legal.find(candidate=>sameCpuMove(candidate,move));
}

function sameRepetition(a:RepetitionStatus,b:RepetitionStatus):boolean{`,
'MOVE_MAP_HELPER',
);

replaceOnce(
`    rootTitleLegalMoves=null;
    rootTitleParityVerified=false;`,
`    rootTitleLegalMoves=null;
    rootTitleMoveMap=null;
    rootTitleParityVerified=false;`,
'INIT_MAP_RESET',
);

replaceOnce(
`    const official=officialLegal.find(candidate=>sameCpuMove(candidate,move));`,
`    const official=level==='title'
      ?titleOfficialMove(officialLegal,move)
      :officialLegal.find(candidate=>sameCpuMove(candidate,move));`,
'MOVE_LOOKUP',
);

await writeFile(path,source);
