interface VisualManifestEntry {
  id:string;
  url:string;
}

interface VisualManifest {
  version:number;
  visuals:VisualManifestEntry[];
}

const idPattern=/^[a-z0-9][a-z0-9-]{0,63}$/;

function safeUrl(value:string):string|null{
  try{
    const url=new URL(value,document.baseURI);
    const localDev=url.origin===location.origin;
    if(url.protocol!=='https:'&&!localDev)return null;
    return url.toString();
  }catch{return null;}
}

function cssUrl(value:string):string{
  return `url(${JSON.stringify(value)})`;
}

function setFavicon(url:string):void{
  let link=document.querySelector<HTMLLinkElement>('link[data-shogi-asset="app-icon"]');
  if(!link){
    link=document.createElement('link');
    link.rel='icon';
    link.dataset.shogiAsset='app-icon';
    document.head.append(link);
  }
  link.href=url;
}

async function loadManifest():Promise<VisualManifest|null>{
  try{
    const response=await fetch(new URL('assets/manifest.json',document.baseURI),{
      cache:'no-cache',
      credentials:'same-origin',
      redirect:'error',
    });
    if(!response.ok)return null;
    const value=await response.json() as Partial<VisualManifest>;
    if(value.version!==1||!Array.isArray(value.visuals))return null;
    const visuals:VisualManifestEntry[]=[];
    const seen=new Set<string>();
    for(const item of value.visuals){
      if(!item||typeof item.id!=='string'||typeof item.url!=='string')continue;
      if(!idPattern.test(item.id)||seen.has(item.id))continue;
      const url=safeUrl(item.url);
      if(!url)continue;
      seen.add(item.id);
      visuals.push({id:item.id,url});
    }
    return{version:1,visuals};
  }catch{return null;}
}

export async function applyVisualAssets():Promise<void>{
  const manifest=await loadManifest();
  if(!manifest)return;
  const byId=new Map(manifest.visuals.map(item=>[item.id,item.url]));
  const root=document.documentElement;
  const cssSlots:Record<string,string>={
    'menu-background':'--shogi-menu-background',
    'game-background':'--shogi-game-background',
    'board-texture':'--shogi-board-texture',
    'menu-illustration':'--shogi-menu-illustration',
    'game-illustration':'--shogi-game-illustration',
  };
  for(const [id,property] of Object.entries(cssSlots)){
    const url=byId.get(id);
    if(url)root.style.setProperty(property,cssUrl(url));
  }
  const icon=byId.get('app-icon');
  if(icon)setFavicon(icon);
}

void applyVisualAssets();