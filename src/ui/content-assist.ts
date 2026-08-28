import { formatCloudBody } from '../content/format';
import type { CloudBodyNode } from '../content/format';

function renderNode(node:CloudBodyNode):HTMLElement{
  if(node.kind==='paragraph'){
    const p=document.createElement('p');
    p.textContent=node.text;
    return p;
  }
  if(node.kind==='list'){
    const ul=document.createElement('ul');
    for(const item of node.items){
      const li=document.createElement('li');
      li.textContent=item;
      ul.append(li);
    }
    return ul;
  }
  const section=document.createElement('section');
  const heading=document.createElement('h3');
  heading.textContent=node.title;
  section.append(heading);
  for(const child of node.children)section.append(renderNode(child));
  return section;
}

function upgradeManagedContent():void{
  for(const pre of document.querySelectorAll<HTMLPreElement>('.cloud-document-body > pre')){
    if(pre.dataset.categorized==='checked')continue;
    pre.dataset.categorized='checked';
    let body:unknown;
    try{body=JSON.parse(pre.textContent??'');}catch{continue;}
    const nodes=formatCloudBody(body);
    if(nodes.length===0)continue;
    const container=document.createElement('div');
    container.className='cloud-document-categories';
    for(const node of nodes)container.append(renderNode(node));
    pre.replaceWith(container);
  }
}

function removeSettingsMaterialNote():void{
  const panel=document.querySelector<HTMLElement>('.settings-panel');
  if(!panel)return;
  for(const note of panel.querySelectorAll<HTMLParagraphElement>(':scope > .note')){
    if((note.textContent??'').includes('BGM・SE素材は外部manifestから読み込みます'))note.remove();
  }
}

function enhanceUi():void{
  upgradeManagedContent();
  removeSettingsMaterialNote();
}

const app=document.querySelector('#app');
if(app){
  new MutationObserver(enhanceUi).observe(app,{subtree:true,childList:true});
  enhanceUi();
}
