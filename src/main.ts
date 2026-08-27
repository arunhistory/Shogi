import './style.css';
import { fetchCloudContent } from './content/client';
import type { CloudContentKey } from './content/client';
import { applyMove, gameOutcome, initialPosition, isCheck, legalMoves, positionKey } from './game/engine';
import type { CpuLevel, GameOutcome, Handicap, Mode, Move, PieceKind, Position, Side } from './game/types';
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
  app.innerHTML=`<main class="document rules-document">${back()}<h2>ルール</h2>
    <section><h3>目的と盤</h3><p>将棋は9×9の盤を使い、交互に1手ずつ指します。通常対局では先手から開始し、相手の玉を詰ませることが目的です。王手そのものでは終局せず、王手を受ける合法手が一つもない「詰み」で勝敗が確定します。玉を実際に取って盤から除く着手は行いません。</p></section>
    <section><h3>駒の種類と動き</h3><dl class="piece-rules"><dt>玉</dt><dd>縦・横・斜めの隣接1マス。王手されるマスには移動できません。</dd><dt>飛車</dt><dd>縦・横に何マスでも進めます。途中の駒は飛び越せません。</dd><dt>角</dt><dd>斜めに何マスでも進めます。途中の駒は飛び越せません。</dd><dt>金</dt><dd>前・左右・後ろ・前斜めの計6方向へ1マス。後ろ斜めには進めません。</dd><dt>銀</dt><dd>前1マスと、前後の斜め4方向へ1マス。</dd><dt>桂馬</dt><dd>前方へ2、左右へ1ずれた2地点へ跳びます。途中の駒を飛び越せます。</dd><dt>香車</dt><dd>前方へ何マスでも進めます。途中の駒は飛び越せません。</dd><dt>歩</dt><dd>前方へ1マス。</dd><dt>龍（成飛車）</dt><dd>飛車の動きに加え、斜め隣接1マスへ進めます。</dd><dt>馬（成角）</dt><dd>角の動きに加え、縦・横の隣接1マスへ進めます。</dd><dt>成銀・成桂・成香・と金</dt><dd>金と同じ動きになります。</dd></dl></section>
    <section><h3>駒を取る・持ち駒・駒打ち</h3><p>移動先に相手の駒があればその駒を取り、自分の持ち駒にします。成駒を取った場合は成る前の駒に戻ります。持ち駒は自分の手番に空きマスへ打つことができ、打った手で手番を終えます。</p></section>
    <section><h3>成り・不成・強制成り</h3><p>飛車、角、銀、桂、香、歩は、移動元または移動先が相手側の3段に含まれる着手で成ることを選べます。成れる場面でも、合法であれば不成を選べます。ただし、そのままでは次の手以降に一度も動けなくなる歩・香の最終段への移動、桂の最終2段への移動は必ず成ります。</p></section>
    <section><h3>王手・詰み</h3><p>相手玉を次の手で取れる状態を王手と呼びます。王手された側は、玉を逃がす、王手している駒を取る、合駒をする等により必ず王手を解消しなければなりません。自玉を王手されたままにする着手、自ら王手される状態へ入る着手は不合法です。手番側が王手され、王手を解消する合法手が一つもなければ詰みとなり、その側の敗北です。</p></section>
    <section><h3>主な禁じ手</h3><ul><li><strong>二歩:</strong> 同じ筋に自分の成っていない歩が既にある場合、その筋へ新たな歩を打てません。</li><li><strong>打ち歩詰め:</strong> 持ち駒の歩を打つ1手だけで相手玉を直ちに詰ませる着手はできません。</li><li><strong>行き所のない駒:</strong> 歩・香を最終段へ、桂を最終2段へ持ち駒から打つことはできません。</li><li><strong>王手放置・自玉を王手にさらす手:</strong> 着手後に自玉が王手されている状態になる手はできません。</li></ul><p>不合法な入力は盤面・持ち駒・手番・履歴へ一切反映せず、合法手だけを正式な着手として確定します。</p></section>
    <section><h3>投了</h3><p>投了が正式に受理された場合は、投了した側の敗北として終局します。投了ボタン等の具体的なUIは現在の確定仕様に含まれていないため、本アプリでは未確定のまま保持します。</p></section>
    <section><h3>千日手</h3><p>盤面、両者の持ち駒、手番がすべて同一の局面が4回現れた場合は千日手として通常の着手を終了し、指し直し対象として扱います。これは単なる手順の繰り返しではなく、同一局面の成立回数で判定します。</p></section>
    <section><h3>連続王手の千日手</h3><p>千日手となる反復区間で一方が連続して毎回王手をかけ続けていた場合は通常の千日手と分け、王手を続けた側の敗北とします。</p></section>
    <section><h3>入玉・持将棋</h3><p>玉が相手陣へ入っただけでは自動終局しません。入玉・持将棋は別途確定する判定方式・条件に従って処理する仕様ですが、その具体方式は現在未確定です。このため、未確定方式を本アプリ独自に作って自動終局させません。</p></section>
    <section><h3>駒落ち</h3><p>平手のほか、飛車落ち、角落ち、2枚落ち、4枚落ち、6枚落ちを選べます。駒落ちでは上手（後手側）から指定駒を開始前に除き、上手から指し始めます。飛車落ちは飛車、角落ちは角、2枚落ちは飛車・角、4枚落ちは飛車・角・左右の香、6枚落ちはさらに左右の桂を除きます。</p></section>
    <section><h3>全モード共通</h3><p>CPU対局、ローカル2人対局、オンライン対局で将棋ルールを変えません。オンラインではCloudflare側の正式局面が基準となり、クライアントが送った着手申告だけで盤面は変化しません。ブラウザ終了や通信切断だけを投了・詰み・敗北として扱いません。</p></section>
  </main>`;
  bindBack();
}
function settings(){
  cancelCpu();
  cancelOnline();
  const prefs=audioController.getPreferences();
  app.innerHTML=`<main class="panel settings-panel">${back()}<h2>設定</h2><label class="setting-row"><span>BGM</span><input id="bgmEnabled" type="checkbox" ${prefs.bgmEnabled?'checked':''}></label><label class="setting-row"><span>BGM音量</span><input id="bgmVolume" type="range" min="0" max="100" value="${Math.round(prefs.bgmVolume*100)}"></label><label class="setting-row"><span>SE</span><input id="seEnabled" type="checkbox" ${prefs.seEnabled?'checked':''}></label><label class="setting-row"><span>SE音量</span><input id="seVolume" type="range" min="0" max="100" value="${Math.round(prefs.seVolume*100)}"></label><button data-content="terms">利用規約</button><button data-content="credits">クレジット</button><button data-content="licenses">ライセンス</button><p class="note">BGM・SE素材は外部manifestから読み込みます。素材が未登録でもゲームはそのまま動作します。</p></main>`;
  bindBack();
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
  cancelCpu();
  cancelOnline();
  app.innerHTML=`<main class="document">${back()}<h2>${escapeHtml(title)}</h2><p id="documentState">読み込み中…</p></main>`;
  bindBack();
  const state=document.querySelector('#documentState')!;
  const api=onlineApi();
  if(!api){state.textContent='Cloudflare接続先が未設定のため、本文を取得できません。';return;}
  try{
    const documentValue=await fetchCloudContent(api,key);
    if(!documentValue.available){state.textContent='現在、本文は未登録です。';return;}
    state.replaceWith(renderCloudBody(documentValue.body));
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
      const previousPly=onlineState?.position.ply??event.state.position.ply;
      onlineState=event.state;
      pos=event.state.position;
      onlinePendingMove=false;
      onlineMessage='';
      resetInteraction();
      if(event.state.position.ply>previousPly)void audioController.playSe('move');
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
    void audioController.playSe('move');
    resetInteraction();
    play();
  };
  cpuWorker.onerror=()=>{cancelCpu();play();};
  cpuWorker.postMessage({requestId,position:pos,level:cpuLevel,wasmUrl});
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
