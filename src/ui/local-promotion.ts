export type PromotionSide='sente'|'gote';

export interface PromotionProbe{
  label:string;
  side:PromotionSide;
  fromY:number;
  toY:number;
}

const promotableLabels=new Set(['飛','角','銀','桂','香','歩']);
let bypassInterception=false;
let promotionPending=false;

export function isOptionalPromotionChoice(probe:PromotionProbe):boolean{
  if(!promotableLabels.has(probe.label))return false;
  const touchesZone=probe.side==='sente'
    ? probe.fromY<=2||probe.toY<=2
    : probe.fromY>=6||probe.toY>=6;
  if(!touchesZone)return false;
  const lastRank=probe.side==='sente'?probe.toY===0:probe.toY===8;
  if((probe.label==='歩'||probe.label==='香')&&lastRank)return false;
  const lastTwoRanks=probe.side==='sente'?probe.toY<=1:probe.toY>=7;
  if(probe.label==='桂'&&lastTwoRanks)return false;
  return true;
}

export function shouldRotatePromotionDialog(side:PromotionSide):boolean{
  return side==='gote';
}

function localPromotionProbe(target:HTMLButtonElement):PromotionProbe|null{
  if(!target.classList.contains('legal'))return null;
  const board=target.closest<HTMLElement>('.board');
  const game=board?.closest<HTMLElement>('.game');
  if(!board||!game)return null;
  if(game.querySelector('.cpu-level')||game.querySelector('.online-info'))return null;
  const cells=[...board.querySelectorAll<HTMLButtonElement>('.cell')];
  if(cells.length!==81)return null;
  const selected=cells.find(cell=>cell.classList.contains('selected'));
  if(!selected)return null;
  const fromIndex=cells.indexOf(selected);
  const toIndex=cells.indexOf(target);
  if(fromIndex<0||toIndex<0)return null;
  const label=(selected.textContent??'').trim();
  const side:PromotionSide=selected.classList.contains('gote')?'gote':'sente';
  return{label,side,fromY:Math.floor(fromIndex/9),toY:Math.floor(toIndex/9)};
}

function showPromotionDialog(side:PromotionSide):Promise<boolean>{
  return new Promise(resolve=>{
    document.querySelector('.promotion-choice-overlay')?.remove();
    const overlay=document.createElement('div');
    overlay.className='promotion-choice-overlay';
    const dialog=document.createElement('div');
    dialog.className=`promotion-choice-dialog${shouldRotatePromotionDialog(side)?' opponent-view':''}`;
    dialog.setAttribute('role','dialog');
    dialog.setAttribute('aria-modal','true');
    dialog.setAttribute('aria-labelledby','promotion-choice-title');
    const title=document.createElement('p');
    title.id='promotion-choice-title';
    title.textContent='成りますか？';
    const promote=document.createElement('button');
    promote.type='button';
    promote.textContent='成る';
    const decline=document.createElement('button');
    decline.type='button';
    decline.textContent='成らない';
    dialog.append(title,promote,decline);
    overlay.append(dialog);
    document.body.append(overlay);

    const finish=(value:boolean)=>{
      document.removeEventListener('keydown',onKey,true);
      overlay.remove();
      resolve(value);
    };
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();finish(false);}
      else if(event.key==='Enter'){event.preventDefault();finish(true);}
    };
    document.addEventListener('keydown',onKey,true);
    promote.addEventListener('click',()=>finish(true),{once:true});
    decline.addEventListener('click',()=>finish(false),{once:true});
    promote.focus();
  });
}

function commitExistingMove(target:HTMLButtonElement,promote:boolean):void{
  if(!target.isConnected)return;
  const originalConfirm=window.confirm;
  try{
    bypassInterception=true;
    window.confirm=()=>promote;
    target.click();
  }finally{
    window.confirm=originalConfirm;
    bypassInterception=false;
  }
}

function interceptLocalPromotion(event:MouseEvent):void{
  if(bypassInterception||promotionPending)return;
  const source=event.target;
  if(!(source instanceof Element))return;
  const target=source.closest<HTMLButtonElement>('.board .cell');
  if(!target)return;
  const probe=localPromotionProbe(target);
  if(!probe||!isOptionalPromotionChoice(probe))return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  promotionPending=true;
  void showPromotionDialog(probe.side)
    .then(choice=>commitExistingMove(target,choice))
    .finally(()=>{promotionPending=false;});
}

if(typeof document!=='undefined')document.addEventListener('click',interceptLocalPromotion,true);
