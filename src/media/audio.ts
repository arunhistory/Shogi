export interface AudioPreferences {
  bgmEnabled:boolean;
  bgmVolume:number;
  seEnabled:boolean;
  seVolume:number;
}

interface AudioManifest {
  version:number;
  bgm:Array<{id:string;url:string;loop?:boolean}>;
  se:Array<{id:string;url:string}>;
}

const storageKey='shogi:audio-preferences:v1';
const defaults:AudioPreferences={bgmEnabled:false,bgmVolume:0.7,seEnabled:false,seVolume:0.7};

function clamp(value:number):number{return Math.max(0,Math.min(1,Number.isFinite(value)?value:0));}
function safeUrl(value:string):string|null{
  try{
    const url=new URL(value,document.baseURI);
    if(url.protocol!=='https:'&&url.origin!==location.origin)return null;
    return url.toString();
  }catch{return null;}
}

function loadPreferences():AudioPreferences{
  const raw=localStorage.getItem(storageKey);
  if(!raw)return{...defaults};
  try{
    const value=JSON.parse(raw) as Partial<AudioPreferences>;
    return{
      bgmEnabled:value.bgmEnabled===true,
      bgmVolume:clamp(Number(value.bgmVolume??defaults.bgmVolume)),
      seEnabled:value.seEnabled===true,
      seVolume:clamp(Number(value.seVolume??defaults.seVolume)),
    };
  }catch{return{...defaults};}
}

export class AudioController {
  private preferences=loadPreferences();
  private manifest:AudioManifest={version:1,bgm:[],se:[]};
  private bgm:HTMLAudioElement|null=null;
  private initialized=false;
  private bgmGestureArmed=false;
  private bgmToggleBound=false;

  getPreferences():AudioPreferences{return{...this.preferences};}

  async initialize():Promise<void>{
    this.bindBgmToggleGesture();
    if(this.initialized){
      this.armBgmGesture();
      return;
    }
    this.initialized=true;
    try{
      const response=await fetch(new URL('assets/manifest.json',document.baseURI),{cache:'no-cache',credentials:'same-origin'});
      if(response.ok){
        const value=await response.json() as Partial<AudioManifest>;
        if(value.version===1&&Array.isArray(value.bgm)&&Array.isArray(value.se)){
          this.manifest={
            version:1,
            bgm:value.bgm.filter(item=>item&&typeof item.id==='string'&&typeof item.url==='string'),
            se:value.se.filter(item=>item&&typeof item.id==='string'&&typeof item.url==='string'),
          };
        }
      }
    }catch{/* Assets are optional by design. */}
    this.armBgmGesture();
  }

  async updatePreferences(next:Partial<AudioPreferences>):Promise<void>{
    this.preferences={
      bgmEnabled:next.bgmEnabled??this.preferences.bgmEnabled,
      bgmVolume:clamp(next.bgmVolume??this.preferences.bgmVolume),
      seEnabled:next.seEnabled??this.preferences.seEnabled,
      seVolume:clamp(next.seVolume??this.preferences.seVolume),
    };
    this.persistPreferences();
    if(this.bgm)this.bgm.volume=this.preferences.bgmVolume;
    if(!this.preferences.bgmEnabled){
      this.bgm?.pause();
      this.disarmBgmGesture();
      return;
    }
    await this.startBgm();
    if(!this.bgm||this.bgm.paused)this.armBgmGesture();
  }

  async startBgm(id?:string):Promise<void>{
    await this.initialize();
    const attempt=this.startBgmImmediately(id);
    if(!attempt)return;
    await attempt;
  }

  async playSe(id:string):Promise<void>{
    await this.initialize();
    if(!this.preferences.seEnabled)return;
    const entry=this.manifest.se.find(item=>item.id===id);
    if(!entry)return;
    const url=safeUrl(entry.url);
    if(!url)return;
    const audio=new Audio(url);
    audio.volume=this.preferences.seVolume;
    try{await audio.play();}catch{/* Optional sound never blocks gameplay. */}
  }

  private persistPreferences():void{
    localStorage.setItem(storageKey,JSON.stringify(this.preferences));
  }

  private bindBgmToggleGesture():void{
    if(this.bgmToggleBound)return;
    this.bgmToggleBound=true;
    document.addEventListener('change',this.handleBgmToggleGesture,true);
  }

  private startBgmImmediately(id?:string):Promise<void>|null{
    if(!this.preferences.bgmEnabled||this.manifest.bgm.length===0)return null;
    const entry=(id?this.manifest.bgm.find(item=>item.id===id):this.manifest.bgm[0])??null;
    if(!entry)return null;
    const url=safeUrl(entry.url);
    if(!url)return null;
    if(!this.bgm||this.bgm.src!==url){
      this.bgm?.pause();
      this.bgm=new Audio(url);
      this.bgm.preload='auto';
      this.bgm.loop=entry.loop!==false;
    }
    this.bgm.volume=this.preferences.bgmVolume;
    try{
      const attempt=this.bgm.play();
      return attempt.then(()=>{this.disarmBgmGesture();}).catch(()=>{this.armBgmGesture();});
    }catch{
      this.armBgmGesture();
      return Promise.resolve();
    }
  }

  private armBgmGesture():void{
    if(this.bgmGestureArmed||!this.preferences.bgmEnabled||this.manifest.bgm.length===0)return;
    this.bgmGestureArmed=true;
    document.addEventListener('pointerdown',this.handleBgmGesture,{once:true,capture:true});
    document.addEventListener('keydown',this.handleBgmGesture,{once:true,capture:true});
  }

  private disarmBgmGesture():void{
    if(!this.bgmGestureArmed)return;
    this.bgmGestureArmed=false;
    document.removeEventListener('pointerdown',this.handleBgmGesture,true);
    document.removeEventListener('keydown',this.handleBgmGesture,true);
  }

  private handleBgmToggleGesture=(event:Event):void=>{
    const target=event.target;
    if(!(target instanceof HTMLInputElement)||target.id!=='bgmEnabled')return;
    this.preferences={...this.preferences,bgmEnabled:target.checked};
    this.persistPreferences();
    if(!target.checked){
      this.bgm?.pause();
      this.disarmBgmGesture();
      return;
    }
    const attempt=this.startBgmImmediately();
    if(!attempt)this.armBgmGesture();
  };

  private handleBgmGesture=():void=>{
    this.bgmGestureArmed=false;
    document.removeEventListener('pointerdown',this.handleBgmGesture,true);
    document.removeEventListener('keydown',this.handleBgmGesture,true);
    const attempt=this.startBgmImmediately();
    if(!attempt)this.armBgmGesture();
  };
}

export const audioController=new AudioController();
