const app=document.querySelector<HTMLElement>('#app');

function decorateBoard():void{
  if(!app)return;
  const cells=[...app.querySelectorAll<HTMLButtonElement>('.board .cell')];
  if(cells.length!==81)return;

  for(const cell of cells){
    cell.classList.remove('move-target','capture-target','in-check');
    if(cell.classList.contains('legal')){
      if((cell.textContent??'').trim())cell.classList.add('capture-target');
      else cell.classList.add('move-target');
      cell.setAttribute('aria-description',cell.classList.contains('capture-target')?'合法手・駒を取る':'合法手');
    }else{
      cell.removeAttribute('aria-description');
    }
  }

  const status=app.querySelector<HTMLElement>('.game header strong')?.textContent??'';
  if(!status.includes('王手'))return;
  const checkedSide=status.startsWith('先手')?'sente':status.startsWith('後手')?'gote':null;
  if(!checkedSide)return;

  const king=cells.find(cell=>{
    if((cell.textContent??'').trim()!=='玉')return false;
    const side=cell.classList.contains('gote')?'gote':'sente';
    return side===checkedSide;
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
