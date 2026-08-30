import {readFile,writeFile} from 'node:fs/promises';

const path='src/game/wasm.ts';
let source=await readFile(path,'utf8');

const oldText=`        const score=profileValue===4
          ?wasm.shogi_search_future_root_move_with_history(positionCount,historyWords,encodedMove,depth,nodes,laneValue)
          :wasm.shogi_search_root_move_with_history(positionCount,historyWords,encodedMove,depth,nodes,laneValue,profileValue);`;
const newText=`        const score=wasm.shogi_search_root_move_with_history(
          positionCount,historyWords,encodedMove,depth,nodes,laneValue,profileValue,
        );`;

if(!source.includes(oldText))throw new Error('TITLE_SEARCH_ROUTE_ANCHOR_NOT_FOUND');
source=source.replace(oldText,newText);
await writeFile(path,source);
