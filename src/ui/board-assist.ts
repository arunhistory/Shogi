const app=document.querySelector<HTMLElement>('#app');

function sideOf(cell:HTMLButtonElement):'sente'|'gote'{
  return cell.classList.contains('gote')?'gote':'sente';
}

function decorateBoard():void{
  if(!app)return;
  const cells=[...app.querySelectorAll<HTMLButtonElement>('.board .cell')];
  if(cells.length!==81)return;

  for(const cell of cells){
    cell.classList.remove('move-target','capture-target','danger','in-check');
    if(cell.classList.contains('legal')){
      if((cell.textContent??'').trim())cell.classList.add('capture-target');
      else cell.classList.add('move-target');
      cell.setAttribute('aria-description',cell.classList.contains('capture-target')?'合法手・駒を取る':'合法手');
    }else{
      cell.removeAttribute('aria-description');
    }
  }

  // The game engine has already removed every illegal king destination from the
  // `.legal` set. Reuse that authoritative result instead of duplicating an
  // opponent attack-map implementation in the UI.
  const selectedKingIndex=cells.findIndex(cell=>
    cell.classList.contains('selected')&&(cell.textContent??'').trim()==='玉'
  );
  if(selectedKingIndex>=0){
    const selectedKing=cells[selectedKingIndex]!;
    const selectedSide=sideOf(selectedKing);
    const kingY=Math.floor(selectedKingIndex/9);
    const kingX=selectedKingIndex%9;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      if(dy===0&&dx===0)continue;
      const y=kingY+dy,x=kingX+dx;
      if(y<0||y>=9||x<0||x>=9)continue;
      const target=cells[y*9+x]!;
      const occupied=(target.textContent??'').trim().length>0;
      if(occupied&&sideOf(target)===selectedSide)continue;
      if(target.classList.contains('legal'))continue;
      target.classList.add('danger');
      target.setAttribute('aria-description','危険マス・玉は移動できません');
    }
  }

  const status=app.querySelector<HTMLElement>('.game header strong')?.textContent??'';
  if(!status.includes('王手'))return;
  const checkedSide=status.startsWith('先手')?'sente':status.startsWith('後手')?'gote':null;
  if(!checkedSide)return;

  const king=cells.find(cell=>{
    if((cell.textContent??'').trim()!=='玉')return false;
    return sideOf(cell)===checkedSide;
  });
  if(king){
    king.classList.add('in-check');
    king.setAttribute('aria-description','王手を受けています');
  }
}

if(app){
  const observer=new MutationObserver(()=>decorateBoard());
  observer.observe(app,{subtree:true,childList:true});
  decorateBoard();
}
