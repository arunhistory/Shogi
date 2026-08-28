const redundantOnlineStatuses=new Set([
  'Cloudflare接続先を確認しています。',
  '部屋を作るか、受け取ったパスコードを入力してください。',
]);
const removableOnlineNotes=new Set([
  'オンライン対局はCloudflare側の正式状態管理へ接続して開始します。接続先未設定時は対局を開始しません。',
  '正式局面はCloudflare側から受信した後に表示します。',
]);

export function isRedundantOnlineStatus(text:string):boolean{
  return redundantOnlineStatuses.has(text.trim());
}

export function isRemovableOnlineNote(text:string):boolean{
  return removableOnlineNotes.has(text.trim());
}

function cleanOnlineCopy():void{
  const status=document.querySelector<HTMLElement>('#onlineStatus');
  if(status)status.hidden=isRedundantOnlineStatus(status.textContent??'');
  for(const note of document.querySelectorAll<HTMLParagraphElement>('.panel > .note')){
    if(isRemovableOnlineNote(note.textContent??''))note.remove();
  }
}

if(typeof document!=='undefined'){
  const app=document.querySelector('#app');
  if(app){
    new MutationObserver(cleanOnlineCopy).observe(app,{subtree:true,childList:true,characterData:true});
    cleanOnlineCopy();
  }
}
