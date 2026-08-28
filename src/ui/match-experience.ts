import {emptyHands,isCheck} from '../game/engine';
import type {Board,BoardKind,Position,Side} from '../game/types';

const app=document.querySelector<HTMLElement>('#app');
const labelKinds:Record<string,BoardKind>={
  '玉':'king','飛':'rook','角':'bishop','金':'gold','銀':'silver','桂':'knight','香':'lance','歩':'pawn',
  '龍':'dragon','馬':'horse','全':'promotedSilver','圭':'promotedKnight','杏':'promotedLance','と':'tokin',
};

let scheduled=false;
let lastBoardSignature='';
let lastTurn:Side|null=null;
let lastCheckSignature='';

function opposite(side:Side):Side{return side==='sente'?'gote':'sente';}

function boardSignature(game:HTMLElement):string{
  const cells=[...game.querySelectorAll<HTMLButtonElement>('.board .cell')];
  if(cells.length!==81)return'';
  return cells.map(cell=>`${cell.classList.contains('gote')?'g':'s'}:${(cell.textContent??'').trim()}`).join('|');
}

function boardFromDom(game:HTMLElement):Board|null{
  const cells=[...game.querySelectorAll<HTMLButtonElement>('.board .cell')];
  if(cells.length!==81)return null;
  const board:Board=Array.from({length:9},()=>Array(9).fill(null));
  for(let index=0;index<81;index++){
    const cell=cells[index]!;
    const label=(cell.textContent??'').trim();
    if(!label)continue;
    const kind=labelKinds[label];
    if(!kind)return null;
    const side:Side=cell.classList.contains('gote')?'gote':'sente';
    board[Math.floor(index/9)]![index%9]={side,kind};
  }
  return board;
}

function sideFromStatus(game:HTMLElement):Side|null{
  const status=(game.querySelector<HTMLElement>('.match-header>strong')?.textContent??'').trim();
  if(status.startsWith('先手'))return'sente';
  if(status.startsWith('後手'))return'gote';
  if(status.startsWith('CPU思考中')){
    const cpuInfo=game.querySelector<HTMLElement>('.cpu-level')?.textContent??'';
    if(cpuInfo.includes('あなた: 後手'))return'sente';
    if(cpuInfo.includes('あなた: 先手'))return'gote';
  }
  return null;
}

function showCheckEffect(game:HTMLElement,checkedSide:Side):void{
  document.querySelector('.check-effect')?.remove();
  const effect=document.createElement('div');
  effect.className=`check-effect${game.classList.contains('local-mode')&&checkedSide==='gote'?' opponent-view':''}`;
  effect.setAttribute('role','status');
  effect.setAttribute('aria-live','assertive');
  effect.innerHTML='<i class="check-bolt bolt-a"></i><i class="check-bolt bolt-b"></i><i class="check-bolt bolt-c"></i><i class="check-bolt bolt-d"></i><strong>王手</strong>';
  document.body.append(effect);
  const remove=()=>effect.remove();
  effect.addEventListener('animationend',event=>{
    if(event.target===effect)remove();
  },{once:true});
  window.setTimeout(remove,1100);
}

function syncCheckEffect(game:HTMLElement,currentTurn:Side|null):void{
  const signature=boardSignature(game);
  if(!signature)return;
  const changed=lastBoardSignature!==''&&signature!==lastBoardSignature;
  const checkedSide=currentTurn??(changed&&lastTurn?opposite(lastTurn):null);
  if(changed&&checkedSide&&signature!==lastCheckSignature){
    const board=boardFromDom(game);
    if(board){
      const position:Position={board,hands:emptyHands(),turn:checkedSide,ply:0,history:[]};
      if(isCheck(position,checkedSide)){
        lastCheckSignature=signature;
        showCheckEffect(game,checkedSide);
      }
    }
  }
  lastBoardSignature=signature;
  if(checkedSide)lastTurn=checkedSide;
}

function syncCpuView(game:HTMLElement):void{
  const cpuInfo=game.querySelector<HTMLElement>('.cpu-level');
  if(!cpuInfo)return;
  const humanIsGote=(cpuInfo.textContent??'').includes('あなた: 後手');
  game.classList.toggle('cpu-view-gote',humanIsGote);
  game.classList.toggle('cpu-view-sente',!humanIsGote);
  const board=game.querySelector<HTMLElement>('.board');
  const senteHand=game.querySelector<HTMLElement>('#senteHand');
  const goteHand=game.querySelector<HTMLElement>('#goteHand');
  if(!board||!senteHand||!goteHand)return;
  if(humanIsGote){
    if(senteHand.nextElementSibling!==board)board.before(senteHand);
    if(board.nextElementSibling!==goteHand)board.after(goteHand);
  }else{
    if(goteHand.nextElementSibling!==board)board.before(goteHand);
    if(board.nextElementSibling!==senteHand)board.after(senteHand);
  }
}

function syncLocalView(game:HTMLElement,currentTurn:Side|null):void{
  if(!game.querySelector('.local-order'))return;
  game.classList.add('local-mode');
  game.classList.toggle('local-turn-sente',currentTurn==='sente');
  game.classList.toggle('local-turn-gote',currentTurn==='gote');
  const resign=game.querySelector<HTMLButtonElement>('#resign');
  if(!resign||!currentTurn)return;
  const hand=game.querySelector<HTMLElement>(currentTurn==='sente'?'#senteHand':'#goteHand');
  if(!hand)return;
  resign.classList.add('local-resign-button');
  if(resign.parentElement!==hand)hand.append(resign);
}

function syncOnlineWaitingExit(game:HTMLElement):void{
  if(!game.querySelector('.online-info'))return;
  const status=(game.querySelector<HTMLElement>('.match-header>strong')?.textContent??'').trim();
  if(status!=='対戦相手を待っています')return;
  const onlineInfo=game.querySelector<HTMLElement>('.online-info');
  if(!onlineInfo||onlineInfo.querySelector('#cancelOnlineWaiting'))return;
  const button=document.createElement('button');
  button.id='cancelOnlineWaiting';
  button.type='button';
  button.textContent='対戦をやめる';
  button.addEventListener('click',()=>{
    button.disabled=true;
    const url=new URL(location.href);
    url.searchParams.delete('invite');
    location.replace(`${url.pathname}${url.search}${url.hash}`);
  },{once:true});
  onlineInfo.append(button);
}

function sync():void{
  scheduled=false;
  if(!app)return;
  const game=app.querySelector<HTMLElement>('.game');
  if(!game){
    lastBoardSignature='';
    lastTurn=null;
    lastCheckSignature='';
    return;
  }
  const currentTurn=sideFromStatus(game);
  syncCpuView(game);
  syncLocalView(game,currentTurn);
  syncOnlineWaitingExit(game);
  syncCheckEffect(game,currentTurn);
}

function scheduleSync():void{
  if(scheduled)return;
  scheduled=true;
  queueMicrotask(sync);
}

if(app){
  new MutationObserver(scheduleSync).observe(app,{subtree:true,childList:true,characterData:true});
  sync();
}
