import { readFile, writeFile } from 'node:fs/promises';

function replaceOnce(source, from, to, label) {
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`PATCH_MARKER_MISSING:${label}`);
  if (source.indexOf(from, first + from.length) >= 0) throw new Error(`PATCH_MARKER_DUPLICATE:${label}`);
  return source.slice(0, first) + to + source.slice(first + from.length);
}

let main = await readFile('src/main.ts', 'utf8');

main = replaceOnce(
  main,
  "import type { CpuLevel, GameOutcome, Handicap, Mode, Move, PieceKind, Position, Side } from './game/types';\nimport { audioController } from './media/audio';",
  "import type { CpuLevel, GameOutcome, Handicap, Mode, Move, PieceKind, Position, Side } from './game/types';\nimport { getTitleStatus, resignTitleMatch, startTitleMatch, submitTitleMove } from './game/title-client';\nimport type { TitleOutcome, TitleResponse, TitleSession } from './game/title-client';\nimport { audioController } from './media/audio';",
  'title-imports',
);

main = replaceOnce(
  main,
  "let cpuWorker:Worker|null=null;\nlet onlineConnection:OnlineMatchConnection|null=null;",
  "let cpuWorker:Worker|null=null;\nlet titleSession:TitleSession|null=null;\nlet titleOutcome:TitleOutcome|null=null;\nlet titleEpoch=0;\nlet titleMessage='';\nlet onlineConnection:OnlineMatchConnection|null=null;",
  'title-state',
);

main = replaceOnce(
  main,
  "function warmCpuWorker(){\n  if(activeMode!=='cpu')return;\n  ensureCpuWorker().postMessage({type:'warmup',position:pos,level:cpuLevel,wasmUrl:cpuWasmUrl()});\n}\nfunction cancelOnline(){",
  `function warmCpuWorker(){
  if(activeMode!=='cpu'||cpuLevel==='title')return;
  ensureCpuWorker().postMessage({type:'warmup',position:pos,level:cpuLevel,wasmUrl:cpuWasmUrl()});
}
const TITLE_POLL_INTERVAL_MS=1000;
const TITLE_POLL_TIMEOUT_MS=15*60*1000;
function isTitleMatch(){return activeMode==='cpu'&&cpuLevel==='title';}
function cancelTitle(){
  titleEpoch+=1;
  titleSession=null;
  titleOutcome=null;
  titleMessage='';
}
function titleTerminalState():TerminalState|null{
  if(!isTitleMatch()||!titleOutcome)return null;
  if(!titleOutcome.ended)return{ended:false};
  if(titleOutcome.reason==='repetition')return{ended:true,reason:'repetition'};
  return{ended:true,winner:titleOutcome.winner,loser:titleOutcome.loser,reason:titleOutcome.reason};
}
function syncTitleResponse(response:TitleResponse,playMoveSound:boolean){
  if(titleSession&&response.gameId!==titleSession.gameId)return false;
  const previousPly=pos.ply;
  titleSession={gameId:response.gameId,stateToken:response.stateToken};
  titleOutcome=response.outcome;
  humanSide=response.humanSide;
  pos=response.position;
  cpuThinking=response.phase==='cpu_pending';
  titleMessage=response.phase==='cpu_pending'?'CPU思考中…':'';
  resetInteraction();
  if(playMoveSound&&pos.ply>previousPly)void audioController.playSe('move');
  if(response.outcome.ended&&matchEndedAt===null)matchEndedAt=Date.now();
  play();
  return true;
}
function titleErrorText(error:unknown){
  const code=error&&typeof error==='object'&&'code' in error?String((error as {code:unknown}).code):'';
  return code==='TITLE_API_NOT_CONFIGURED'?'タイトル級の接続先が未設定です。':'タイトル級の通信に失敗しました。正式局面は変更していません。';
}
const titleDelay=(ms:number)=>new Promise<void>(resolve=>window.setTimeout(resolve,ms));
async function pollTitleCpu(epoch:number){
  const deadline=Date.now()+TITLE_POLL_TIMEOUT_MS;
  while(epoch===titleEpoch&&isTitleMatch()&&titleSession&&!titleOutcome?.ended){
    const session=titleSession;
    try{
      const response=await getTitleStatus(session);
      if(epoch!==titleEpoch||!isTitleMatch())return;
      if(response.gameId!==session.gameId){
        cpuThinking=false;
        titleMessage='タイトル級の応答を確認できませんでした。';
        play();
        return;
      }
      if(response.phase!=='cpu_pending'){
        syncTitleResponse(response,true);
        return;
      }
      titleSession={gameId:response.gameId,stateToken:response.stateToken};
      titleOutcome=response.outcome;
      humanSide=response.humanSide;
      pos=response.position;
      cpuThinking=true;
      titleMessage='CPU思考中…';
    }catch{
      if(epoch!==titleEpoch||!isTitleMatch())return;
      cpuThinking=true;
      titleMessage='CPU結果を再確認中…';
      play();
    }
    if(Date.now()>=deadline){
      if(epoch!==titleEpoch||!isTitleMatch())return;
      cpuThinking=false;
      titleMessage='CPU結果の確認がタイムアウトしました。';
      play();
      return;
    }
    await titleDelay(TITLE_POLL_INTERVAL_MS);
  }
}
async function beginTitleMatch(config:MatchConfig){
  leaveMatch();
  activeMode='cpu';
  currentConfig={...config};
  cpuLevel='title';
  humanSide=config.order==='gote'?'gote':'sente';
  localPlayerOneSide=humanSide;
  pos=configuredInitialPosition({sente:config.senteHandicap,gote:config.goteHandicap});
  localTerminal=null;
  titleOutcome=null;
  titleSession=null;
  resetInteraction();
  setMatchClock(Date.now());
  cpuThinking=true;
  titleMessage='対局を開始しています…';
  const epoch=titleEpoch;
  play();
  try{
    const response=await startTitleMatch({order:config.order,senteHandicap:config.senteHandicap,goteHandicap:config.goteHandicap});
    if(epoch!==titleEpoch||!isTitleMatch())return;
    syncTitleResponse(response,false);
    if(response.phase==='cpu_pending')void pollTitleCpu(epoch);
  }catch(error){
    if(epoch!==titleEpoch||!isTitleMatch())return;
    cpuThinking=false;
    const message=titleErrorText(error);
    cancelTitle();
    resetMatchClock();
    app.innerHTML=\`<main class="panel">\${back()}<h2>タイトル級</h2><p>\${escapeHtml(message)}</p></main>\`;
    bindBack(()=>settingsGame('cpu',config));
  }
}
async function submitTitleHumanMove(move:Move){
  const session=titleSession;
  if(!session||!isTitleMatch()||cpuThinking||terminalState().ended)return;
  const epoch=titleEpoch;
  cpuThinking=true;
  titleMessage='着手を確認中…';
  resetInteraction();
  play();
  try{
    const response=await submitTitleMove(session,move);
    if(epoch!==titleEpoch||!isTitleMatch())return;
    syncTitleResponse(response,true);
    if(response.phase==='cpu_pending')void pollTitleCpu(epoch);
  }catch(error){
    if(epoch!==titleEpoch||!isTitleMatch())return;
    try{
      const response=await getTitleStatus(session);
      if(epoch!==titleEpoch||!isTitleMatch())return;
      syncTitleResponse(response,false);
      if(response.phase==='cpu_pending')void pollTitleCpu(epoch);
    }catch{
      cpuThinking=false;
      titleMessage=titleErrorText(error);
      play();
    }
  }
}
async function submitTitleResign(){
  const session=titleSession;
  if(!session||!isTitleMatch()||terminalState().ended)return;
  const epoch=titleEpoch;
  const previousThinking=cpuThinking;
  cpuThinking=true;
  titleMessage='投了を確認中…';
  play();
  try{
    const response=await resignTitleMatch(session);
    if(epoch!==titleEpoch||!isTitleMatch())return;
    syncTitleResponse(response,false);
  }catch(error){
    if(epoch!==titleEpoch||!isTitleMatch())return;
    try{
      const response=await getTitleStatus(session);
      if(epoch!==titleEpoch||!isTitleMatch())return;
      syncTitleResponse(response,false);
      if(response.phase==='cpu_pending')void pollTitleCpu(epoch);
    }catch{
      cpuThinking=previousThinking;
      titleMessage=titleErrorText(error);
      play();
    }
  }
}
function cancelOnline(){`,
  'title-runtime',
);

main = replaceOnce(
  main,
  "function leaveMatch(){\n  cancelCpu();\n  cancelOnline();",
  "function leaveMatch(){\n  cancelCpu();\n  cancelTitle();\n  cancelOnline();",
  'title-leave',
);

main = replaceOnce(
  main,
  "function beginOfflineMatch(config:MatchConfig){\n  leaveMatch();",
  "function beginOfflineMatch(config:MatchConfig){\n  if(config.mode==='cpu'&&config.cpuLevel==='title'){void beginTitleMatch(config);return;}\n  leaveMatch();",
  'title-begin',
);

main = replaceOnce(
  main,
  "function terminalState():TerminalState{\n  if(activeMode==='online'){",
  "function terminalState():TerminalState{\n  const titleTerminal=titleTerminalState();\n  if(titleTerminal)return titleTerminal;\n  if(activeMode==='online'){",
  'title-terminal',
);

main = replaceOnce(
  main,
  "    play();\n    return;\n  }\n  const loser=activeMode==='cpu'?humanSide:pos.turn;",
  "    play();\n    return;\n  }\n  if(isTitleMatch()){void submitTitleResign();return;}\n  const loser=activeMode==='cpu'?humanSide:pos.turn;",
  'title-resign',
);

main = replaceOnce(
  main,
  "  if(ended)status='終局';\n  else if(cpuThinking)status='CPU思考中…';",
  "  if(ended)status='終局';\n  else if(isTitleMatch()&&titleMessage)status=titleMessage;\n  else if(cpuThinking)status='CPU思考中…';",
  'title-status',
);

main = replaceOnce(
  main,
  "  const canResign=!ended&&(activeMode!=='online'||onlineState?.status==='playing');",
  "  const canResign=!ended&&(activeMode!=='online'||onlineState?.status==='playing')&&(!isTitleMatch()||!!titleSession);",
  'title-resign-button',
);

main = replaceOnce(
  main,
  "      play();\n      return;\n    }\n    pos=applyMove(pos,move);",
  "      play();\n      return;\n    }\n    if(isTitleMatch()){void submitTitleHumanMove(move);return;}\n    pos=applyMove(pos,move);",
  'title-human-move',
);

main = replaceOnce(
  main,
  "function maybeStartCpu(){\n  if(activeMode!=='cpu'||pos.turn===humanSide||terminalState().ended||cpuThinking)return;\n  cpuThinking=true;",
  "function maybeStartCpu(){\n  if(activeMode!=='cpu'||pos.turn===humanSide||terminalState().ended||cpuThinking)return;\n  if(cpuLevel==='title')return;\n  cpuThinking=true;",
  'title-no-local-worker',
);

await writeFile('src/main.ts', main, 'utf8');

let pages = await readFile('.github/workflows/pages.yml', 'utf8');
pages = replaceOnce(
  pages,
  "        env:\n          VITE_SHOGI_API_URL: https://shogi-system.garigarimegane625.workers.dev\n        run: npm run build",
  "        env:\n          VITE_SHOGI_API_URL: https://shogi-system.garigarimegane625.workers.dev\n          VITE_TITLE_SUPABASE_URL: https://mpuhgfbdkxmhynytwhzu.supabase.co/functions/v1/title-supercomputer\n          VITE_TITLE_SUPABASE_KEY: sb_publishable_POCxau9QCPFlF0J11o-ZFg_-QY4b8gF\n        run: npm run build",
  'pages-title-env',
);
await writeFile('.github/workflows/pages.yml', pages, 'utf8');
