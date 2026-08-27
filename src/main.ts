import './style.css';
import { applyMove, dangerousSquaresFor, gameResult, initialPosition, isCheck, legalMoves } from './game/engine';
import { CpuController } from './game/cpu';
import type { CpuLevel, GameResult, Handicap, Mode, Move, PieceKind, Position, Side } from './game/types';
import { AssetManager } from './services/assets';
import { loadSettings, saveSettings, type AppSettings } from './services/settings';
import {
  connectRoomSocket, createRoom, fetchManagedDocument, joinByInvite, joinByPasscode,
  loadRoomCredentials, roomState, submitOnlineMove, systemConfigured,
  type CreatedRoom, type RoomCredentials,
} from './services/system';

const app=document.querySelector<HTMLDivElement>('#app')!;
const cpu=new CpuController();
const assets=new AssetManager();
let settings:AppSettings=loadSettings();
let closeOnlineSocket:(()=>void)|null=null;
let generation=0;

const pieceName:Record<string,string>={king:'玉',rook:'飛',bishop:'角',gold:'金',silver:'銀',knight:'桂',lance:'香',pawn:'歩',dragon:'龍',horse:'馬',promotedSilver:'全',promotedKnight:'圭',promotedLance:'杏',tokin:'と'};
const levelName:Record<CpuLevel,string>={beginner:'初心者',intermediate:'中級者',amateur:'アマチュア',pro:'プロ',title:'タイトル級'};
const sideName=(s:Side)=>s==='sente'?'先手':'後手';
const esc=(value:string)=>value.replace(/[&<>\"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[ch]!));

interface Session{
  mode:Mode; handicap:Handicap; cpuLevel:CpuLevel; position:Position;
  selected:[number,number]|null; hand:PieceKind|null; candidates:Move[];
  cpuThinking:boolean; cpuInfo:string; onlineBusy:boolean; onlineAuth:RoomCredentials|null; onlineRevision:number;
}
let session:Session|null=null;

function stopTransient(){generation++;cpu.cancelAll();closeOnlineSocket?.();closeOnlineSocket=null;}
function buttonBack(handler:()=>void){document.querySelector('#back')?.addEventListener('click',handler);}
function setView(html:string){app.innerHTML=html;window.scrollTo({top:0,behavior:'instant'});}

function menu(){
  stopTransient();session=null;
  setView(`<main class="menu shell"><div class="crest" aria-hidden="true">王</div><h1>将棋</h1><p class="subtitle">SHOGI</p><div class="menu-actions"><button id="start" class="primary">スタート</button><button id="rules">ルール</button><button id="settings">設定</button></div></main>`);
  document.querySelector('#start')!.addEventListener('click',modeSelect);
  document.querySelector('#rules')!.addEventListener('click',rulesScreen);
  document.querySelector('#settings')!.addEventListener('click',settingsScreen);
}

function modeSelect(){
  stopTransient();
  setView(`<main class="panel shell"><button class="back" id="back">← 戻る</button><p class="eyebrow">START</p><h2>ゲームモード</h2><div class="choice-grid"><button data-mode="cpu"><strong>CPU対局</strong><span>人間 対 CPU</span></button><button data-mode="local"><strong>ローカル2人対局</strong><span>同じ端末で対局</span></button><button data-mode="online"><strong>オンライン対局</strong><span>別の端末と接続</span></button></div></main>`);
  buttonBack(menu);
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b=>b.addEventListener('click',()=>gameSettings(b.dataset.mode as Mode)));
}

function handicapOptions(){return `<option value="even">平手</option><option value="rook">飛車落ち</option><option value="bishop">角落ち</option><option value="two">2枚落ち</option><option value="four">4枚落ち</option><option value="six">6枚落ち</option>`;}
function gameSettings(mode:Mode){
  if(mode==='online'){onlineSettings();return;}
  setView(`<main class="panel shell"><button class="back" id="back">← 戻る</button><p class="eyebrow">GAME SETTING</p><h2>${mode==='cpu'?'CPU対局':'ローカル2人対局'}</h2>${mode==='cpu'?`<label class="field">CPU難易度<select id="cpuLevel"><option value="beginner">初心者</option><option value="intermediate">中級者</option><option value="amateur">アマチュア</option><option value="pro">プロ</option><option value="title">タイトル級</option></select></label>`:''}<label class="field">駒落ち<select id="handicap">${handicapOptions()}</select></label><p class="hint">駒落ちは上手（後手側）が指定の駒を外し、上手から指します。</p><button id="go" class="primary">開始</button></main>`);
  buttonBack(modeSelect);
  document.querySelector('#go')!.addEventListener('click',()=>{
    const handicap=(document.querySelector('#handicap') as HTMLSelectElement).value as Handicap;
    const cpuLevel=(document.querySelector('#cpuLevel') as HTMLSelectElement|null)?.value as CpuLevel|undefined;
    startLocalGame(mode,handicap,cpuLevel??'beginner');
  });
}

function onlineSettings(){
  setView(`<main class="panel shell"><button class="back" id="back">← 戻る</button><p class="eyebrow">ONLINE</p><h2>オンライン対局</h2><div class="segmented"><button id="createTab" class="active">部屋を作る</button><button id="joinTab">パスコードで参加</button></div><div id="onlineForm"></div><p class="hint">招待URLを開いた場合は、部屋番号等を追加で入力せず該当部屋へ自動接続します。</p></main>`);
  buttonBack(modeSelect);
  const renderCreate=()=>{document.querySelector('#createTab')?.classList.add('active');document.querySelector('#joinTab')?.classList.remove('active');const form=document.querySelector('#onlineForm')!;form.innerHTML=`<label class="field">駒落ち<select id="onlineHandicap">${handicapOptions()}</select></label><button id="onlineCreate" class="primary">開始</button><p class="connection-note">${systemConfigured()?'Cloudflareシステムへ接続します。':'Cloudflareシステム接続先は未設定です。'}</p>`;document.querySelector('#onlineCreate')!.addEventListener('click',()=>void createOnlineRoom());};
  const renderJoin=()=>{document.querySelector('#joinTab')?.classList.add('active');document.querySelector('#createTab')?.classList.remove('active');const form=document.querySelector('#onlineForm')!;form.innerHTML=`<label class="field">パスコード<input id="passcode" autocomplete="off" maxlength="32" inputmode="text" placeholder="パスコード"></label><button id="onlineJoin" class="primary">開始</button><p class="connection-note">パスコードから部屋を自動検索し、部屋一覧は表示しません。</p>`;document.querySelector('#onlineJoin')!.addEventListener('click',()=>void joinOnlinePasscode());};
  document.querySelector('#createTab')!.addEventListener('click',renderCreate);document.querySelector('#joinTab')!.addEventListener('click',renderJoin);renderCreate();
}

async function createOnlineRoom(){
  const handicap=(document.querySelector('#onlineHandicap') as HTMLSelectElement).value as Handicap;
  showBusy('部屋を作成しています…');
  try{const room=await createRoom(handicap);showCreatedRoom(room);}catch(error){showOnlineError(error,()=>onlineSettings());}
}
function showCreatedRoom(room:CreatedRoom){
  setView(`<main class="panel shell"><button class="back" id="back">← 戻る</button><p class="eyebrow">ROOM READY</p><h2>対局相手を招待</h2><label class="field">招待URL<div class="copy-row"><input id="inviteUrl" readonly value="${esc(room.inviteUrl)}"><button id="copyInvite">コピー</button></div></label><label class="field">パスコード<div class="passcode">${esc(room.passcode)}</div></label><p class="hint">相手は招待URLを開くだけで自動接続できます。パスコード方式でも部屋一覧の選択はありません。</p><button id="enterRoom" class="primary">対局画面へ</button></main>`);
  buttonBack(modeSelect);document.querySelector('#copyInvite')!.addEventListener('click',()=>void navigator.clipboard.writeText(room.inviteUrl));document.querySelector('#enterRoom')!.addEventListener('click',()=>void enterOnlineRoom(room));
}
async function joinOnlinePasscode(){const input=document.querySelector<HTMLInputElement>('#passcode')!;const passcode=input.value.trim();if(!passcode){input.focus();return;}showBusy('部屋へ接続しています…');try{await enterOnlineRoom(await joinByPasscode(passcode));}catch(error){showOnlineError(error,onlineSettings);}}
async function joinOnlineInvite(token:string){showBusy('招待された対局へ接続しています…');try{const auth=await joinByInvite(token);history.replaceState(null,'',`${location.pathname}?room=${encodeURIComponent(auth.roomId)}`);await enterOnlineRoom(auth);}catch(error){showOnlineError(error,menu);}}
async function reconnectOnline(roomId:string){const auth=loadRoomCredentials(roomId);if(!auth){menu();return;}showBusy('対局へ再接続しています…');try{await enterOnlineRoom(auth);}catch(error){showOnlineError(error,menu);}}
function showBusy(message:string){setView(`<main class="panel shell status-screen"><div class="spinner" aria-hidden="true"></div><h2>${esc(message)}</h2></main>`);}
function showOnlineError(error:unknown,back:()=>void){const code=error instanceof Error?error.message:'ONLINE_ERROR';setView(`<main class="panel shell"><h2>接続できませんでした</h2><p class="error-code">${esc(code)}</p><button id="back" class="primary">戻る</button></main>`);buttonBack(back);}

async function enterOnlineRoom(auth:RoomCredentials){
  stopTransient();const snapshot=await roomState(auth);
  session={mode:'online',handicap:'even',cpuLevel:'beginner',position:snapshot.position,selected:null,hand:null,candidates:[],cpuThinking:false,cpuInfo:'',onlineBusy:false,onlineAuth:auth,onlineRevision:snapshot.revision};
  history.replaceState(null,'',`${location.pathname}?room=${encodeURIComponent(auth.roomId)}`);
  openOnlineStream(auth);renderGame(snapshot.state==='waiting'?'相手の接続を待っています':'');
}
function openOnlineStream(auth:RoomCredentials){closeOnlineSocket?.();try{closeOnlineSocket=connectRoomSocket(auth,snapshot=>{if(!session||session.mode!=='online'||snapshot.roomId!==auth.roomId)return;if(snapshot.revision<session.onlineRevision)return;session.position=snapshot.position;session.onlineRevision=snapshot.revision;session.onlineBusy=false;clearSelection();renderGame(snapshot.state==='waiting'?'相手の接続を待っています':'');},()=>{if(session?.mode==='online')renderGame('通信が切断されました。再接続できます。',true);});}catch{closeOnlineSocket=null;}}

function startLocalGame(mode:'cpu'|'local',handicap:Handicap,cpuLevel:CpuLevel){
  stopTransient();session={mode,handicap,cpuLevel,position:initialPosition(handicap),selected:null,hand:null,candidates:[],cpuThinking:false,cpuInfo:'',onlineBusy:false,onlineAuth:null,onlineRevision:0};assets.playBgm('game',settings);renderGame();scheduleCpuIfNeeded();
}
function clearSelection(){if(!session)return;session.selected=null;session.hand=null;session.candidates=[];}
function canHumanAct():boolean{if(!session)return false;const result=gameResult(session.position);if(result.status==='finished'||session.cpuThinking||session.onlineBusy)return false;if(session.mode==='cpu')return session.position.turn==='sente';if(session.mode==='online')return session.onlineAuth?.side===session.position.turn;return true;}

function resultText(result:GameResult):string{
  if(result.status==='ongoing')return '';
  if(result.reason==='checkmate')return `${sideName(result.winner!)}の勝ち — 詰み`;
  if(result.reason==='perpetual_check')return `${sideName(result.loser!)}の反則負け — 連続王手の千日手`;
  return '千日手 — 勝敗を付けず、この一局を終了';
}

function renderGame(message='',disconnected=false){
  if(!session)return;const pos=session.position;const result=gameResult(pos);const moves=result.status==='ongoing'?legalMoves(pos):[];
  const selectedPiece=session.selected?pos.board[session.selected[0]]![session.selected[1]]:null;
  const danger=selectedPiece?.kind==='king'?dangerousSquaresFor(pos,pos.turn):new Set<string>();
  const status=result.status==='finished'?resultText(result):session.cpuThinking?`CPU思考中 — ${levelName[session.cpuLevel]}`:message||`${sideName(pos.turn)}番${isCheck(pos,pos.turn)?'・王手':''}`;
  setView(`<main class="game-shell"><header class="game-header"><button id="back" class="back">← メニュー</button><div class="turn-status ${isCheck(pos,pos.turn)&&result.status==='ongoing'?'check':''}">${esc(status)}</div>${session.cpuInfo?`<div class="cpu-info">${esc(session.cpuInfo)}</div>`:''}</header><section class="hand top" id="goteHand"></section><div class="board-wrap"><div class="board" id="board" role="grid" aria-label="将棋盤"></div></div><section class="hand bottom" id="senteHand"></section>${result.status==='finished'?`<div class="result-banner">${esc(resultText(result))}</div>`:''}${disconnected?`<div class="connection-banner"><span>正式な対局状態はCloudflare側に保持されています。</span><button id="reconnect">再接続</button></div>`:''}</main>`);
  document.querySelector('#back')!.addEventListener('click',menu);
  const board=document.querySelector('#board')!;
  for(let y=0;y<9;y++)for(let x=0;x<9;x++){
    const q=pos.board[y]![x];const cell=document.createElement('button');cell.className='cell';cell.setAttribute('role','gridcell');cell.dataset.square=`${y},${x}`;
    if(session.selected?.[0]===y&&session.selected[1]===x)cell.classList.add('selected');
    if(session.candidates.some(m=>m.to[0]===y&&m.to[1]===x))cell.classList.add('legal');
    if(danger.has(`${y},${x}`))cell.classList.add('danger');
    if(q){const label=pieceName[q.kind]??q.kind;cell.textContent=label;cell.classList.add(q.side);cell.setAttribute('aria-label',`${sideName(q.side)} ${label}`);}else cell.setAttribute('aria-label','空きマス');
    cell.disabled=!canHumanAct();cell.addEventListener('click',()=>void clickSquare(y,x,moves));board.append(cell);
  }
  renderHand('gote','goteHand',moves);renderHand('sente','senteHand',moves);
  document.querySelector('#reconnect')?.addEventListener('click',()=>{if(session?.onlineAuth)void enterOnlineRoom(session.onlineAuth);});
}

function renderHand(side:Side,id:string,moves:Move[]){if(!session)return;const el=document.querySelector(`#${id}`)!;const title=document.createElement('span');title.className='hand-label';title.textContent=`${sideName(side)} 持ち駒`;el.append(title);let any=false;for(const [kind,n] of Object.entries(session.position.hands[side]))if(n>0){any=true;const b=document.createElement('button');b.className='hand-piece';b.textContent=`${pieceName[kind]} ×${n}`;b.disabled=!canHumanAct()||side!==session.position.turn;b.addEventListener('click',()=>{if(!session)return;session.selected=null;session.hand=kind as PieceKind;session.candidates=moves.filter(m=>m.drop===kind);assets.playSe('select',settings);renderGame();});el.append(b);}if(!any){const empty=document.createElement('span');empty.className='empty-hand';empty.textContent='なし';el.append(empty);}}

async function clickSquare(y:number,x:number,moves:Move[]){
  if(!session||!canHumanAct())return;
  const hits=session.candidates.filter(m=>m.to[0]===y&&m.to[1]===x);
  if(hits.length){let move:Move|null=hits[0]!;if(hits.length>1&&hits.some(m=>m.promote))move=await choosePromotion(hits);if(move)await commitHumanMove(move);return;}
  const q=session.position.board[y]![x];session.hand=null;
  if(q?.side===session.position.turn){session.selected=[y,x];session.candidates=moves.filter(m=>m.from?.[0]===y&&m.from[1]===x);assets.playSe('select',settings);}else clearSelection();
  renderGame();
}

function choosePromotion(moves:Move[]):Promise<Move|null>{return new Promise(resolve=>{const promote=moves.find(m=>m.promote);const plain=moves.find(m=>!m.promote);if(!promote||!plain){resolve(moves[0]??null);return;}const overlay=document.createElement('div');overlay.className='modal-overlay';overlay.innerHTML=`<div class="modal"><h3>成りますか？</h3><div class="modal-actions"><button id="promoteYes" class="primary">成る</button><button id="promoteNo">成らない</button></div></div>`;document.body.append(overlay);overlay.querySelector('#promoteYes')!.addEventListener('click',()=>{overlay.remove();resolve(promote);});overlay.querySelector('#promoteNo')!.addEventListener('click',()=>{overlay.remove();resolve(plain);});});}

async function commitHumanMove(move:Move){
  if(!session)return;
  if(session.mode==='online'){
    const auth=session.onlineAuth;if(!auth)return;session.onlineBusy=true;clearSelection();renderGame('着手を確認しています…');
    try{const snapshot=await submitOnlineMove(auth,move,session.onlineRevision);session.position=snapshot.position;session.onlineRevision=snapshot.revision;session.onlineBusy=false;assets.playSe('move',settings);renderGame();}
    catch{try{const snapshot=await roomState(auth);session.position=snapshot.position;session.onlineRevision=snapshot.revision;}finally{session.onlineBusy=false;clearSelection();renderGame('正式な状態へ再同期しました。');}}
    return;
  }
  session.position=applyMove(session.position,move);clearSelection();assets.playSe('move',settings);renderGame();scheduleCpuIfNeeded();
}

function scheduleCpuIfNeeded(){
  if(!session||session.mode!=='cpu'||session.position.turn!=='gote'||gameResult(session.position).status==='finished')return;
  const myGeneration=++generation;session.cpuThinking=true;session.cpuInfo='';renderGame();const snapshot=session.position;const level=session.cpuLevel;
  void cpu.think(snapshot,level).then(result=>{if(!session||session.mode!=='cpu'||generation!==myGeneration)return;session.cpuThinking=false;if(result.move){session.position=applyMove(session.position,result.move);session.cpuInfo=`CPU: ${result.engine==='wasm'?'C++ / WebAssembly':'安全フォールバック'}・${result.nodes.toLocaleString()} nodes`;assets.playSe('move',settings);}renderGame();}).catch(()=>{if(session&&generation===myGeneration){session.cpuThinking=false;session.cpuInfo='CPU探索を中断しました。';renderGame();}});
}

function rulesScreen(){
  stopTransient();
  setView(`<main class="document shell"><button class="back" id="back">← 戻る</button><p class="eyebrow">RULES</p><h2>将棋のルール</h2>
  <section><h3>目的と初期配置</h3><p>9×9の盤を使い、相手の王将・玉将を詰ませることが目的です。平手では先手から交互に1手ずつ指します。王・玉、飛、角、金、銀、桂、香、歩を所定の初期配置に並べます。</p></section>
  <section><h3>駒の動き</h3><dl><dt>王将・玉将</dt><dd>周囲8方向へ1マス。</dd><dt>飛車</dt><dd>縦横へ何マスでも。成ると龍王となり、斜め1マスも動けます。</dd><dt>角行</dt><dd>斜めへ何マスでも。成ると龍馬となり、縦横1マスも動けます。</dd><dt>金将</dt><dd>前3方向、横2方向、真後ろへ1マス。</dd><dt>銀将</dt><dd>前3方向と斜め後ろ2方向へ1マス。</dd><dt>桂馬</dt><dd>前へ2マス・左右へ1マスの位置へ跳びます。</dd><dt>香車</dt><dd>前方へ何マスでも。</dd><dt>歩兵</dt><dd>前方へ1マス。</dd></dl></section>
  <section><h3>駒取り・持ち駒・駒打ち</h3><p>相手の駒があるマスへ合法的に移動すると、その駒を取ります。取った成駒は元の駒へ戻して持ち駒とし、自分の手番に空きマスへ打てます。王将・玉将は取って盤上から除くのではなく、詰みの成立時点で終局します。</p></section>
  <section><h3>成り・不成・強制成り</h3><p>飛・角・銀・桂・香・歩は、移動元または移動先が相手陣3段にある着手で成ることを選べます。成れる状況でも通常は不成を選べます。ただし、歩・香が最終段へ進む場合、桂が最終2段へ進む場合は次の合法手がなくなるため強制的に成ります。</p></section>
  <section><h3>王手・詰み・投了</h3><p>次に玉を取れる状態が王手です。王手を受けた側は必ず王手を解消する合法手を指します。王手がかかっており、それを解消する合法手が一つもない状態が詰みで、詰まされた側の敗北です。投了は対局者本人による投了が受理された場合に投了側の敗北となります。投了UIの具体仕様は未確定です。</p></section>
  <section><h3>主な非法手</h3><ul><li><strong>二歩：</strong>同じ筋に自分の成っていない歩がある状態で、さらに歩を打つことはできません。</li><li><strong>打ち歩詰め：</strong>歩を打ったその手で相手玉を詰ませることはできません。</li><li><strong>行き所のない駒：</strong>次に動けない位置へ歩・香・桂を不成のまま進めたり、その位置へ打ったりできません。</li><li><strong>王手放置：</strong>自玉への王手を解消しない手、自玉を新たに王手へさらす手は指せません。</li></ul></section>
  <section><h3>千日手</h3><p>盤上の配置、双方の持ち駒、手番がすべて同一の局面が4回現れ、連続王手の千日手に該当しない場合は勝敗を付けず、その一局を終了して指し直しの対象とします。指し直しは「再戦」とは別の扱いです。</p><p>千日手となる一連の手順で一方が毎回王手を続けていた場合は、通常の千日手ではなく<strong>連続王手の千日手</strong>とし、王手を続けた側の敗北です。</p></section>
  <section><h3>入玉・持将棋</h3><p>入玉したことだけでは自動的に終局しません。入玉・持将棋の採用方式と具体的な終局条件は設計上未確定のため、方式が確定するまでは勝敗を自動確定しません。</p></section>
  <section><h3>駒落ち</h3><table><thead><tr><th>方式</th><th>上手が外す駒</th></tr></thead><tbody><tr><td>平手</td><td>なし</td></tr><tr><td>飛車落ち</td><td>飛車</td></tr><tr><td>角落ち</td><td>角行</td></tr><tr><td>2枚落ち</td><td>飛車・角行</td></tr><tr><td>4枚落ち</td><td>飛車・角行・香車2枚</td></tr><tr><td>6枚落ち</td><td>4枚落ち＋桂馬2枚</td></tr></tbody></table><p>本アプリでは駒を落とす側を上手（内部の後手側）、相手を下手（内部の先手側）として扱い、駒落ちでは上手から指します。追加の駒落ち方式を後から追加できる構造とします。</p></section>
  <section><h3>終局にしない事象</h3><p>画面を閉じること、通信切断、アプリの処理失敗を、そのまま投了や詰みとは判定しません。時間切れを採用する場合は、今後確定する持ち時間・秒読み規定に従います。</p></section>
  </main>`);buttonBack(menu);
}

function settingsScreen(){
  stopTransient();
  setView(`<main class="panel shell"><button class="back" id="back">← 戻る</button><p class="eyebrow">SETTINGS</p><h2>設定</h2><div class="setting-row"><label><span>BGM</span><input id="bgmEnabled" type="checkbox" ${settings.bgm.enabled?'checked':''}></label><label class="volume">音量<input id="bgmVolume" type="range" min="0" max="100" value="${Math.round(settings.bgm.volume*100)}"></label></div><div class="setting-row"><label><span>SE</span><input id="seEnabled" type="checkbox" ${settings.se.enabled?'checked':''}></label><label class="volume">音量<input id="seVolume" type="range" min="0" max="100" value="${Math.round(settings.se.volume*100)}"></label></div><div class="document-buttons"><button data-document="terms">利用規約</button><button data-document="credits">クレジット</button><button data-document="licenses">ライセンス</button></div><p class="hint">BGM・SE・イラスト等は素材が存在しなくてもゲームが動作し、後から差し替え可能な構造です。利用規約・クレジット・ライセンス本文はCloudflare側の表示用情報のみ取得します。</p></main>`);
  buttonBack(menu);
  const sync=()=>{settings={bgm:{enabled:(document.querySelector('#bgmEnabled') as HTMLInputElement).checked,volume:Number((document.querySelector('#bgmVolume') as HTMLInputElement).value)/100},se:{enabled:(document.querySelector('#seEnabled') as HTMLInputElement).checked,volume:Number((document.querySelector('#seVolume') as HTMLInputElement).value)/100}};saveSettings(settings);assets.apply(settings);};
  ['bgmEnabled','bgmVolume','seEnabled','seVolume'].forEach(id=>document.querySelector(`#${id}`)!.addEventListener('input',sync));
  document.querySelectorAll<HTMLButtonElement>('[data-document]').forEach(b=>b.addEventListener('click',()=>void managedDocument(b.dataset.document as 'terms'|'credits'|'licenses')));
}

async function managedDocument(kind:'terms'|'credits'|'licenses'){
  const label={terms:'利用規約',credits:'クレジット',licenses:'ライセンス'}[kind];showBusy(`${label}を取得しています…`);
  try{const doc=await fetchManagedDocument(kind);setView(`<main class="document shell"><button class="back" id="back">← 設定</button><p class="eyebrow">${esc(label)}</p><h2>${esc(doc.title)}</h2><div class="managed-body">${esc(doc.body).replace(/\n/g,'<br>')}</div><p class="updated">更新: ${esc(doc.updatedAt)}</p></main>`);buttonBack(settingsScreen);}catch(error){const code=error instanceof Error?error.message:'DOCUMENT_ERROR';setView(`<main class="panel shell"><button class="back" id="back">← 設定</button><h2>${esc(label)}</h2><p>表示用情報を取得できませんでした。</p><p class="error-code">${esc(code)}</p></main>`);buttonBack(settingsScreen);}
}

async function boot(){await assets.load();const params=new URLSearchParams(location.search);const invite=params.get('invite');const room=params.get('room');if(invite){await joinOnlineInvite(invite);return;}if(room){await reconnectOnline(room);return;}menu();}
void boot();
