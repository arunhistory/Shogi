import { fetchCloudContent } from '../content/client';
import type { CloudContentKey } from '../content/client';

const titles:Record<'credits'|'licenses',string>={credits:'クレジット',licenses:'ライセンス'};
let activeModal:HTMLElement|null=null;
let previousFocus:HTMLElement|null=null;

function apiBase():string|null{
  const value=(import.meta.env.VITE_SHOGI_API_URL as string|undefined)?.trim();
  return value||null;
}

function renderBody(body:unknown):HTMLElement{
  const container=document.createElement('div');
  container.className='footer-doc-body';
  if(typeof body==='string'){
    for(const block of body.split(/\n{2,}/)){
      const p=document.createElement('p');
      p.textContent=block;
      container.append(p);
    }
    return container;
  }
  if(Array.isArray(body)&&body.every(item=>typeof item==='string')){
    const list=document.createElement('ul');
    for(const item of body){
      const li=document.createElement('li');
      li.textContent=item;
      list.append(li);
    }
    container.append(list);
    return container;
  }
  if(body&&typeof body==='object'&&!Array.isArray(body)){
    for(const [heading,value] of Object.entries(body as Record<string,unknown>)){
      const section=document.createElement('section');
      const h3=document.createElement('h3');
      h3.textContent=heading;
      section.append(h3,renderBody(value));
      container.append(section);
    }
    return container;
  }
  const pre=document.createElement('pre');
  try{pre.textContent=JSON.stringify(body,null,2);}catch{pre.textContent='表示できない形式です。';}
  container.append(pre);
  return container;
}

function closeModal(){
  if(!activeModal)return;
  activeModal.remove();
  activeModal=null;
  previousFocus?.focus();
  previousFocus=null;
}

async function openDocument(key:'credits'|'licenses'){
  closeModal();
  previousFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;
  const overlay=document.createElement('div');
  overlay.className='footer-doc-modal';
  overlay.setAttribute('role','dialog');
  overlay.setAttribute('aria-modal','true');
  overlay.setAttribute('aria-labelledby','footerDocTitle');
  const dialog=document.createElement('div');
  dialog.className='footer-doc-dialog';
  const header=document.createElement('div');
  header.className='footer-doc-header';
  const title=document.createElement('h2');
  title.id='footerDocTitle';
  title.textContent=titles[key];
  const close=document.createElement('button');
  close.type='button';
  close.className='footer-doc-close';
  close.textContent='閉じる';
  const state=document.createElement('p');
  state.textContent='読み込み中…';
  header.append(title,close);
  dialog.append(header,state);
  overlay.append(dialog);
  document.body.append(overlay);
  activeModal=overlay;
  close.addEventListener('click',closeModal);
  overlay.addEventListener('click',event=>{if(event.target===overlay)closeModal();});
  close.focus();

  const api=apiBase();
  if(!api){state.textContent='Cloudflare接続先が未設定のため、本文を取得できません。';return;}
  try{
    const documentValue=await fetchCloudContent(api,key as CloudContentKey);
    if(activeModal!==overlay)return;
    if(!documentValue.available){state.textContent='現在、本文は未登録です。';return;}
    state.replaceWith(renderBody(documentValue.body));
  }catch{
    if(activeModal===overlay)state.textContent='本文を取得できませんでした。';
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-footer-content]').forEach(button=>{
  button.addEventListener('click',()=>{
    const key=button.dataset.footerContent;
    if(key==='credits'||key==='licenses')void openDocument(key);
  });
});

document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&activeModal)closeModal();
});
