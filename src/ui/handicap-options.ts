import { HANDICAP_RULE_LIST } from '../game/handicaps';

const initialized=new WeakSet<HTMLSelectElement>();

function bindHandicapOptions():void{
  const select=document.querySelector<HTMLSelectElement>('#handicap');
  if(!select||initialized.has(select))return;
  const current=select.value;
  select.replaceChildren(...HANDICAP_RULE_LIST.map(rule=>{
    const option=document.createElement('option');
    option.value=rule.id;
    option.textContent=rule.label;
    return option;
  }));
  if(HANDICAP_RULE_LIST.some(rule=>rule.id===current))select.value=current;
  initialized.add(select);
}

const app=document.querySelector('#app');
if(app){
  new MutationObserver(bindHandicapOptions).observe(app,{subtree:true,childList:true});
  bindHandicapOptions();
}
