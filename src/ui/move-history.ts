import {inferMove,snapshotsEqual} from './move-history-core';
import type {BoardSnapshot,HistoryPiece,InferredMove} from './move-history-core';

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

function closeHistory():void{
  document.querySelector('[data-move-history-overlay]')?.remove();
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

    const notes:string[]=[];
    if(entry.drop)notes.push('打');
    if(entry.captured)notes.push(`${entry.captured}を取る`);
    if(entry.promotedTo)notes.push(`成 → ${entry.promotedTo}`);
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

function ensureHistoryButton(game:HTMLElement):void{
  const header=game.querySelector<HTMLElement>('header');
  if(!header||header.querySelector('#moveHistory'))return;
  const button=document.createElement('button');
  button.id='moveHistory';
  button.type='button';
  button.className='move-history-button';
  button.textContent='履歴';
  button.setAttribute('aria-label','対戦中の駒の移動履歴を開く');
  button.addEventListener('click',openHistory);
  header.append(button);
}

function resetTracking():void{
  history=[];
  lastSnapshot=null;
  closeHistory();
}

function sync():void{
  scheduled=false;
  if(!app)return;
  const game=app.querySelector<HTMLElement>('.game');
  if(!game){
    if(lastSnapshot||history.length)resetTracking();
    return;
  }
  ensureHistoryButton(game);
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
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeHistory();});
  sync();
}
