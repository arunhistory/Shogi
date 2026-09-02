import {readFile,writeFile} from 'node:fs/promises';
const path='src/style.css';
let css=await readFile(path,'utf8');
const from='@media(max-width:520px){.opponent-action-button{padding:7px 8px;font-size:12px}.cell.opponent-move-from,.cell.opponent-move-to{box-shadow:inset 0 0 0 4px currentColor}}';
const to='@media(max-width:520px){.opponent-action-button{padding:7px 8px;font-size:12px}.cell.opponent-move-from{box-shadow:inset 0 0 0 4px rgba(43,92,170,.88)}.cell.opponent-move-to{box-shadow:inset 0 0 0 4px rgba(241,205,72,.94)}}';
if(css.split(from).length-1!==1)throw new Error('MOBILE_RULE_MARKER_MISMATCH');
css=css.replace(from,to);
await writeFile(path,css,'utf8');
