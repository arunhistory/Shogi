const CREATOR='ある〜ん';
const CO_CREATOR='由咲るい';
const JOINED=`${CREATOR}・${CO_CREATOR}`;
const CREATOR_PATTERN=/ある〜ん(?!・由咲るい)/g;

function correctString(value:string):string{
  return value.replace(CREATOR_PATTERN,JOINED);
}

export function correctCreatorAttribution(value:unknown):unknown{
  if(typeof value==='string')return correctString(value);
  if(Array.isArray(value))return value.map(correctCreatorAttribution);
  if(value&&typeof value==='object'){
    return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,item])=>[key,correctCreatorAttribution(item)]));
  }
  return value;
}

export function correctCreatorAttributionIn(root:ParentNode):void{
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  const nodes:Text[]=[];
  for(let node=walker.nextNode();node;node=walker.nextNode())nodes.push(node as Text);
  for(const node of nodes){
    const current=node.nodeValue??'';
    const corrected=correctString(current);
    if(corrected!==current)node.nodeValue=corrected;
  }
}
