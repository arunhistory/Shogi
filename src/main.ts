import './style.css';
import { fetchCloudContent } from './content/client';
import type { CloudContentKey } from './content/client';
import { rulesMarkup } from './content/rules';
import { applyMove, gameOutcome, isCheck, legalMoves, positionKey } from './game/engine';
import { configuredInitialPosition, oppositeSide, resolveOrder } from './game/setup';
import type { OrderPreference } from './game/setup';
import type { CpuLevel, GameOutcome, Handicap, Mode, Move, PieceKind, Position, Side } from './game/types';
import { getTitleStatus, resignTitleMatch, startTitleMatch, submitTitleMove } from './game/title-client';
import type { TitleOutcome, TitleResponse, TitleSession } from './game/title-client';
import { audioController } from './media/audio';
import {
  createOnlineRoom,
  joinOnlineInvite,
  joinOnlineRoom,
  OnlineMatchConnection,
} from './online/client';
import type { AuthoritativeState, OnlineRoomEntry } from './online/client';

const names:Record<string,string>={king:'玉',rook:'飛',bishop:'角',gold:'金',silver:'銀',knight:'桂',lance:'香',pawn:'歩',dragon:'龍',horse:'馬',promotedSilver:'全',promotedKnight:'圭',promotedLance:'杏',tokin:'と'};
const cpuLabels:Record<CpuLevel,string>={beginner:'初心者',intermediate:'中級者',amateur:'アマチュア',pro:'プロ',title:'タイトル級'};
const sideName=(side:Side)=>side==='sente'?'先手':'後手';
const orderLabel=(order:OrderPreference)=>order==='random'?'ランダム':order==='sente'?'先手':'後手';
const handicapLabels:Record<Handicap,string>={even:'平手',rook:'飛車落ち',bishop:'角落ち',two:'2枚落ち',four:'4枚落ち',six:'6枚落ち'};

interface MatchConfig{
  mode:Mode;
  cpuLevel:CpuLevel;
  senteHandicap:Handicap;
  goteHandicap:Handicap;
  order:OrderPreference;
}
interface LocalTerminal{
  winner:Side;
  loser:Side;
  reason:'resignation';
}
interface TerminalState{
  ended:boolean;
  winner?:Side;
  loser?:Side;
  reason?:'mate'|'repetition'|'perpetual-check'|'resignation';
}

const defaultConfig=(mode:Mode):MatchConfig=>({mode,cpuLevel:'beginner',senteHandicap:'even',goteHandicap:'even',order:'random'});

let pos:Position=configuredInitialPosition();
let selected:[number,number]|null=null;
let hand:PieceKind|null=null;
let candidates:Move[]=[];
let activeMode:Mode='local';
let currentConfig:MatchConfig=defaultConfig('local');
let cpuLevel:CpuLevel='beginner';
let humanSide:Side='sente';
let localPlayerOneSide:Side='sente';
let localTerminal:LocalTerminal|null=null;
let cpuThinking=false;
let cpuRequestId:string|null=null;
let cpuWorker:Worker|null=null;
let titleSession:TitleSession|null=null;
let titleOutcome:TitleOutcome|null=null;
let titleEpoch=0;
let titleMessage='';
let onlineConnection:OnlineMatchConnection|null=null;
let onlineUnsubscribe:(()=>void)|null=null;
let onlineRoom:OnlineRoomEntry|null=null;
let onlineState:AuthoritativeState|null=null;
let onlineSeat:Side|null=null;
let onlinePendingAction=false;
let onlineMessage='';
let matchStartedAt:number|null=null;
let matchEndedAt:number|null=null;
let elapsedTimer:number|null=null;
let lastOpponentMove:Move|null=null;
let opponentMoveVisible=false;

const app=document.querySelector<HTMLDivElement>('#app')!;

function resetInteraction(){selected=null;hand=null;candidates=[];}
function rememberOpponentMove(move:Move){
  lastOpponentMove={...move,to:[move.to[0],move.to[1]],...(move.from?{from:[move.from[0],move.from[1]] as [number,number]}:{})};
  opponentMoveVisible=false;
}
function clearOpponentMove(){lastOpponentMove=null;opponentMoveVisible=false;}
function stopElapsedTimer(){if(elapsedTimer!==null){window.clearInterval(elapsedTimer);elapsedTimer=null;}}
function resetMatchClock(){stopElapsedTimer();matchStartedAt=null;matchEndedAt=null;}
function setMatchClock(startedAt:number|null,endedAt:number|null=null){
  matchStartedAt=startedAt;
  matchEndedAt=endedAt;
  stopElapsedTimer();
}
function formatElapsed():string{
  if(matchStartedAt===null)return'--:--';
  const end=matchEndedAt??Date.now();
  const total=Math.max(0,Math.floor((end-matchStartedAt)/1000));
  const hours=Math.floor(total/3600);
  const minutes=Math.floor((total%3600)/60);
  const seconds=total%60;
  return hours>0?`${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`:`${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
}
function refreshElapsed(){const node=document.querySelector<HTMLElement>('#elapsed');if(node)node.textContent=formatElapsed();}
function ensureElapsedTimer(){
  refreshElapsed();
  if(matchStartedAt===null||matchEndedAt!==null||elapsedTimer!==null)return;
  elapsedTimer=window.setInterval(refreshElapsed,1000);
}
function cancelCpu(){
  cpuRequestId=null;
  cpuThinking=false;
  cpuWorker?.terminate();
  cpuWorker=null;
}
function cpuWasmUrl(){return new URL('wasm/shogi_engine.wasm',document.baseURI).toString();}
function ensureCpuWorker():Worker{
  if(cpuWorker)return cpuWorker;
  const worker=new Worker(new URL('./game/cpu-worker.ts',import.meta.url),{type:'module'});
  worker.onerror=()=>{
    if(cpuWorker!==worker)return;
    worker.terminate();
    cpuWorker=null;
    cpuRequestId=null;
    if(cpuThinking){cpuThinking=false;play();}
  };
  cpuWorker=worker;
  return worker;
}
function warmCpuWorker(){
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
  if(response.title?.move)rememberOpponentMove(response.title.move);
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
    app.innerHTML=`<main class="panel">${back()}<h2>タイトル級</h2><p>${escapeHtml(message)}</p></main>`;
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
function cancelOnline(){
  onlineUnsubscribe?.();
  onlineUnsubscribe=null;
  onlineConnection?.close();
  onlineConnection=null;
  onlineRoom=null;
  onlineState=null;
  onlineSeat=null;
  onlinePendingAction=false;
  onlineMessage='';
}
function clearInviteParameter(){
  const url=new URL(location.href);
  if(!url.searchParams.has('invite'))return;
  url.searchParams.delete('invite');
  history.replaceState(null,'',`${url.pathname}${url.search}${url.hash}`);
}
function leaveMatch(){
  cancelCpu();
  cancelTitle();
  cancelOnline();
  resetInteraction();
  clearOpponentMove();
  resetMatchClock();
  localTerminal=null;
}
function menu(){
  leaveMatch();
  clearInviteParameter();
  app.innerHTML=`<main class="menu"><h1>将棋</h1><button id="start">スタート</button><button id="rules">ルール</button><button id="settings">設定</button></main>`;
  document.querySelector('#start')!.addEventListener('click',mode);
  document.querySelector('#rules')!.addEventListener('click',rules);
  document.querySelector('#settings')!.addEventListener('click',settings);
}
function back(){return `<button class="back" id="back">← 戻る</button>`;}
function bindBack(target:()=>void){document.querySelector('#back')?.addEventListener('click',target);}
function mode(){
  leaveMatch();
  app.innerHTML=`<main class="panel">${back()}<h2>ゲームモード</h2><button data-mode="cpu">CPU対局</button><button data-mode="local">ローカル2人対局</button><button data-mode="online">オンライン対局</button></main>`;
  bindBack(menu);
  document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>settingsGame((button as HTMLElement).dataset.mode as Mode)));
}
function selectedOption(value:string,current:string){return value===current?' selected':'';}
function handicapOptions(current:Handicap){
  return (Object.entries(handicapLabels) as [Handicap,string][]).map(([value,label])=>`<option value="${value}"${selectedOption(value,current)}>${label}</option>`).join('');
}
function settingsGame(modeValue:Mode,preset:MatchConfig=defaultConfig(modeValue)){
  leaveMatch();
  const config={...preset,mode:modeValue};
  const orderTitle=modeValue==='local'?'プレイヤー1の先手・後手':'あなたの先手・後手';
  app.innerHTML=`<main class="panel game-settings">${back()}<h2>ゲーム設定</h2>
    ${modeValue==='cpu'?`<label>CPU難易度<select id="cpuLevel"><option value="beginner"${selectedOption('beginner',config.cpuLevel)}>初心者</option><option value="intermediate"${selectedOption('intermediate',config.cpuLevel)}>中級者</option><option value="amateur"${selectedOption('amateur',config.cpuLevel)}>アマチュア</option><option value="pro"${selectedOption('pro',config.cpuLevel)}>プロ</option><option value="title"${selectedOption('title',config.cpuLevel)}>タイトル級</option></select></label>`:''}
    <label>${orderTitle}<select id="order"><option value="random"${selectedOption('random',config.order)}>ランダム</option><option value="sente"${selectedOption('sente',config.order)}>先手</option><option value="gote"${selectedOption('gote',config.order)}>後手</option></select></label>
    <label>先手の駒落ち<select id="senteHandicap">${handicapOptions(config.senteHandicap)}</select></label>
    <label>後手の駒落ち<select id="goteHandicap">${handicapOptions(config.goteHandicap)}</select></label>
    <button id="go">開始</button><p class="note">${modeValue==='online'?'先手・後手と、先手・後手それぞれの駒落ちは部屋作成時に適用されます。参加する場合は作成済みの部屋設定に従います。':'先手・後手はランダムが初期設定です。'}</p></main>`;
  bindBack(mode);
  const senteHandicapSelect=document.querySelector<HTMLSelectElement>('#senteHandicap')!;
  const goteHandicapSelect=document.querySelector<HTMLSelectElement>('#goteHandicap')!;
  document.querySelector('#go')!.addEventListener('click',()=>{
    const next:MatchConfig={
      mode:modeValue,
      cpuLevel:modeValue==='cpu'?(document.querySelector('#cpuLevel') as HTMLSelectElement).value as CpuLevel:'beginner',
      order:(document.querySelector('#order') as HTMLSelectElement).value as OrderPreference,
      senteHandicap:senteHandicapSelect.value as Handicap,
      goteHandicap:goteHandicapSelect.value as Handicap,
    };
    currentConfig=next;
    if(modeValue==='online'){onlineEntry(next);return;}
    beginOfflineMatch(next);
  });
}
function rules(){
  leaveMatch();
  app.innerHTML=`<main class="document rules-document">${back()}<h2>ルール</h2>${rulesMarkup()}</main>`;
  bindBack(menu);
}
function settings(){
  leaveMatch();
  const prefs=audioController.getPreferences();
  app.innerHTML=`<main class="panel settings-panel">${back()}<h2>設定</h2><label class="setting-row"><span>BGM</span><input id="bgmEnabled" type="checkbox" ${prefs.bgmEnabled?'checked':''}></label><label class="setting-row"><span>BGM音量</span><input id="bgmVolume" type="range" min="0" max="100" value="${Math.round(prefs.bgmVolume*100)}"></label><label class="setting-row"><span>SE</span><input id="seEnabled" type="checkbox" ${prefs.seEnabled?'checked':''}></label><label class="setting-row"><span>SE音量</span><input id="seVolume" type="range" min="0" max="100" value="${Math.round(prefs.seVolume*100)}"></label><button data-content="terms">利用規約</button><button data-content="credits">クレジット</button><button data-content="licenses">ライセンス</button><p class="note">BGM・SE素材は外部manifestから読み込みます。素材が未登録でもゲームはそのまま動作します。</p></main>`;
  bindBack(menu);
  void audioController.initialize();
  const bgmEnabled=document.querySelector<HTMLInputElement>('#bgmEnabled')!;
  const bgmVolume=document.querySelector<HTMLInputElement>('#bgmVolume')!;
  const seEnabled=document.querySelector<HTMLInputElement>('#seEnabled')!;
  const seVolume=document.querySelector<HTMLInputElement>('#seVolume')!;
  bgmEnabled.addEventListener('change',()=>void audioController.updatePreferences({bgmEnabled:bgmEnabled.checked}));
  bgmVolume.addEventListener('input',()=>void audioController.updatePreferences({bgmVolume:Number(bgmVolume.value)/100}));
  seEnabled.addEventListener('change',()=>void audioController.updatePreferences({seEnabled:seEnabled.checked}));
  seVolume.addEventListener('input',()=>void audioController.updatePreferences({seVolume:Number(seVolume.value)/100}));
  document.querySelectorAll<HTMLElement>('[data-content]').forEach(button=>button.addEventListener('click',()=>{
    const key=button.dataset.content as CloudContentKey;
    const title=key==='terms'?'利用規約':key==='credits'?'クレジット':'ライセンス';
    void showCloudDocument(key,title);
  }));
}
async function showCloudDocument(key:CloudContentKey,title:string){
  leaveMatch();
  app.innerHTML=`<main class="document">${back()}<h2>${escapeHtml(title)}</h2><p id="documentState">読み込み中…</p></main>`;
  bindBack(settings);
  const state=document.querySelector('#documentState')!;
  const api=onlineApi();
  if(!api){state.textContent='Cloudflare接続先が未設定のため、本文を取得できません。';return;}
  try{
    const documentValue=await fetchCloudContent(api,key);
    if(!documentValue.available){state.textContent='現在、本文は未登録です。';return;}
    const rendered=renderCloudBody(documentValue.body);
    if(key==='terms'){
      const deadline=document.createElement('p');
      deadline.textContent='最長2027年12月31日まで公開';
      rendered.append(deadline);
    }
    state.replaceWith(rendered);
  }catch{state.textContent='本文を取得できませんでした。';}
}
function renderCloudBody(body:unknown):HTMLElement{
  const container=document.createElement('div');
  container.className='cloud-document-body';
  if(typeof body==='string'){
    for(const line of body.split(/\n{2,}/)){
      const p=document.createElement('p');p.textContent=line;container.append(p);
    }
    return container;
  }
  if(Array.isArray(body)&&body.every(item=>typeof item==='string')){
    const list=document.createElement('ul');
    for(const item of body){const li=document.createElement('li');li.textContent=item;list.append(li);}
    container.append(list);return container;
  }
  const pre=document.createElement('pre');
  try{pre.textContent=JSON.stringify(body,null,2);}catch{pre.textContent='表示できない形式です。';}
  container.append(pre);
  return container;
}
function onlineApi():string|null{
  const value=(import.meta.env.VITE_SHOGI_API_URL as string|undefined)?.trim();
  return value||null;
}
function configFromRoom(room:OnlineRoomEntry):MatchConfig{
  return{mode:'online',cpuLevel:'beginner',senteHandicap:room.senteHandicap,goteHandicap:room.goteHandicap,order:room.order};
}
function onlineEntry(config:MatchConfig){
  leaveMatch();
  activeMode='online';
  currentConfig={...config,mode:'online'};
  app.innerHTML=`<main class="panel">${back()}<h2>オンライン対局</h2><div class="rule-summary">先手 ${escapeHtml(handicapLabels[config.senteHandicap])} / 後手 ${escapeHtml(handicapLabels[config.goteHandicap])} / ${escapeHtml(orderLabel(config.order))}</div><button id="createRoom">部屋を作成</button><label>パスコード<input id="passcode" inputmode="text" autocomplete="off" maxlength="8"></label><button id="joinRoom">パスコードで接続</button><p class="note" id="onlineStatus">Cloudflare接続先を確認しています。</p></main>`;
  bindBack(()=>settingsGame('online',config));
  const status=document.querySelector('#onlineStatus')!;
  const api=onlineApi();
  if(!api){
    status.textContent='Cloudflare接続先が未設定です。ローカル状態をオンライン対局の正式状態として使用しません。';
    (document.querySelector('#createRoom') as HTMLButtonElement).disabled=true;
    (document.querySelector('#joinRoom') as HTMLButtonElement).disabled=true;
    return;
  }
  status.textContent='部屋を作るか、受け取ったパスコードを入力してください。';
  document.querySelector('#createRoom')!.addEventListener('click',()=>{
    status.textContent='部屋を作成しています…';
    void createOnlineRoom(api,config.senteHandicap,config.goteHandicap,config.order).then(room=>connectOnlineRoom(api,room)).catch(()=>{status.textContent='部屋作成に失敗しました。ローカル状態へフォールバックしません。';});
  });
  document.querySelector('#joinRoom')!.addEventListener('click',()=>{
    const passcode=(document.querySelector('#passcode') as HTMLInputElement).value.trim();
    if(!passcode){status.textContent='パスコードを入力してください。';return;}
    status.textContent='部屋へ接続しています…';
    void joinOnlineRoom(api,passcode).then(room=>connectOnlineRoom(api,room)).catch(()=>{status.textContent='接続に失敗しました。パスコードと接続状態を確認してください。';});
  });
}
function connectOnlineRoom(api:string,room:OnlineRoomEntry){
  leaveMatch();
  activeMode='online';
  currentConfig=configFromRoom(room);
  onlineRoom=room;
  onlineSeat=room.seat;
  onlineMessage='正式局面を取得しています…';
  app.innerHTML=`<main class="panel">${back()}<h2>オンライン対局</h2><p>${escapeHtml(onlineMessage)}</p><p class="note">正式局面はCloudflare側から受信した後に表示します。</p></main>`;
  bindBack(()=>onlineEntry(currentConfig));
  const connection=new OnlineMatchConnection(api,room.roomId);
  onlineConnection=connection;
  onlineUnsubscribe=connection.subscribe(event=>{
    if(onlineConnection!==connection)return;
    if(event.type==='authenticated'){
      onlineSeat=event.seat;
      onlineMessage=`${sideName(event.seat)}として接続しました。`;
      return;
    }
    if(event.type==='state'){
      const previousPly=onlineState?.position.ply??event.state.position.ply;
      onlineState=event.state;
      pos=event.state.position;
      onlinePendingAction=false;
      onlineMessage='';
      currentConfig={mode:'online',cpuLevel:'beginner',senteHandicap:event.state.senteHandicap,goteHandicap:event.state.goteHandicap,order:event.state.order};
      setMatchClock(event.state.startedAt??null,event.state.endedAt??null);
      resetInteraction();
      if(event.state.position.ply>previousPly)void audioController.playSe('move');
      play();
      return;
    }
    if(event.type==='rejected'){
      onlinePendingAction=false;
      onlineMessage=`操作は反映されませんでした（${event.code}）。正式局面を再取得します。`;
      if(onlineState)play();
      return;
    }
    if(event.type==='disconnected'){
      onlinePendingAction=false;
      onlineMessage='接続が切れました。切断を敗北として扱わず、同じ席で再接続できます。';
      if(onlineState)play();
      else renderOnlineConnectionFailure();
      return;
    }
    onlinePendingAction=false;
    onlineMessage=`通信エラー: ${event.code}`;
    if(onlineState)play();
    else renderOnlineConnectionFailure();
  });
  try{connection.connect();}catch{
    onlineMessage='オンライン接続を開始できませんでした。';
    renderOnlineConnectionFailure();
  }
}
function renderOnlineConnectionFailure(){
  app.innerHTML=`<main class="panel">${back()}<h2>オンライン対局</h2><p>${escapeHtml(onlineMessage)}</p>${onlineConnection?'<button id="reconnect">再接続</button>':''}</main>`;
  bindBack(()=>onlineEntry(currentConfig));
  document.querySelector('#reconnect')?.addEventListener('click',()=>{
    onlineMessage='再接続しています…';
    try{onlineConnection?.connect();}catch{onlineMessage='再接続を開始できませんでした。';renderOnlineConnectionFailure();}
  });
}
function beginOfflineMatch(config:MatchConfig){
  if(config.mode==='cpu'&&config.cpuLevel==='title'){void beginTitleMatch(config);return;}
  leaveMatch();
  activeMode=config.mode;
  currentConfig={...config};
  cpuLevel=config.cpuLevel;
  humanSide=resolveOrder(config.order);
  localPlayerOneSide=humanSide;
  pos=configuredInitialPosition({sente:config.senteHandicap,gote:config.goteHandicap});
  localTerminal=null;
  resetInteraction();
  setMatchClock(Date.now());
  if(config.mode==='cpu')warmCpuWorker();
  play();
  maybeStartCpu();
}
function terminalState():TerminalState{
  const titleTerminal=titleTerminalState();
  if(titleTerminal)return titleTerminal;
  if(activeMode==='online'){
    if(!onlineState||onlineState.status!=='ended')return{ended:false};
    if(onlineState.resultReason==='repetition')return{ended:true,reason:'repetition'};
    const reason=onlineState.resultReason as TerminalState['reason'];
    return{ended:true,winner:onlineState.winner,loser:onlineState.winner?oppositeSide(onlineState.winner):undefined,reason};
  }
  if(localTerminal)return{ended:true,...localTerminal};
  const outcome=gameOutcome(pos);
  if(!outcome.ended)return{ended:false};
  if(outcome.reason==='repetition')return{ended:true,reason:'repetition'};
  return{ended:true,winner:outcome.winner,loser:outcome.loser,reason:outcome.reason};
}
function resultReasonText(reason:TerminalState['reason']):string{
  if(reason==='mate')return'詰み';
  if(reason==='perpetual-check')return'連続王手の千日手';
  if(reason==='resignation')return'投了';
  if(reason==='repetition')return'千日手';
  return'';
}
function resultMarkup(terminal:TerminalState):string{
  if(!terminal.ended)return'';
  let body='';
  if(terminal.reason==='repetition')body='<div class="result-title">千日手</div>';
  else if(terminal.winner&&terminal.loser){
    if(activeMode==='local'){
      body=`<div class="result-title local-result"><span>${sideName(terminal.winner)}：勝利</span><span>${sideName(terminal.loser)}：敗北</span></div>`;
    }else{
      const self=activeMode==='online'?onlineSeat:humanSide;
      body=`<div class="result-title">${self===terminal.winner?'勝利':'敗北'}</div>`;
    }
    const reason=resultReasonText(terminal.reason);
    if(reason)body+=`<div class="result-reason">${escapeHtml(reason)}</div>`;
  }
  return `<section class="result-panel">${body}<div class="result-actions"><button id="playAgain">もう一度対戦する</button><button id="sameAgain">同じルールでもう一度対戦する</button><button id="homeFromResult">ホームに戻る</button></div></section>`;
}
function openSettingsForRematch(){const config={...currentConfig};leaveMatch();settingsGame(config.mode,config);}
function sameRulesAgain(){
  const config={...currentConfig};
  if(config.mode!=='online'){beginOfflineMatch(config);return;}
  leaveMatch();
  activeMode='online';
  currentConfig=config;
  const api=onlineApi();
  app.innerHTML=`<main class="panel"><h2>オンライン対局</h2><p id="onlineStatus">同じルールで新しい部屋を作成しています…</p><button id="cancelRematch">ゲーム設定へ戻る</button></main>`;
  document.querySelector('#cancelRematch')?.addEventListener('click',()=>settingsGame('online',config));
  if(!api){document.querySelector('#onlineStatus')!.textContent='Cloudflare接続先が未設定です。';return;}
  void createOnlineRoom(api,config.senteHandicap,config.goteHandicap,config.order).then(room=>connectOnlineRoom(api,room)).catch(()=>{document.querySelector('#onlineStatus')!.textContent='部屋作成に失敗しました。';});
}
function bindResultActions(){
  document.querySelector('#playAgain')?.addEventListener('click',openSettingsForRematch);
  document.querySelector('#sameAgain')?.addEventListener('click',sameRulesAgain);
  document.querySelector('#homeFromResult')?.addEventListener('click',menu);
}
function showResignDialog(){
  document.querySelector('.resign-overlay')?.remove();
  const overlay=document.createElement('div');
  overlay.className='resign-overlay';
  overlay.innerHTML=`<div class="resign-dialog" role="dialog" aria-modal="true" aria-labelledby="resignTitle"><p id="resignTitle">本当にいいですか？</p><div><button id="resignYes">はい</button><button id="resignNo">いいえ</button></div></div>`;
  document.body.append(overlay);
  const close=()=>overlay.remove();
  document.querySelector('#resignNo')?.addEventListener('click',close,{once:true});
  document.querySelector('#resignYes')?.addEventListener('click',()=>{close();confirmResign();},{once:true});
  (document.querySelector('#resignNo') as HTMLButtonElement)?.focus();
}
function confirmResign(){
  const terminal=terminalState();
  if(terminal.ended)return;
  if(activeMode==='online'){
    if(!onlineState||onlineState.status!=='playing'||!onlineSeat||onlinePendingAction)return;
    try{
      onlineConnection?.sendResign();
      onlinePendingAction=true;
      onlineMessage='投了を確認中…';
    }catch{onlinePendingAction=false;onlineMessage='投了を送信できませんでした。正式状態は変更していません。';}
    play();
    return;
  }
  if(isTitleMatch()){void submitTitleResign();return;}
  const loser=activeMode==='cpu'?humanSide:pos.turn;
  localTerminal={winner:oppositeSide(loser),loser,reason:'resignation'};
  matchEndedAt=Date.now();
  cancelCpu();
  resetInteraction();
  play();
}
function escapeHtml(value:string){return value.replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]!));}
function play(){
  const moves=legalMoves(pos);
  const terminal=terminalState();
  const ended=terminal.ended;
  if(ended&&matchEndedAt===null){matchEndedAt=activeMode==='online'?(onlineState?.endedAt??Date.now()):Date.now();stopElapsedTimer();}
  const onlineCanOperate=activeMode==='online'&&onlineState?.status==='playing'&&onlineSeat===pos.turn&&!onlinePendingAction;
  const humanCanOperate=!ended&&!cpuThinking&&(activeMode==='cpu'?pos.turn===humanSide:activeMode==='online'?onlineCanOperate:true);
  let status:string;
  if(ended)status='終局';
  else if(isTitleMatch()&&titleMessage)status=titleMessage;
  else if(cpuThinking)status='CPU思考中…';
  else if(activeMode==='online'&&onlineState?.status==='waiting')status='対戦相手を待っています';
  else if(activeMode==='online'&&onlinePendingAction)status='操作を確認中…';
  else status=`${sideName(pos.turn)}番${isCheck(pos,pos.turn)?'・王手':''}`;
  const onlineInfo=activeMode==='online'&&onlineRoom&&onlineState
    ?`<aside class="online-info"><div>あなた: ${onlineSeat?sideName(onlineSeat):'確認中'}</div><div>接続: 先手 ${onlineState.connections.sente} / 後手 ${onlineState.connections.gote}</div><label>招待URL<input readonly value="${escapeHtml(onlineRoom.inviteUrl)}"></label><label>パスコード<input readonly value="${escapeHtml(onlineRoom.passcode)}"></label>${onlineMessage?`<p class="note">${escapeHtml(onlineMessage)}</p>`:''}${onlineMessage?'<button id="reconnect">再接続</button>':''}</aside>`:'';
  const modeInfo=activeMode==='cpu'?`<div class="note cpu-level">CPU: ${cpuLabels[cpuLevel]} / あなた: ${sideName(humanSide)}</div>`:activeMode==='local'?`<div class="note local-order">プレイヤー1: ${sideName(localPlayerOneSide)}</div>`:'';
  const canResign=!ended&&(activeMode!=='online'||onlineState?.status==='playing')&&(!isTitleMatch()||!!titleSession);
  const opponentAction=activeMode==='cpu'&&lastOpponentMove&&!ended
    ?`<button class="opponent-action-button${opponentMoveVisible?' active':''}" id="opponentAction" type="button" aria-pressed="${opponentMoveVisible?'true':'false'}">相手行動</button>`
    :'<span class="opponent-action-spacer"></span>';
  app.innerHTML=`<main class="game"><header>${canResign?'<button class="resign-button" id="resign">諦める</button>':'<span class="resign-spacer"></span>'}<div class="match-header"><span class="elapsed-label">経過 <strong id="elapsed">${formatElapsed()}</strong></span><strong>${status}</strong></div>${opponentAction}</header>${onlineInfo}<section class="hand" id="goteHand"></section><div class="board" id="board" aria-busy="${cpuThinking||onlinePendingAction?'true':'false'}"></div><section class="hand" id="senteHand"></section>${modeInfo}${resultMarkup(terminal)}</main>`;
  document.querySelector('#resign')?.addEventListener('click',showResignDialog);
  document.querySelector('#opponentAction')?.addEventListener('click',()=>{opponentMoveVisible=!opponentMoveVisible;resetInteraction();play();});
  bindResultActions();
  document.querySelector('#reconnect')?.addEventListener('click',()=>{
    onlineMessage='再接続しています…';
    try{onlineConnection?.connect();}catch{onlineMessage='再接続を開始できませんでした。';play();}
  });
  const board=document.querySelector('#board')!;
  for(let y=0;y<9;y++)for(let x=0;x<9;x++){
    const piece=pos.board[y]![x];
    const cell=document.createElement('button');
    cell.className='cell';
    cell.disabled=!humanCanOperate;
    if(selected?.[0]===y&&selected[1]===x)cell.classList.add('selected');
    if(candidates.some(move=>move.to[0]===y&&move.to[1]===x))cell.classList.add('legal');
    if(opponentMoveVisible&&lastOpponentMove?.from?.[0]===y&&lastOpponentMove.from[1]===x)cell.classList.add('opponent-move-from');
    if(opponentMoveVisible&&lastOpponentMove?.to[0]===y&&lastOpponentMove.to[1]===x)cell.classList.add('opponent-move-to');
    if(piece){cell.textContent=names[piece.kind]??piece.kind;if(piece.side==='gote')cell.classList.add('gote');}
    cell.addEventListener('click',()=>clickSquare(y,x,moves));
    board.append(cell);
  }
  renderHand('gote','goteHand',moves,humanCanOperate);
  renderHand('sente','senteHand',moves,humanCanOperate);
  if(ended)stopElapsedTimer();else ensureElapsedTimer();
}
function renderHand(side:Side,id:string,moves:Move[],humanCanOperate:boolean){
  const element=document.querySelector(`#${id}`)!;
  element.innerHTML=`<span>${sideName(side)} 持ち駒</span>`;
  for(const [kind,count] of Object.entries(pos.hands[side]))if(count>0){
    const button=document.createElement('button');
    button.textContent=`${names[kind]??kind}×${count}`;
    button.disabled=!humanCanOperate||side!==pos.turn;
    button.addEventListener('click',()=>{opponentMoveVisible=false;selected=null;hand=kind as PieceKind;candidates=moves.filter(move=>move.drop===kind);play();});
    element.append(button);
  }
}
function clickSquare(y:number,x:number,moves:Move[]){
  if(cpuThinking||terminalState().ended||(activeMode==='cpu'&&pos.turn!==humanSide))return;
  if(activeMode==='online'&&(!onlineState||onlineState.status!=='playing'||onlineSeat!==pos.turn||onlinePendingAction))return;
  if(opponentMoveVisible)opponentMoveVisible=false;
  const hit=candidates.filter(move=>move.to[0]===y&&move.to[1]===x);
  if(hit.length){
    let move=hit[0]!;
    if(hit.length===2&&hit.some(candidate=>candidate.promote)&&confirm('成りますか？'))move=hit.find(candidate=>candidate.promote)!;
    if(activeMode==='online'){
      try{
        onlineConnection?.sendMove(move);
        onlinePendingAction=true;
        onlineMessage='';
      }catch{onlineMessage='着手を送信できませんでした。正式局面は変更していません。';}
      resetInteraction();
      play();
      return;
    }
    if(isTitleMatch()){void submitTitleHumanMove(move);return;}
    pos=applyMove(pos,move);
    void audioController.playSe('move');
    resetInteraction();
    play();
    maybeStartCpu();
    return;
  }
  const piece=pos.board[y]![x];
  hand=null;
  if(piece?.side===pos.turn){
    selected=[y,x];
    candidates=moves.filter(move=>move.from?.[0]===y&&move.from[1]===x);
  }else{
    selected=null;
    candidates=[];
  }
  play();
}
function maybeStartCpu(){
  if(activeMode!=='cpu'||pos.turn===humanSide||terminalState().ended||cpuThinking)return;
  if(cpuLevel==='title')return;
  cpuThinking=true;
  const requestId=crypto.randomUUID();
  const sourceKey=positionKey(pos);
  cpuRequestId=requestId;
  const worker=ensureCpuWorker();
  worker.onmessage=(event:MessageEvent<{requestId:string;positionKey:string;ok:boolean;result?:{move:Move|null};error?:string}>)=>{
    if(worker!==cpuWorker||event.data.requestId!==cpuRequestId)return;
    cpuThinking=false;
    cpuRequestId=null;
    if(terminalState().ended||!event.data.ok||!event.data.result?.move||event.data.positionKey!==sourceKey||positionKey(pos)!==sourceKey){play();return;}
    try{pos=applyMove(pos,event.data.result.move);}catch{play();return;}
    rememberOpponentMove(event.data.result.move);
    void audioController.playSe('move');
    resetInteraction();
    play();
  };
  worker.postMessage({type:'search',requestId,position:pos,level:cpuLevel,wasmUrl:cpuWasmUrl()});
  play();
}

async function start(){
  void audioController.initialize();
  const invite=new URL(location.href).searchParams.get('invite')?.trim();
  if(!invite){menu();return;}
  const api=onlineApi();
  if(!api){
    activeMode='online';
    app.innerHTML=`<main class="panel">${back()}<h2>オンライン対局</h2><p>Cloudflare接続先が未設定のため、招待された正式局面へ接続できません。</p></main>`;
    bindBack(menu);
    return;
  }
  activeMode='online';
  app.innerHTML=`<main class="panel">${back()}<h2>オンライン対局</h2><p>招待された部屋へ接続しています…</p></main>`;
  bindBack(menu);
  try{
    const room=await joinOnlineInvite(api,invite);
    connectOnlineRoom(api,room);
  }catch{
    app.innerHTML=`<main class="panel">${back()}<h2>オンライン対局</h2><p>招待URLから部屋へ接続できませんでした。</p></main>`;
    bindBack(menu);
  }
}

void start();
