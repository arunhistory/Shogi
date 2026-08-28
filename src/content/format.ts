export type CloudBodyNode =
  | {kind:'paragraph';text:string}
  | {kind:'list';items:string[]}
  | {kind:'section';title:string;children:CloudBodyNode[]};

const MAX_DEPTH=8;
const MAX_NODES=500;

function scalar(value:unknown):string|null{
  if(typeof value==='string')return value;
  if(typeof value==='number'&&Number.isFinite(value))return String(value);
  if(typeof value==='boolean')return value?'true':'false';
  return null;
}

function pushNode(nodes:CloudBodyNode[],node:CloudBodyNode,counter:{value:number}):void{
  if(counter.value>=MAX_NODES)return;
  counter.value++;
  nodes.push(node);
}

function formatValue(value:unknown,depth:number,counter:{value:number}):CloudBodyNode[]{
  if(counter.value>=MAX_NODES)return[];
  if(depth>MAX_DEPTH)return[{kind:'paragraph',text:'表示階層が深すぎるため省略しました。'}];

  const direct=scalar(value);
  if(direct!==null){
    return direct.split(/\n{2,}/).map(text=>text.trim()).filter(Boolean).map(text=>({kind:'paragraph' as const,text}));
  }
  if(value===null||value===undefined)return[];

  if(Array.isArray(value)){
    const scalarItems=value.map(scalar);
    if(scalarItems.every(item=>item!==null)){
      const items=scalarItems.filter((item):item is string=>item!==null).map(item=>item.trim()).filter(Boolean);
      return items.length?[{kind:'list',items}]:[];
    }
    const nodes:CloudBodyNode[]=[];
    for(const item of value){
      for(const node of formatValue(item,depth+1,counter))pushNode(nodes,node,counter);
      if(counter.value>=MAX_NODES)break;
    }
    return nodes;
  }

  if(typeof value==='object'){
    const nodes:CloudBodyNode[]=[];
    for(const [title,child] of Object.entries(value as Record<string,unknown>)){
      const normalizedTitle=title.trim();
      if(!normalizedTitle)continue;
      const children=formatValue(child,depth+1,counter);
      if(children.length===0)continue;
      pushNode(nodes,{kind:'section',title:normalizedTitle,children},counter);
      if(counter.value>=MAX_NODES)break;
    }
    return nodes;
  }

  return[{kind:'paragraph',text:String(value)}];
}

export function formatCloudBody(body:unknown):CloudBodyNode[]{
  const counter={value:0};
  return formatValue(body,0,counter);
}
