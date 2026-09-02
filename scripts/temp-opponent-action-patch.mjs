import {readFile,writeFile} from 'node:fs/promises';

const mainPath='src/main.ts';
const cssPath='src/style.css';
let main=await readFile(mainPath,'utf8');
let css=await readFile(cssPath,'utf8');

function replaceOnce(source,from,to,label){
  const count=source.split(from).length-1;
  if(count!==1)throw new Error(`${label}: expected 1 match, got ${count}`);
  return source.replace(from,to);
}

main=replaceOnce(main,
`let elapsedTimer:number|null=null;\n`,
`let elapsedTimer:number|null=null;\nlet lastOpponentMove:Move|null=null;\nlet opponentMoveVisible=false;\n`,
'vars');

main=replaceOnce(main,
`const app=document.querySelector<HTMLDivElement>('#app')!;\n\nfunction resetInteraction(){selected=null;hand=null;candidates=[];}\n`,
`const app=document.querySelector<HTMLDivElement>('#app')!;\n\nfunction resetInteraction(){selected=null;hand=null;candidates=[];}\nfunction rememberOpponentMove(move:Move){\n  lastOpponentMove={...move,to:[move.to[0],move.to[1]],...(move.from?{from:[move.from[0],move.from[1]] as [number,number]}:{})};\n  opponentMoveVisible=false;\n}\nfunction clearOpponentMove(){lastOpponentMove=null;opponentMoveVisible=false;}\n`,
'helpers');

main=replaceOnce(main,
`  titleOutcome=response.outcome;\n  humanSide=response.humanSide;\n  pos=response.position;\n`,
`  titleOutcome=response.outcome;\n  humanSide=response.humanSide;\n  if(response.title?.move)rememberOpponentMove(response.title.move);\n  pos=response.position;\n`,
'title-record');

main=replaceOnce(main,
`  resetInteraction();\n  resetMatchClock();\n  localTerminal=null;\n}\nfunction menu(){\n`,
`  resetInteraction();\n  clearOpponentMove();\n  resetMatchClock();\n  localTerminal=null;\n}\nfunction menu(){\n`,
'leave-reset');

main=replaceOnce(main,
`    try{pos=applyMove(pos,event.data.result.move);}catch{play();return;}\n    void audioController.playSe('move');\n`,
`    try{pos=applyMove(pos,event.data.result.move);}catch{play();return;}\n    rememberOpponentMove(event.data.result.move);\n    void audioController.playSe('move');\n`,
'cpu-record');

main=replaceOnce(main,
`  const canResign=!ended&&(activeMode!=='online'||onlineState?.status==='playing')&&(!isTitleMatch()||!!titleSession);\n  app.innerHTML=\`<main class="game"><header>\${canResign?'<button class="resign-button" id="resign">諦める</button>':'<span class="resign-spacer"></span>'}<div class="match-header"><span class="elapsed-label">経過 <strong id="elapsed">\${formatElapsed()}</strong></span><strong>\${status}</strong></div></header>\${onlineInfo}<section class="hand" id="goteHand"></section><div class="board" id="board" aria-busy="\${cpuThinking||onlinePendingAction?'true':'false'}"></div><section class="hand" id="senteHand"></section>\${modeInfo}\${resultMarkup(terminal)}</main>\`;\n  document.querySelector('#resign')?.addEventListener('click',showResignDialog);\n`,
`  const canResign=!ended&&(activeMode!=='online'||onlineState?.status==='playing')&&(!isTitleMatch()||!!titleSession);\n  const opponentAction=activeMode==='cpu'&&lastOpponentMove&&!ended\n    ?\`<button class="opponent-action-button\${opponentMoveVisible?' active':''}" id="opponentAction" type="button" aria-pressed="\${opponentMoveVisible?'true':'false'}">相手行動</button>\`\n    :'<span class="opponent-action-spacer"></span>';\n  app.innerHTML=\`<main class="game"><header>\${canResign?'<button class="resign-button" id="resign">諦める</button>':'<span class="resign-spacer"></span>'}<div class="match-header"><span class="elapsed-label">経過 <strong id="elapsed">\${formatElapsed()}</strong></span><strong>\${status}</strong></div>\${opponentAction}</header>\${onlineInfo}<section class="hand" id="goteHand"></section><div class="board" id="board" aria-busy="\${cpuThinking||onlinePendingAction?'true':'false'}"></div><section class="hand" id="senteHand"></section>\${modeInfo}\${resultMarkup(terminal)}</main>\`;\n  document.querySelector('#resign')?.addEventListener('click',showResignDialog);\n  document.querySelector('#opponentAction')?.addEventListener('click',()=>{opponentMoveVisible=!opponentMoveVisible;resetInteraction();play();});\n`,
'button');

main=replaceOnce(main,
`    if(selected?.[0]===y&&selected[1]===x)cell.classList.add('selected');\n    if(candidates.some(move=>move.to[0]===y&&move.to[1]===x))cell.classList.add('legal');\n`,
`    if(selected?.[0]===y&&selected[1]===x)cell.classList.add('selected');\n    if(candidates.some(move=>move.to[0]===y&&move.to[1]===x))cell.classList.add('legal');\n    if(opponentMoveVisible&&lastOpponentMove?.from?.[0]===y&&lastOpponentMove.from[1]===x)cell.classList.add('opponent-move-from');\n    if(opponentMoveVisible&&lastOpponentMove?.to[0]===y&&lastOpponentMove.to[1]===x)cell.classList.add('opponent-move-to');\n`,
'board-highlight');

main=replaceOnce(main,
`function clickSquare(y:number,x:number,moves:Move[]){\n  if(cpuThinking||terminalState().ended||(activeMode==='cpu'&&pos.turn!==humanSide))return;\n  if(activeMode==='online'&&(!onlineState||onlineState.status!=='playing'||onlineSeat!==pos.turn||onlinePendingAction))return;\n`,
`function clickSquare(y:number,x:number,moves:Move[]){\n  if(cpuThinking||terminalState().ended||(activeMode==='cpu'&&pos.turn!==humanSide))return;\n  if(activeMode==='online'&&(!onlineState||onlineState.status!=='playing'||onlineSeat!==pos.turn||onlinePendingAction))return;\n  if(opponentMoveVisible)opponentMoveVisible=false;\n`,
'clear-on-board-action');

main=replaceOnce(main,
`    button.addEventListener('click',()=>{selected=null;hand=kind as PieceKind;candidates=moves.filter(move=>move.drop===kind);play();});\n`,
`    button.addEventListener('click',()=>{opponentMoveVisible=false;selected=null;hand=kind as PieceKind;candidates=moves.filter(move=>move.drop===kind);play();});\n`,
'clear-on-hand-action');

const cssAddition=`\n/* Opponent move visual replay: source is outlined, destination is marked on the live board. */\n.game header>.opponent-action-button,.game header>.opponent-action-spacer{grid-column:3;justify-self:end}\n.opponent-action-button{padding:8px 12px;border:1px solid #8c7857;border-radius:8px;background:#2b2118;color:#f7e7ce;font-weight:800;white-space:nowrap}\n.opponent-action-button.active{box-shadow:0 0 0 2px rgba(247,231,206,.42)}\n.opponent-action-spacer{display:block}\n.cell.opponent-move-from{box-shadow:inset 0 0 0 5px rgba(43,92,170,.88)}\n.cell.opponent-move-to{box-shadow:inset 0 0 0 5px rgba(241,205,72,.94)}\n.cell.opponent-move-from:before,.cell.opponent-move-to:before{content:"";position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:2}\n.cell.opponent-move-from:before{width:48%;aspect-ratio:1;border:4px solid rgba(43,92,170,.9);border-radius:50%;background:transparent}\n.cell.opponent-move-to:before{width:34%;aspect-ratio:1;border-radius:50%;background:rgba(241,205,72,.82);box-shadow:0 0 0 4px rgba(255,248,205,.56)}\n@media(max-width:520px){.opponent-action-button{padding:7px 8px;font-size:12px}.cell.opponent-move-from,.cell.opponent-move-to{box-shadow:inset 0 0 0 4px currentColor}}\n`;
if(css.includes('opponent-action-button'))throw new Error('css already patched');
css+=cssAddition;

await writeFile(mainPath,main,'utf8');
await writeFile(cssPath,css,'utf8');
