import './style.css';
import { applyMove, gameOutcome, initialPosition, isCheck, legalMoves, positionKey } from './game/engine';
import type { CpuLevel, GameOutcome, Handicap, Mode, Move, PieceKind, Position, Side } from './game/types';
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

let pos:Position=initialPosition();
let selected:[number,number]|null=null;
let hand:PieceKind|null=null;
let candidates:Move[]=[];
let activeMode:Mode='local';
let cpuLevel:CpuLevel='beginner';
const humanSide:Side='sente';
let cpuThinking=false;
let cpuRequestId:string|null=null;
let cpuWorker:Worker|null=null;
let onlineConnection:OnlineMatchConnection|null=null;
let onlineUnsubscribe:(()=>void)|null=null;
let onlineRoom:OnlineRoomEntry|null=null;
let onlineState:AuthoritativeState|null=null;
let onlineSeat:Side|null=null;
let onlinePendingMove=false;
let onlineMessage='';

const app=document.querySelector<HTMLDivElement>('#app')!;

function resetInteraction(){selected=null;hand=null;candidates=[];}
function cancelCpu(){
  cpuRequestId=null;
  cpuThinking=false;
  cpuWorker?.terminate();
  cpuWorker=null;
}
function cancelOnline(){
  onlineUnsubscribe?.();
  onlineUnsubscribe=null;
  onlineConnection?.close();
  onlineConnection=null;
  onlineRoom=null;
  onlineState=null;
  onlineSeat=null;
  onlinePendingMove=false;
  onlineMessage='';
}
function clearInviteParameter(){
  const url=new URL(location.href);
  if(!url.searchParams.has('invite'))return;
  url.searchParams.delete('invite');
  history.replaceState(null,'',`${url.pathname}${url.search}${url.hash}`);
}
function menu(){
  cancelCpu();
  cancelOnline();
  resetInteraction();
  clearInviteParameter();
  app.innerHTML=`<main class="menu"><h1>将棋</h1><button id="start">スタート</button><button id="rules">ルール</button><button id="settings">設定</button></main>`;
  document.querySelector('#start')!.addEventListener('click',mode);
  document.querySelector('#rules')!.addEventListener('click',rules);
  document.querySelector('#settings')!.addEventListener('click',settings);
}
function back(){return `<button class="back" id="back">← 戻る</button>`;}
function bindBack(){document.querySelector('#back')?.addEventListener('click',menu);}
function mode(){
  cancelCpu();
  cancelOnline();
  app.innerHTML=`<main class="panel">${back()}<h2>ゲームモード</h2><button data-mode="cpu">CPU対局</button><button data-mode="local">ローカル2人対局</button><button data-mode="online">オンライン対局</button></main>`;
  bindBack();
  document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>settingsGame((button as HTMLElement).dataset.mode as Mode)));
}
function settingsGame(modeValue:Mode){
  cancelCpu();
  cancelOnline();
  app.innerHTML=`<main class="panel">${back()}<h2>ゲーム設定</h2>${modeValue==='cpu'?`<label>CPU難易度<select id="cpuLevel"><option value="beginner">初心者</option><option value="intermediate">中級者</option><option value="amateur">アマチュア</option><option value="pro">プロ</option><option value="title">タイトル級</option></select></label>`:''}<label>駒落ち<select id="handicap"><option value="even">平手</option><option value="rook">飛車落ち</option><option value="bishop">角落ち</option><option value="two">2枚落ち</option><option value="four">4枚落ち</option><option value="six">6枚落ち</option></select></label><button id="go">開始</button><p class="note">${modeValue==='online'?'オンライン対局はCloudflare側の正式状態管理へ接続して開始します。接続先未設定時は対局を開始しません。':''}</p></main>`;
  bindBack();
  document.querySelector('#go')!.addEventListener('click',()=>{
    const handicap=(document.querySelector('#handicap') as HTMLSelectElement).value as Handicap;
    if(modeValue==='online'){
      onlineEntry(handicap);
      return;
    }
    activeMode=modeValue;
    if(modeValue==='cpu')cpuLevel=(document.querySelector('#cpuLevel') as HTMLSelectElement).value as CpuLevel;
    pos=initialPosition(handicap);
    resetInteraction();
    play();
    maybeStartCpu();
  });
}
function rules(){
  cancelCpu();
  cancelOnline();
  app.innerHTML=`<main class="document">${back()}<h2>ルール</h2><p>9×9の盤で、相手の玉を詰ませることが目的です。取った駒は持ち駒として自分の手番に打てます。敵陣3段では対象駒を成ることができ、歩・香・桂には行き所がなくなる場合の強制成りがあります。</p><p>二歩、打ち歩詰め、行き所のない駒打ち、自玉を王手にさらす着手、王手放置はできません。合法手のみ盤面に反映されます。</p><p>同一局面が4回現れた場合は千日手です。連続王手による千日手は王手を続けた側の敗北として通常の千日手と分けて判定します。入玉・持将棋の具体方式は設計上未確定のため、方式確定までは自動終局させません。</p></main>`;
  bindBack();
}
function settings(){
  cancelCpu();
  cancelOnline();
  app.innerHTML=`<main class="panel">${back()}<h2>設定</h2><label>BGM <input type="checkbox" disabled> ON</label><label>音量 <input type="range" min="0" max="100" value="70"></label><label>SE <input type="checkbox" disabled> ON</label><label>音量 <input type="range" min="0" max="100" value="70"></label><button disabled>利用規約</button><button disabled>クレジット</button><button disabled>ライセンス</button><p class="note">本文・素材は設計上Cloudflare側から後付けする構造です。</p></main>`;
  bindBack();
}
function onlineApi():string|null{
  const value=(import.meta.env.VITE_SHOGI_API_URL as string|undefined)?.trim();
  return value||null;
}
function onlineEntry(handicap:Handicap){
  cancelCpu();
  cancelOnline();
  activeMode='online';
  app.innerHTML=`<main class="panel">${back()}<h2>オンライン対局</h2><button id="createRoom">部屋を作成</button><label>パスコード<input id="passcode" inputmode="text" autocomplete="off" maxlength="8"></label><button id="joinRoom">パスコードで接続</button><p class="note" id="onlineStatus">Cloudflare接続先を確認しています。</p></main>`;
  bindBack();
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
    void createOnlineRoom(api,handicap).then(room=>connectOnlineRoom(api,room)).catch(()=>{status.textContent='部屋作成に失敗しました。ローカル状態へフォールバックしません。';});
  });
  document.querySelector('#joinRoom')!.addEventListener('click',()=>{
    const passcode=(document.querySelector('#passcode') as HTMLInputElement).value.trim();
    if(!passcode){status.textContent='パスコードを入力してください。';return;}
    status.textContent='部屋へ接続しています…';
    void joinOnlineRoom(api,passcode).then(room=>connectOnlineRoom(api,room)).catch(()=>{status.textContent='接続に失敗しました。パスコードと接続状態を確認してください。';});
  });
}
function connectOnlineRoom(api:string,room:OnlineRoomEntry){
  cancelOnline();
  activeMode='online';
  onlineRoom=room;
  onlineSeat=room.seat;
  onlineMessage='正式局面を取得しています…';
  app.innerHTML=`<main class="panel">${back()}<h2>オンライン対局</h2><p>${escapeHtml(onlineMessage)}</p><p class="note">正式局面はCloudflare側から受信した後に表示します。</p></main>`;
  bindBack();
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
      onlineState=event.state;
      pos=event.state.position;
      onlinePendingMove=false;
      onlineMessage='';
      resetInteraction();
      play();
      return;
    }
    if(event.type==='rejected'){
      onlinePendingMove=false;
      onlineMessage=`着手は反映されませんでした（${event.code}）。正式局面を再取得します。`;
      if(onlineState)play();
      return;
    }
    if(event.type==='disconnected'){
      onlinePendingMove=false;
      onlineMessage='接続が切れました。切断を敗北として扱わず、同じ席で再接続できます。';
      if(onlineState)play();
      else renderOnlineConnectionFailure();
      return;
    }
    onlinePendingMove=false;
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
  bindBack();
  document.querySelector('#reconnect')?.addEventListener('click',()=>{
    onlineMessage='再接続しています…';
    try{onlineConnection?.connect();}catch{onlineMessage='再接続を開始できませんでした。';renderOnlineConnectionFailure();}
  });
}
function escapeHtml(value:string){return value.replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]!));}
function describeOutcome(outcome:GameOutcome):string{
  if(!outcome.ended)return'';
  if(outcome.reason==='mate')return`${sideName(outcome.winner)}の勝ち（詰み）`;
  if(outcome.reason==='perpetual-check')return`${sideName(outcome.winner)}の勝ち（連続王手の千日手）`;
  if(outcome.reason==='repetition')return'千日手・指し直し対象';
  return'終局';
}
function describeOnlineResult(state:AuthoritativeState):string{
  if(state.status!=='ended')return'';
  if(state.resultReason==='repetition')return'千日手・指し直し対象';
  if(state.winner&&state.resultReason==='mate')return`${sideName(state.winner)}の勝ち（詰み）`;
  if(state.winner&&state.resultReason==='perpetual-check')return`${sideName(state.winner)}の勝ち（連続王手の千日手）`;
  return state.winner?`${sideName(state.winner)}の勝ち`:'終局';
}
function play(){
  const moves=legalMoves(pos);
  const localOutcome=gameOutcome(pos);
  const onlineEnded=activeMode==='online'&&onlineState?.status==='ended';
  const ended=activeMode==='online'?!!onlineEnded:localOutcome.ended;
  const onlineCanOperate=activeMode==='online'&&onlineState?.status==='playing'&&onlineSeat===pos.turn&&!onlinePendingMove;
  const humanCanOperate=!ended&&!cpuThinking&&(activeMode==='cpu'?pos.turn===humanSide:activeMode==='online'?onlineCanOperate:true);
  const result=activeMode==='online'&&onlineState?describeOnlineResult(onlineState):describeOutcome(localOutcome);
  let status:string;
  if(ended)status=result;
  else if(cpuThinking)status='CPU思考中…';
  else if(activeMode==='online'&&onlineState?.status==='waiting')status='対戦相手を待っています';
  else if(activeMode==='online'&&onlinePendingMove)status='着手を確認中…';
  else status=`${sideName(pos.turn)}番${isCheck(pos,pos.turn)?'・王手':''}`;
  const onlineInfo=activeMode==='online'&&onlineRoom&&onlineState
    ?`<aside class="online-info"><div>あなた: ${onlineSeat?sideName(onlineSeat):'確認中'}</div><div>接続: 先手 ${onlineState.connections.sente} / 後手 ${onlineState.connections.gote}</div><label>招待URL<input readonly value="${escapeHtml(onlineRoom.inviteUrl)}"></label><label>パスコード<input readonly value="${escapeHtml(onlineRoom.passcode)}"></label>${onlineMessage?`<p class="note">${escapeHtml(onlineMessage)}</p>`:''}${onlineMessage?'<button id="reconnect">再接続</button>':''}</aside>`:'';
  app.innerHTML=`<main class="game"><header>${back()}<strong>${status}</strong></header>${onlineInfo}<section class="hand" id="goteHand"></section><div class="board" id="board" aria-busy="${cpuThinking||onlinePendingMove?'true':'false'}"></div><section class="hand" id="senteHand"></section>${ended?`<div class="result">${escapeHtml(result)}</div>`:''}${activeMode==='cpu'?`<div class="note cpu-level">CPU: ${cpuLabels[cpuLevel]}</div>`:''}</main>`;
  bindBack();
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
    if(piece){cell.textContent=names[piece.kind]??piece.kind;if(piece.side==='gote')cell.classList.add('gote');}
    cell.addEventListener('click',()=>clickSquare(y,x,moves));
    board.append(cell);
  }
  renderHand('gote','goteHand',moves,humanCanOperate);
  renderHand('sente','senteHand',moves,humanCanOperate);
}
function renderHand(side:Side,id:string,moves:Move[],humanCanOperate:boolean){
  const element=document.querySelector(`#${id}`)!;
  element.innerHTML=`<span>${sideName(side)} 持ち駒</span>`;
  for(const [kind,count] of Object.entries(pos.hands[side]))if(count>0){
    const button=document.createElement('button');
    button.textContent=`${names[kind]??kind}×${count}`;
    button.disabled=!humanCanOperate||side!==pos.turn;
    button.addEventListener('click',()=>{selected=null;hand=kind as PieceKind;candidates=moves.filter(move=>move.drop===kind);play();});
    element.append(button);
  }
}
function clickSquare(y:number,x:number,moves:Move[]){
  const ended=activeMode==='online'?onlineState?.status==='ended':gameOutcome(pos).ended;
  if(cpuThinking||ended||(activeMode==='cpu'&&pos.turn!==humanSide))return;
  if(activeMode==='online'&&(!onlineState||onlineState.status!=='playing'||onlineSeat!==pos.turn||onlinePendingMove))return;
  const hit=candidates.filter(move=>move.to[0]===y&&move.to[1]===x);
  if(hit.length){
    let move=hit[0]!;
    if(hit.length===2&&hit.some(candidate=>candidate.promote)&&confirm('成りますか？'))move=hit.find(candidate=>candidate.promote)!;
    if(activeMode==='online'){
      try{
        onlineConnection?.sendMove(move);
        onlinePendingMove=true;
        onlineMessage='';
      }catch{onlineMessage='着手を送信できませんでした。正式局面は変更していません。';}
      resetInteraction();
      play();
      return;
    }
    pos=applyMove(pos,move);
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
  if(activeMode!=='cpu'||pos.turn===humanSide||gameOutcome(pos).ended||cpuThinking)return;
  cancelCpu();
  cpuThinking=true;
  const requestId=crypto.randomUUID();
  const sourceKey=positionKey(pos);
  const wasmUrl=new URL('wasm/shogi_engine.wasm',document.baseURI).toString();
  cpuRequestId=requestId;
  cpuWorker=new Worker(new URL('./game/cpu-worker.ts',import.meta.url),{type:'module'});
  cpuWorker.onmessage=(event:MessageEvent<{requestId:string;positionKey:string;ok:boolean;result?:{move:Move|null};error?:string}>)=>{
    if(event.data.requestId!==cpuRequestId)return;
    const worker=cpuWorker;
    cpuWorker=null;
    worker?.terminate();
    cpuThinking=false;
    cpuRequestId=null;
    if(!event.data.ok||!event.data.result?.move||event.data.positionKey!==sourceKey||positionKey(pos)!==sourceKey){play();return;}
    try{pos=applyMove(pos,event.data.result.move);}catch{play();return;}
    resetInteraction();
    play();
  };
  cpuWorker.onerror=()=>{cancelCpu();play();};
  cpuWorker.postMessage({requestId,position:pos,level:cpuLevel,wasmUrl});
  play();
}

async function start(){
  const invite=new URL(location.href).searchParams.get('invite')?.trim();
  if(!invite){menu();return;}
  const api=onlineApi();
  if(!api){
    activeMode='online';
    app.innerHTML=`<main class="panel">${back()}<h2>オンライン対局</h2><p>Cloudflare接続先が未設定のため、招待された正式局面へ接続できません。</p></main>`;
    bindBack();
    return;
  }
  activeMode='online';
  app.innerHTML=`<main class="panel">${back()}<h2>オンライン対局</h2><p>招待された部屋へ接続しています…</p></main>`;
  bindBack();
  try{
    const room=await joinOnlineInvite(api,invite);
    connectOnlineRoom(api,room);
  }catch{
    app.innerHTML=`<main class="panel">${back()}<h2>オンライン対局</h2><p>招待URLから部屋へ接続できませんでした。</p></main>`;
    bindBack();
  }
}

void start();
