import {inferMove,latestOpponentMove,snapshotsEqual} from './move-history-core';
import type {BoardSnapshot,HistoryPiece,HistorySide,InferredMove} from './move-history-core';

interface MoveHistoryEntry extends InferredMove{
  number:number;
}

const app=document.querySelector<HTMLElement>('#app');
let scheduled=false;
let lastSnapshot:BoardSnapshot|null=null;
let history:MoveHistoryEntry[]=[];

function captureBoard(game:HTMLElement):BoardSnapshot|null{
  const cells=[...game.querySelectorAll<HTMLButtonElement>('.board .cell')];
  if(cells.length!==81)return null;
  return cells.map(cell=>{
    const label=(cell.textContent??'').trim();
    if(!label)return null;
    const piece:HistoryPiece={label,side:cell.classList.contains('gote')?'gote':'sente'};
    return piece;
  });
}

function sideLabel(side:MoveHistoryEntry['side']):string{return side==='sente'?'先手':'後手';}

function moveNotes(entry:InferredMove):string[]{
  const notes:string[]=[];
  if(entry.drop)notes.push('打');
  if(entry.captured)notes.push(`${entry.captured}を取る`);
  if(entry.promotedTo)notes.push(`成 → ${entry.promotedTo}`);
  return notes;
}

function closeHistory():void{
  document.querySelector('[data-move-history-overlay]')?.remove();
}

function closeOpponentAction():void{
  document.querySelector('[data-opponent-action-overlay]')?.remove();
}

function renderHistoryList():void{
  const list=document.querySelector<HTMLElement>('[data-move-history-list]');
  if(!list)return;
  list.replaceChildren();
  if(history.length===0){
    const empty=document.createElement('p');
    empty.className='move-history-empty';
    empty.textContent='まだ駒は動いていません。';
    list.append(empty);
    return;
  }
  for(const entry of history){
    const row=document.createElement('article');
    row.className='move-history-entry';

    const number=document.createElement('span');
    number.className='move-history-number';
    number.textContent=`#${String(entry.number).padStart(2,'0')}`;

    const side=document.createElement('span');
    side.className=`move-history-side ${entry.side}`;
    side.textContent=sideLabel(entry.side);

    const detail=document.createElement('div');
    detail.className='move-history-detail';
    const route=document.createElement('strong');
    route.textContent=`${entry.piece}　${entry.from??'持ち駒'} → ${entry.to}`;
    detail.append(route);

    const notes=moveNotes(entry);
    if(notes.length){
      const meta=document.createElement('span');
      meta.className='move-history-meta';
      meta.textContent=notes.join(' / ');
      detail.append(meta);
    }

    row.append(number,side,detail);
    list.append(row);
  }
  list.scrollTop=list.scrollHeight;
}

function openHistory():void{
  closeOpponentAction();
  const existing=document.querySelector<HTMLElement>('[data-move-history-overlay]');
  if(existing){renderHistoryList();return;}
  const overlay=document.createElement('div');
  overlay.className='move-history-overlay';
  overlay.dataset.moveHistoryOverlay='';
  overlay.innerHTML='<section class="move-history-dialog" role="dialog" aria-modal="true" aria-labelledby="moveHistoryTitle"><header><div><span>対局中記録</span><h2 id="moveHistoryTitle">履歴</h2></div><button type="button" class="move-history-close" aria-label="履歴を閉じる">×</button></header><div class="move-history-list" data-move-history-list></div></section>';
  document.body.append(overlay);
  overlay.addEventListener('click',event=>{if(event.target===overlay)closeHistory();});
  overlay.querySelector('.move-history-close')?.addEventListener('click',closeHistory);
  renderHistoryList();
  (overlay.querySelector('.move-history-close') as HTMLButtonElement|null)?.focus();
}

function viewerSide(game:HTMLElement):HistorySide|null{
  const cpuText=game.querySelector<HTMLElement>('.cpu-level')?.textContent??'';
  if(cpuText.includes('あなた: 先手'))return'sente';
  if(cpuText.includes('あなた: 後手'))return'gote';
  const onlineText=game.querySelector<HTMLElement>('.online-info')?.textContent??'';
  if(onlineText.includes('あなた: 先手'))return'sente';
  if(onlineText.includes('あなた: 後手'))return'gote';
  if(game.querySelector('.local-order')){
    const status=(game.querySelector<HTMLElement>('.match-header>strong')?.textContent??'').trim();
    if(status.startsWith('先手'))return'sente';
    if(status.startsWith('後手'))return'gote';
  }
  return null;
}

function openOpponentAction():void{
  closeHistory();
  closeOpponentAction();
  const game=app?.querySelector<HTMLElement>('.game')??null;
  if(!game)return;
  const entry=latestOpponentMove(history,viewerSide(game));
  const overlay=document.createElement('div');
  overlay.className='opponent-action-overlay';
  overlay.dataset.opponentActionOverlay='';
  const panel=document.createElement('section');
  panel.className='opponent-action-dialog';
  panel.setAttribute('role','dialog');
  panel.setAttribute('aria-modal','true');
  panel.setAttribute('aria-labelledby','opponentActionTitle');
  const header=document.createElement('header');
  header.innerHTML='<div><span>直前確認</span><h2 id="opponentActionTitle">相手行動</h2></div><button type="button" class="opponent-action-close" aria-label="相手行動を閉じる">×</button>';
  panel.append(header);
  const body=document.createElement('div');
  body.className='opponent-action-body';
  if(!entry){
    const empty=document.createElement('p');
    empty.className='opponent-action-empty';
    empty.textContent='まだ相手の着手はありません。';
    body.append(empty);
  }else{
    const badge=document.createElement('span');
    badge.className=`opponent-action-side ${entry.side}`;
    badge.textContent=sideLabel(entry.side);
    const piece=document.createElement('strong');
    piece.className='opponent-action-piece';
    piece.textContent=entry.piece;
    const route=document.createElement('div');
    route.className='opponent-action-route';
    route.textContent=`${entry.from??'持ち駒'} → ${entry.to}`;
    body.append(badge,piece,route);
    const notes=moveNotes(entry);
    if(notes.length){
      const meta=document.createElement('div');
      meta.className='opponent-action-meta';
      meta.textContent=notes.join(' / ');
      body.append(meta);
    }
  }
  panel.append(body);
  overlay.append(panel);
  document.body.append(overlay);
  overlay.addEventListener('click',event=>{if(event.target===overlay)closeOpponentAction();});
  overlay.querySelector('.opponent-action-close')?.addEventListener('click',closeOpponentAction);
  (overlay.querySelector('.opponent-action-close') as HTMLButtonElement|null)?.focus();
}

function ensureHistoryButtons(game:HTMLElement):void{
  const header=game.querySelector<HTMLElement>('header');
  if(!header)return;
  let actions=header.querySelector<HTMLElement>('.move-history-actions');
  if(!actions){
    actions=document.createElement('div');
    actions.className='move-history-actions';
    header.append(actions);
  }
  if(!actions.querySelector('#moveHistory')){
    const historyButton=document.createElement('button');
    historyButton.id='moveHistory';
    historyButton.type='button';
    historyButton.className='move-history-button';
    historyButton.textContent='履歴';
    historyButton.setAttribute('aria-label','対戦中の駒の移動履歴を開く');
    historyButton.addEventListener('click',openHistory);
    actions.append(historyButton);
  }
  if(!actions.querySelector('#opponentAction')){
    const opponentButton=document.createElement('button');
    opponentButton.id='opponentAction';
    opponentButton.type='button';
    opponentButton.className='opponent-action-button';
    opponentButton.textContent='相手行動';
    opponentButton.setAttribute('aria-label','相手の直前の駒移動を表示する');
    opponentButton.addEventListener('click',openOpponentAction);
    actions.append(opponentButton);
  }
}

function resetTracking():void{
  history=[];
  lastSnapshot=null;
  closeHistory();
  closeOpponentAction();
}

function sync():void{
  scheduled=false;
  if(!app)return;
  const game=app.querySelector<HTMLElement>('.game');
  if(!game){
    if(lastSnapshot||history.length)resetTracking();
    return;
  }
  ensureHistoryButtons(game);
  const current=captureBoard(game);
  if(!current)return;
  if(!lastSnapshot){
    lastSnapshot=current;
    renderHistoryList();
    return;
  }
  if(snapshotsEqual(lastSnapshot,current))return;
  const move=inferMove(lastSnapshot,current);
  if(move){
    history.push({...move,number:history.length+1});
  }else{
    history=[];
  }
  lastSnapshot=current;
  renderHistoryList();
}

function scheduleSync():void{
  if(scheduled)return;
  scheduled=true;
  queueMicrotask(sync);
}

if(app){
  new MutationObserver(scheduleSync).observe(app,{subtree:true,childList:true,characterData:true});
  document.addEventListener('click',event=>{
    if(!(event.target instanceof Element))return;
    if(event.target.closest('#go,#sameAgain,#playAgain,#homeFromResult'))resetTracking();
  },true);
  document.addEventListener('keydown',event=>{
    if(event.key!=='Escape')return;
    closeHistory();
    closeOpponentAction();
  });
  sync();
}
